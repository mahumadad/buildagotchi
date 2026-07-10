import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ConfigSchema } from '../src/config/schema.js';
import type { ActiveAttention } from '../src/core/attention.js';
import { BalloonHistory } from '../src/core/balloon-history.js';
import { type Event, type ResolvedState, newEvent } from '../src/core/events.js';
import { severityPassesMode } from '../src/core/modes.js';
import { StateMachine, type StateMachineDeps } from '../src/core/state-machine.js';
import { PersonalityManager, type PersonalityPreset } from '../src/personality/personality.js';

/**
 * Full-stack integration for Fase 2.5. These tests drive the REAL config.yaml
 * and REAL preset YAMLs — not fixtures — so the assertions catch drift between
 * the shipped bridge and the specification.
 *
 * The individual milestones (M12a…M16) have unit tests; this file protects the
 * interactions between them. Each case corresponds to one row of §8.2 of
 * SPEC-IMPL-FASE-2.5.
 */

function loadConfig() {
  const raw = parse(readFileSync(join(__dirname, '..', '..', 'config.yaml'), 'utf-8'));
  return ConfigSchema.parse(raw);
}

function loadPreset(name: string): PersonalityPreset {
  const path = join(__dirname, '..', 'presets', 'personalities', `${name}.yaml`);
  return parse(readFileSync(path, 'utf-8')) as PersonalityPreset;
}

function makeSm(personalityName = 'companion'): {
  sm: StateMachine;
  emitted: ResolvedState[];
  history: BalloonHistory;
} {
  const cfg = loadConfig();
  const emitted: ResolvedState[] = [];
  const history = new BalloonHistory(cfg.dashboard.balloonHistorySize);
  const deps: StateMachineDeps = {
    emit: (s) => emitted.push(s),
    record: vi.fn(),
    metrics: {
      counter: () => ({ inc: vi.fn() }),
      gauge: () => ({ set: vi.fn() }),
    },
    balloonHistory: history,
  };
  const personality = new PersonalityManager(loadPreset(personalityName));
  return {
    sm: new StateMachine(cfg.stateRules, deps, personality),
    emitted,
    history,
  };
}

function claudeEvent(category: string, payload: Record<string, unknown>): Event {
  const severity =
    category === 'permission' || category === 'permission_critical' ? 'critical' : 'ambient';
  return newEvent({ source: 'claude', category, severity, payload });
}

function activeOf(e: Event): ActiveAttention {
  return { event: e, deadline: null };
}

describe('Fase 2.5 — integration (M17)', () => {
  it('E2E-1: prompt → response → the balloon persists through idle (S2.5.2 sticky)', () => {
    const { sm } = makeSm();
    sm.apply(activeOf(claudeEvent('prompt', { cwd: '/x/p' })));
    // A rule with no `balloon` inherits (S2.5.2). Nothing yet to inherit.
    expect(sm.current().balloon).toBe('');

    sm.apply(activeOf(claudeEvent('response', { cwd: '/x/p', text: 'listo' })));
    expect(sm.current().balloon).toBe('[p] listo');

    // Idle: response is sticky.
    sm.apply(null);
    expect(sm.current().balloon).toBe('[p] listo');
  });

  it('E2E-2: permission preempts response; resolved clears', () => {
    const { sm } = makeSm();
    sm.apply(activeOf(claudeEvent('response', { cwd: '/x/proj', text: 'previa' })));
    expect(sm.current().balloon).toBe('[proj] previa');

    sm.apply(activeOf(claudeEvent('permission_critical', { cwd: '/x/proj', command: 'rm -rf /' })));
    expect(sm.current().balloon).toBe('proj: ⚠ rm -rf /');
    expect(sm.current().emotion).toBe('DOUBTFUL');

    sm.apply(activeOf(claudeEvent('permission_resolved', { cwd: '/x/proj' })));
    expect(sm.current().balloon).toBe('');
    expect(sm.current().emotion).toBe('HAPPY');
  });

  it('E2E-3: permission expires by TTL; the next promoted event does NOT inherit the text', () => {
    // The bug the council found (verified 2026-07-09): a transient balloon
    // must die when its event stops being active, even when another event is
    // promoted from the queue without going through apply(null).
    const { sm } = makeSm();
    sm.apply(activeOf(claudeEvent('permission_critical', { cwd: '/x/p', command: 'sudo rm' })));
    expect(sm.current().balloon).toBe('p: ⚠ sudo rm');

    // The AM promotes another event directly (resolve/expire path).
    sm.apply(activeOf(claudeEvent('prompt', { cwd: '/x/p' })));
    expect(sm.current().balloon).toBe(''); // transient died
    expect(sm.current().emotion).toBe('NEUTRAL');
  });

  it('E2E-4: in FOCUS, an ambient event does not pass the AM filter (simulated)', () => {
    // The AttentionManager itself rejects the event; we don't drive it here —
    // just verify the mode filter classifies `ambient` as blocked in FOCUS.
    expect(severityPassesMode('ambient', 'FOCUS')).toBe(false);
    expect(severityPassesMode('ambient', 'NORMAL')).toBe(true);
    expect(severityPassesMode('critical', 'SLEEP')).toBe(true);
    expect(severityPassesMode('high', 'SLEEP')).toBe(false);
  });

  it('E2E-5: BalloonHistory only records EFFECTIVE changes (S2.5.11 + M15 §6.4 #7)', () => {
    const { sm, history } = makeSm();

    // Two responses with the SAME text → the second is a no-op transition
    // (statesEqual short-circuits), so the history sees one entry.
    sm.apply(activeOf(claudeEvent('response', { cwd: '/x/p', text: 'igual' })));
    sm.apply(activeOf(claudeEvent('response', { cwd: '/x/p', text: 'igual' })));
    expect(history.recent().length).toBe(1);

    // A different text → new entry.
    sm.apply(activeOf(claudeEvent('response', { cwd: '/x/p', text: 'nuevo' })));
    expect(history.recent().length).toBe(2);
    expect(history.recent()[0]?.text).toBe('[p] nuevo');
    expect(history.recent()[1]?.text).toBe('[p] igual');
  });

  it('E2E-6: mascot preset stays silent for response even though the rule has a balloon', () => {
    // D28: the mascot has no words. Personality wins the TEXT (S2.5.9).
    const { sm } = makeSm('mascot');
    sm.apply(activeOf(claudeEvent('response', { cwd: '/x/p', text: 'hola' })));
    expect(sm.current().balloon).toBe('');
    // But the sound and LEDs from the rule still come through.
    expect(sm.current().sound).toBe('notification');
    expect(sm.current().leds).toContainEqual(
      expect.objectContaining({ row: 'right', color: 'green' }),
    );
  });
});
