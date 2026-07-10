import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AmConfig, AttentionManager } from '../src/core/attention.js';
import { newEvent } from '../src/core/events.js';

function baseConfig(overrides: Partial<AmConfig> = {}): AmConfig {
  return {
    ttlBySeverity: {
      critical: 30_000,
      high: 120_000,
      medium: 300_000,
      low: 600_000,
      ambient: 30_000,
    },
    ttlOverrides: [{ source: 'claude', category: 'permission', ttl: null }],
    maxQueueSize: 20,
    replacementPolicy: 'higher_severity_interrupts',
    transitionToBackgroundMoodDelay: 2_000,
    onModeChange: { toFOCUS: 'drop_below_high', toSLEEP: 'drop_below_critical' },
    ...overrides,
  };
}

function deps() {
  return {
    record: vi.fn(),
    metrics: { gauge: () => ({ set: () => {} }) },
    onActiveChange: vi.fn(),
  };
}

function ev(overrides: Partial<Parameters<typeof newEvent>[0]> & { timestamp?: number } = {}) {
  const { timestamp, ...rest } = overrides;
  const event = newEvent({
    source: 'src',
    category: 'cat',
    severity: 'medium',
    payload: {},
    ...rest,
  });
  return timestamp !== undefined ? { ...event, timestamp } : event;
}

