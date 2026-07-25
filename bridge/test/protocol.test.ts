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
      // Signature mirrors the real Counter: labelValues first, then n.
      inc: (_labelValues?: Record<string, string>, n = 1) => {
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

  it('seeds lastState before connect and state_syncs it after hello', async () => {
    const transport = new LoopbackTransport();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics: makeMetrics().metrics,
      logger: makeLogger(),
    });

    session.sendState(STATE_B); // link not healthy yet — must not transmit
    expect(parsedSent(transport).filter((m) => m.t === 'state' || m.t === 'state_sync')).toEqual([]);

    await session.start();
    await vi.advanceTimersByTimeAsync(10);

    const synced = parsedSent(transport).filter((m) => m.t === 'state_sync');
    expect(synced).toHaveLength(1);
    expect(synced[0]?.p).toMatchObject({ emotion: 'HAPPY' });
  });

  it('happy path: sendState -> ack -> state_applied -> latency histogram (offset-corrected)', async () => {
    const transport = new LoopbackTransport({ ackDelayMs: 25, fwClockSkewMs: 4_000 });
    const { metrics, histograms } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
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

  it('D-10: records the firmware-leg sample tagged with the driving eventId', async () => {
    const transport = new LoopbackTransport({ ackDelayMs: 25, fwClockSkewMs: 4_000 });
    const recordStateApplied = vi.fn();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics: makeMetrics().metrics,
      logger: makeLogger(),
      recordStateApplied,
    });

    await session.start();
    session.sendState(STATE_A, 'evt-42');
    await vi.advanceTimersByTimeAsync(25);

    expect(recordStateApplied).toHaveBeenCalledTimes(1);
    expect(recordStateApplied).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-42', latencyMs: 25 }),
    );
  });

  it('D-10: a state with no eventId records the sample without one', async () => {
    const transport = new LoopbackTransport({ ackDelayMs: 10 });
    const recordStateApplied = vi.fn();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics: makeMetrics().metrics,
      logger: makeLogger(),
      recordStateApplied,
    });

    await session.start();
    session.sendState(STATE_A); // no eventId (e.g. reconnect state_sync)
    await vi.advanceTimersByTimeAsync(10);

    expect(recordStateApplied).toHaveBeenCalledTimes(1);
    expect(recordStateApplied.mock.calls[0]?.[0]).not.toHaveProperty('eventId');
  });

  it('D-10: the eventId follows the retry onto its new seq', async () => {
    const transport = new LoopbackTransport({ dropSeqs: new Set([2]) });
    const recordStateApplied = vi.fn();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics: makeMetrics().metrics,
      logger: makeLogger(),
      recordStateApplied,
    });

    await session.start(); // hello uses seq 1
    session.sendState(STATE_A, 'evt-7'); // seq 2, dropped
    await vi.advanceTimersByTimeAsync(500); // ack timeout -> retry as seq 3
    await vi.advanceTimersByTimeAsync(10); // default loopback ack delay

    // Only the retry (seq 3) is applied, and it still carries the eventId.
    expect(recordStateApplied).toHaveBeenCalledTimes(1);
    expect(recordStateApplied).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-7', seq: 3 }),
    );
  });

  it('drops the first send, retries at 500ms, gets acked -> no reconnection', async () => {
    const transport = new LoopbackTransport({ dropSeqs: new Set([2]) });
    const { metrics, counters } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
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
      onLinkChange: vi.fn(),
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

  it('logs a "link down" diagnostic with uptime when a live link dies', async () => {
    const transport = new LoopbackTransport({ dropSeqs: new Set([2, 3]) });
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics: makeMetrics().metrics,
      logger,
    });

    await session.start();
    await vi.advanceTimersByTimeAsync(3_000); // the device stays up 3s...
    session.sendState(STATE_A); // seq 2, dropped
    await vi.advanceTimersByTimeAsync(500); // retry seq 3, also dropped
    await vi.advanceTimersByTimeAsync(500); // second miss -> #onLinkDead

    const call = warn.mock.calls.find((c) => c[1] === 'link down');
    expect(call).toBeDefined();
    expect(call?.[0]).toMatchObject({ sendInFlight: expect.any(Boolean) });
    expect(call?.[0].uptimeMs).toBeGreaterThanOrEqual(3_000);
  });

  it('flags a firmware clock reset when the reconnect hello ts jumps backwards (reboot)', async () => {
    const transport = new LoopbackTransport({ dropSeqs: new Set([2, 3]) });
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics: makeMetrics().metrics,
      logger,
    });

    await session.start(); // hello 1: ts ~ now
    transport.setFwClockSkew(-1_000_000); // the device reboots -> its clock resets far back
    session.sendState(STATE_A); // seq 2, dropped
    await vi.advanceTimersByTimeAsync(500); // retry seq 3, dropped
    await vi.advanceTimersByTimeAsync(500); // ack miss -> reconnect scheduled
    await vi.advanceTimersByTimeAsync(1_000); // backoff -> reconnect -> hello 2 (ts jumped back)

    const call = warn.mock.calls.find((c) => c[1] === 'firmware clock reset (reboot confirmed)');
    expect(call).toBeDefined();
    expect(call?.[0]).toMatchObject({ prevTs: expect.any(Number), ts: expect.any(Number) });
  });

  it('a connect() failure during reconnect retries with backoff instead of crashing', async () => {
    // The CoreS3 stops advertising while it reboots (e.g. after a flash), so the
    // reconnect scan rejects. That rejection used to escape `void
    // #attemptReconnect()` and crash the whole bridge; it must now just schedule
    // another attempt. `failConnectTimes: 1` reproduces the first scan timing out.
    const transport = new LoopbackTransport({ dropSeqs: new Set([2, 3]) });
    const { metrics, counters } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    await session.start(); // initial connect succeeds
    transport.failNextConnects(1); // ...but the first RECONNECT scan will time out
    session.sendState(STATE_A); // seq 2, dropped
    await vi.advanceTimersByTimeAsync(500); // retry, seq 3, also dropped
    await vi.advanceTimersByTimeAsync(500); // ack miss -> reconnection scheduled

    // Attempt 0 (backoff 1s): connect() REJECTS. The session must survive and
    // reschedule — not reconnect yet, not throw.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(counters.ble_reconnects_total ?? 0).toBe(0);

    // Attempt 1 (backoff grows to 2s): connect() succeeds -> reconnected.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(counters.ble_reconnects_total).toBe(1);
  });

  it('a failed initial connect keeps the bridge up and retries instead of aborting startup', async () => {
    // The device isn't advertising at startup (e.g. still booting after a flash).
    // start() must resolve — not throw and take the whole process down — and the
    // reconnect loop attaches the link once the device appears.
    const transport = new LoopbackTransport();
    transport.failNextConnects(1);
    const { metrics, counters } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
      metrics,
      logger: makeLogger(),
    });

    await expect(session.start()).resolves.toBeUndefined(); // no throw
    expect(counters.ble_reconnects_total ?? 0).toBe(0); // not linked yet

    await vi.advanceTimersByTimeAsync(1_000); // backoff -> connect succeeds -> linked
    expect(counters.ble_reconnects_total).toBe(1);
  });

  it('die() -> 3 hb windows -> reconnection with growing backoff -> revive() -> hello -> state_sync', async () => {
    const transport = new LoopbackTransport();
    const { metrics, counters } = makeMetrics();
    const session = new ProtocolSession(transport, baseCfg(), {
      onInboundEvent: vi.fn(),
      onLinkChange: vi.fn(),
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
      onLinkChange: vi.fn(),
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
      onLinkChange: vi.fn(),
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
      onLinkChange: vi.fn(),
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
