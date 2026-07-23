import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude-adapter.js';
import { AttentionManager } from '../src/core/attention.js';
import { EventBus } from '../src/core/bus.js';
import { type Event, newEvent } from '../src/core/events.js';
import { makeStubMetrics } from './helpers/factories.js';

/**
 * The seam nobody tested: hook → ClaudeAdapter → EventBus → AttentionManager.
 *
 * Approving a permission from the dashboard goes through `POST /approve/:id`,
 * which calls `claudeAdapter.resolvePermission()` AND
 * `attentionManager.resolve(eventId)` (server.ts:602). Approving from the CHAT
 * arrives as a `PostToolUse` hook, and `#autoResolvePending` only cleared the
 * adapter's own session state — the AttentionManager kept the permission as its
 * active event.
 *
 * Because `permission_critical` carries an infinite TTL override (S2.5.8) and
 * `permission_resolved` is `ambient` (which can never preempt a `critical`),
 * the AM was deadlocked: the robot showed `⚠ sudo rm -rf /` with a DOUBTFUL
 * face forever, for a permission the user had already approved.
 *
 * Reproduced against the running bridge on 2026-07-09 before writing this.
 *
 * Every test here drives the REAL adapter and the REAL bus. Mocking either one
 * would reintroduce the blind spot: the adapter's unit tests pass today, and so
 * do the AM's. The bug lives strictly between them.
 */

const CRITICAL_TTL_MS = 30_000;

function setup(criticalCommands: string[] = ['rm', 'sudo']) {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-chain-'));
  const stateDir = join(dir, 'claude-state');
  mkdirSync(stateDir, { recursive: true });
  const metrics = makeStubMetrics();

  const attentionManager = new AttentionManager(
    {
      ttlBySeverity: {
        critical: CRITICAL_TTL_MS,
        high: 120_000,
        medium: 300_000,
        low: 600_000,
        ambient: 30_000,
      },
      // Mirrors config.yaml: both permission categories never expire on their own.
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

  // Wire the bus to the AM exactly like index.ts does.
  const bus = new EventBus(
    { windowMs: 60_000, autoMuteAfter: 10 },
    {
      onAccepted: (e: Event) => attentionManager.push(e),
      onOutcome: () => {},
    },
  );

  const adapter = new ClaudeAdapter(
    {
      staleSessionTimeoutMs: 1_800_000,
      transcriptReadEnabled: false,
      unknownLineThreshold: 5,
      unknownLineBrokenThreshold: 20,
      scanIntervalMs: 0, // no background scan in tests
    },
    {
      logger: { warn: vi.fn(), info: vi.fn() },
      metrics,
      criticalCommands,
      stateDir,
      projectsDir: join(dir, 'no-projects'),
      claudeDesktopSessionsDir: '',
    },
  );

  return { adapter, bus, attentionManager, dir };
}

describe('permission resolve chain — hook → adapter → bus → AM', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(async () => {
    await ctx.adapter.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('the permission becomes the AM active event with an infinite deadline', async () => {
    await ctx.adapter.start(ctx.bus);
    ctx.adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      command: 'sudo rm -rf /',
    });

    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.category).toBe('permission_critical');
    // This is what makes the bug permanent rather than self-healing after 30s.
    expect(snap.active?.deadline).toBeNull();
  });

  it('PostToolUse (approve from chat) releases the AM active event', async () => {
    await ctx.adapter.start(ctx.bus);
    ctx.adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      command: 'sudo rm -rf /',
    });
    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('permission_critical');

    // The user approves in the chat. Claude Code runs the tool and fires PostToolUse.
    ctx.adapter.handleHookEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      cwd: '/tmp/p',
    });

    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.category).not.toBe('permission_critical');
    // And the stale permission isn't lurking in the queue either.
    expect(snap.queue.map((a) => a.event.category)).not.toContain('permission_critical');
  });

  it('Stop (user typed instead of approving) also releases the AM active event', async () => {
    await ctx.adapter.start(ctx.bus);
    ctx.adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      command: 'sudo rm -rf /',
    });
    ctx.adapter.handleHookEvent({
      hook_event_name: 'Stop',
      session_id: 's1',
      last_assistant_message: 'ok, no lo hago',
    });

    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.category).not.toBe('permission_critical');
  });

  it('resolving session A promotes session B, and only A is retired', async () => {
    await ctx.adapter.start(ctx.bus);
    // Both permission categories share severity `critical` — S2.5.8 split them
    // by category, not severity — so B does NOT preempt A. B queues behind it.
    ctx.adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'A',
      notification_type: 'permission_prompt',
      cwd: '/tmp/a',
      command: 'ls',
    });
    ctx.adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'B',
      notification_type: 'permission_prompt',
      cwd: '/tmp/b',
      command: 'sudo rm',
    });
    let snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.payload.sessionId).toBe('A');
    expect(snap.queue.map((a) => a.event.payload.sessionId)).toContain('B');

    // Approving A retires ONLY A. B is promoted and keeps waiting for the user.
    ctx.adapter.handleHookEvent({ hook_event_name: 'PostToolUse', session_id: 'A', cwd: '/tmp/a' });

    snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.category).toBe('permission_critical');
    expect(snap.active?.event.payload.sessionId).toBe('B');
    // A's permission is gone — not active, not lurking in the queue.
    // (A's `permission_resolved` IS queued: it's the "approved" flash, an
    // ambient event waiting behind B's critical one. That's correct.)
    const pendingPermissions = snap.queue.map((a) => a.event).filter(
      (e) => e.category === 'permission' || e.category === 'permission_critical',
    );
    expect(pendingPermissions).toHaveLength(0);
  });

  it('AttentionManager.push resolves any event naming another via payload.resolvesEventId', () => {
    // The mechanism is generic (D3: normalized events), not Claude-specific.
    // Fase 3 gets it for free — a "CI green" event can retire a "CI red" one.
    const target = newEvent({
      source: 'ci',
      category: 'build_failed',
      severity: 'critical',
      payload: {},
    });
    ctx.attentionManager.push(target);
    expect(ctx.attentionManager.snapshot().active?.event.id).toBe(target.id);

    const resolver = newEvent({
      source: 'ci',
      category: 'build_fixed',
      severity: 'ambient',
      payload: { resolvesEventId: target.id },
    });
    ctx.attentionManager.push(resolver);

    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.id).not.toBe(target.id);
    expect(snap.queue.map((a) => a.event.id)).not.toContain(target.id);
  });

  it('a resolvesEventId pointing at nothing is a harmless no-op', () => {
    const e = newEvent({
      source: 'x',
      category: 'y',
      severity: 'ambient',
      payload: { resolvesEventId: 'does-not-exist' },
    });
    expect(() => ctx.attentionManager.push(e)).not.toThrow();
    expect(ctx.attentionManager.snapshot().active?.event.id).toBe(e.id);
  });
});
