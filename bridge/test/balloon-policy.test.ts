import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveAttention } from '../src/core/attention.js';
import { type Event, type ResolvedState, newEvent } from '../src/core/events.js';
import { StateMachine, type StateMachineDeps, type StateRule } from '../src/core/state-machine.js';
import { PersonalityManager, type PersonalityPreset } from '../src/personality/personality.js';

/**
 * The 21 tests that gate M12a. Order roughly follows the criterion table in
 * SPEC-IMPL-FASE-2.5 §2.5. #6 reproduces the trace captured on 2026-07-09
 * (permission expires → another event is promoted from the queue without going
 * through the bus); #21 covers the early-return of `statesEqual` — the trap
 * nobody would write a test for without having thought about it.
 */

function makeDeps(): { deps: StateMachineDeps; emitted: ResolvedState[] } {
  const emitted: ResolvedState[] = [];
  const deps: StateMachineDeps = {
    emit: (s) => emitted.push(s),
    record: vi.fn(),
    metrics: {
      counter: () => ({ inc: vi.fn() }),
      gauge: () => ({ set: vi.fn() }),
    },
  };
  return { deps, emitted };
}

function activeOf(e: Event): ActiveAttention {
  return { event: e, deadline: null };
}

function ev(category: string, payload: Record<string, unknown> = {}, source = 'test'): Event {
  return newEvent({ source, category, severity: 'ambient', payload });
}

function preset(templates: Record<string, string> = {}): PersonalityPreset {
  return {
    name: 'test',
    idleEmotion: 'NEUTRAL',
    decoratorsBySeverity: {},
    templates,
  };
}

const TRANSIENT_RULE = (extra: Partial<StateRule> = {}): StateRule => ({
  match: { category: 'transient_evt' },
  state: { emotion: 'DOUBTFUL', balloon: 'PERM' },
  ...extra,
});

const STICKY_RULE = (extra: Partial<StateRule> = {}): StateRule => ({
  match: { category: 'sticky_evt' },
  balloonPolicy: 'sticky',
  state: { emotion: 'HAPPY', balloon: 'RESP' },
  ...extra,
});

const SILENT_RULE = (category: string, extra: Partial<StateRule> = {}): StateRule => ({
  match: { category },
  state: { emotion: 'NEUTRAL' }, // no balloon field → inherit
  ...extra,
});

