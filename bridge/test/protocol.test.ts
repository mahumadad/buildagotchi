import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BleConfig, type MetricsLike, ProtocolSession } from '../src/ble/protocol.js';
import { LoopbackTransport } from '../src/ble/transport-loopback.js';
import type { ResolvedState } from '../src/core/events.js';

function baseCfg(overrides: Partial<BleConfig> = {}): BleConfig {
  return {
    heartbeatSeconds: 5,
    missesBeforeDead: 3,
    reconnectBackoff: { initial: 1_000, max: 10_000 },
    ...overrides,
  };
}

function makeMetrics() {
  const counters: Record<string, number> = {};
  const histograms: Record<string, number[]> = {};
  const metrics: MetricsLike = {
    counter: (name: string) => ({
      inc: (n = 1) => {
        counters[name] = (counters[name] ?? 0) + n;
      },
    }),
    histogram: (name: string) => ({
      observe: (ms: number) => {
        if (!histograms[name]) histograms[name] = [];
        histograms[name].push(ms);
      },
    }),
  };
  return { metrics, counters, histograms };
}

function makeLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const STATE_A: ResolvedState = { emotion: 'NEUTRAL', decorators: [], leds: [] };
const STATE_B: ResolvedState = { emotion: 'HAPPY', decorators: [], leds: [] };

function parsedSent(transport: LoopbackTransport): Array<{ t: string; seq: number; p: unknown }> {
  return transport.sentLines().map((l) => JSON.parse(l));
}

describe('ProtocolSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: sendState -> ack -> state_applied -> latency histogram (offset-corrected)', async () => {
    const transport = new LoopbackTransport({ ackDelayMs: 25, fwClockSkewMs: 4_000 });
    const { metrics, histograms } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    await session.start();
    session.sendState(STATE_A);
    await vi.advanceTimersByTimeAsync(25);

    // The clock-offset correction cancels the fake firmware skew exactly:
    // the observed latency should equal the pure ack delay.
    expect(histograms.state_latency_ms).toEqual([25]);
  });

  it('drops the first send, retries at 500ms, gets acked -> no reconnection', async () => {
    const transport = new LoopbackTransport({ dropSeqs: new Set([2]) });
    const { metrics, counters } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    await session.start(); // hello uses seq 1
    session.sendState(STATE_A); // seq 2, dropped by the fake firmware
    await vi.advanceTimersByTimeAsync(500); // ack timeout -> retry (seq 3)
    await vi.advanceTimersByTimeAsync(10); // default loopback ack delay

    const sent = parsedSent(transport).filter((m) => m.t === 'state');
    expect(sent.map((m) => m.seq)).toEqual([2, 3]);
    expect(counters.ack_misses_total ?? 0).toBe(0);
    expect(counters.ble_reconnects_total ?? 0).toBe(0);
  });

  it('drops the send and the retry -> ack miss -> reconnection triggered', async () => {
    const transport = new LoopbackTransport({ dropSeqs: new Set([2, 3]) });
    const { metrics, counters } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    await session.start();
    session.sendState(STATE_A); // seq 2, dropped
    await vi.advanceTimersByTimeAsync(500); // retry, seq 3, also dropped
    await vi.advanceTimersByTimeAsync(500); // second miss -> ack miss + reconnection

    expect(counters.ack_misses_total).toBe(1);

    // Reconnection backoff (initial: 1s) kicks in; the fake firmware is still
    // alive so the reconnect attempt succeeds and is counted.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(counters.ble_reconnects_total).toBe(1);
  });

  it('die() -> 3 hb windows -> reconnection with growing backoff -> revive() -> hello -> state_sync', async () => {
    const transport = new LoopbackTransport();
    const { metrics, counters } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    await session.start();
    session.sendState(STATE_A);
    await vi.advanceTimersByTimeAsync(10); // ack + state_applied for the initial state

    transport.die();
    await vi.advanceTimersByTimeAsync(15_000); // 3 heartbeat windows (5s each) -> link dead

    await vi.advanceTimersByTimeAsync(1_000); // backoff attempt 0 (1s) -> hello sent, still dead
    await vi.advanceTimersByTimeAsync(2_000); // hello timeout (2s) -> attempt fails

    await vi.advanceTimersByTimeAsync(2_000); // backoff attempt 1 (2s) -> hello sent, still dead
    transport.revive();
    await vi.advanceTimersByTimeAsync(2_000); // hello now answered synchronously -> reconnected

    expect(counters.ble_reconnects_total).toBe(1);

    const stateMsgs = parsedSent(transport).filter((m) => m.t === 'state' || m.t === 'state_sync');
    expect(stateMsgs.at(-1)?.t).toBe('state_sync');
  });

  it('no hello from the peer -> 2s timeout -> offset 0 + counter; late hello on the 30s retry updates the offset', async () => {
    const transport = new LoopbackTransport({ respondHello: false });
    const { metrics, counters, histograms } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    // start() blocks on the hello timeout (no response), so it must run
    // concurrently with the fake-timer advance instead of being awaited first.
    const startPromise = session.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;
    expect(counters.handshake_failures_total).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000); // 30s retry fires, awaits a new hello

    const fwTs = Date.now() + 4_000; // simulate a firmware clock 4s ahead
    transport.inject(
      JSON.stringify({ v: 1, seq: 999, t: 'hello', ts: fwTs, p: { role: 'fw', ts: fwTs } }),
    );
    await vi.advanceTimersByTimeAsync(0);

    session.sendState(STATE_A);
    await vi.advanceTimersByTimeAsync(10); // default loopback ack delay, fwClockSkewMs 0

    // latency = fw_applied_ts - offset - bridge_ts = 10 - 4000 (offset now applied)
    expect(histograms.state_latency_ms).toEqual([10 - 4_000]);
  });

  it('injects a button event -> arrives at onInboundEvent with kind/detail', async () => {
    const onInboundEvent = vi.fn();
    const transport = new LoopbackTransport();
    const { metrics } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent,
      metrics,
      logger: makeLogger(),
    });

    await session.start();
    transport.inject(
      JSON.stringify({
        v: 1,
        seq: 50,
        t: 'event',
        ts: Date.now(),
        p: { kind: 'button', detail: { button: 'A', action: 'press' } },
      }),
    );

    expect(onInboundEvent).toHaveBeenCalledWith('button', { button: 'A', action: 'press' });
  });

  it('a new state replaces the pending-ack state: only the latest is retried', async () => {
    const transport = new LoopbackTransport({ ackDelayMs: 10_000 }); // never acks within this test
    const { metrics } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    await session.start();
    session.sendState(STATE_A);
    await vi.advanceTimersByTimeAsync(100); // before STATE_A's ack timeout
    session.sendState(STATE_B); // replaces the pending ack for STATE_A
    await vi.advanceTimersByTimeAsync(500); // STATE_B's own ack timeout -> retry

    const emotions = parsedSent(transport)
      .filter((m) => m.t === 'state')
      .map((m) => (m.p as ResolvedState).emotion);

    expect(emotions).toEqual(['NEUTRAL', 'HAPPY', 'HAPPY']);
  });
});
