import type { Emotion, Severity } from '../core/events.js';

export interface PersonalityPreset {
  name: string;
  idleEmotion: Emotion;
  decoratorsBySeverity: Partial<Record<Severity, string[]>>;
  templates: Record<string, string>;
}

function interpolate(template: string, context: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => context[key] ?? `{${key}}`);
}

const FALLBACK_PRESET: PersonalityPreset = {
  name: 'fallback',
  idleEmotion: 'NEUTRAL',
  decoratorsBySeverity: {},
  templates: {},
};

export class PersonalityManager {
  #preset: PersonalityPreset;
  #customTemplates: Record<string, string>;

  constructor(preset: PersonalityPreset, customTemplates?: Record<string, string>) {
    this.#preset = preset;
    this.#customTemplates = customTemplates ?? {};
  }

  balloon(category: string, context?: Record<string, string>): string | null {
    const template = this.#customTemplates[category] ?? this.#preset.templates[category];
    if (!template) return null;
    return interpolate(template, context ?? {});
  }

  decorators(severity: Severity): string[] {
    return this.#preset.decoratorsBySeverity[severity] ?? [];
  }

  idleEmotion(): Emotion {
    return this.#preset.idleEmotion;
  }

  reload(preset: PersonalityPreset, customTemplates?: Record<string, string>): void {
    this.#preset = preset;
    this.#customTemplates = customTemplates ?? {};
  }

  presetName(): string {
    return this.#preset.name;
  }

  static fallback(): PersonalityPreset {
    return { ...FALLBACK_PRESET };
  }
}