describe('StateMachine — balloon policy (M12a)', () => {
  let deps: StateMachineDeps;
  let emitted: ResolvedState[];

  beforeEach(() => {
    const made = makeDeps();
    deps = made.deps;
    emitted = made.emitted;
  });

  it('#1: transient with balloon → apply(null) clears', () => {
    const sm = new StateMachine([TRANSIENT_RULE()], deps);
    sm.apply(activeOf(ev('transient_evt')));
    sm.apply(null);
    expect(sm.current().balloon).toBe('');
  });

  it('#2: transient with balloon → mode-drop clears (via apply(null))', () => {
    // SetMode is on AM, not SM. The SM behavior tested here is: whatever route
    // ends up in apply(null), the transient balloon dies.
    const sm = new StateMachine([TRANSIENT_RULE()], deps);
    sm.apply(activeOf(ev('transient_evt')));
    expect(sm.current().balloon).toBe('PERM');
    sm.apply(null); // AM's mode-drop path terminates here
    expect(sm.current().balloon).toBe('');
  });

  it('#3: sticky with balloon → apply(null) preserves', () => {
    const sm = new StateMachine([STICKY_RULE()], deps);
    sm.apply(activeOf(ev('sticky_evt')));
    sm.apply(null);
    expect(sm.current().balloon).toBe('RESP');
  });

  it('#4: sticky then a rule with no balloon inherits text AND policy', () => {
    const sm = new StateMachine([STICKY_RULE(), SILENT_RULE('silent_evt')], deps);
    sm.apply(activeOf(ev('sticky_evt')));
    sm.apply(activeOf(ev('silent_evt')));
    expect(sm.current().balloon).toBe('RESP'); // text inherited
    sm.apply(null);
    expect(sm.current().balloon).toBe('RESP'); // policy inherited → still sticky
  });

  it('#5: transient → silent rule clears immediately (no wait for apply(null))', () => {
    // Superseded by #22: the M13 e2e verification showed that transient must
    // die THE MOMENT its event stops being active, including when the AM
    // promotes another event straight from resolve/expire without idling.
    const sm = new StateMachine([TRANSIENT_RULE(), SILENT_RULE('silent_evt')], deps);
    sm.apply(activeOf(ev('transient_evt')));
    sm.apply(activeOf(ev('silent_evt')));
    expect(sm.current().balloon).toBe(''); // ← transient died on promotion
    sm.apply(null);
    expect(sm.current().balloon).toBe(''); // idle keeps it clear
  });

  it('#6: the bug from §1.1 — transient expires, another event is promoted, no leak', () => {
    // Reproduces the trace captured 2026-07-09: permission (transient) becomes
    // active, dies via TTL expiry, then a silent event is promoted from the
    // queue. If balloon inherited on the promotion, the permission text would
    // hang under an unrelated event.
    const sm = new StateMachine([TRANSIENT_RULE(), SILENT_RULE('subagent_evt')], deps);
    sm.apply(activeOf(ev('transient_evt'))); // permission active
    expect(sm.current().balloon).toBe('PERM');

    // TTL expires → AM calls apply(null), then promotes another event.
    sm.apply(null); // transient policy → cleared
    sm.apply(activeOf(ev('subagent_evt'))); // promoted; rule has no balloon → inherits

    // What's inherited must be the (now cleared) '', NOT the stale 'PERM'.
    expect(sm.current().balloon).toBe('');
  });

  it('#7: a rule with balloon replaces', () => {
    const rules: StateRule[] = [
      TRANSIENT_RULE(),
      {
        match: { category: 'other' },
        state: { emotion: 'ANGRY', balloon: 'NEW' },
      },
    ];
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('transient_evt')));
    sm.apply(activeOf(ev('other')));
    expect(sm.current().balloon).toBe('NEW');
  });

  it('#8: balloon: "" in the rule clears', () => {
    const rules: StateRule[] = [
      TRANSIENT_RULE(),
      {
        match: { category: 'clear_evt' },
        state: { emotion: 'HAPPY', balloon: '' },
      },
    ];
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('transient_evt')));
    sm.apply(activeOf(ev('clear_evt')));
    expect(sm.current().balloon).toBe('');
  });

  it('#9: personality template overrides the rule (S2.5.9)', () => {
    const p = new PersonalityManager(preset({ transient_evt: 'FROM_PRESET' }));
    const sm = new StateMachine([TRANSIENT_RULE()], deps, p);
    sm.apply(activeOf(ev('transient_evt')));
    expect(sm.current().balloon).toBe('FROM_PRESET');
  });

  it('#10: personality template "" clears even if the rule has text', () => {
    const p = new PersonalityManager(preset({ transient_evt: '' }));
    const sm = new StateMachine([TRANSIENT_RULE()], deps, p);
    sm.apply(activeOf(ev('transient_evt')));
    expect(sm.current().balloon).toBe('');
  });

  it('#11: no template + no rule balloon → inherits', () => {
    const p = new PersonalityManager(preset()); // no templates at all
    const rules: StateRule[] = [STICKY_RULE(), SILENT_RULE('silent_evt')];
    const sm = new StateMachine(rules, deps, p);
    sm.apply(activeOf(ev('sticky_evt')));
    sm.apply(activeOf(ev('silent_evt')));
    expect(sm.current().balloon).toBe('RESP'); // inherited from sticky
  });

  it('#12: policy always comes from the rule, never from the preset', () => {
    // Preset provides the text; the rule (sticky) provides the policy.
    // After apply(null), the balloon must survive → policy came from rule.
    const p = new PersonalityManager(preset({ pres_evt: 'PRESET_TEXT' }));
    const rule: StateRule = {
      match: { category: 'pres_evt' },
      balloonPolicy: 'sticky',
      state: { emotion: 'NEUTRAL' }, // no balloon → preset wins the text
    };
    const sm = new StateMachine([rule], deps, p);
    sm.apply(activeOf(ev('pres_evt')));
    expect(sm.current().balloon).toBe('PRESET_TEXT');
    sm.apply(null);
    expect(sm.current().balloon).toBe('PRESET_TEXT'); // sticky held
  });

  it('#13: two states differing only in balloon still transition', () => {
    const rules: StateRule[] = [
      {
        match: { category: 'a' },
        state: { emotion: 'NEUTRAL', balloon: 'X' },
      },
      {
        match: { category: 'b' },
        state: { emotion: 'NEUTRAL', balloon: 'Y' },
      },
    ];
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a')));
    sm.apply(activeOf(ev('b')));
    // 2 real emits (plus whatever forceSafeState / initial may add — check ≥2)
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect(emitted[emitted.length - 2]?.balloon).toBe('X');
    expect(emitted[emitted.length - 1]?.balloon).toBe('Y');
  });

  it('#14: interpolates any payload field', () => {
    const rules: StateRule[] = [
      {
        match: { category: 'r' },
        state: { emotion: 'HAPPY', balloon: '[{project}] {text}' },
      },
    ];
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('r', { cwd: '/a/b/proj', text: 'ok' })));
    expect(sm.current().balloon).toBe('[proj] ok');
  });

  it('#15: truncates to balloonMaxChars, ending in "…"', () => {
    const rules: StateRule[] = [
      {
        match: { category: 'r' },
        state: { emotion: 'NEUTRAL', balloon: '{text}' },
      },
    ];
    const sm = new StateMachine(rules, deps);
    sm.setBalloonMaxChars(10);
    sm.apply(activeOf(ev('r', { text: 'x'.repeat(500) })));
    const b = sm.current().balloon ?? '';
    expect(b.length).toBe(10);
    expect(b.endsWith('…')).toBe(true);
  });

  it('#16: truncation preserves the interpolated prefix (S2.5.13)', () => {
    const rules: StateRule[] = [
      {
        match: { category: 'r' },
        state: { emotion: 'NEUTRAL', balloon: '[{project}] {text}' },
      },
    ];
    const sm = new StateMachine(rules, deps);
    sm.setBalloonMaxChars(20);
    sm.apply(activeOf(ev('r', { cwd: '/x/proj', text: 'y'.repeat(500) })));
    const b = sm.current().balloon ?? '';
    expect(b.startsWith('[proj] ')).toBe(true); // prefix survived
    expect(b.length).toBe(20);
  });

  it('#17: emitted ResolvedState always has balloon: string', () => {
    const rules: StateRule[] = [SILENT_RULE('any')];
    const sm = new StateMachine(rules, deps);
    // Before any event, current() is BACKGROUND_MOOD; the invariant is on
    // *emitted* states. Trigger one.
    sm.apply(activeOf(ev('any')));
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    for (const s of emitted) {
      expect(typeof s.balloon).toBe('string');
    }
  });

  it('#18: mcp:set_face without payload.balloon clears (S2.5.14)', () => {
    const sm = new StateMachine([TRANSIENT_RULE()], deps);
    sm.apply(activeOf(ev('transient_evt')));
    expect(sm.current().balloon).toBe('PERM');

    // set_face override — no balloon in payload → must clear, never inherit.
    const setFace = newEvent({
      source: 'mcp:set_face',
      category: 'set_face',
      severity: 'medium',
      payload: { emotion: 'HAPPY' },
    });
    sm.apply(activeOf(setFace));
    expect(sm.current().balloon).toBe('');
  });

  it('#19: mcp:set_face with payload.balloon uses it, transient policy', () => {
    const sm = new StateMachine([TRANSIENT_RULE()], deps);
    const setFace = newEvent({
      source: 'mcp:set_face',
      category: 'set_face',
      severity: 'medium',
      payload: { emotion: 'HAPPY', balloon: 'FROM_MCP' },
    });
    sm.apply(activeOf(setFace));
    expect(sm.current().balloon).toBe('FROM_MCP');
    // Transient → dies on idle.
    sm.apply(null);
    expect(sm.current().balloon).toBe('');
  });

  it('#20: forceSafeState clears balloon and resets policy', () => {
    const sm = new StateMachine([STICKY_RULE()], deps);
    sm.apply(activeOf(ev('sticky_evt')));
    expect(sm.current().balloon).toBe('RESP');
    sm.forceSafeState();
    expect(sm.current().balloon).toBe('');
    // And the previous sticky is gone — a subsequent idle doesn't resurrect it.
    sm.apply(null);
    expect(sm.current().balloon).toBe('');
  });

  it('#22: transient followed DIRECTLY by a silent rule clears — no apply(null) needed', () => {
    // Regression for a bug found in M13 e2e (2026-07-09). The council covered
    // "transient → apply(null) → promote" (test #6) but the AttentionManager
    // also has a resolve/expire path that goes straight to apply(nextActive)
    // WITHOUT passing through apply(null) — see attention.ts:210-220. If the
    // inheritance path blindly copies the previous {text, policy}, the
    // transient text leaks onto the next event's silent rule.
    const sm = new StateMachine(
      [TRANSIENT_RULE(), SILENT_RULE('subagent_evt')],
      deps,
    );
    sm.apply(activeOf(ev('transient_evt')));
    expect(sm.current().balloon).toBe('PERM');
    // Straight to the next event — no null in between.
    sm.apply(activeOf(ev('subagent_evt')));
    expect(sm.current().balloon).toBe(''); // transient policy → cleared
  });

  it('#21: policy is updated even when statesEqual short-circuits the transition', () => {
    // Two rules produce the same visible ResolvedState (same emotion, decorators,
    // leds, balloon text). Only balloonPolicy differs. If policy is set after
    // #transition, the early-return skips it and the sticky "wins" forever.
    const rules: StateRule[] = [
      {
        match: { category: 'a' },
        balloonPolicy: 'sticky',
        state: { emotion: 'NEUTRAL', balloon: 'SAME' },
      },
      {
        match: { category: 'b' },
        balloonPolicy: 'transient',
        state: { emotion: 'NEUTRAL', balloon: 'SAME' },
      },
    ];
    const sm = new StateMachine(rules, deps);
    sm.apply(activeOf(ev('a'))); // sticky, text SAME
    sm.apply(activeOf(ev('b'))); // transient, same visible state
    sm.apply(null);
    // If policy was correctly updated to 'transient' → cleared.
    // If policy was skipped (bug) → still 'SAME'.
    expect(sm.current().balloon).toBe('');
  });
});
