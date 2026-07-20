import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { ActiveAttention } from '../src/core/attention.js';
import { newEvent } from '../src/core/events.js';
import { StateMachine, type StateMachineDeps, type StateRule } from '../src/core/state-machine.js';

/**
 * The real config.yaml, fed through the real StateMachine. This tests the two
 * decorators added on 2026-07-10: `sweat` when the context window is about to
 * blow, `heart` when a permission is approved. The firmware can already draw
 * both (renderers/decorator.ts) and so can the emulator (face-renderer.js
 * DECORATOR_MAP) — same emulator-first posture the `angry_mark` decorator has
 * shipped under since phase 2.
 *
 * Loaded from disk like m13-contract.test.ts, so the assertion is against what
 * ships, not a hand-written copy.
 */

function realRules(): StateRule[] {
  const configPath = join(__dirname, '..', '..', 'config.yaml');
  const cfg = parse(readFileSync(configPath, 'utf-8')) as { stateRules: StateRule[] };
  return cfg.stateRules;
}

function deps(): StateMachineDeps {
  return {
    emit: vi.fn(),
    record: vi.fn(),
    metrics: { counter: () => ({ inc: vi.fn() }), gauge: () => ({ set: vi.fn() }) },
  };
}

function active(category: string, payload: Record<string, unknown> = {}): ActiveAttention {
  const severity = category === 'context_high' ? 'high' : 'ambient';
  return { event: newEvent({ source: 'claude', category, severity, payload }), deadline: null };
}

describe('config.yaml decorators', () => {
  it('context_high wears sweat', () => {
    const sm = new StateMachine(realRules(), deps());
    sm.apply(active('context_high', { cwd: '/x/proj', pct: 95 }));
    expect(sm.current().decorators).toContain('sweat');
    expect(sm.current().emotion).toBe('SAD');
  });

  it('permission_resolved wears heart', () => {
    const sm = new StateMachine(realRules(), deps());
    sm.apply(active('permission_resolved', { cwd: '/x/proj' }));
    expect(sm.current().decorators).toContain('heart');
    expect(sm.current().emotion).toBe('HAPPY');
  });

  it('a benign permission carries no decorator — sweat is for pressure, not routine', () => {
    const sm = new StateMachine(realRules(), deps());
    sm.apply(active('permission', { cwd: '/x/proj', command: 'ls' }));
    expect(sm.current().decorators).toEqual([]);
  });

  it('prompt wears thinking while Claude is working', () => {
    const sm = new StateMachine(realRules(), deps());
    sm.apply(active('prompt', { cwd: '/x/proj', text: 'hola' }));
    expect(sm.current().decorators).toContain('thinking');
    expect(sm.current().emotion).toBe('NEUTRAL');
  });

  it('every decorator the config names is one the emulator can draw', () => {
    // The bug this guards against is the whole point of the day: a decorator the
    // config asks for that the renderer does not know, so it silently no-ops.
    const KNOWN = new Set(['heart', 'angry_mark', 'sweat', 'sleepy_z', 'bubble', 'hot_steam', 'thinking']);
    const used = new Set<string>();
    for (const rule of realRules()) {
      for (const d of rule.state.decorators ?? []) used.add(d);
    }
    for (const d of used)
      expect(KNOWN.has(d), `decorator "${d}" is not in the renderer's map`).toBe(true);
  });
});
