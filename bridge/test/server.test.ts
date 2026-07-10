import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionManager } from '../src/core/attention.js';
import { EventBus } from '../src/core/bus.js';
import type { Event } from '../src/core/events.js';
import { StateMachine } from '../src/core/state-machine.js';
import type { Platform } from '../src/platform/platform.js';
import { EventRecorder } from '../src/recorder/recorder.js';
import { Metrics } from '../src/server/metrics.js';
import { BridgeServer } from '../src/server/server.js';

/**
 * `Response.json()` is typed `unknown`. These tests assert on JSON shapes the
 * server itself owns, so a checked cast here is honest — and it keeps D-11's
 * typecheck from drowning in 10 identical `unknown` errors.
 */
// biome-ignore lint/suspicious/noExplicitAny: assertions on server-owned JSON
async function json(res: Response): Promise<any> {
  return res.json();
}


const STORED_TOKEN = 'stored-secret-token';

function makePlatform(token: string | null): Platform {
  return {
    getSecret: vi.fn().mockResolvedValue(token),
    setSecret: vi.fn().mockResolvedValue(undefined),
    dataDir: () => '/tmp/buildagotchi-test',
  };
}

function makeAm(): AttentionManager {
  return new AttentionManager(
    {
      ttlBySeverity: {
        critical: 30_000,
        high: 120_000,
        medium: 300_000,
        low: 600_000,
        ambient: 30_000,
      },
      ttlOverrides: [],
      maxQueueSize: 20,
      replacementPolicy: 'higher_severity_interrupts',
      transitionToBackgroundMoodDelay: 2_000,
      onModeChange: { toFOCUS: 'drop_below_high', toSLEEP: 'drop_below_critical' },
    },
    {
      record: () => {},
      metrics: { gauge: () => ({ set: () => {} }) },
      onActiveChange: () => {},
    },
  );
}

function makeStateMachine(): StateMachine {
  return new StateMachine([], {
    emit: () => {},
    record: () => {},
    metrics: {
      counter: () => ({ inc: () => {} }),
      gauge: () => ({ set: () => {} }),
    },
  });
}

describe('BridgeServer', () => {
  let dir: string;
  let recorder: EventRecorder;
  let bus: EventBus;
  let accepted: Event[];
  let metrics: Metrics;
  let platform: Platform;
  let server: BridgeServer;
  let baseUrl: string;

  async function start(
    opts: {
      requireToken?: boolean;
      simulate?: boolean;
      token?: string | null;
      rateLimitPerMinute?: number;
    } = {},
  ) {
    dir = mkdtempSync(join(tmpdir(), 'bridge-server-test-'));
    recorder = new EventRecorder({ dir, retentionDays: 30 });
    accepted = [];
    bus = new EventBus(
      { windowMs: 60_000, autoMuteAfter: 10 },
      { onAccepted: (e) => accepted.push(e) },
    );
    metrics = new Metrics();
    platform = makePlatform(opts.token === undefined ? STORED_TOKEN : opts.token);

    server = new BridgeServer({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: opts.rateLimitPerMinute ?? 60,
      requireToken: opts.requireToken ?? true,
      simulate: opts.simulate ?? false,
      logger: { warn: () => {}, error: () => {}, info: () => {} } as never,
      metrics,
      platform,
      bus,
      recorder,
      attentionManager: makeAm(),
      stateMachine: makeStateMachine(),
      getHealth: () => ({
        adapters: {},
        transport: { kind: 'sim', connected: true, reconnects: 0, latency: { p50: 0, p95: 0 } },
      }),
    });
    await server.start();
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr?.port}`;
  }

  afterEach(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /state returns resolvedState/active/queue/mode/uptimeMs', async () => {
    await start();
    const res = await fetch(`${baseUrl}/state`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.mode).toBe('NORMAL');
    expect(body.active).toBeNull();
    expect(body.queue).toEqual([]);
    expect(body.resolvedState.emotion).toBe('NEUTRAL');
    expect(typeof body.uptimeMs).toBe('number');
  });

  it('GET /health returns bridge ok + adapters + transport', async () => {
    await start();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.bridge).toBe('ok');
    expect(body.transport.kind).toBe('sim');
  });

  it('GET /events?limit=N returns recent recorder lines', async () => {
    await start();
    recorder.record({
      line_type: 'event',
      ts: Date.now(),
      context: { metabolicScore: null, activeMode: 'NORMAL', bleHealthy: true, adapterHealth: {} },
      data: { hello: 'world' },
    });
    const res = await fetch(`${baseUrl}/events?limit=1`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(1);
    expect(body[0].data).toEqual({ hello: 'world' });
  });

  it('GET /metrics returns prometheus text', async () => {
    await start();
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('external_events_rejected_total');
  });

  it('unknown route returns 404', async () => {
    await start();
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not found' });
  });

  it('POST /events without stored token and not --simulate returns 503', async () => {
    await start({ token: null, simulate: false });
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      body: JSON.stringify({ source: 'test', category: 'x', severity: 'low' }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /events without stored token but --simulate bypasses auth', async () => {
    await start({ token: null, simulate: true });
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      body: JSON.stringify({ source: 'test', category: 'x', severity: 'low' }),
    });
    expect(res.status).toBe(202);
  });

  it('POST /events with wrong bearer token returns 401', async () => {
    await start();
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ source: 'test', category: 'x', severity: 'low' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /events with missing auth header returns 401', async () => {
    await start();
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      body: JSON.stringify({ source: 'test', category: 'x', severity: 'low' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /events with correct token accepts and forces external: prefix', async () => {
    await start();
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${STORED_TOKEN}` },
      body: JSON.stringify({ source: 'test', category: 'x', severity: 'low' }),
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.outcome.kind).toBe('accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.source).toBe('external:test');
  });

  it('POST /events source already prefixed with external: is not duplicated', async () => {
    await start();
    await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${STORED_TOKEN}` },
      body: JSON.stringify({ source: 'external:test', category: 'x', severity: 'low' }),
    });
    expect(accepted[0]?.source).toBe('external:test');
  });

  it('POST /events with invalid schema returns 400 with issues', async () => {
    await start();
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${STORED_TOKEN}` },
      body: JSON.stringify({ source: 'test' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('POST /events rate limits after bucket exhausted', async () => {
    await start({ rateLimitPerMinute: 2 });
    const make = () =>
      fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${STORED_TOKEN}` },
        body: JSON.stringify({ source: 'test', category: 'x', severity: 'low' }),
      });
    const r1 = await make();
    const r2 = await make();
    const r3 = await make();
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r3.status).toBe(429);
  });

  it('POST /events with body over 1MB returns 413', async () => {
    await start();
    const bigPayload = 'x'.repeat(1024 * 1024 + 10);
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${STORED_TOKEN}` },
      body: JSON.stringify({
        source: 'test',
        category: 'x',
        severity: 'low',
        payload: { big: bigPayload },
      }),
    });
    expect(res.status).toBe(413);
  });

  it('GET /stream responds with text/event-stream headers', async () => {
    await start();
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });
});