describe('AttentionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires by TTL per severity and promotes the next queued event', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);

    const active = ev({ severity: 'medium' });
    const queued = ev({ severity: 'low' });
    am.push(active);
    am.push(queued);

    vi.advanceTimersByTime(300_000);
    am.tick();

    expect(d.record).toHaveBeenCalledWith('am_decision', { action: 'expired', eventId: active.id });
    expect(am.snapshot().active?.event.id).toBe(queued.id);
  });

  it('an override with ttl: infinite never expires by time; resolve clears it', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const permission = ev({ source: 'claude', category: 'permission', severity: 'critical' });
    am.push(permission);

    vi.advanceTimersByTime(10_000_000);
    am.tick();
    expect(am.snapshot().active?.event.id).toBe(permission.id);

    am.resolve(permission.id, 'approved', 'head');
    expect(am.snapshot().active).toBeNull();
  });

  it('event.ttlMs wins over both override and table', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const permission = ev({
      source: 'claude',
      category: 'permission',
      severity: 'critical',
      ttlMs: 1_000,
    });
    am.push(permission);

    vi.advanceTimersByTime(1_000);
    am.tick();

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'expired',
      eventId: permission.id,
    });
    expect(am.snapshot().active).toBeNull();
  });

  it('a higher-severity event interrupts the active one, which resumes after resolution', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const medium = ev({ severity: 'medium' });
    const critical = ev({ severity: 'critical' });

    am.push(medium);
    am.push(critical);

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'interrupted',
      interrupted: medium.id,
      eventId: critical.id,
    });
    expect(am.snapshot().active?.event.id).toBe(critical.id);
    expect(am.snapshot().queue.map((e) => e.id)).toEqual([medium.id]);

    am.resolve(critical.id, 'approved', 'head');
    expect(am.snapshot().active?.event.id).toBe(medium.id);
  });

  it('an event of the same severity enqueues instead of interrupting', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const first = ev({ severity: 'medium' });
    const second = ev({ severity: 'medium' });

    am.push(first);
    am.push(second);

    expect(am.snapshot().active?.event.id).toBe(first.id);
    expect(am.snapshot().queue.map((e) => e.id)).toEqual([second.id]);
  });

  it('always_enqueue policy never interrupts', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig({ replacementPolicy: 'always_enqueue' }), d);
    const medium = ev({ severity: 'medium' });
    const critical = ev({ severity: 'critical' });

    am.push(medium);
    am.push(critical);

    expect(am.snapshot().active?.event.id).toBe(medium.id);
    expect(am.snapshot().queue.map((e) => e.id)).toEqual([critical.id]);
  });

  it('a full queue drops the lowest-severity, oldest entry among queue + incoming', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig({ maxQueueSize: 2 }), d);
    const activeAnchor = ev({ severity: 'critical', timestamp: 0 });
    am.push(activeAnchor);

    const e1 = ev({ severity: 'low', timestamp: 1_000 });
    const e2 = ev({ severity: 'low', timestamp: 2_000 });
    const e3 = ev({ severity: 'low', timestamp: 3_000 });
    am.push(e1);
    am.push(e2);
    am.push(e3);

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'dropped',
      reason: 'queue_full',
      dropped: e1.id,
      eventId: e1.id,
    });
    expect(am.snapshot().queue.map((e) => e.id)).toEqual([e2.id, e3.id]);
  });

  it('drops the incoming event itself when it is the worst of the combined set', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig({ maxQueueSize: 2 }), d);
    const activeAnchor = ev({ severity: 'critical', timestamp: 0 });
    am.push(activeAnchor);

    const e1 = ev({ severity: 'medium', timestamp: 1_000 });
    const e2 = ev({ severity: 'medium', timestamp: 2_000 });
    const e3 = ev({ severity: 'low', timestamp: 3_000 });
    am.push(e1);
    am.push(e2);
    am.push(e3);

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'dropped',
      reason: 'queue_full',
      dropped: e3.id,
      eventId: e3.id,
    });
    expect(am.snapshot().queue.map((e) => e.id)).toEqual([e1.id, e2.id]);
  });

  it('FOCUS rejects medium on push, and dropped both queued and active medium (SA6)', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const critical = ev({ severity: 'critical' });
    const medium = ev({ severity: 'medium' });
    am.push(critical);
    am.push(medium); // enqueued (lower severity than active critical)

    am.setMode('FOCUS');
    expect(am.snapshot().queue).toHaveLength(0);
    expect(am.snapshot().active?.event.id).toBe(critical.id);

    d.record.mockClear();
    const rejected = ev({ severity: 'medium' });
    am.push(rejected);
    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'rejected',
      reason: 'mode_filter',
      eventId: rejected.id,
    });
  });

  it('SLEEP mode drops the active event unless it is critical', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const high = ev({ severity: 'high' });
    am.push(high);

    am.setMode('SLEEP');
    expect(am.snapshot().active).toBeNull();
  });

  it('SLEEP keeps a critical active event but drops queued non-critical ones', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const critical = ev({ severity: 'critical' });
    const high = ev({ severity: 'high' });
    am.push(critical);
    am.push(high);

    am.setMode('SLEEP');
    expect(am.snapshot().active?.event.id).toBe(critical.id);
    expect(am.snapshot().queue).toHaveLength(0);
  });

  it('transitions to idle only after transitionToBackgroundMoodDelay', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig({ transitionToBackgroundMoodDelay: 2_000 }), d);
    const e = ev();
    am.push(e);
    am.resolve(e.id, 'dismissed', 'external');

    am.tick(); // schedules the idle deadline
    d.onActiveChange.mockClear();

    vi.advanceTimersByTime(1_000);
    am.tick();
    expect(d.onActiveChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_001);
    am.tick();
    expect(d.onActiveChange).toHaveBeenCalledWith(null);
  });

  it('a new event during the idle delay cancels the transition to background mood', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig({ transitionToBackgroundMoodDelay: 2_000 }), d);
    const e = ev();
    am.push(e);
    am.resolve(e.id, 'dismissed', 'external');
    am.tick();

    vi.advanceTimersByTime(1_000);
    const e2 = ev();
    am.push(e2);
    d.onActiveChange.mockClear();

    vi.advanceTimersByTime(1_500);
    am.tick();
    expect(d.onActiveChange).not.toHaveBeenCalledWith(null);
  });

  it('watchdog fires an incident and forces safe state when the tick loop stalls', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    am.start();
    vi.spyOn(am, 'tick').mockImplementation(() => {});

    vi.advanceTimersByTime(6_000);

    expect(d.record).toHaveBeenCalledWith('incident', { reason: 'am_tick_stalled' });
    expect(d.onActiveChange).toHaveBeenCalledWith(null);
    am.stop();
  });

  it('canonical DECISIONS sequence: meeting -> exception -> permission', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);

    const meeting = ev({
      source: 'calendar',
      category: 'meeting-soon',
      severity: 'high',
      timestamp: 0,
    });
    am.push(meeting);
    expect(d.onActiveChange).toHaveBeenLastCalledWith(expect.objectContaining({ event: meeting }));

    vi.advanceTimersByTime(3_000);
    const exception = ev({
      source: 'chrome',
      category: 'exception',
      severity: 'critical',
      timestamp: 3_000,
    });
    am.push(exception);
    expect(d.onActiveChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: exception }),
    );
    expect(am.snapshot().queue.map((e) => e.id)).toEqual([meeting.id]);

    vi.advanceTimersByTime(3_000); // t = 6000
    const permission = ev({
      source: 'claude',
      category: 'permission',
      severity: 'critical',
      timestamp: 6_000,
    });
    am.push(permission);
    // same severity as active exception -> enqueued, not interrupting
    expect(d.onActiveChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: exception }),
    );
    expect(am.snapshot().queue.map((e) => e.id)).toEqual([permission.id, meeting.id]);

    vi.advanceTimersByTime(27_000); // t = 33000 -> exception's 30s TTL (from t=3000) expires
    am.tick();
    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'expired',
      eventId: exception.id,
    });
    expect(am.snapshot().active?.event.id).toBe(permission.id);

    am.resolve(permission.id, 'approved', 'head');
    expect(am.snapshot().active?.event.id).toBe(meeting.id);
    expect(d.onActiveChange).toHaveBeenLastCalledWith(expect.objectContaining({ event: meeting }));
  });
});

