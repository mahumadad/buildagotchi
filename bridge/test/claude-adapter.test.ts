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

vi.mock('../src/adapters/claude-jsonl-scanner.js', () => ({
  scanClaudeSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/adapters/claude-desktop-titles.js', () => ({
  readDesktopSessionTitles: vi.fn().mockResolvedValue(new Map()),
  defaultClaudeDesktopSessionsDir: vi.fn().mockReturnValue(''),
}));

import { readDesktopSessionTitles } from '../src/adapters/claude-desktop-titles.js';
import { scanClaudeSessions } from '../src/adapters/claude-jsonl-scanner.js';
import { readTranscriptTail } from '../src/adapters/claude-transcript.js';
const mockReadTranscript = vi.mocked(readTranscriptTail);
const mockScan = vi.mocked(scanClaudeSessions);
const mockDesktopTitles = vi.mocked(readDesktopSessionTitles);

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
    mockScan.mockResolvedValue([]);
    mockDesktopTitles.mockResolvedValue(new Map());
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

  it('enriches a permission with the preceding PreToolUse (Bash)', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'S',
      cwd: '/proj',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'S',
      notification_type: 'permission_prompt',
    });

    const call = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e.category === 'permission' || e.category === 'permission_critical');
    expect(call?.payload.tool).toBe('Bash: git push origin main');
    expect(call?.payload.command).toBe('git push origin main');
    await adapter.stop();
  });

  it('does not retain the raw tool_input on the session (it is serialized to the dashboard)', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'S',
      cwd: '/proj',
      tool_name: 'Write',
      tool_input: { file_path: '/proj/.env', content: 'SECRET_KEY=hunter2' },
    });

    const stored = JSON.stringify(adapter.sessions().get('S'));
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('SECRET_KEY');
    expect(adapter.sessions().get('S')?.lastToolUse?.summary).toBe('Write: .env');
    await adapter.stop();
  });

  it('criticality is judged on the enriched command', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir, ['git push']));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'S',
      cwd: '/proj',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force' },
    });
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'S',
      notification_type: 'permission_prompt',
    });

    const call = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e.category === 'permission_critical');
    expect(call).toBeDefined();
    await adapter.stop();
  });

  it('permission without a preceding PreToolUse behaves as before (no tool field)', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'S',
      notification_type: 'permission_prompt',
      command: 'legacy command',
    });

    const call = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((e) => e.category === 'permission');
    expect(call?.payload.command).toBe('legacy command');
    expect(call?.payload.tool).toBeUndefined();
    await adapter.stop();
  });

  // M13 tests 1-3: category split (S2.5.8). Not just isCritical on the session
  // payload — the bus receives a different `category` so `stateRules` can map
  // each to a distinct expression without special-casing the state machine.
  it('M13-1: critical command emits category=permission_critical', async () => {
    const bus = makeBus();
    mockReadTranscript.mockReturnValue({ command: 'rm -rf /', unknownLineRatio: 0 });
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir, ['rm']));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      transcript_path: '/fake/path',
    });

    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'claude',
        category: 'permission_critical',
        severity: 'critical',
        payload: expect.objectContaining({ isCritical: true }),
      }),
    );
    await adapter.stop();
  });

  it('M13-2: benign command emits category=permission (not permission_critical)', async () => {
    const bus = makeBus();
    mockReadTranscript.mockReturnValue({ command: 'ls', unknownLineRatio: 0 });
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir, ['rm']));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      transcript_path: '/fake/path',
    });

    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'claude',
        category: 'permission',
        severity: 'critical',
        payload: expect.objectContaining({ isCritical: false }),
      }),
    );
    // And NOT the critical category.
    expect(bus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ category: 'permission_critical' }),
    );
    await adapter.stop();
  });

  it('M13-3: payload.isCritical is present in BOTH branches', async () => {
    // Dashboard's `⚠` marker still reads payload.isCritical (dashboard.js:253).
    // If we ever drop it, this test flags it.
    const bus = makeBus();
    mockReadTranscript.mockReturnValue({ command: 'sudo apt', unknownLineRatio: 0 });
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir, ['sudo']));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's-crit',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      transcript_path: '/fake/path',
    });
    mockReadTranscript.mockReturnValue({ command: 'echo hi', unknownLineRatio: 0 });
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's-benign',
      notification_type: 'permission_prompt',
      cwd: '/tmp/p',
      transcript_path: '/fake/path',
    });

    const critCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([e]) => (e as { payload: { sessionId: string } }).payload.sessionId === 's-crit',
    );
    const benignCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([e]) => (e as { payload: { sessionId: string } }).payload.sessionId === 's-benign',
    );
    expect(critCalls[0]?.[0]).toMatchObject({
      category: 'permission_critical',
      payload: { isCritical: true },
    });
    expect(benignCalls[0]?.[0]).toMatchObject({
      category: 'permission',
      payload: { isCritical: false },
    });
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

  it('PostToolUse resolves pendingPermission as approved', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp',
      command: 'ls',
    });
    expect(adapter.sessions().get('s1')?.pendingPermission).toBeDefined();

    adapter.handleHookEvent({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/tmp' });

    expect(adapter.sessions().get('s1')?.pendingPermission).toBeUndefined();
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'claude',
        category: 'permission_resolved',
        payload: expect.objectContaining({ action: 'approved' }),
      }),
    );
    await adapter.stop();
  });

  it('UserPromptSubmit after Notification resolves pendingPermission as external', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp',
      command: 'ls',
    });
    adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/tmp',
      prompt: 'nevermind',
    });

    const session = adapter.sessions().get('s1');
    expect(session?.pendingPermission).toBeUndefined();
    expect(session?.state).toBe('working');
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'permission_resolved',
        payload: expect.objectContaining({ action: 'external' }),
      }),
    );
    await adapter.stop();
  });

  it('Stop after Notification also clears pendingPermission', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      cwd: '/tmp',
      command: 'ls',
    });
    adapter.handleHookEvent({ hook_event_name: 'Stop', session_id: 's1' });

    const session = adapter.sessions().get('s1');
    expect(session?.pendingPermission).toBeUndefined();
    expect(session?.state).toBe('idle');
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

  it('scan populates title/lastPrompt/lastResponse for newly discovered sessions', async () => {
    const bus = makeBus();
    mockScan.mockResolvedValue([
      {
        sessionId: 'scan-1',
        cwd: '/some/proj',
        filePath: '/fake/scan-1.jsonl',
        mtimeMs: Date.now(),
        title: 'Discovered title',
        lastPrompt: 'Latest human message',
        lastResponse: 'Latest assistant answer',
      },
    ]);

    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    const changed = new Promise<void>((resolve) => {
      adapter.onSessionChangeCallback = () => resolve();
    });
    await adapter.start(bus);
    await changed;

    const session = adapter.sessions().get('scan-1');
    expect(session?.title).toBe('Discovered title');
    expect(session?.lastPrompt).toBe('Latest human message');
    expect(session?.lastResponse).toBe('Latest assistant answer');
    await adapter.stop();
  });

  it('applies desktopTitle to a newly discovered session', async () => {
    const bus = makeBus();
    mockScan.mockResolvedValue([
      {
        sessionId: 'scan-1',
        cwd: '/p',
        filePath: '/fake/scan-1.jsonl',
        mtimeMs: Date.now(),
      },
    ]);
    mockDesktopTitles.mockResolvedValue(new Map([['scan-1', 'BUILDATGOCHI']]));

    const adapter = new ClaudeAdapter(makeConfig(), {
      ...makeDeps(stateDir),
      claudeDesktopSessionsDir: '/fake/desktop',
    });
    const changed = new Promise<void>((resolve) => {
      adapter.onSessionChangeCallback = () => resolve();
    });
    await adapter.start(bus);
    await changed;

    expect(adapter.sessions().get('scan-1')?.desktopTitle).toBe('BUILDATGOCHI');
    await adapter.stop();
  });

  it('applies desktopTitle to a session already known from hooks (never overwrites)', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), {
      ...makeDeps(stateDir),
      claudeDesktopSessionsDir: '/fake/desktop',
    });
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-1',
      cwd: '/tmp',
      prompt: 'Hi',
    });
    expect(adapter.sessions().get('hook-1')?.desktopTitle).toBeUndefined();

    // Next scan supplies a desktop title for that session.
    mockDesktopTitles.mockResolvedValue(new Map([['hook-1', 'MY CHAT']]));
    await adapter.stop();
    await adapter.start(bus);
    await new Promise((r) => setImmediate(r));

    expect(adapter.sessions().get('hook-1')?.desktopTitle).toBe('MY CHAT');
    await adapter.stop();
  });

  it('scan does not overwrite hook-derived title/lastPrompt/lastResponse', async () => {
    const bus = makeBus();
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    await adapter.start(bus);

    adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'hook-1',
      cwd: '/tmp',
      prompt: 'Hook prompt from human',
    });
    adapter.handleHookEvent({
      hook_event_name: 'Stop',
      session_id: 'hook-1',
      last_assistant_message: 'Hook response',
    });

    const before = adapter.sessions().get('hook-1');
    expect(before?.title).toBe('Hook prompt from human');
    expect(before?.lastPrompt).toBe('Hook prompt from human');
    expect(before?.lastResponse).toBe('Hook response');

    // A subsequent scan returns different values for the same session; they
    // must not overwrite the hook-derived ones (hooks are the source of truth).
    mockScan.mockResolvedValue([
      {
        sessionId: 'hook-1',
        cwd: '/tmp',
        filePath: '/fake/hook-1.jsonl',
        mtimeMs: Date.now() + 1000,
        title: 'Scan title (should be ignored)',
        lastPrompt: 'Scan prompt (should be ignored)',
        lastResponse: 'Scan response (should be ignored)',
      },
    ]);
    // Trigger a scan by restarting: start() runs one scan pass at boot.
    await adapter.stop();
    await adapter.start(bus);
    // Give the void this.#runScan() microtask a chance to complete.
    await new Promise((r) => setImmediate(r));

    const after = adapter.sessions().get('hook-1');
    expect(after?.title).toBe('Hook prompt from human');
    expect(after?.lastPrompt).toBe('Hook prompt from human');
    expect(after?.lastResponse).toBe('Hook response');
    await adapter.stop();
  });
});

describe('ClaudeAdapter.sessionCounts', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sc-counts-'));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('counts running, waiting, and total, excluding stale', () => {
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    adapter.start(makeBus());

    // working
    adapter.handleHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'a',
      cwd: '/x',
      prompt: 'hi',
    });
    // waiting on a permission (the real contract: notification_type)
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'b',
      cwd: '/y',
      notification_type: 'permission_prompt',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    const counts = adapter.sessionCounts();
    expect(counts.total).toBe(2);
    expect(counts.running).toBe(1);
    expect(counts.waiting).toBe(1);
  });

  it('is all zeros with no sessions', () => {
    const adapter = new ClaudeAdapter(makeConfig(), makeDeps(stateDir));
    adapter.start(makeBus());
    expect(adapter.sessionCounts()).toEqual({ total: 0, running: 0, waiting: 0 });
  });
});
