import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BleConfig, ProtocolSession } from '../src/ble/protocol.js';
import type { Transport, TransportState } from '../src/ble/transport.js';
import { newEvent } from '../src/core/events.js';
import { StateMachine, type StateRule } from '../src/core/state-machine.js';

/**
 * D16 (safe mode): when the link to the firmware dies, the robot must not keep
 * showing whatever the last event left on its face. `StateMachine.forceSafeState()`
 * has existed since phase 1 and, until now, nothing in `src/` ever called it —
 * because `ProtocolSession` had no way to tell anyone the link was gone. Its
 * only dep was `onInboundEvent`.
 *
 * These tests drive a Transport that stops answering, so the heartbeat starves
 * and `#onLinkDead()` fires for real, rather than mocking the moment.
 */

const CFG: BleConfig = {
  heartbeatSeconds: 1,
  missesBeforeDead: 2,
  reconnectBackoff: { initial: 60_000, max: 60_000 }, // long: don't reconnect mid-test
};

/** Answers `hello` while alive; goes silent on demand, like a robot out of range. */
class FlakyTransport implements Transport {
  alive = true;
  #lineCb: ((line: string) => void) | null = null;
  #stateCb: ((s: TransportState) => void) | null = null;
  sent: string[] = [];

  connect(): Promise<void> {
    this.#stateCb?.('connected');
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    this.#stateCb?.('disconnected');
    return Promise.resolve();
  }
  send(line: string): void {
    this.sent.push(line);
    if (!this.alive) return;
    const env = JSON.parse(line) as { t: string; seq: number; ts: number };
    if (env.t === 'hello') {
      // Reply on the next macrotask, as a real peer would.
      queueMicrotask(() =>
        this.#lineCb?.(
          JSON.stringify({ v: 1, seq: 0, t: 'hello', ts: env.ts, p: { role: 'fw', ts: env.ts } }),
        ),
      );
    }
  }
  onLine(cb: (line: string) => void): void {
    this.#lineCb = cb;
  }
  onStateChange(cb: (s: TransportState) => void): void {
    this.#stateCb = cb;
  }
}

function stateMachine() {
  const rules: StateRule[] = [{ match: { severity: 'critical' }, state: { emotion: 'ANGRY' } }];
  return new StateMachine(rules, {
    emit: vi.fn(),
    record: vi.fn(),
    metrics: { counter: () => ({ inc: vi.fn() }), gauge: () => ({ set: vi.fn() }) },
  });
}

function metrics() {
  return { counter: () => ({ inc: vi.fn() }), histogram: () => ({ observe: vi.fn() }) };
}

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };

describe('ProtocolSession → safe mode (D16)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the link as dead after missesBeforeDead starved heartbeats', async () => {
    const transport = new FlakyTransport();
    const onLinkChange = vi.fn();
    const session = new ProtocolSession(transport, CFG, {
      onInboundEvent: vi.fn(),
      onLinkChange,
      // biome-ignore lint/suspicious/noExplicitAny: pino Logger shape, only warn/info used
      logger: logger as any,
      metrics: metrics(),
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0); // let the hello reply land
    onLinkChange.mockClear();

    transport.alive = false; // the robot goes out of range
    await vi.advanceTimersByTimeAsync(2_100); // two starved heartbeat windows

    expect(onLinkChange).toHaveBeenCalledWith(false);
    await session.stop();
  });

  it('the face falls back to the safe state when the link dies', async () => {
    const sm = stateMachine();
    const transport = new FlakyTransport();
    const session = new ProtocolSession(transport, CFG, {
      onInboundEvent: vi.fn(),
      onLinkChange: (healthy) => {
        if (!healthy) sm.forceSafeState();
      },
      // biome-ignore lint/suspicious/noExplicitAny: pino Logger shape, only warn/info used
      logger: logger as any,
      metrics: metrics(),
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    sm.apply({
      event: newEvent({ source: 's', category: 'c', severity: 'critical', payload: {} }),
      deadline: null,
    });
    expect(sm.current().emotion).toBe('ANGRY');

    transport.alive = false;
    await vi.advanceTimersByTimeAsync(2_100);

    // Without a link, an ANGRY face is a lie: it describes a state nobody can update.
    expect(sm.current().emotion).toBe('NEUTRAL');
    expect(sm.current().balloon).toBe('');
    await session.stop();
  });

  it('reports the link healthy once the handshake succeeds', async () => {
    const transport = new FlakyTransport();
    const onLinkChange = vi.fn();
    const session = new ProtocolSession(transport, CFG, {
      onInboundEvent: vi.fn(),
      onLinkChange,
      // biome-ignore lint/suspicious/noExplicitAny: pino Logger shape, only warn/info used
      logger: logger as any,
      metrics: metrics(),
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onLinkChange).toHaveBeenCalledWith(true);
    await session.stop();
  });
});

/**
 * The bug the wiring exposed. `#sendStatePayload` transmitted the state and only
 * then registered `#pending`. A transport that answers synchronously — the
 * SimTransport does, and so could a fast real one — delivers the ack while
 * `#pending` is still null, `#handleAck` discards it, the retry fires 500ms
 * later, and the second "missed" ack kills a perfectly healthy link.
 *
 * On a live bridge this flapped the link once a second, and every death called
 * `forceSafeState()`, wiping the face. `protocol.test.ts` never saw it: its
 * LoopbackTransport answers after 10ms, so `#pending` is always assigned in time.
 */
describe('ProtocolSession with a synchronous peer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Answers ack + state_applied from inside `send()`, like SimTransport. */
  class SyncTransport implements Transport {
    #lineCb: ((line: string) => void) | null = null;
    connect(): Promise<void> {
      return Promise.resolve();
    }
    disconnect(): Promise<void> {
      return Promise.resolve();
    }
    send(line: string): void {
      const env = JSON.parse(line) as { t: string; seq: number; ts: number };
      const reply = (t: string, p: unknown) =>
        this.#lineCb?.(JSON.stringify({ v: 1, seq: 0, t, ts: env.ts, p }));
      if (env.t === 'hello') reply('hello', { role: 'fw', ts: env.ts });
      if (env.t === 'state' || env.t === 'state_sync') {
        reply('ack', { ack_seq: env.seq });
        reply('state_applied', { ack_seq: env.seq, bridge_ts: env.ts, fw_applied_ts: env.ts });
      }
    }
    onLine(cb: (line: string) => void): void {
      this.#lineCb = cb;
    }
    onStateChange(): void {}
  }

  it('a synchronously acked state does not kill the link', async () => {
    const onLinkChange = vi.fn();
    const session = new ProtocolSession(new SyncTransport(), CFG, {
      onInboundEvent: vi.fn(),
      onLinkChange,
      // biome-ignore lint/suspicious/noExplicitAny: pino Logger shape
      logger: logger as any,
      metrics: metrics(),
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    onLinkChange.mockClear();

    session.sendState({ emotion: 'ANGRY', decorators: [], leds: [], balloon: '' });
    await vi.advanceTimersByTimeAsync(1_500); // past both ack timeouts

    expect(onLinkChange).not.toHaveBeenCalledWith(false);
    await session.stop();
  });
});