/**
 * Gate 1 (D20) is the go/no-go for phase 3+, and it asks for hard numbers from
 * the Event Recorder. Two of them were unmeasurable: nothing recorded WHERE an
 * approval came from, and nothing recorded that the user entered FOCUS at all.
 * Audited 2026-07-10 against a live bridge.
 */
describe('AttentionManager — what Gate 1 needs to be able to count', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records where an approval came from: the head, not the terminal (D20)', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const e = ev({ severity: 'critical' });
    am.push(e);

    am.resolve(e.id, 'approved', 'head');

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'resolved',
      reason: 'approved',
      source: 'head',
      eventId: e.id,
    });
  });

  it('records the source when the event is resolved while still queued', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    const active = ev({ severity: 'critical' });
    const queued = ev({ severity: 'low' });
    am.push(active);
    am.push(queued); // lower severity → sits in the queue
    d.record.mockClear();

    am.resolve(queued.id, 'approved', 'dashboard');

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'resolved',
      reason: 'approved',
      source: 'dashboard',
      eventId: queued.id,
    });
  });

  it('records entering FOCUS even when there is nothing to drop', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d); // empty queue, no active
    am.setMode('FOCUS');

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'mode_changed',
      from: 'NORMAL',
      to: 'FOCUS',
    });
  });

  it('records returning to NORMAL — otherwise FOCUS time cannot be measured', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    am.setMode('FOCUS');
    d.record.mockClear();

    am.setMode('NORMAL');

    expect(d.record).toHaveBeenCalledWith('am_decision', {
      action: 'mode_changed',
      from: 'FOCUS',
      to: 'NORMAL',
    });
  });

  it('does not record a mode change that changes nothing', () => {
    const d = deps();
    const am = new AttentionManager(baseConfig(), d);
    am.setMode('FOCUS');
    d.record.mockClear();

    am.setMode('FOCUS');

    expect(d.record).not.toHaveBeenCalled();
  });
});
