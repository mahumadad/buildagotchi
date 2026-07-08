import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { AdapterHealth } from '../core/events.js';

const logger = pino({ name: 'recorder' });

export type LineType = 'event' | 'am_decision' | 'state_change' | 'health_change' | 'incident';

export interface RecorderContext {
  metabolicScore: number | null; // null en toda la Fase 1
  activeMode: 'NORMAL' | 'FOCUS' | 'SLEEP';
  bleHealthy: boolean;
  adapterHealth: Record<string, AdapterHealth>;
}

export interface RecorderLine {
  line_type: LineType;
  ts: number;
  replay?: true;
  context: RecorderContext;
  data: Record<string, unknown>;
}

export interface EventRecorderOptions {
  dir: string;
  retentionDays: number;
  now?: () => number;
}

const RING_BUFFER_SIZE = 512;
const FILE_DATE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

function expandHome(dir: string): string {
  return dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
}

function localDateString(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class EventRecorder {
  #dir: string;
  #retentionDays: number;
  #now: () => number;
  #currentDate: string | null = null;
  #fd: number | null = null;
  #ring: RecorderLine[] = [];
  #ioErrors = 0;
  #replayMode = false;

  constructor(opts: EventRecorderOptions) {
    this.#dir = expandHome(opts.dir);
    this.#retentionDays = opts.retentionDays;
    this.#now = opts.now ?? Date.now;
    mkdirSync(this.#dir, { recursive: true });
    this.#applyRetention();
  }

  /** Global flag (§5.5): while true, every recorded line is tagged replay: true. */
  setReplayMode(enabled: boolean): void {
    this.#replayMode = enabled;
  }

  record(rawLine: RecorderLine): void {
    const line = this.#replayMode ? { ...rawLine, replay: true as const } : rawLine;
    this.#ring.push(line);
    if (this.#ring.length > RING_BUFFER_SIZE) {
      this.#ring.shift();
    }

    const date = localDateString(line.ts);
    if (date !== this.#currentDate) {
      this.#rotate(date);
    }

    try {
      if (this.#fd !== null) {
        writeSync(this.#fd, `${JSON.stringify(line)}\n`);
      }
    } catch (err) {
      this.#ioErrors += 1;
      logger.error({ err, ioErrors: this.#ioErrors }, 'failed to write recorder line');
    }
  }

  recent(limit: number): RecorderLine[] {
    return this.#ring.slice(Math.max(0, this.#ring.length - limit));
  }

  async flush(): Promise<void> {
    // writeSync is synchronous — nothing buffered to flush.
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }

  #rotate(date: string): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
    }
    this.#currentDate = date;
    this.#fd = openSync(join(this.#dir, `${date}.ndjson`), 'a');
    this.#applyRetention();
  }

  #applyRetention(): void {
    const cutoff = this.#now() - this.#retentionDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = readdirSync(this.#dir);
    } catch (err) {
      logger.error({ err }, 'failed to read recorder dir for retention');
      return;
    }

    for (const entry of entries) {
      const match = FILE_DATE_RE.exec(entry);
      if (!match) continue;
      const fileDate = new Date(`${match[1]}T00:00:00`).getTime();
      if (fileDate < cutoff) {
        try {
          unlinkSync(join(this.#dir, entry));
        } catch (err) {
          this.#ioErrors += 1;
          logger.error({ err }, 'failed to delete expired recorder file');
        }
      }
    }
  }
}
