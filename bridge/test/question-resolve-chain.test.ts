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
 * Same seam as permission-resolve-chain.test.ts: hook → adapter → bus → AM.
 * Verifies that a visible AskUserQuestion reaches the AM and that answering it
 * in the terminal (PostToolUse) retires the balloon.
 */

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'question-resolve-chain-'));
  const stateDir = join(dir, 'claude-state');
  mkdirSync(stateDir, { recursive: true });
  const metrics = makeStubMetrics();

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
    {
      record: vi.fn(),
      metrics: { gauge: () => ({ set: vi.fn() }) },
      onActiveChange: vi.fn(),
    },
  );

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
      scanIntervalMs: 0,
    },
    {
      logger: { warn: vi.fn(), info: vi.fn() },
      metrics,
      criticalCommands: [],
      stateDir,
      projectsDir: join(dir, 'no-projects'),
      claudeDesktopSessionsDir: '',
    },
  );

  return { adapter, bus, attentionManager, dir };
}

describe('question resolve chain — hook → adapter → bus → AM', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(async () => {
    await ctx.adapter.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('AskUserQuestion becomes the AM active event as a medium-severity question', async () => {
    await ctx.adapter.start(ctx.bus);
    ctx.adapter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/tmp/p',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            header: 'Model selection',
            question: 'Which model do you want?',
            options: [{ label: 'Claude 3.5 Sonnet' }, { label: 'Claude 3 Opus' }],
          },
        ],
      },
    });

    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('question');
    expect(ctx.attentionManager.snapshot().active?.event.severity).toBe('medium');
  });

  it('PostToolUse AskUserQuestion releases the AM active event', async () => {
    await ctx.adapter.start(ctx.bus);
    ctx.adapter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/tmp/p',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            header: 'Model selection',
            question: 'Which model do you want?',
            options: [{ label: 'Claude 3.5 Sonnet' }, { label: 'Claude 3 Opus' }],
          },
        ],
      },
    });
    expect(ctx.attentionManager.snapshot().active?.event.category).toBe('question');

    ctx.adapter.handleHookEvent({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'AskUserQuestion',
      tool_response: { answers: ['Claude 3.5 Sonnet'] },
    });

    const snap = ctx.attentionManager.snapshot();
    expect(snap.active?.event.category).not.toBe('question');
    expect(snap.queue.map((a) => a.event.category)).not.toContain('question');
  });
});
