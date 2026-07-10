import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoAdapter } from '../src/adapters/demo.js';
import type { AttentionManager } from '../src/core/attention.js';
import { EventBus } from '../src/core/bus.js';
import type { Event } from '../src/core/events.js';

describe('DemoAdapter', () => {
  let bus: EventBus;
  let published: Event[];
  let resolve: ReturnType<typeof vi.fn>;
  let am: Pick<AttentionManager, 'resolve'>;
  let adapter: DemoAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    published = [];
    bus = new EventBus(
      { windowMs: 60_000, autoMuteAfter: 10 },
      { onAccepted: (e) => published.push(e) },
    );
    resolve = vi.fn();
    am = { resolve };
    adapter = new DemoAdapter({ attentionManager: am as AttentionManager });
  });

  afterEach(async () => {
    await adapter.stop();
    vi.useRealTimers();
  });

  it('health() is always HEALTHY', () => {
    expect(adapter.health().status).toBe('HEALTHY');
  });

  it('emits the canonical sequence: meeting -> exception -> permission -> auto-resolve -> repeat', async () => {
    await adapter.start(bus);

    expect(published).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      source: 'calendar',
      category: 'meeting-soon',
      severity: 'high',
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({
      source: 'chrome',
      category: 'exception',
      severity: 'critical',
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(published).toHaveLength(3);
    const permission = published[2] as Event;
    expect(permission).toMatchObject({
      source: 'claude',
      category: 'permission',
      severity: 'critical',
    });

    expect(resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_000); // t = 6 + 14 = 20s
    expect(resolve).toHaveBeenCalledWith(permission.id, 'approved', 'head');

    await vi.advanceTimersByTimeAsync(10_001); // t = 30s -> loop repeats
    expect(published).toHaveLength(4);
    expect(published[3]).toMatchObject({
      source: 'calendar',
      category: 'meeting-soon',
      severity: 'high',
    });
  });

  it('stop() clears pending timers so the loop does not keep firing', async () => {
    await adapter.start(bus);
    await vi.advanceTimersByTimeAsync(0);
    await adapter.stop();
    const countAfterStop = published.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(published).toHaveLength(countAfterStop);
  });
});
