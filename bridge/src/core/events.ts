import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { EventBus } from './bus.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'ambient';

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'ambient'];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  ambient: 0,
};

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export type Emotion =
  | 'NEUTRAL'
  | 'HAPPY'
  | 'SAD'
  | 'ANGRY'
  | 'SLEEPY'
  | 'DOUBTFUL'
  | 'COLD'
  | 'HOT';

export const EMOTIONS: Emotion[] = [
  'NEUTRAL',
  'HAPPY',
  'SAD',
  'ANGRY',
  'SLEEPY',
  'DOUBTFUL',
  'COLD',
  'HOT',
];

// Shape provisional (Q3, SPEC-FASE-1 §18): se cierra en 1B al ver el firmware stock.
export interface LedCommand {
  row: 'left' | 'right';
  // `| undefined` (not just `?:`), see ResolvedState above.
  index?: number | undefined;
  color: string;
  pattern: string;
}

export interface ResolvedState {
  emotion: Emotion;
  decorators: string[];
  // `| undefined` (not just `?:`) on the optional fields below so this
  // structurally matches zod's inferred optional-field type under
  // `exactOptionalPropertyTypes` (M4 index.ts wires `config.stateRules`
  // straight from ConfigSchema's z.infer into StateRule.state).
  gaze?: 'left' | 'right' | 'center' | undefined;
  leds: LedCommand[];
  sound?: string | undefined;
  servo?: { yaw?: number | undefined; pitch?: number | undefined } | undefined;
  balloon?: string | undefined;
}

export type AdapterHealth = 'HEALTHY' | 'DEGRADED' | 'BROKEN';

export interface Adapter {
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  health(): { status: AdapterHealth; lastEventAt?: number; detail?: string };
}

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'ambient']);

export const EventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    source: z.string().min(1),
    category: z.string().min(1),
    severity: SeveritySchema,
    hash: z.string().min(1),
    timestamp: z.number().positive(),
    direction: z.enum(['left', 'right']).optional(),
    ttlMs: z.number().optional(),
    payload: z.record(z.unknown()),
  })
  .strict();

export type Event = z.infer<typeof EventSchema>;

export interface NewEventInput {
  source: string;
  category: string;
  severity: Severity;
  payload?: Record<string, unknown>;
  hash?: string;
  direction?: 'left' | 'right';
  ttlMs?: number;
}

/** SA9: sha256(source + ' ' + category + ' ' + JSON.stringify(payload)), hex truncado a 16 chars. */
function computeHash(source: string, category: string, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${source} ${category} ${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 16);
}

export function newEvent(input: NewEventInput): Event {
  const payload = input.payload ?? {};
  const event: Event = {
    schemaVersion: 1,
    id: uuidv7(),
    source: input.source,
    category: input.category,
    severity: input.severity,
    hash: input.hash ?? computeHash(input.source, input.category, payload),
    timestamp: Date.now(),
    payload,
  };
  if (input.direction !== undefined) event.direction = input.direction;
  if (input.ttlMs !== undefined) event.ttlMs = input.ttlMs;
  return event;
}
