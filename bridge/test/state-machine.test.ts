import { describe, expect, it, vi } from 'vitest';
import { newEvent } from '../src/core/events.js';
import type { StateRule } from '../src/core/state-machine.js';
import { StateMachine } from '../src/core/state-machine.js';

function deps() {
  return {
    emit: vi.fn(),
    record: vi.fn(),
    metrics: { counter: () => ({ inc: vi.fn() }) },
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
    expect(sm.current()).toEqual({ emotion: 'NEUTRAL', decorators: [], leds: [] });
  });
});
