import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeAdapterDeps,
} from '../src/adapters/claude-adapter.js';
import type { EventBus } from '../src/core/bus.js';
import type { Metrics } from '../src/server/metrics.js';

vi.mock('../src/adapters/claude-transcript.js', () => ({
  readTranscriptTail: vi.fn().mockReturnValue(null),
}));

import { readTranscriptTail } from '../src/adapters/claude-transcript.js';
const mockReadTranscript = vi.mocked(readTranscriptTail);

function makeConfig(overrides?: Partial<ClaudeAdapterConfig>): ClaudeAdapterConfig {
  return {
    staleSessionTimeoutMs: 1_800_000,
    transcriptReadEnabled: true,
    unknownLineThreshold: 5,
    unknownLineBrokenThreshold: 20,
    ...overrides,
  };
}

function makeDeps(stateDir: string, criticalCommands: string[] = []): ClaudeAdapterDeps {
  return {
    logger: { warn: vi.fn(), info: vi.fn() },
    metrics: {
      counter: () => ({ inc: vi.fn() }),
      gauge: () => ({ set: vi.fn() }),
    } as unknown as Metrics,
    criticalCommands,
    stateDir,
  };
}

function makeBus() {
  return {
    publish: vi.fn().mockReturnValue({ kind: 'accepted', event: {} }),
  } as unknown as EventBus;
}

describe('ClaudeAdapter', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-adapter-test-'));
    stateDir = join(dir, 'claude-state');
    mkdirSync(stateDir, { recursive: true });
    mockReadTranscript.mockReturnValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('UserPromptSubmit creates session and emits event', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/tmp/p',
    });

    const sessions = adapter.sessions();
    expect(sessions.get('s1')?.state).toBe('working');
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'claude', category: 'prompt', severity: 'ambient' }),
    );
    await adapter.stop();
  });

  it('Stop changes session to idle', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/tmp/p',
    });
    adapter.handleHookEvent({ hook_event_name: 'Stop', session_id: 's1' });

    expect(adapter.sessions().get('s1')?.state).toBe('idle');
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'claude', category: 'response', severity: 'ambient' }),
    );
    await adapter.stop();
  });

  it('Notification permission → critical event + permission_pending', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/tmp/p',
    });
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
    });

    expect(adapter.sessions().get('s1')?.state).toBe('permission_pending');
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'claude', category: 'permission', severity: 'critical' }),
    );
    await adapter.stop();
  });

  it('detects critical command', async () => {
    const bus = makeBus();
    mockReadTranscript.mockReturnValue({ command: 'rm -rf /tmp', unknownLineRatio: 0 });
    const deps = makeDeps(stateDir, ['rm']);
    const adapter = new ClaudeAdapter(makeConfig(), deps);
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      transcript_path: '/fake/path',
    });

    const session = adapter.sessions().get('s1');
    expect(session?.pendingPermission?.isCritical).toBe(true);
    await adapter.stop();
  });

  it('detects non-critical command', async () => {
    const bus = makeBus();
    mockReadTranscript.mockReturnValue({ command: 'ls', unknownLineRatio: 0 });
    const deps = makeDeps(stateDir, ['rm']);
    const adapter = new ClaudeAdapter(makeConfig(), deps);
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      transcript_path: '/fake/path',
    });

    const session = adapter.sessions().get('s1');
    expect(session?.pendingPermission?.isCritical).toBe(false);
    await adapter.stop();
  });

  it('tracks multiple sessions independently', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a' });
    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: '/b' });
    adapter.handleHookEvent({ hook_event_name: 'Stop', session_id: 's1' });

    expect(adapter.sessions().get('s1')?.state).toBe('idle');
    expect(adapter.sessions().get('s2')?.state).toBe('working');
    expect(adapter.sessions().size).toBe(2);
    await adapter.stop();
  });

  it('marks stale sessions after timeout', async () => {
    vi.useFakeTimers();
    const bus = makeBus();
    const adapter = new ClaudeAdapter(
      makeConfig({ staleSessionTimeoutMs: 10_000 }),
      makeDeps(stateDir),
    );
    await adapter.start(bus);

    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp' });
    expect(adapter.sessions().get('s1')?.state).toBe('working');

    vi.advanceTimersByTime(70_000);

    expect(adapter.sessions().get('s1')?.state).toBe('stale');
    await adapter.stop();
  });

  it('health returns HEALTHY after receiving events', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp' });

    expect(adapter.health().status).toBe('HEALTHY');
    await adapter.stop();
  });

  it('health returns DEGRADED when no events for >5 min', async () => {
    vi.useFakeTimers();
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp' });
    vi.advanceTimersByTime(360_000);

    expect(adapter.health().status).toBe('DEGRADED');
    await adapter.stop();
  });

  it('health returns BROKEN when unknownLineRatio exceeds broken threshold', async () => {
    const bus = makeBus();
    mockReadTranscript.mockReturnValue({ unknownLineRatio: 0.25 });
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Stop',
      session_id: 's1',
      transcript_path: '/fake/path',
    });

    expect(adapter.health().status).toBe('BROKEN');
    await adapter.stop();
  });

  it('resolvePermission approve → working', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp',
    });
    expect(adapter.sessions().get('s1')?.state).toBe('permission_pending');

    const eventId = adapter.resolvePermission('s1', 'approved');
    expect(eventId).toBeTypeOf('string');
    expect(adapter.sessions().get('s1')?.state).toBe('working');
    expect(adapter.sessions().get('s1')?.pendingPermission).toBeUndefined();
    await adapter.stop();
  });

  it('resolvePermission deny → idle', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp',
    });

    const eventId = adapter.resolvePermission('s1', 'denied');
    expect(eventId).toBeTypeOf('string');
    expect(adapter.sessions().get('s1')?.state).toBe('idle');
    await adapter.stop();
  });

  it('fallback state files resync on start', async () => {
    const bus = makeBus();
    writeFileSync(
      join(stateDir, 'test-session.json'),
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'fallback-s1',
        cwd: '/tmp/fb',
      }),
    );

    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    expect(adapter.sessions().get('fallback-s1')?.state).toBe('working');
    expect(existsSync(join(stateDir, 'test-session.json'))).toBe(false);
    await adapter.stop();
  });

  it('invalid hook payload warns and does not emit', async () => {
    const bus = makeBus();
    const deps = makeDeps(stateDir);
    const adapter = new ClaudeAdapter(makeConfig(), deps);
    await adapter.start(bus);

    adapter.handleHookEvent({ something: 'wrong' });

    expect(bus.publish).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
    await adapter.stop();
  });

  it('SessionEnd removes the session', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp' });
    expect(adapter.sessions().has('s1')).toBe(true);

    adapter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1' });
    expect(adapter.sessions().has('s1')).toBe(false);
    await adapter.stop();
  });

  it('handleHookEvent is not idempotent — bus handles dedup', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp' });
    adapter.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp' });

    expect(bus.publish).toHaveBeenCalledTimes(2);
    await adapter.stop();
  });
});
