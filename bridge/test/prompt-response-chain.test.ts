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
 * D-06: Claude's answer used to reach the screen ~30 seconds late.
 *
 * `prompt` and `response` are both `ambient`, so when `Stop` fires the session's
 * own `prompt` is still the AM's active event and `response` merely queues
 * behind it (equal severity → no preemption). The response only surfaced when
 * the prompt expired on its `ttlBySeverity.ambient` = 30s.
 *
 * That is backwards for an ambient device: you glance at the robot to learn
 * whether Claude finished, and it tells you half a minute after it did.
 *
 * A prompt stops meaning anything the moment its response arrives. The response
 * now retires it via `payload.resolvesEventId` — the same mechanism that fixed
 * the permission deadlock, which is why this is cheap.
 */

const AMBIENT_TTL_MS = 30_000;

function makeMetrics(): Metrics {
  return {
    counter: () => ({ inc: vi.fn() }),
    gauge: () => ({ set: vi.fn() }),
  } as unknown as Metrics;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-response-'));
  const stateDir = join(dir, 'claude-state');
  mkdirSync(stateDir, { recursive: true });

  const attentionManager = new AttentionManager(
    {
      ttlBySeverity: {
        critical: 30_000,
        high: 120_000,
        medium: 300_000,
        low: 600_000,
        ambient: AMBIENT_TTL_MS,
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
    { record: vi.fn(), metrics: { gauge: () => ({ set: vi.fn() }) }, onActiveChange: vi.fn() },
  );

  const bus = new EventBus(
    { windowMs: 60_000, autoMuteAfter: 10 },
    { onAccepted: (e: Event) => attentionManager.push(e), onOutcome: () => {} },
  );

  const adapter = new ClaudeAdapter(
    {
      staleSessionTimeoutMs: 1_800_000,
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

function prompt(adapter: ClaudeAdapter, sessionId: string, text = 'hace la tarea') {
  adapter.handleHookEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    cwd: `/tmp/${sessionId}`,
    prompt: text,
  });
}

function stop(adapter: ClaudeAdapter, sessionId: string, message = 'listo') {
  adapter.handleHookEvent({
    hook_event_name: 'Stop',
    session_id: sessionId,
    cwd: `/tmp/${sessionId}`,
    last_assistant_message: message,
  });
}

describe('D-06: a response retires its own prompt', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await ctx.adapter.start(ctx.bus);
  });

  afterEach(async () => {
    await ctx.adapter.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('the response becomes active immediately — no waiting for the prompt TTL', () => {
    prompt(ctx.adapter, 's1');
    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('prompt');

    stop(ctx.adapter, 's1');

    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.category).toBe('response');
    expect(snap.active?.event.payload.text).toBe('listo');
  });

  it('the retired prompt is gone from the queue, not merely displaced', () => {
    prompt(ctx.adapter, 's1');
    stop(ctx.adapter, 's1');

    const snap = ctx.attentionManager.snapshot();
    const inFlight = [...(snap.active ? [snap.active.event] : []), ...snap.queue.map((a) => a.event)];
    expect(inFlight.filter((e) => e.category === 'prompt')).toEqual([]);
  });

  it('a second prompt retires the first — stale prompts do not pile up', () => {
    prompt(ctx.adapter, 's1', 'primera');
    prompt(ctx.adapter, 's1', 'segunda');

    const snap = ctx.attentionManager.snapshot();
    const prompts = [...(snap.active ? [snap.active.event] : []), ...snap.queue.map((a) => a.event)].filter(
      (e) => e.category === 'prompt',
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.payload.text).toBe('segunda');
  });

  it("a response only retires its OWN session's prompt", () => {
    prompt(ctx.adapter, 'A', 'de A');
    prompt(ctx.adapter, 'B', 'de B');
    stop(ctx.adapter, 'A');

    const snap = ctx.attentionManager.snapshot();
    const inFlight = [...(snap.active ? [snap.active.event] : []), ...snap.queue.map((a) => a.event)];
    const prompts = inFlight.filter((e) => e.category === 'prompt');
    // B's prompt survives; A's is gone.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.payload.sessionId).toBe('B');
  });

  it('a Stop with no prior prompt (bridge restarted mid-session) is a no-op', () => {
    // The adapter never saw the UserPromptSubmit, so there is no id to resolve.
    expect(() => stop(ctx.adapter, 's1')).not.toThrow();
    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.category).toBe('response');
  });

  it('a Stop resolves BOTH the pending permission and the prompt', () => {
    prompt(ctx.adapter, 's1');
    ctx.adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/s1',
      command: 'sudo rm -rf /',
    });
    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('permission_critical');

    stop(ctx.adapter, 's1');

    const snap = ctx.attentionManager.snapshot();
    const inFlight = [...(snap.active ? [snap.active.event] : []), ...snap.queue.map((a) => a.event)];
    // Neither the permission nor the prompt survives; both were retired by
    // distinct events, each naming its own target.
    expect(inFlight.filter((e) => e.category === 'permission_critical')).toEqual([]);
    expect(inFlight.filter((e) => e.category === 'prompt')).toEqual([]);
  });

  it('a second response retires the first — the latest answer wins immediately', () => {
    prompt(ctx.adapter, 's1');
    stop(ctx.adapter, 's1', 'primera respuesta');
    const firstResponse = ctx.attentionManager.snapshot().active?.event.id;

    // Another turn with no intervening prompt is rare, but the NORMAL case of
    // prompt -> response -> prompt -> response has the same pathology: the new
    // response would queue behind the old one for the full ambient TTL while
    // the robot keeps showing the previous answer. Retiring the previous
    // response (same resolvesEventId mechanism as D-06) fixes both.
    stop(ctx.adapter, 's1', 'segunda respuesta');

    const snap = ctx.attentionManager.snapshot();
    const inFlight = [...(snap.active ? [snap.active.event] : []), ...snap.queue.map((a) => a.event)];
    expect(inFlight.map((e) => e.id)).not.toContain(firstResponse);
    expect(snap.active?.event.payload.text).toBe('segunda respuesta');
  });

  it('the prompt id is forgotten after use — a stale prompt id is not re-resolved', () => {
    prompt(ctx.adapter, 's1');
    stop(ctx.adapter, 's1', 'primera respuesta');
    const firstResponse = ctx.attentionManager.snapshot().active?.event.id;

    // A second Stop no longer carries the prompt id, so it cannot accidentally
    // retire the first response via that stale id. It retires the previous
    // response explicitly via lastResponseEventId, keeping the chain safe.
    stop(ctx.adapter, 's1', 'segunda respuesta');

    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.payload.text).toBe('segunda respuesta');
    // The stale id is a no-op: it is not found (already resolved) and the AM
    // does not throw or get confused.
    expect(() => stop(ctx.adapter, 's1', 'tercera respuesta')).not.toThrow();
    expect(ctx.attentionManager.snapshot().active?.event.payload.text).toBe('tercera respuesta');
  });
});
