import type { Emotion, Severity } from '../core/events.js';
import { interpolate } from './interpolate.js';

export interface PersonalityPreset {
  name: string;
  idleEmotion: Emotion;
  decoratorsBySeverity: Partial<Record<Severity, string[]>>;
  templates: Record<string, string>;
  /**
   * Categories intentionally left without a template (S2.5.8). The contract
   * test in M13 iterates `CLAUDE_CATEGORIES` × each preset and fails on any
   * category that has neither a template nor a slot here — the same failure
   * mode that hid the vacuous `balloon()` for two phases.
   */
  silentCategories?: string[];
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

  /**
   * Returns the interpolated template for `category`, or `null` if no template
   * exists. `""` (empty string) is a valid return — it means "clear the balloon",
   * distinct from "no template defined" (S2.5.10). The caller must check
   * `!== null`, not falsy.
   */
  balloon(category: string, context?: Record<string, string>): string | null {
    const template = this.#customTemplates[category] ?? this.#preset.templates[category];
    if (template === undefined) return null;
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
