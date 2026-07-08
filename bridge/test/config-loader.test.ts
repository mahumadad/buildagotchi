import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader, type MetricsLike } from '../src/config/loader.js';

const logger = pino({ level: 'silent' });

function fakeMetrics(): MetricsLike & { failures: number; durations: number[] } {
  const state: MetricsLike & { failures: number; durations: number[] } = {
    failures: 0,
    durations: [],
    counter: () => ({
      inc: () => {
        state.failures += 1;
      },
    }),
    histogram: () => ({
      observe: (ms: number) => {
        state.durations.push(ms);
      },
    }),
  };
  return state;
}

function tmpConfigFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-config-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, content);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const VALID = 'schemaVersion: 1\nattentionManager:\n  ttlBySeverity:\n    high: 2m\n';
const VALID_CHANGED = 'schemaVersion: 1\nattentionManager:\n  ttlBySeverity:\n    high: 5m\n';
const BROKEN = 'schemaVersion: 1\n  bad indent: [\n';

describe('ConfigLoader', () => {
  const loaders: ConfigLoader[] = [];

  afterEach(() => {
    for (const loader of loaders) loader.close();
    loaders.length = 0;
  });

  it('load() parses and validates a config file', () => {
    const path = tmpConfigFile(VALID);
    const loader = new ConfigLoader(path, { logger, metrics: fakeMetrics() });
    loaders.push(loader);
    const config = loader.load();
    expect(config.attentionManager.ttlBySeverity.high).toBe(120_000);
  });

  it('load() throws a legible error for an invalid config', () => {
    const path = tmpConfigFile(BROKEN);
    const loader = new ConfigLoader(path, { logger, metrics: fakeMetrics() });
    loaders.push(loader);
    expect(() => loader.load()).toThrow();
  });

  it('watch(): editing the file triggers onChange with new values', async () => {
    const path = tmpConfigFile(VALID);
    const loader = new ConfigLoader(path, { logger, metrics: fakeMetrics() });
    loaders.push(loader);
    loader.load();

    let received: number | null = null;
    loader.watch((next) => {
      received = next.attentionManager.ttlBySeverity.high;
    });

    // Let the OS-level watcher (FSEvents on macOS) finish arming before writing —
    // an edit synchronous with watch() setup can otherwise be missed.
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, VALID_CHANGED);
    await waitFor(() => received === 300_000);
    expect(loader.current().attentionManager.ttlBySeverity.high).toBe(300_000);
  });

  it('watch(): broken YAML does not call onChange and bumps failures, current() stays intact', async () => {
    const path = tmpConfigFile(VALID);
    const metrics = fakeMetrics();
    const loader = new ConfigLoader(path, { logger, metrics });
    loaders.push(loader);
    loader.load();

    let onChangeCalls = 0;
    loader.watch(() => {
      onChangeCalls += 1;
    });

    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, BROKEN);
    await new Promise((r) => setTimeout(r, 300));

    expect(onChangeCalls).toBe(0);
    expect(metrics.failures).toBeGreaterThan(0);
    expect(loader.current().attentionManager.ttlBySeverity.high).toBe(120_000);
  });

  it('watch(): a subsequent valid write triggers onChange again', async () => {
    const path = tmpConfigFile(VALID);
    const loader = new ConfigLoader(path, { logger, metrics: fakeMetrics() });
    loaders.push(loader);
    loader.load();

    let received: number | null = null;
    loader.watch((next) => {
      received = next.attentionManager.ttlBySeverity.high;
    });

    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, BROKEN);
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path, VALID_CHANGED);
    await waitFor(() => received === 300_000);
  });
});
