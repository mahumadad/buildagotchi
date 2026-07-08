import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/bus.js';
import { newEvent } from '../src/core/events.js';

const cfg = { windowMs: 60_000, autoMuteAfter: 3 };

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    ...newEvent({
      source: 'claude',
      category: 'permission',
      severity: 'high',
      payload: {},
      hash: 'default-hash',
    }),
    ...overrides,
  };
}

describe('EventBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts the first event for a hash', () => {
    const bus = new EventBus(cfg, {});
    const outcome = bus.publish(rawEvent());
    expect(outcome.kind).toBe('accepted');
  });

  it('dedupes a repeat within the window and counts it', () => {
    const bus = new EventBus(cfg, {});
    bus.publish(rawEvent({ hash: 'h1' }));
    const outcome = bus.publish(rawEvent({ hash: 'h1' }));
    expect(outcome).toMatchObject({ kind: 'deduped', hash: 'h1', count: 2 });
  });

  it('re-emits on severity change even within the window', () => {
    const bus = new EventBus(cfg, {});
    bus.publish(rawEvent({ hash: 'h1', severity: 'medium' }));
    const outcome = bus.publish(rawEvent({ hash: 'h1', severity: 'critical' }));
    expect(outcome.kind).toBe('accepted');
  });

  it('auto-mutes after reaching autoMuteAfter repeats', () => {
    const bus = new EventBus(cfg, {});
    bus.publish(rawEvent({ hash: 'h1' })); // count 1
    bus.publish(rawEvent({ hash: 'h1' })); // count 2
    const outcome = bus.publish(rawEvent({ hash: 'h1' })); // count 3 = autoMuteAfter
    expect(outcome.kind).toBe('muted');
  });

  it('keeps muting while hits keep arriving (renewing lastSeen, SA4)', () => {
    const bus = new EventBus(cfg, {});
    bus.publish(rawEvent({ hash: 'h1' }));
    bus.publish(rawEvent({ hash: 'h1' }));
    bus.publish(rawEvent({ hash: 'h1' })); // muted starts here
    vi.advanceTimersByTime(cfg.windowMs - 1);
    const outcome = bus.publish(rawEvent({ hash: 'h1' }));
    expect(outcome.kind).toBe('muted');
  });

  it('re-accepts after the window expires with no hits', () => {
    const bus = new EventBus(cfg, {});
    bus.publish(rawEvent({ hash: 'h1' }));
    vi.advanceTimersByTime(cfg.windowMs);
    const outcome = bus.publish(rawEvent({ hash: 'h1' }));
    expect(outcome.kind).toBe('accepted');
  });

  it('returns invalid for a malformed event without throwing', () => {
    const bus = new EventBus(cfg, {});
    expect(() => bus.publish({ source: 'x' })).not.toThrow();
    const outcome = bus.publish({ source: 'x' });
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') {
      expect(outcome.issues.length).toBeGreaterThan(0);
    }
  });

  it('purges expired entries so an old hash is treated as new', () => {
    const bus = new EventBus(cfg, {});
    bus.publish(rawEvent({ hash: 'A' }));
    vi.advanceTimersByTime(cfg.windowMs * 2);
    bus.publish(rawEvent({ hash: 'B' }));
    const outcome = bus.publish(rawEvent({ hash: 'A' }));
    expect(outcome.kind).toBe('accepted');
  });

  it('invokes onAccepted for accepted events', () => {
    const onAccepted = vi.fn();
    const bus = new EventBus(cfg, { onAccepted });
    bus.publish(rawEvent({ hash: 'h1' }));
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it('invokes onOutcome for every publish', () => {
    const onOutcome = vi.fn();
    const bus = new EventBus(cfg, { onOutcome });
    bus.publish(rawEvent({ hash: 'h1' }));
    bus.publish(rawEvent({ hash: 'h1' }));
    expect(onOutcome).toHaveBeenCalledTimes(2);
  });

  it('applies a new dedup config via setDedupConfig (hot-reload)', () => {
    const bus = new EventBus(cfg, {});
    bus.setDedupConfig({ windowMs: 10, autoMuteAfter: 3 });
    bus.publish(rawEvent({ hash: 'h1' }));
    vi.advanceTimersByTime(11);
    const outcome = bus.publish(rawEvent({ hash: 'h1' }));
    expect(outcome.kind).toBe('accepted');
  });
});
