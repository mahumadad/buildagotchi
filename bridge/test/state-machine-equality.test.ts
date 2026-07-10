import { describe, expect, it, vi } from 'vitest';
import type { ActiveAttention } from '../src/core/attention.js';
import { type Event, type ResolvedState, newEvent } from '../src/core/events.js';
import { StateMachine, type StateMachineDeps, type StateRule } from '../src/core/state-machine.js';

/**
 * D-01: `statesEqual` used to compare with `JSON.stringify`, which preserves
 * key insertion order. `#resolve` builds its object through conditional
 * spreads, so two semantically identical `ResolvedState`s could serialize
 * differently and be treated as a real transition:
 *
 *   - `state_change` written to the recorder (lying about how often the state
 *     changed)
 *   - `face_changes_total` incremented
 *   - a redundant SSE broadcast
 *   - a duplicate entry pushed to BalloonHistory
 *
 * Two ways to trigger it, both exercised below:
 *
 *   1. Two rules declaring the same fields in a different order. `stateRules`
 *      come from YAML, which preserves key order, so this is one careless
 *      config edit away.
 *   2. `gaze` arriving from `rule.state` in one event and from `e.direction`
 *      in another. The direction path appends `gaze` last; the rule path puts
 *      it wherever the author wrote it. Fase 3's JiraAdapter and GitHubAdapter
 *      emit `direction` (ROADMAP §Fase 3) — that is the detonator.
 */

function makeDeps(): {
  deps: StateMachineDeps;
  emitted: ResolvedState[];
  faceChanges: () => number;
} {
  const emitted: ResolvedState[] = [];
  let faceChanges = 0;
  const deps: StateMachineDeps = {
    emit: (s) => emitted.push(s),
    record: vi.fn(),
    metrics: {
      counter: () => ({
        inc: () => {
          faceChanges += 1;
        },
      }),
      gauge: () => ({ set: vi.fn() }),
    },
  };
  return { deps, emitted, faceChanges: () => faceChanges };
}

function activeOf(e: Event): ActiveAttention {
  return { event: e, deadline: null };
}

function ev(category: string, extra: Partial<Parameters<typeof newEvent>[0]> = {}): Event {
  return newEvent({
    source: 'test',
    category,
    severity: 'ambient',
    payload: {},
    ...extra,
  } as Parameters<typeof newEvent>[0]);
}

describe('D-01: statesEqual must not depend on key insertion order', () => {
  it('two rules declaring the same fields in a different order are ONE state', () => {
    // `a` writes emotion then gaze; `b` writes gaze then emotion. Identical
    // resolved state; different JSON.stringify output.
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { emotion: 'NEUTRAL', gaze: 'left' } },
      { match: { category: 'b' }, state: { gaze: 'left', emotion: 'NEUTRAL' } },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);

    sm.apply(activeOf(ev('a')));
    const afterFirst = emitted.length;
    sm.apply(activeOf(ev('b')));

    expect(emitted.length).toBe(afterFirst); // no second emit
  });

  it('gaze from a rule and gaze from e.direction are the same state', () => {
    // Rule `a` declares gaze inline (so it lands mid-object); rule `b` leaves
    // it out and the event's `direction` appends it last. Fase 3 scenario.
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { gaze: 'left', emotion: 'NEUTRAL' } },
      { match: { category: 'b' }, state: { emotion: 'NEUTRAL' } },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);

    sm.apply(activeOf(ev('a')));
    const afterFirst = emitted.length;
    sm.apply(activeOf(ev('b', { direction: 'left' })));

    expect(emitted.length).toBe(afterFirst);
  });

  it('does not increment face_changes_total for a non-change', () => {
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { emotion: 'HAPPY', sound: 'ping' } },
      { match: { category: 'b' }, state: { sound: 'ping', emotion: 'HAPPY' } },
    ];
    const { deps, faceChanges } = makeDeps();
    const sm = new StateMachine(rules, deps);

    sm.apply(activeOf(ev('a')));
    const before = faceChanges();
    sm.apply(activeOf(ev('b')));

    expect(faceChanges()).toBe(before);
  });

  // ── Genuine differences must still register as transitions ──────────────

  it('a different emotion IS a transition', () => {
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { emotion: 'NEUTRAL' } },
      { match: { category: 'b' }, state: { emotion: 'ANGRY' } },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    const n = emitted.length;
    sm.apply(activeOf(ev('b')));
    expect(emitted.length).toBe(n + 1);
  });

  it('a different balloon IS a transition', () => {
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { emotion: 'NEUTRAL', balloon: 'uno' } },
      { match: { category: 'b' }, state: { emotion: 'NEUTRAL', balloon: 'dos' } },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    const n = emitted.length;
    sm.apply(activeOf(ev('b')));
    expect(emitted.length).toBe(n + 1);
  });

  it('a different LED colour IS a transition', () => {
    const rules: StateRule[] = [
      {
        match: { category: 'a' },
        state: { emotion: 'NEUTRAL', leds: [{ row: 'left', color: 'red', pattern: 'solid' }] },
      },
      {
        match: { category: 'b' },
        state: { emotion: 'NEUTRAL', leds: [{ row: 'left', color: 'green', pattern: 'solid' }] },
      },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    const n = emitted.length;
    sm.apply(activeOf(ev('b')));
    expect(emitted.length).toBe(n + 1);
  });

  it('a different LED count IS a transition', () => {
    const rules: StateRule[] = [
      {
        match: { category: 'a' },
        state: { emotion: 'NEUTRAL', leds: [{ row: 'left', color: 'red', pattern: 'solid' }] },
      },
      {
        match: { category: 'b' },
        state: {
          emotion: 'NEUTRAL',
          leds: [
            { row: 'left', color: 'red', pattern: 'solid' },
            { row: 'right', color: 'red', pattern: 'solid' },
          ],
        },
      },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    const n = emitted.length;
    sm.apply(activeOf(ev('b')));
    expect(emitted.length).toBe(n + 1);
  });

  it('a different servo angle IS a transition', () => {
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { emotion: 'NEUTRAL', servo: { pitch: 10 } } },
      { match: { category: 'b' }, state: { emotion: 'NEUTRAL', servo: { pitch: 20 } } },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    const n = emitted.length;
    sm.apply(activeOf(ev('b')));
    expect(emitted.length).toBe(n + 1);
  });

  it('servo {pitch: 10} and {yaw: undefined, pitch: 10} are the same state', () => {
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { emotion: 'NEUTRAL', servo: { pitch: 10 } } },
      {
        match: { category: 'b' },
        state: { emotion: 'NEUTRAL', servo: { yaw: undefined, pitch: 10 } },
      },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    const n = emitted.length;
    sm.apply(activeOf(ev('b')));
    expect(emitted.length).toBe(n);
  });

  it('decorator ORDER is significant — [a,b] is not [b,a]', () => {
    // Not a cosmetic choice: the face renderer draws decorators in order, so
    // two orderings are two different pictures.
    const rules: StateRule[] = [
      { match: { category: 'a' }, state: { emotion: 'NEUTRAL', decorators: ['x', 'y'] } },
      { match: { category: 'b' }, state: { emotion: 'NEUTRAL', decorators: ['y', 'x'] } },
    ];
    const { deps, emitted } = makeDeps();
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    const n = emitted.length;
    sm.apply(activeOf(ev('b')));
    expect(emitted.length).toBe(n + 1);
  });
});
