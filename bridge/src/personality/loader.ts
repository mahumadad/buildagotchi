import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { EMOTIONS, type Emotion, SEVERITIES } from '../core/events.js';
import type { PersonalityPreset } from './personality.js';

const PresetSchema = z.object({
  name: z.string(),
  idleEmotion: z.enum(EMOTIONS as [Emotion, ...Emotion[]]),
  decoratorsBySeverity: z
    .record(z.enum(SEVERITIES as [string, ...string[]]), z.array(z.string()))
    .default({}),
  templates: z.record(z.string()).default({}),
});

export function loadPreset(name: string, presetsDir?: string): PersonalityPreset {
  const dir = presetsDir ?? join(import.meta.dirname, '..', '..', 'presets', 'personalities');
  const filePath = join(dir, `${name}.yaml`);
  if (!existsSync(filePath)) {
    return { name: 'fallback', idleEmotion: 'NEUTRAL', decoratorsBySeverity: {}, templates: {} };
  }
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw);
  return PresetSchema.parse(parsed);
}
