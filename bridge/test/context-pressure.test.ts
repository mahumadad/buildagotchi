import { describe, expect, it, vi } from 'vitest';
import { ContextPressureMonitor } from '../src/core/context-pressure.js';

/**
 * Context pressure drives the face. The window size is NOT inferred: no field in
 * the transcript reports it, so it is declared in config. A percentage computed
 * against a guessed limit would look authoritative and be invented.
 *
 * Edge-triggered, like `ProtocolSession.onLinkChange`. A session sitting at 75%
 * for an hour is one event, not one per response — otherwise the robot spends
 * the afternoon shouting the same thing.
 */

const CFG = { windowTokens: 200_000, warnAt: 0.7, highAt: 0.9 };

function monitor() {
  const events: { level: string; sessionId: string; pct: number; cwd: string }[] = [];
  const m = new ContextPressureMonitor(CFG, {
    onLevelChange: (level, ctx) => events.push({ level, ...ctx }),
  });
  return { m, events };
}

describe('ContextPressureMonitor', () => {
  it('says nothing below the warn threshold', () => {
    const { m, events } = monitor();
    m.observe('a', 100_000); // 50%
    expect(events).toEqual([]);
  });

  it('fires once when a session crosses into warn', () => {
    const { m, events } = monitor();
    m.observe('a', 150_000, '/Users/x/myapp'); // 75%
    expect(events).toEqual([{ level: 'warn', sessionId: 'a', pct: 0.75, cwd: '/Users/x/myapp' }]);
  });

  it('does not re-fire while the level holds', () => {
    const { m, events } = monitor();
    m.observe('a', 150_000);
    m.observe('a', 155_000);
    m.observe('a', 160_000);
    expect(events).toHaveLength(1);
  });

  it('escalates warn → high on a further climb', () => {
    const { m, events } = monitor();
    m.observe('a', 150_000);
    m.observe('a', 190_000); // 95%
    expect(events.map((e) => e.level)).toEqual(['warn', 'high']);
  });

  it('reports relief when a session compacts back below warn', () => {
    const { m, events } = monitor();
    m.observe('a', 190_000);
    m.observe('a', 12_000); // compaction
    expect(events.map((e) => e.level)).toEqual(['high', 'calm']);
  });

  it('tracks sessions independently', () => {
    const { m, events } = monitor();
    m.observe('a', 190_000);
    m.observe('b', 10_000); // b is calm and was never warned; no event for b
    expect(events).toEqual([{ level: 'high', sessionId: 'a', pct: 0.95, cwd: '' }]);
  });

  it('a session that ends stops being tracked and does not report relief', () => {
    const { m, events } = monitor();
    m.observe('a', 190_000);
    m.forget('a');
    expect(events).toHaveLength(1); // dying is not the same as compacting
  });

  it('a forgotten session warns again at the SAME level it left at', () => {
    // The distinguishing test: if `forget` didn't clear the level, this second
    // `warn` would be swallowed as a no-change. Observing a *different* level
    // after forgetting proves nothing — it would fire either way.
    const { m, events } = monitor();
    m.observe('a', 150_000); // warn
    m.forget('a');
    m.observe('a', 150_000); // warn again, from scratch
    expect(events.map((e) => e.level)).toEqual(['warn', 'warn']);
  });

  it('a zero window never divides by zero and never fires', () => {
    const events: unknown[] = [];
    const m = new ContextPressureMonitor(
      { windowTokens: 0, warnAt: 0.7, highAt: 0.9 },
      { onLevelChange: (l, c) => events.push({ l, c }) },
    );
    m.observe('a', 500_000);
    expect(events).toEqual([]);
  });

  it('a context above the declared window clamps instead of exceeding 100%', () => {
    const { m, events } = monitor();
    m.observe('a', 412_967); // measured on a real session
    expect(events[0]?.pct).toBe(1);
  });

  it('hands the caller the fresh threshold config after a hot-reload', () => {
    const onLevelChange = vi.fn();
    const m = new ContextPressureMonitor(CFG, { onLevelChange });
    m.observe('a', 150_000); // warn at the old 70%
    onLevelChange.mockClear();

    m.setConfig({ windowTokens: 1_000_000, warnAt: 0.7, highAt: 0.9 });
    m.observe('a', 150_000); // now 15% — calm

    expect(onLevelChange).toHaveBeenCalledWith('calm', expect.objectContaining({ sessionId: 'a' }));
  });
});
