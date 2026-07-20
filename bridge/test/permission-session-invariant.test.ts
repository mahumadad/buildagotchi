import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude-adapter.js';
import { AttentionManager } from '../src/core/attention.js';
import { EventBus } from '../src/core/bus.js';
import type { Event } from '../src/core/events.js';
import type { Metrics } from '../src/server/metrics.js';

/**
 * INVARIANT: no permission may be active (or queued) in the AttentionManager
 * for a session the adapter no longer tracks.
 *
 * `permission` and `permission_critical` carry an infinite TTL (S2.5.8), so a
 * permission the AM never hears about again is a permanent deadlock: the robot
 * shows a warning for an operation nobody will ever resolve.
 *
 * The adapter has several ways to stop tracking a session. Testing them one by
 * one is how we got here: the `PostToolUse` path was fixed on 2026-07-09 while
 * `SessionEnd` and `#cleanStale` kept leaking. This file asserts the invariant
 * itself, so a FOURTH way to drop a session — added by anyone, later — fails
 * here instead of on the user's desk.
 *
 * `assertNoOrphanPermissions` is the whole point. Every test ends with it.
 */

const STALE_TIMEOUT_MS = 1_800_000;

function makeMetrics(): Metrics {
  return {
    counter: () => ({ inc: vi.fn() }),
    gauge: () => ({ set: vi.fn() }),
  } as unknown as Metrics;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'perm-invariant-'));
  const stateDir = join(dir, 'claude-state');
  mkdirSync(stateDir, { recursive: true });

  const attentionManager = new AttentionManager(
    {
      ttlBySeverity: {
        critical: 30_000,
        high: 120_000,
        medium: 300_000,
        low: 600_000,
        ambient: 30_000,
      },
      ttlOverrides: [
        { source: 'claude', category: 'permission', ttl: null },
        { source: 'claude', category: 'permission_critical', ttl: null },
      ],
      maxQueueSize: 20,
      replacementPolicy: 'higher_severity_interrupts',
      transitionToBackgroundMoodDelay: 2000,
      onModeChange: { toFOCUS: 'drop_below_high', toSLEEP: 'drop_below_critical' },
    },
    {
      record: vi.fn(),
      metrics: { gauge: () => ({ set: vi.fn() }) },
      onActiveChange: vi.fn(),
    },
  );

  const bus = new EventBus(
    { windowMs: 60_000, autoMuteAfter: 10 },
    { onAccepted: (e: Event) => attentionManager.push(e), onOutcome: () => {} },
  );

  const adapter = new ClaudeAdapter(
    {
      staleSessionTimeoutMs: STALE_TIMEOUT_MS,
      transcriptReadEnabled: false,
      unknownLineThreshold: 5,
      unknownLineBrokenThreshold: 20,
      scanIntervalMs: 0,
    },
    {
      logger: { warn: vi.fn(), info: vi.fn() },
      metrics: makeMetrics(),
      criticalCommands: ['rm', 'sudo'],
      stateDir,
      projectsDir: join(dir, 'no-projects'),
      claudeDesktopSessionsDir: '',
    },
  );

  return { adapter, bus, attentionManager, dir };
}

const PERMISSION_CATEGORIES = new Set(['permission', 'permission_critical']);

/**
 * The invariant. Reads the AM's snapshot and the adapter's live session map,
 * and fails on any permission event whose session is gone.
 */
function assertNoOrphanPermissions(
  attentionManager: AttentionManager,
  adapter: ClaudeAdapter,
): void {
  const snap = attentionManager.snapshot();
  const liveSessions = new Set(adapter.sessions().keys());

  const inFlight: Event[] = [...(snap.active ? [snap.active.event] : []), ...snap.queue.map((a) => a.event)];

  const orphans = inFlight.filter((e) => {
    if (!PERMISSION_CATEGORIES.has(e.category)) return false;
    const sessionId = e.payload.sessionId;
    return typeof sessionId === 'string' && !liveSessions.has(sessionId);
  });

  expect(orphans.map((e) => ({ category: e.category, sessionId: e.payload.sessionId }))).toEqual(
    [],
  );
}

