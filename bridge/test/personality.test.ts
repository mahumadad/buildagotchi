import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newEvent } from '../src/core/events.js';
import type { StateRule } from '../src/core/state-machine.js';
import { StateMachine } from '../src/core/state-machine.js';
import { loadPreset } from '../src/personality/loader.js';
import { PersonalityManager } from '../src/personality/personality.js';

const PRESETS_DIR = join(import.meta.dirname, '..', 'presets', 'personalities');

function deps() {
  return {
    emit: vi.fn(),
    record: vi.fn(),
    metrics: {
      counter: () => ({ inc: vi.fn() }),
      gauge: () => ({ set: vi.fn() }),
    },
  };
}

describe('loadPreset', () => {
  it('loads the companion preset with its templates', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    expect(preset.name).toBe('companion');
    expect(preset.idleEmotion).toBe('NEUTRAL');
    expect(preset.templates['permission']).toBe('{project}: {command}');
  });

  it('falls back to a minimal preset when the file is missing, without crashing', () => {
    const preset = loadPreset('does-not-exist', PRESETS_DIR);
    expect(preset).toEqual({
      name: 'fallback',
      idleEmotion: 'NEUTRAL',
      decoratorsBySeverity: {},
      templates: {},
    });
  });
});

describe('PersonalityManager', () => {
  it('interpolates balloon templates with the given context', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    expect(manager.balloon('permission', { project: 'myapp' })).toBe('myapp: {command}');
  });

  it('leaves unresolved placeholders untouched when a variable is missing', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    expect(manager.balloon('permission', {})).toBe('{project}: {command}');
  });

  it('returns null for an unknown category', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    expect(manager.balloon('unknown.category')).toBeNull();
  });

  it('returns the decorators configured for a severity', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    expect(manager.decorators('critical')).toEqual(['angry_mark']);
  });

  it('exposes the idle emotion for the companion preset', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    expect(manager.idleEmotion()).toBe('NEUTRAL');
  });

  it('exposes the idle emotion for the critic preset', () => {
    const preset = loadPreset('critic', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    expect(manager.idleEmotion()).toBe('DOUBTFUL');
  });

  it('prefers custom templates over the preset templates', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset, {
      permission: 'custom override',
    });
    expect(manager.balloon('permission', { project: 'myapp' })).toBe('custom override');
  });

  it('reload() swaps the active preset and its templates', () => {
    const companion = loadPreset('companion', PRESETS_DIR);
    const supervisor = loadPreset('supervisor', PRESETS_DIR);
    const manager = new PersonalityManager(companion);
    expect(manager.balloon('permission', { project: 'myapp' })).toBe('myapp: {command}');
    manager.reload(supervisor);
    expect(manager.balloon('permission', { project: 'myapp' })).toBe('Autorización requerida');
    expect(manager.presetName()).toBe('supervisor');
  });
});

describe('StateMachine with personality', () => {
  const RULES: StateRule[] = [
    { match: { category: 'permission' }, state: { emotion: 'DOUBTFUL' } },
    { match: { severity: 'critical' }, state: { emotion: 'ANGRY' } },
  ];

  it('attaches a balloon from the personality preset to the resolved state', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    const sm = new StateMachine(RULES, deps(), manager);
    const e = newEvent({
      source: 'claude',
      category: 'permission',
      severity: 'high',
      payload: { cwd: '/Users/x/myapp', command: 'ls -la' },
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().balloon).toBe('myapp: ls -la');
  });

  // D-08: this test used to omit `command` and assert that the literal
  // `myapp: {command}` reached the screen — the bug, written down as an
  // expectation. The StateMachine now refuses to render a template whose
  // placeholders didn't all resolve.
  it('never renders a preset template with an unresolved placeholder', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    const sm = new StateMachine(RULES, deps(), manager);
    const e = newEvent({
      source: 'claude',
      category: 'permission',
      severity: 'high',
      payload: { cwd: '/Users/x/myapp' }, // no `command`
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().balloon).toBe('');
  });

  it('uses the personality idle emotion when there is no active attention', () => {
    const preset = loadPreset('critic', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    const sm = new StateMachine(RULES, deps(), manager);
    sm.apply(null);
    expect(sm.current().emotion).toBe('DOUBTFUL');
  });

  it('merges personality decorators with the rule decorators for the event severity', () => {
    const preset = loadPreset('companion', PRESETS_DIR);
    const manager = new PersonalityManager(preset);
    const sm = new StateMachine(RULES, deps(), manager);
    const e = newEvent({
      source: 'claude',
      category: 'permission',
      severity: 'critical',
      payload: {},
    });
    sm.apply({ event: e, deadline: null });
    expect(sm.current().decorators).toEqual(['angry_mark']);
  });
});
