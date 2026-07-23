import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAdapter } from '../src/adapters/claude-adapter.js';
import { AttentionManager } from '../src/core/attention.js';
import { EventBus } from '../src/core/bus.js';
import { StateMachine } from '../src/core/state-machine.js';
import type { Platform } from '../src/platform/platform.js';
import { EventRecorder } from '../src/recorder/recorder.js';
import { Metrics } from '../src/server/metrics.js';
import { BridgeServer } from '../src/server/server.js';
import { makePlatform } from './helpers/factories.js';

const STORED_TOKEN = 'stored-secret-token';
const PUBLIC_DIR = join(import.meta.dirname, '..', 'src', 'server', 'public');

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

function makeClaudeAdapter() {
  const sessions = new Map<string, Record<string, unknown>>();
  return {
    handleHookEvent: vi.fn((payload: Record<string, unknown>) => {
      const sid = payload.session_id;
      if (
        payload.hook_event_name === 'Notification' &&
        payload.notification_type === 'permission_prompt'
      ) {
        sessions.set(sid as string, {
          sessionId: sid,
          cwd: payload.cwd ?? '',
          state: 'permission_pending',
          lastEventAt: Date.now(),
          pendingPermission: { eventId: 'e1', isCritical: false },
        });
      } else if (payload.hook_event_name === 'UserPromptSubmit') {
        sessions.set(sid as string, {
          sessionId: sid,
          cwd: payload.cwd ?? '',
          state: 'working',
          lastEventAt: Date.now(),
        });
      }
    }),
    sessions: vi.fn(() => sessions),
    resolvePermission: vi.fn((sessionId: string, action: 'approved' | 'denied') => {
      const s = sessions.get(sessionId);
      const pending = s?.pendingPermission as { eventId: string } | undefined;
      if (s && pending) {
        const eventId = pending.eventId;
        s.pendingPermission = undefined;
        s.state = action === 'approved' ? 'working' : 'idle';
        return eventId;
      }
      return null;
    }),
    onSessionChangeCallback: null,
    health: () => ({ status: 'HEALTHY' }),
    name: 'claude',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as ClaudeAdapter;
}

describe('BridgeServer dashboard (M8)', () => {
  let dir: string;
  let recorder: EventRecorder;
  let bus: EventBus;
  let metrics: Metrics;
  let platform: Platform;
  let server: BridgeServer;
  let baseUrl: string;
  let claudeAdapter: ReturnType<typeof makeClaudeAdapter>;

  async function startDashboard(
    opts: { withClaudeAdapter?: boolean; rateLimitPerMinute?: number } = {},
  ) {
    dir = mkdtempSync(join(tmpdir(), 'bridge-dashboard-test-'));
    recorder = new EventRecorder({ dir, retentionDays: 30 });
    bus = new EventBus({ windowMs: 60_000, autoMuteAfter: 10 }, { onAccepted: () => {} });
    metrics = new Metrics();
    platform = makePlatform({
      getSecret: vi.fn().mockResolvedValue(STORED_TOKEN),
      dataDir: () => '/tmp/buildagotchi-test',
    });
    claudeAdapter = makeClaudeAdapter();

    server = new BridgeServer({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: opts.rateLimitPerMinute ?? 60,
      requireToken: true,
      simulate: true,
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
      publicDir: PUBLIC_DIR,
      // exactOptionalPropertyTypes: an absent key, not an explicit `undefined`.
      ...(opts.withClaudeAdapter === false ? {} : { claudeAdapter }),
    });
    await server.start();
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr?.port}`;
  }

  afterEach(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET / returns index.html', async () => {
    await startDashboard();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('<title>');
  });

  it('GET /dashboard.css returns css', async () => {
    await startDashboard();
    const res = await fetch(`${baseUrl}/dashboard.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('GET /dashboard.js returns javascript', async () => {
    await startDashboard();
    const res = await fetch(`${baseUrl}/dashboard.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });

  it('GET /nonexistent.txt returns 404', async () => {
    await startDashboard();
    const res = await fetch(`${baseUrl}/nonexistent.txt`);
    expect(res.status).toBe(404);
  });

  it('POST /hooks/claude with valid payload returns 202', async () => {
    await startDashboard();
    const res = await fetch(`${baseUrl}/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp' }),
    });
    expect(res.status).toBe(202);
    expect(claudeAdapter.handleHookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }),
    );
  });

  it('POST /hooks/claude with missing session_id returns 400', async () => {
    await startDashboard();
    const res = await fetch(`${baseUrl}/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /hooks/claude rate limits after 120 requests', async () => {
    await startDashboard();
    const make = () =>
      fetch(`${baseUrl}/hooks/claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }),
      });
    let last: Response | undefined;
    for (let i = 0; i < 121; i++) {
      last = await make();
    }
    expect(last?.status).toBe(429);
  });

  it('POST /approve/:id resolves pending permission', async () => {
    await startDashboard();
    await fetch(`${baseUrl}/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        session_id: 's1',
        cwd: '/tmp',
      }),
    });
    const res = await fetch(`${baseUrl}/approve/s1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });
  });

  it('POST /approve/:id with no pending permission returns 404', async () => {
    await startDashboard();
    const res = await fetch(`${baseUrl}/approve/unknown-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /hooks/claude triggers handleHookEvent on adapter', async () => {
    await startDashboard();
    await fetch(`${baseUrl}/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: '/tmp' }),
    });
    expect(claudeAdapter.handleHookEvent).toHaveBeenCalledTimes(1);
  });
});
