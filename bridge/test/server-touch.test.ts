import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAdapter } from '../src/adapters/claude-adapter.js';
import { AttentionManager } from '../src/core/attention.js';
import { EventBus } from '../src/core/bus.js';
import type { Event } from '../src/core/events.js';
import { StateMachine } from '../src/core/state-machine.js';
import type { Platform } from '../src/platform/platform.js';
import { EventRecorder } from '../src/recorder/recorder.js';
import { Metrics } from '../src/server/metrics.js';
import { BridgeServer } from '../src/server/server.js';

/**
 * Harness copied from server-dashboard.test.ts / integration-fase2.test.ts:
 * a real EventBus (onAccepted records published events), a real
 * AttentionManager/StateMachine (no rules needed for these tests), and a
 * minimal ClaudeAdapter stub for the pending-permission tests.
 */

function makePlatform(): Platform {
  return {
    getSecret: vi.fn().mockResolvedValue('stored-secret-token'),
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

function makeClaudeAdapterWithPendingPermission(isCritical = false) {
  const sessions = new Map<string, Record<string, unknown>>([
    [
      's1',
      {
        sessionId: 's1',
        cwd: '/tmp/p',
        state: 'permission_pending',
        lastEventAt: Date.now(),
        pendingPermission: { eventId: 'e1', isCritical },
      },
    ],
  ]);
  return {
    sessions: vi.fn(() => sessions),
    resolvePermission: vi.fn(() => null),
    onSessionChangeCallback: null,
    health: () => ({ status: 'HEALTHY' }),
    name: 'claude',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as ClaudeAdapter;
}

describe('BridgeServer touch gestures', () => {
  let dir: string;
  let recorder: EventRecorder;
  let bus: EventBus;
  let published: Event[];
  let server: BridgeServer;

  function makeServer(claudeAdapter?: ClaudeAdapter): BridgeServer {
    dir = mkdtempSync(join(tmpdir(), 'bridge-touch-test-'));
    recorder = new EventRecorder({ dir, retentionDays: 30 });
    published = [];
    bus = new EventBus(
      { windowMs: 60_000, autoMuteAfter: 10 },
      { onAccepted: (e) => published.push(e) },
    );

    server = new BridgeServer({
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      requireToken: false,
      simulate: true,
      logger: { warn: () => {}, error: () => {}, info: () => {} } as never,
      metrics: new Metrics(),
      platform: makePlatform(),
      bus,
      recorder,
      attentionManager: makeAm(),
      stateMachine: makeStateMachine(),
      claudeAdapter,
      getHealth: () => ({
        adapters: {},
        transport: { kind: 'sim', connected: true, reconnects: 0, latency: { p50: 0, p95: 0 } },
      }),
    });
    return server;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a pet gesture publishes a head_pet event, not touch_head', () => {
    const server = makeServer();
    server.handleDeviceInput('touch', { gesture: 'pet' });
    const evt = published.find((e) => e.category === 'head_pet');
    expect(evt).toBeDefined();
    expect(evt?.source).toBe('firmware');
    expect(evt?.payload).toEqual({ gesture: 'pet' });
    expect(published.some((e) => e.category === 'touch_head')).toBe(false);
  });

  it('a pet gesture never approves a pending permission', () => {
    const claudeAdapter = makeClaudeAdapterWithPendingPermission();
    const server = makeServer(claudeAdapter);
    server.handleDeviceInput('touch', { gesture: 'pet' });
    expect(claudeAdapter.resolvePermission).not.toHaveBeenCalled();
  });

  it('a single head tap approves a non-critical pending permission', () => {
    const claudeAdapter = makeClaudeAdapterWithPendingPermission(false);
    claudeAdapter.resolvePermission = vi.fn(() => 'e1');
    const server = makeServer(claudeAdapter);
    server.handleDeviceInput('touch', { gesture: 'tap' });
    expect(claudeAdapter.resolvePermission).toHaveBeenCalledWith('s1', 'approved');
  });

  it('a single head tap on a critical permission only arms the double-tap guard', () => {
    const claudeAdapter = makeClaudeAdapterWithPendingPermission(true);
    claudeAdapter.resolvePermission = vi.fn(() => 'e1');
    const server = makeServer(claudeAdapter);
    server.handleDeviceInput('touch', { gesture: 'tap' });
    expect(claudeAdapter.resolvePermission).not.toHaveBeenCalled();
  });

  it('two head taps within the window approve a critical permission', () => {
    const claudeAdapter = makeClaudeAdapterWithPendingPermission(true);
    claudeAdapter.resolvePermission = vi.fn(() => 'e1');
    const server = makeServer(claudeAdapter);
    server.handleDeviceInput('touch', { gesture: 'tap' });
    server.handleDeviceInput('touch', { gesture: 'tap' });
    expect(claudeAdapter.resolvePermission).toHaveBeenCalledTimes(1);
    expect(claudeAdapter.resolvePermission).toHaveBeenCalledWith('s1', 'approved');
  });

  it('two slow head taps do not approve a critical permission', () => {
    const claudeAdapter = makeClaudeAdapterWithPendingPermission(true);
    claudeAdapter.resolvePermission = vi.fn(() => 'e1');
    const server = makeServer(claudeAdapter);
    server.handleDeviceInput('touch', { gesture: 'tap' });
    vi.advanceTimersByTime(1_000); // past the 700ms window
    server.handleDeviceInput('touch', { gesture: 'tap' });
    expect(claudeAdapter.resolvePermission).not.toHaveBeenCalled();
  });
});