function firePermission(adapter: ClaudeAdapter, sessionId: string, command = 'sudo rm -rf /') {
  adapter.handleHookEvent({
    hook_event_name: 'Notification',
    session_id: sessionId,
    notification_type: 'permission_prompt',
    cwd: `/tmp/${sessionId}`,
    command,
  });
}

describe('INVARIANT: no permission outlives its session', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await ctx.adapter.start(ctx.bus);
  });

  afterEach(async () => {
    await ctx.adapter.stop();
    vi.useRealTimers();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('holds while a permission is legitimately pending (control)', () => {
    firePermission(ctx.adapter, 's1');
    // The session IS alive, so an active permission is correct, not an orphan.
    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('permission_critical');
    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
  });

  it('holds after PostToolUse (approve from chat)', () => {
    firePermission(ctx.adapter, 's1');
    ctx.adapter.handleHookEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      cwd: '/tmp/s1',
    });
    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
  });

  it('holds after Stop', () => {
    firePermission(ctx.adapter, 's1');
    ctx.adapter.handleHookEvent({ hook_event_name: 'Stop', session_id: 's1' });
    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
  });

  it('holds after SessionEnd — the session is deleted outright', () => {
    firePermission(ctx.adapter, 's1');
    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('permission_critical');

    ctx.adapter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1' });

    expect(ctx.adapter.sessions().has('s1')).toBe(false);
    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
  });

  it('holds after a stale session is reaped by #cleanStale', async () => {
    // The adapter's #cleanStale interval is registered inside start(), so fake
    // timers must be installed BEFORE it, or advanceTimersByTime drives nothing.
    await ctx.adapter.stop();
    vi.useFakeTimers();
    await ctx.adapter.start(ctx.bus);

    firePermission(ctx.adapter, 's1');
    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('permission_critical');

    // #cleanStale runs on a 60s interval. One pass marks the session stale; a
    // later pass (past staleSessionTimeoutMs + STALE_EXTRA_MS) deletes it.
    vi.advanceTimersByTime(STALE_TIMEOUT_MS + 300_000 + 120_000);

    expect(ctx.adapter.sessions().has('s1')).toBe(false);
    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
  });

  it('holds when a session with a QUEUED (not active) permission ends', () => {
    // A's permission is active; B's queues behind it (same `critical` severity,
    // so no preemption — see S2.5.8). Ending B must retire B's queued one.
    firePermission(ctx.adapter, 'A', 'ls');
    firePermission(ctx.adapter, 'B', 'sudo rm');
    expect(ctx.attentionManager.snapshot().active?.event.payload.sessionId).toBe('A');
    expect(ctx.attentionManager.snapshot().queue.length).toBeGreaterThan(0);

    ctx.adapter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 'B' });

    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
    // A's is untouched.
    expect(ctx.attentionManager.snapshot().active?.event.payload.sessionId).toBe('A');
  });

  it('holds when several sessions with permissions end at once', () => {
    firePermission(ctx.adapter, 'A', 'ls');
    firePermission(ctx.adapter, 'B', 'sudo rm');
    firePermission(ctx.adapter, 'C', 'rm -rf /');

    ctx.adapter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 'A' });
    ctx.adapter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 'B' });
    ctx.adapter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 'C' });

    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
    // Nothing permission-shaped is left anywhere.
    const snap = ctx.attentionManager.snapshot();
    const stillThere = [...(snap.active ? [snap.active.event] : []), ...snap.queue.map((a) => a.event)].filter((e) =>
      PERMISSION_CATEGORIES.has(e.category),
    );
    expect(stillThere).toEqual([]);
  });

  it('SessionEnd for a session without a pending permission is a no-op', () => {
    ctx.adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/tmp/s1',
      prompt: 'hola',
    });
    expect(() =>
      ctx.adapter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1' }),
    ).not.toThrow();
    assertNoOrphanPermissions(ctx.attentionManager, ctx.adapter);
  });
});
