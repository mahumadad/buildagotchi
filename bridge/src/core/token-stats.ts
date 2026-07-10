import { readFileSync, writeFileSync } from 'node:fs';
import pino from 'pino';
import { localDateString } from '../recorder/recorder.js';

const logger = pino({ name: 'token-stats' });

export interface TokenStatsSnapshot {
  output: { sinceStart: number; today: number };
  context: { bySession: Record<string, number>; max: number };
}

export interface TokenStatsOptions {
  /** Where `today` survives a restart. */
  path: string;
  now?: () => number;
}

interface PersistedShape {
  day: string;
  today: number;
}

/**
 * Two numbers that answer different questions (D22-style: measure the thing, not
 * a proxy for it).
 *
 * `output` is **spend**. It only grows. Mirrors the precedent in
 * `claude-desktop-buddy/REFERENCE.md`: `tokens` since the process started,
 * `tokens_today` since local midnight and persisted.
 *
 * `context` is **pressure**: how full each session's window is right now. It
 * climbs on its own and collapses when a session compacts. It is deliberately
 * NOT summed across sessions — two sessions at half a window are not one full
 * window. The interesting number is the fullest one.
 */
export class TokenStats {
  #path: string;
  #now: () => number;

  #sinceStart = 0;
  #today = 0;
  #day: string;
  #context = new Map<string, number>();

  constructor(opts: TokenStatsOptions) {
    this.#path = opts.path;
    this.#now = opts.now ?? Date.now;
    this.#day = localDateString(this.#now());
    this.#load();
  }

  addOutput(tokens: number): void {
    this.#rollDayIfNeeded();
    this.#sinceStart += tokens;
    this.#today += tokens;
    this.#save();
  }

  setContext(sessionId: string, tokens: number): void {
    this.#context.set(sessionId, tokens);
  }

  forgetSession(sessionId: string): void {
    this.#context.delete(sessionId);
  }

  snapshot(): TokenStatsSnapshot {
    const bySession = Object.fromEntries(this.#context);
    return {
      output: { sinceStart: this.#sinceStart, today: this.#today },
      context: {
        bySession,
        max: this.#context.size === 0 ? 0 : Math.max(...this.#context.values()),
      },
    };
  }

  /** Local midnight, matching the recorder's own rotation (never UTC). */
  #rollDayIfNeeded(): void {
    const today = localDateString(this.#now());
    if (today === this.#day) return;
    this.#day = today;
    this.#today = 0;
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return; // first run
    }
    try {
      const parsed = JSON.parse(raw) as PersistedShape;
      // Only revive `today` if it IS today. A stale counter reads as real usage.
      if (parsed.day === this.#day && typeof parsed.today === 'number') {
        this.#today = parsed.today;
      }
    } catch (err) {
      logger.warn({ err, path: this.#path }, 'corrupt token stats; starting from zero');
    }
  }

  #save(): void {
    const data: PersistedShape = { day: this.#day, today: this.#today };
    try {
      writeFileSync(this.#path, JSON.stringify(data));
    } catch (err) {
      logger.warn({ err, path: this.#path }, 'could not persist token stats');
    }
  }
}
