import { type FSWatcher, readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Logger } from 'pino';
import { parse } from 'yaml';
import { type Config, ConfigSchema } from './schema.js';

/**
 * Minimal structural subset of the future `server/metrics.ts` Metrics
 * registry (M4, SA3) — only what the loader needs. Declared locally so M2
 * doesn't depend on a module that doesn't exist yet in this milestone; the
 * real Metrics class will satisfy this shape without changes (SPEC-FASE-1
 * §2: nothing in a later milestone may force a refactor of an earlier one).
 */
export interface MetricsLike {
  // `inc` takes an optional labelValues record ahead of n so this structurally
  // matches server/metrics.ts's real Counter (M4 wires the real Metrics in
  // here; the shape has to line up without changing this milestone's code).
  counter(name: string): { inc(labelValues?: Record<string, string>, n?: number): void };
  histogram(name: string): { observe(ms: number): void };
}

const DEBOUNCE_MS = 100;
const MISSING_FILE_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

export class ConfigLoader {
  #path: string;
  #logger: Logger;
  #metrics: MetricsLike;
  #current: Config | null = null;
  #watcher: FSWatcher | null = null;
  #debounceTimer: NodeJS.Timeout | null = null;

  constructor(path: string, deps: { logger: Logger; metrics: MetricsLike }) {
    this.#path = path;
    this.#logger = deps.logger;
    this.#metrics = deps.metrics;
  }

  /** Reads, parses and validates the config file. Throws a legible error on failure (startup). */
  load(): Config {
    const raw = readFileSync(this.#path, 'utf8');
    const parsed = parse(raw);
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid config at ${this.#path}: ${formatIssues(result.error.issues)}`);
    }
    this.#current = result.data;
    return result.data;
  }

  current(): Config {
    if (!this.#current) {
      throw new Error('ConfigLoader: current() called before load()');
    }
    return this.#current;
  }

  /**
   * Watches the config file's DIRECTORY, not the file (D-07). `fs.watch` on a
   * file path binds to its inode; an atomic save — temp file + `rename`, what
   * vim, VS Code and `sed -i` all do — swaps the inode and leaves the watcher
   * bound to an orphan. It keeps reporting the rename it saw, then goes deaf
   * forever without a single log line. A directory's inode survives the rename.
   */
  watch(onChange: (next: Config) => void): void {
    const dir = dirname(this.#path);
    const file = basename(this.#path);
    this.#watcher = watch(dir, (_event, changed) => {
      // `changed` is null on the platforms that don't report a filename; treat
      // that as "might be ours" rather than miss the change.
      if (changed !== null && changed !== file) return;
      if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
      this.#debounceTimer = setTimeout(() => {
        void this.#reload(onChange);
      }, DEBOUNCE_MS);
    });
  }

  close(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    this.#watcher?.close();
    this.#watcher = null;
  }

  async #reload(onChange: (next: Config) => void): Promise<void> {
    const start = Date.now();

    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      // Atomic saves (rename) can make the file transiently disappear — retry once.
      await sleep(MISSING_FILE_RETRY_MS);
      try {
        raw = readFileSync(this.#path, 'utf8');
      } catch (err) {
        this.#reloadFailed('config reload failed: file unreadable', err);
        return;
      }
    }

    let parsed: unknown;
    try {
      parsed = parse(raw);
    } catch (err) {
      this.#reloadFailed('config reload failed: invalid YAML', err);
      return;
    }

    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      this.#reloadFailed(
        'config reload failed: schema validation',
        formatIssues(result.error.issues),
      );
      return;
    }

    const previous = this.#current;
    if (
      previous &&
      (previous.server.host !== result.data.server.host ||
        previous.server.port !== result.data.server.port)
    ) {
      this.#logger.warn('server.* changed in config; requires a restart to take effect');
    }

    this.#current = result.data;
    this.#metrics.histogram('config_reload_duration_ms').observe(Date.now() - start);
    onChange(result.data);
  }

  #reloadFailed(message: string, detail: unknown): void {
    this.#logger.warn({ detail }, message);
    this.#metrics.counter('config_reload_failures_total').inc();
  }
}
