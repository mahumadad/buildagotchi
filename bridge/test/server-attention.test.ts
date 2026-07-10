import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionManager } from '../src/core/attention.js';
import { EventBus } from '../src/core/bus.js';
import { newEvent } from '../src/core/events.js';
import { StateMachine } from '../src/core/state-machine.js';
import { PersonalityManager } from '../src/personality/personality.js';
import type { Platform } from '../src/platform/platform.js';
import { EventRecorder } from '../src/recorder/recorder.js';
import { Metrics } from '../src/server/metrics.js';
import { BridgeServer, type HealthPayload } from '../src/server/server.js';

/**
 * M14: `event: state` SSE messages must carry `active` and `queue` so the
 * dashboard can render the Attention panel without ever calling `/state` on
 * every tick. #statePayload() is the single source; every path uses it.
 */

const NULL_HEALTH: HealthPayload = {
  adapters: {},
  transport: { kind: 'stub', connected: false, reconnects: 0, latency: { p50: 0, p95: 0 } },
};

function makePlatform(): Platform {
  return {
    getSecret: vi.fn().mockResolvedValue(null),
    setSecret: vi.fn(),
    unpackClaudeCodeStateDir: vi.fn().mockResolvedValue(''),
    home: () => '/tmp',
  } as unknown as Platform;
}

async function setupServer() {
  const tmp = mkdtempSync(join(tmpdir(), 'server-attention-'));
  const metrics = new Metrics();
  const recorder = new EventRecorder({ dir: tmp, retentionDays: 30 });
  // Was `new EventBus(metrics, ...)`: a Metrics where a DedupConfig goes, so
  // windowMs was undefined. Harmless only because this file never exercises dedup.
  const bus = new EventBus(
    { windowMs: 60_000, autoMuteAfter: 10 },
    { onAccepted: () => {}, onOutcome: () => {} },
  );
  const attentionManager = new AttentionManager(
    {
      ttlBySeverity: {
        critical: 30_000,
        high: 120_000,
        medium: 300_000,
        low: 600_000,
        ambient: 30_000,
      },
      ttlOverrides: [{ source: 'claude', category: 'permission_critical', ttl: null }],
      maxQueueSize: 20,
      replacementPolicy: 'higher_severity_interrupts',
      transitionToBackgroundMoodDelay: 2000,
      onModeChange: { toFOCUS: 'drop_below_high', toSLEEP: 'drop_below_critical' },
    },
    {
      record: vi.fn(),
      metrics: { gauge: () => ({ set: vi.fn() }) },
      onActiveChange: () => {},
    },
  );
  const personality = new PersonalityManager(PersonalityManager.fallback());
  const stateMachine = new StateMachine(
    [
      { match: { severity: 'critical' }, state: { emotion: 'ANGRY' } },
      { match: { severity: 'ambient' }, state: { emotion: 'NEUTRAL' } },
    ],
    { emit: () => {}, record: vi.fn(), metrics },
    personality,
  );
  const server = new BridgeServer({
    host: '127.0.0.1',
    port: 0,
    rateLimitPerMinute: 60,
    requireToken: false,
    simulate: true,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics,
    platform: makePlatform(),
    bus,
    recorder,
    attentionManager,
    stateMachine,
    getHealth: () => NULL_HEALTH,
  });
  await server.start();
  const addr = server.address();
  return {
    server,
    url: `http://127.0.0.1:${addr?.port}`,
    attentionManager,
    stateMachine,
    tmp,
    recorder,
  };
}

async function firstSseState(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const res = await fetch(`${url}/stream`, { signal: controller.signal });
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const stateIdx = buf.indexOf('event: state\ndata: ');
      if (stateIdx !== -1) {
        const nl = buf.indexOf('\n\n', stateIdx);
        if (nl !== -1) {
          const dataLine = buf.slice(stateIdx + 'event: state\ndata: '.length, nl);
          return JSON.parse(dataLine);
        }
      }
    }
  } finally {
    controller.abort();
    reader.cancel().catch(() => {});
  }
  throw new Error('no state event received');
}

describe('M14 — SSE state payload', () => {
  let ctx: Awaited<ReturnType<typeof setupServer>>;

  beforeEach(async () => {
    ctx = await setupServer();
  });

  afterEach(async () => {
    await ctx.server.stop();
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  it('M14-1: SSE state includes active and queue', async () => {
    // Push two events; the first is active, the second queues.
    ctx.attentionManager.push(
      newEvent({ source: 't', category: 'a', severity: 'critical', payload: {} }),
    );
    ctx.attentionManager.push(
      newEvent({ source: 't', category: 'b', severity: 'ambient', payload: {} }),
    );

    const snap = await firstSseState(ctx.url);
    expect(snap).toHaveProperty('resolvedState');
    expect(snap).toHaveProperty('mode');
    expect(snap).toHaveProperty('active');
    expect(snap).toHaveProperty('queue');
    expect((snap.queue as unknown[]).length).toBe(1);
  });

  it('M14-2: SSE state includes mode', async () => {
    ctx.attentionManager.setMode('FOCUS');
    const snap = await firstSseState(ctx.url);
    expect(snap.mode).toBe('FOCUS');
  });

  it('M14-3: GET /state and SSE state carry the same resolvedState', async () => {
    ctx.attentionManager.push(
      newEvent({ source: 't', category: 'a', severity: 'critical', payload: {} }),
    );
    // Apply so the state machine reflects it.
    ctx.stateMachine.apply(ctx.attentionManager.snapshot().active);

    const httpState = (await fetch(`${ctx.url}/state`).then((r) => r.json())) as {
      resolvedState: unknown;
    };
    const sseState = await firstSseState(ctx.url);
    expect(sseState.resolvedState).toEqual(httpState.resolvedState);
  });

  it('M14-4: notifyState() has no argument (S2.5.15)', () => {
    // Direct API check: the shape of notifyState should be ()-> void.
    expect(ctx.server.notifyState.length).toBe(0);
  });

  it('M14-5: active is null when queue empties', async () => {
    // No push → the snapshot should have no active.
    const snap = await firstSseState(ctx.url);
    expect(snap.active).toBeNull();
    expect((snap.queue as unknown[]).length).toBe(0);
  });

  it('M14-6: deadline is null for a claude permission_critical event', async () => {
    ctx.attentionManager.push(
      newEvent({
        source: 'claude',
        category: 'permission_critical',
        severity: 'critical',
        payload: {},
      }),
    );
    const snap = await firstSseState(ctx.url);
    const active = snap.active as { deadline: number | null } | null;
    expect(active).not.toBeNull();
    expect(active?.deadline).toBeNull();
  });
});
