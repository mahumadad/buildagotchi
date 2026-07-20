import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ConfigSchema } from '../src/config/schema.js';
import type { ActiveAttention } from '../src/core/attention.js';
import { type Event, type ResolvedState, newEvent } from '../src/core/events.js';
import { StateMachine, type StateMachineDeps } from '../src/core/state-machine.js';
import { PersonalityManager, type PersonalityPreset } from '../src/personality/personality.js';

/**
 * M13 integration tests 6, 7, 8, 10, 11. Everything below drives the REAL
 * config.yaml and REAL preset YAMLs through the StateMachine — a green here
 * means the shipped bridge behaves the way the spec claims.
 */

function loadRealConfig() {
  const raw = parse(readFileSync(join(__dirname, '..', '..', 'config.yaml'), 'utf-8'));
  const parsed = ConfigSchema.parse(raw);
  return parsed;
}

function loadPreset(name: string): PersonalityPreset {
  const path = join(__dirname, '..', 'presets', 'personalities', `${name}.yaml`);
  return parse(readFileSync(path, 'utf-8')) as PersonalityPreset;
}

function makeSM(personality: PersonalityManager | null = null): {
  sm: StateMachine;
  emitted: ResolvedState[];
} {
  const cfg = loadRealConfig();
  const emitted: ResolvedState[] = [];
  const deps: StateMachineDeps = {
    emit: (s) => emitted.push(s),
    record: vi.fn(),
    metrics: {
      counter: () => ({ inc: vi.fn() }),
      gauge: () => ({ set: vi.fn() }),
    },
  };
  return { sm: new StateMachine(cfg.stateRules, deps, personality ?? undefined), emitted };
}

function activeOf(e: Event): ActiveAttention {
  return { event: e, deadline: null };
}

// ── Test 6: permission_resolved clears the balloon ─────────────────────────

describe('M13 integration', () => {
  it('M13-6: permission_resolved rule clears the balloon (real config)', () => {
    const { sm } = makeSM(new PersonalityManager(loadPreset('companion')));
    // First: a permission puts text on the screen.
    sm.apply(
      activeOf(
        newEvent({
          source: 'claude',
          category: 'permission_critical',
          severity: 'critical',
          payload: { cwd: '/tmp/p', command: 'rm -rf /' },
        }),
      ),
    );
    expect(sm.current().balloon).not.toBe('');
    // Then: resolved clears it, both via the rule's `balloon: ""` and the
    // preset's `permission_resolved: ""` — either would suffice; both do.
    sm.apply(
      activeOf(
        newEvent({
          source: 'claude',
          category: 'permission_resolved',
          severity: 'ambient',
          payload: { cwd: '/tmp/p' },
        }),
      ),
    );
    expect(sm.current().balloon).toBe('');
  });

  // ── Test 7: each category → distinct sound ───────────────────────────────

  it('M13-7: each claude category produces its own sound', () => {
    const { sm, emitted } = makeSM();
    for (const category of ['permission', 'permission_critical', 'response', 'notification']) {
      emitted.length = 0;
      sm.forceSafeState();
      sm.apply(
        activeOf(
          newEvent({
            source: 'claude',
            category,
            severity: category.startsWith('permission') ? 'critical' : 'ambient',
            payload: {},
          }),
        ),
      );
    }
    // Sample: permission's sound differs from response's.
    // The verification is per category; drive them one at a time.
    const soundOf = (category: string, severity: 'critical' | 'ambient'): string | undefined => {
      const { sm: sm2 } = makeSM();
      sm2.apply(activeOf(newEvent({ source: 'claude', category, severity, payload: {} })));
      return sm2.current().sound;
    };
    expect(soundOf('permission', 'critical')).toBe('permission');
    // D6: un comando destructivo NO puede sonar como un permiso normal — el
    // oído debe distinguir la alarma antes de mirar la pantalla.
    expect(soundOf('permission_critical', 'critical')).toBe('error');
    expect(soundOf('permission_critical', 'critical')).not.toBe(soundOf('permission', 'critical'));
    expect(soundOf('response', 'ambient')).toBe('notification');
    // `notification` category is silent in the config (Calm Tech: an in-app
    // notification shouldn't chime; the LED speaks for it). Documented here.
    expect(soundOf('notification', 'ambient')).toBeUndefined();
    // And permission ≠ response.
    expect(soundOf('permission', 'critical')).not.toBe(soundOf('response', 'ambient'));
  });

  // ── Test 8: subagent produces NO sound (Calm Tech) ───────────────────────

  it('M13-8: subagent category has no sound', () => {
    const { sm } = makeSM();
    sm.apply(
      activeOf(
        newEvent({
          source: 'claude',
          category: 'subagent',
          severity: 'ambient',
          payload: { sessionId: 's1' },
        }),
      ),
    );
    expect(sm.current().sound).toBeUndefined();
  });

  // ── Test 10: mascot preset silences response.balloon ─────────────────────

  it('M13-10: mascot preset keeps response silent (D28: no words)', () => {
    const { sm } = makeSM(new PersonalityManager(loadPreset('mascot')));
    sm.apply(
      activeOf(
        newEvent({
          source: 'claude',
          category: 'response',
          severity: 'ambient',
          payload: { cwd: '/tmp/p', text: 'hola humano' },
        }),
      ),
    );
    // The mascot template for `response` is `""` → the balloon MUST be empty
    // even though the rule has `balloon: "[{project}] {text}"`. Personality
    // wins the text (S2.5.9).
    expect(sm.current().balloon).toBe('');
    // But cara + emoción del preset sí llegan.
    expect(sm.current().emotion).toBe('HAPPY');
  });

  // ── Test 11: response interpolates AND stays sticky ──────────────────────

  it('M13-11: response with companion interpolates {text} and survives idle (sticky)', () => {
    const { sm } = makeSM(new PersonalityManager(loadPreset('companion')));
    sm.apply(
      activeOf(
        newEvent({
          source: 'claude',
          category: 'response',
          severity: 'ambient',
          payload: { cwd: '/tmp/proj', text: 'listo' },
        }),
      ),
    );
    expect(sm.current().balloon).toBe('[proj] listo');
    // Idle: the balloonPolicy: sticky on the response rule keeps it alive.
    sm.apply(null);
    expect(sm.current().balloon).toBe('[proj] listo');
  });

  it('M13-11-bis: a subsequent silent rule (prompt) inherits the sticky', () => {
    // The user's original complaint ("if I send a prompt, my message is cut")
    // is what this test locks down. `prompt` has no balloon in the rule and no
    // template in companion, so `response` should survive.
    const { sm } = makeSM(new PersonalityManager(loadPreset('companion')));
    sm.apply(
      activeOf(
        newEvent({
          source: 'claude',
          category: 'response',
          severity: 'ambient',
          payload: { cwd: '/tmp/proj', text: 'previa' },
        }),
      ),
    );
    sm.apply(
      activeOf(
        newEvent({
          source: 'claude',
          category: 'prompt',
          severity: 'ambient',
          payload: { cwd: '/tmp/proj', text: 'nueva pregunta' },
        }),
      ),
    );
    // The response text (which is sticky) is still there under the prompt's cara.
    expect(sm.current().balloon).toBe('[proj] previa');
    expect(sm.current().emotion).toBe('NEUTRAL'); // from prompt rule
  });
});
