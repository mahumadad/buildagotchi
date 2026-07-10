import { describe, expect, it, vi } from 'vitest';
import { newEvent } from '../src/core/events.js';
import type { StateRule } from '../src/core/state-machine.js';
import { StateMachine } from '../src/core/state-machine.js';

function deps(now?: () => number) {
  const gauges = new Map<string, () => number>();
  return {
    emit: vi.fn(),
    record: vi.fn(),
    metrics: {
      counter: () => ({ inc: vi.fn() }),
      gauge: (name: string, collect?: () => number) => {
        if (collect) gauges.set(name, collect);
        return { set: vi.fn() };
      },
    },
    // Spread, not `now,`: under exactOptionalPropertyTypes an explicit
    // `now: undefined` is not the same as an absent `now` (D-11).
    ...(now ? { now } : {}),
    _gauges: gauges,
  };
}

const RULES: StateRule[] = [
  {
    match: { source: 'claude', category: 'permission' },
    state: { emotion: 'DOUBTFUL', servo: { pitch: 10 } },
  },
  { match: { severity: 'critical' }, state: { emotion: 'ANGRY' } },
  { match: { severity: 'ambient' }, state: { emotion: 'NEUTRAL' } },
];

describe('StateMachine', () => {
  it('the first matching rule wins over a more generic one', () => {
    const d = deps();
    const sm = new StateMachine(RULES, d);
    const e = newEvent({
      source: 'claude',
      category: 'permission',
      severity: 'critical',
      payload: {},
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().emotion).toBe('DOUBTFUL');
  });

  it('falls back to the configured severity default when no specific rule matches', () => {
    const d = deps();
    const sm = new StateMachine(RULES, d);
    const e = newEvent({
      source: 'unknown',
      category: 'whatever',
      severity: 'critical',
      payload: {},
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().emotion).toBe('ANGRY');
  });

  it('falls back to bare NEUTRAL and warns when no rule matches at all (incomplete config)', () => {
    const d = deps();
    const sm = new StateMachine([], d);
    const e = newEvent({ source: 'unknown', category: 'whatever', severity: 'high', payload: {} });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().emotion).toBe('NEUTRAL');
  });

  it('does not re-emit an identical state', () => {
    const d = deps();
    const sm = new StateMachine(RULES, d);
    const e = newEvent({ source: 'x', category: 'y', severity: 'ambient', payload: {} });
    sm.apply({ event: e, deadline: null });
    d.emit.mockClear();
    d.record.mockClear();
    const e2 = newEvent({ source: 'x2', category: 'y2', severity: 'ambient', payload: {} });
    sm.apply({ event: e2, deadline: null });
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it('maps event.direction to gaze when the rule does not set one', () => {
    const d = deps();
    const sm = new StateMachine(RULES, d);
    const e = newEvent({
      source: 'x',
      category: 'y',
      severity: 'critical',
      payload: {},
      direction: 'left',
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().gaze).toBe('left');
  });

  it('counts a face change only when emotion changes, not for LED-only changes', () => {
    const d = deps();
    const incSpy = vi.fn();
    d.metrics.counter = () => ({ inc: incSpy });
    const sm = new StateMachine(
      [
        {
          match: { category: 'a' },
          state: { emotion: 'HAPPY', leds: [{ row: 'left', color: 'red', pattern: 'solid' }] },
        },
        {
          match: { category: 'b' },
          state: { emotion: 'HAPPY', leds: [{ row: 'left', color: 'blue', pattern: 'solid' }] },
        },
      ],
      d,
    );
    sm.apply({
      event: newEvent({ source: 's', category: 'a', severity: 'low', payload: {} }),
      deadline: null,
    });
    expect(incSpy).toHaveBeenCalledTimes(1);
    sm.apply({
      event: newEvent({ source: 's', category: 'b', severity: 'low', payload: {} }),
      deadline: null,
    });
    expect(incSpy).toHaveBeenCalledTimes(1); // same emotion, only LEDs changed -> no face change
  });

  it('applies the fixed NEUTRAL background mood when input is null', () => {
    const d = deps();
    const sm = new StateMachine(RULES, d);
    sm.apply(null);
    // S2.5.11: emitted ResolvedState always carries `balloon: string`. Empty on
    // idle because there's nothing sticky in the history.
    expect(sm.current()).toEqual({ emotion: 'NEUTRAL', decorators: [], leds: [], balloon: '' });
  });

  it('tracks time_in_critical_state_ratio over a moving window', () => {
    let t = 1000;
    const d = deps(() => t);
    const sm = new StateMachine(RULES, d);
    const collectRatio = d._gauges.get('time_in_critical_state_ratio');
    expect(collectRatio).toBeDefined();

    sm.apply({
      event: newEvent({ source: 'x', category: 'y', severity: 'critical', payload: {} }),
      deadline: null,
    });
    t += 1000;
    sm.apply({
      event: newEvent({ source: 'x', category: 'y', severity: 'low', payload: {} }),
      deadline: null,
    });
    t += 1000;
    sm.apply({
      event: newEvent({ source: 'x', category: 'y', severity: 'low', payload: {} }),
      deadline: null,
    });
    t += 1000;
    sm.apply(null);

    // 1 critical out of 4 samples = 0.25
    expect(collectRatio?.()).toBeCloseTo(0.25);
  });

  it('mcp:set_face overrides resolved emotion', () => {
    const d = deps();
    const sm = new StateMachine(RULES, d);
    const e = newEvent({
      source: 'mcp:set_face',
      category: 'set_face',
      severity: 'high',
      payload: { emotion: 'HAPPY' },
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().emotion).toBe('HAPPY');
  });

  it('mcp:set_face with balloon sets balloon', () => {
    const d = deps();
    const sm = new StateMachine(RULES, d);
    const e = newEvent({
      source: 'mcp:set_face',
      category: 'set_face',
      severity: 'high',
      payload: { emotion: 'SAD', balloon: 'oops' },
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().emotion).toBe('SAD');
    expect(sm.current().balloon).toBe('oops');
  });
});

/**
 * D-10. Gate 1 wants p95 of D23's budget: critical event → the face changes.
 * That path has two legs. The firmware leg (`bridge_ts → fw_applied_ts`) is
 * already instrumented in `ble/protocol.ts` and unreachable until the CoreS3
 * exists. The bridge's own leg — event timestamp → resolved state — was never
 * measured at all, and the histograms that do exist die on restart.
 *
 * The `state_change` line already gets written on every transition, so the
 * latency rides along and p95 gets computed offline, over the whole retention
 * window.
 */
describe('StateMachine — latency lands in the recorder (D-10)', () => {
  const RULE: StateRule[] = [{ match: { severity: 'critical' }, state: { emotion: 'ANGRY' } }];

  it('state_change carries the ms from the event to the resolved state', () => {
    let clock = 5_000;
    const d = deps(() => clock);
    const sm = new StateMachine(RULE, d);

    const e = { ...newEvent({ source: 's', category: 'c', severity: 'critical', payload: {} }) };
    (e as { timestamp: number }).timestamp = 4_850;
    clock = 5_000;
    sm.apply({ event: e, deadline: null });

    expect(d.record).toHaveBeenCalledWith(
      'state_change',
      expect.objectContaining({ eventId: e.id, latencyMs: 150 }),
    );
  });

  it('the background mood has no event, so it carries no latency', () => {
    const d = deps(() => 5_000);
    const sm = new StateMachine(RULE, d);
    const e = newEvent({ source: 's', category: 'c', severity: 'critical', payload: {} });
    sm.apply({ event: e, deadline: null });
    d.record.mockClear();

    sm.apply(null); // back to background mood

    const call = d.record.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[1]).not.toHaveProperty('latencyMs');
  });

  it('a clock that goes backwards does not record a negative latency', () => {
    // NTP steps, sleep/wake. A negative number would poison the p95 silently.
    const clock = 5_000;
    const d = deps(() => clock);
    const sm = new StateMachine(RULE, d);

    const e = { ...newEvent({ source: 's', category: 'c', severity: 'critical', payload: {} }) };
    (e as { timestamp: number }).timestamp = 6_000; // event "from the future"
    sm.apply({ event: e, deadline: null });

    const data = d.record.mock.calls[0]?.[1] as { latencyMs?: number };
    expect(data.latencyMs).toBe(0);
  });
});
