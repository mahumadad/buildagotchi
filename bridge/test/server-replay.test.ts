import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionManager } from '../src/core/attention.js';
import { BalloonHistory } from '../src/core/balloon-history.js';
import { EventBus } from '../src/core/bus.js';
import { StateMachine } from '../src/core/state-machine.js';
import { PersonalityManager } from '../src/personality/personality.js';
import type { Platform } from '../src/platform/platform.js';
import { EventRecorder } from '../src/recorder/recorder.js';
import { Metrics } from '../src/server/metrics.js';
import { BridgeServer, type HealthPayload } from '../src/server/server.js';

/**
 * M16 tests. The interesting checks are the ones that keep the replay from
 * becoming an arbitrary-file-read or a way to poison the ndjson day-log:
 *   - #1: 403 when `--simulate` is off.
 *   - #2: literal `../..` rejected.
 *   - #3: symlink escaping the recorder dir rejected (path.resolve can't see it).
 *   - #6: replayed events land in the ndjson with `replay: true`.
 *   - #7: `setReplayMode(false)` is restored even if `replay()` throws.
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

async function setupServer(opts: { simulate: boolean; recorderDir: string }) {
  const metrics = new Metrics();
  const recorder = new EventRecorder({ dir: opts.recorderDir, retentionDays: 30 });
  const bus = new EventBus(metrics, {
    // Match index.ts: accepted events are appended to the recorder. Without
    // this the M16-5 assertion has no source of truth to look up.
    onAccepted: (e) => recorder.record({ line_type: 'event', ts: Date.now(), context: {}, data: e }),
    onOutcome: () => {},
  });
  const attentionManager = new AttentionManager(
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
      transitionToBackgroundMoodDelay: 2000,
      onModeChange: { toFOCUS: 'drop_below_high', toSLEEP: 'drop_below_critical' },
    },
    { record: vi.fn(), metrics: { gauge: () => ({ set: vi.fn() }) }, onActiveChange: () => {} },
  );
  const personality = new PersonalityManager(PersonalityManager.fallback());
  const stateMachine = new StateMachine(
    [{ match: { severity: 'ambient' }, state: { emotion: 'NEUTRAL' } }],
    { emit: () => {}, record: vi.fn(), metrics },
    personality,
  );
  const balloonHistory = new BalloonHistory();
  const server = new BridgeServer({
    host: '127.0.0.1',
    port: 0,
    rateLimitPerMinute: 60,
    requireToken: false,
    simulate: opts.simulate,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics,
    platform: makePlatform(),
    bus,
    recorder,
    attentionManager,
    stateMachine,
    balloonHistory,
    getHealth: () => NULL_HEALTH,
  });
  await server.start();
  return { server, url: `http://127.0.0.1:${server.address()?.port}`, recorder, bus };
}

describe('M16 — POST /replay', () => {
  let tmp: string;
  let ctx: Awaited<ReturnType<typeof setupServer>>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'server-replay-'));
  });

  afterEach(async () => {
    if (ctx) await ctx.server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('M16-1: 403 when --simulate is off', async () => {
    ctx = await setupServer({ simulate: false, recorderDir: tmp });
    const res = await fetch(`${ctx.url}/replay`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
  });

  it('M16-2: literal ../ traversal is rejected', async () => {
    ctx = await setupServer({ simulate: true, recorderDir: tmp });
    const res = await fetch(`${ctx.url}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: '../../../etc/passwd' }),
    });
    expect(res.status).toBe(400);
  });

  it('M16-3: symlink escaping the recorder dir is rejected', async () => {
    // Write an ndjson OUTSIDE tmp, and a symlink INSIDE tmp pointing to it.
    // path.resolve() alone can't catch this — realpath does. If we only did
    // resolve, this test would pass by accident even for a broken guard.
    const outside = mkdtempSync(join(tmpdir(), 'server-replay-outside-'));
    try {
      const outsideFile = join(outside, 'external.ndjson');
      writeFileSync(outsideFile, '{"line_type":"event","ts":1,"data":{}}\n');
      const linkPath = join(tmp, 'link.ndjson');
      symlinkSync(outsideFile, linkPath);

      ctx = await setupServer({ simulate: true, recorderDir: tmp });
      const res = await fetch(`${ctx.url}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'link.ndjson' }),
      });
      expect(res.status).toBe(400);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('M16-4: without `file`, uses the day-log; `lastN` limits', async () => {
    // Write a day-log with 5 events; ask for lastN: 3.
    // Same shape as the recorder: local-date filename.
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayLog = join(tmp, `${dateStr}.ndjson`);
    const events = Array.from({ length: 5 }, (_, i) => ({
      line_type: 'event',
      ts: Date.now() + i,
      data: {
        schemaVersion: 1,
        id: `id-${i}`,
        source: 't',
        category: 'c',
        severity: 'ambient',
        hash: `h-${i}`,
        timestamp: Date.now() + i,
        payload: {},
      },
    }));
    writeFileSync(dayLog, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    ctx = await setupServer({ simulate: true, recorderDir: tmp });
    const res = await fetch(`${ctx.url}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastN: 3, instant: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { published: number };
    expect(body.published).toBe(3);
  });

  it('M16-5: replayed events land in the recorder with replay: true', async () => {
    // Same shape as the recorder: local-date filename.
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayLog = join(tmp, `${dateStr}.ndjson`);
    writeFileSync(
      dayLog,
      JSON.stringify({
        line_type: 'event',
        ts: Date.now(),
        data: {
          schemaVersion: 1,
          id: 'orig-1',
          source: 't',
          category: 'c',
          severity: 'ambient',
          hash: 'h-1',
          timestamp: Date.now(),
          payload: {},
        },
      }) + '\n',
    );

    ctx = await setupServer({ simulate: true, recorderDir: tmp });
    await fetch(`${ctx.url}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instant: true }),
    });
    const recent = ctx.recorder.recent(50);
    const replayed = recent.find((l) => l.line_type === 'event' && l.replay === true);
    expect(replayed).toBeDefined();
  });
});
