import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/bus.js';
import type { Event } from '../src/core/events.js';
import { replay } from '../src/recorder/replay.js';

function tmpFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-replay-'));
  const file = join(dir, 'log.ndjson');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function eventLine(overrides: Partial<Record<string, unknown>> = {}, ts = 1_000): string {
  return JSON.stringify({
    line_type: 'event',
    ts,
    context: { metabolicScore: null, activeMode: 'NORMAL', bleHealthy: true, adapterHealth: {} },
    data: {
      schemaVersion: 1,
      id: `01911f0a-0000-7${Math.random().toString().slice(2, 15)}`,
      source: 'claude',
      category: 'permission',
      severity: 'high',
      hash: 'abcdef1234567890',
      timestamp: ts,
      payload: {},
      ...overrides,
    },
  });
}

describe('replay', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('re-publishes only event lines, counting the rest as skipped', async () => {
    const file = tmpFile([
      eventLine(),
      JSON.stringify({ line_type: 'am_decision', ts: 1, context: {}, data: {} }),
      eventLine(),
      JSON.stringify({ line_type: 'state_change', ts: 1, context: {}, data: {} }),
      eventLine(),
    ]);
    dir = join(file, '..');

    const published: Event[] = [];
    const bus = new EventBus(
      { windowMs: 60_000, autoMuteAfter: 10 },
      { onAccepted: (e) => published.push(e) },
    );

    const result = await replay(file, bus, { instant: true });
    expect(result.published).toBe(3);
    expect(result.skipped).toBe(2);
    expect(published).toHaveLength(3);
    expect(published[0]?.payload.replayedFrom).toBeDefined();
  });

  it('respects timing between events, divided by speed', async () => {
    const file = tmpFile([eventLine({}, 1_000), eventLine({}, 3_000)]);
    dir = join(file, '..');

    const bus = new EventBus({ windowMs: 60_000, autoMuteAfter: 10 }, {});
    const sleep = vi.fn().mockResolvedValue(undefined);

    await replay(file, bus, { speed: 2, sleep });
    expect(sleep).toHaveBeenCalledWith(1_000); // (3000-1000)/2
  });

  it('--instant does not sleep at all', async () => {
    const file = tmpFile([eventLine({}, 1_000), eventLine({}, 5_000)]);
    dir = join(file, '..');

    const bus = new EventBus({ windowMs: 60_000, autoMuteAfter: 10 }, {});
    const sleep = vi.fn().mockResolvedValue(undefined);

    await replay(file, bus, { instant: true, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a corrupt line is skipped without aborting the replay', async () => {
    const file = tmpFile([eventLine(), 'not valid json{{{', eventLine()]);
    dir = join(file, '..');

    const published: Event[] = [];
    const bus = new EventBus(
      { windowMs: 60_000, autoMuteAfter: 10 },
      { onAccepted: (e) => published.push(e) },
    );

    const result = await replay(file, bus, { instant: true });
    expect(result.published).toBe(2);
    expect(result.skipped).toBe(1);
  });
});
