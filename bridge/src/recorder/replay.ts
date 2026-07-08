import { readFileSync } from 'node:fs';
import pino from 'pino';
import { z } from 'zod';
import type { EventBus } from '../core/bus.js';
import { type NewEventInput, SeveritySchema, newEvent } from '../core/events.js';

const logger = pino({ name: 'replay' });

/**
 * Loose shape of a recorded event line's `data` — only what replay needs to
 * rebuild a `NewEventInput`. `.passthrough()` because recorded events also
 * carry `hash`/`timestamp`/`schemaVersion`, which replay ignores (a new id
 * and hash are minted for the replayed copy).
 */
const ReplayEventDataSchema = z
  .object({
    id: z.string().min(1).optional(),
    source: z.string().min(1),
    category: z.string().min(1),
    severity: SeveritySchema,
    payload: z.record(z.unknown()).optional(),
    direction: z.enum(['left', 'right']).optional(),
    ttlMs: z.number().optional(),
  })
  .passthrough();

export interface ReplayOptions {
  speed?: number;
  instant?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplayResult {
  published: number;
  skipped: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads an ndjson recorder log and re-publishes its `event` lines to the bus
 * (SPEC-IMPL-FASE-1A §5.5). Every other line type — and any unparseable line
 * — is counted as `skipped`; replay never aborts on a bad line.
 */
export async function replay(
  file: string,
  bus: EventBus,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const speed = opts.speed ?? 1;
  const instant = opts.instant ?? false;

  const raw = readFileSync(file, 'utf8');
  const rawLines = raw.split('\n').filter((l) => l.trim().length > 0);

  let published = 0;
  let skipped = 0;
  let prevTs: number | null = null;

  for (const rawLine of rawLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (err) {
      logger.warn({ err }, 'replay: skipping unparseable line');
      skipped += 1;
      continue;
    }

    const line = parsed as { line_type?: unknown; ts?: unknown; data?: unknown };
    if (line.line_type !== 'event') {
      skipped += 1;
      continue;
    }

    const parsedData = ReplayEventDataSchema.safeParse(line.data);
    if (!parsedData.success) {
      logger.warn({ issues: parsedData.error.issues }, 'replay: skipping malformed event line');
      skipped += 1;
      continue;
    }

    const ts = typeof line.ts === 'number' ? line.ts : Date.now();
    if (!instant && prevTs !== null) {
      const deltaMs = Math.max(0, ts - prevTs) / speed;
      if (deltaMs > 0) await sleep(deltaMs);
    }
    prevTs = ts;

    const data = parsedData.data;
    const input: NewEventInput = {
      source: data.source,
      category: data.category,
      severity: data.severity,
      payload: { ...(data.payload ?? {}), replayedFrom: data.id ?? null },
    };
    if (data.direction !== undefined) input.direction = data.direction;
    if (data.ttlMs !== undefined) input.ttlMs = data.ttlMs;

    bus.publish(newEvent(input));
    published += 1;
  }

  return { published, skipped };
}
