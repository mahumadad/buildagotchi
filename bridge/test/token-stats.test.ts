import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenStats } from '../src/core/token-stats.js';

/**
 * Two numbers, and they answer different questions.
 *
 * `output` is spend: it only grows. The precedent (claude-desktop-buddy's
 * REFERENCE.md) tracks exactly this, as `tokens` since start and `tokens_today`
 * since local midnight, persisted across restarts.
 *
 * `context` is pressure: how full the window is right now, per session. It
 * climbs on its own and collapses on compaction. It is not summed across
 * sessions — two sessions at 50% are not one session at 100%.
 */

// 2026-07-10 14:00 local, and 2026-07-11 00:30 local.
const TODAY = new Date(2026, 6, 10, 14, 0, 0).getTime();
const PAST_MIDNIGHT = new Date(2026, 6, 11, 0, 30, 0).getTime();

describe('TokenStats', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function statsFile(): string {
    dir = mkdtempSync(join(tmpdir(), 'token-stats-'));
    return join(dir, 'tokens.json');
  }

  function make(now: () => number, path = statsFile()) {
    return { stats: new TokenStats({ path, now }), path };
  }

  it('accumulates output tokens since start and for today', () => {
    const { stats } = make(() => TODAY);
    stats.addOutput(100);
    stats.addOutput(250);
    expect(stats.snapshot().output).toEqual({ sinceStart: 350, today: 350 });
  });

  it('resets `today` at local midnight but never `sinceStart`', () => {
    let now = TODAY;
    const { stats } = make(() => now);
    stats.addOutput(500);

    now = PAST_MIDNIGHT;
    stats.addOutput(30);

    expect(stats.snapshot().output).toEqual({ sinceStart: 530, today: 30 });
  });

  it('persists `today` across a restart on the same day', () => {
    const { stats, path } = make(() => TODAY);
    stats.addOutput(700);

    const revived = new TokenStats({ path, now: () => TODAY });
    expect(revived.snapshot().output.today).toBe(700);
    // sinceStart is "since this process started" — the precedent says so.
    expect(revived.snapshot().output.sinceStart).toBe(0);
  });

  it('does not revive `today` from a previous day', () => {
    const { stats, path } = make(() => TODAY);
    stats.addOutput(700);

    const revived = new TokenStats({ path, now: () => PAST_MIDNIGHT });
    expect(revived.snapshot().output.today).toBe(0);
  });

  it('a corrupt stats file does not take the bridge down', () => {
    const path = statsFile();
    writeFileSync(path, '{ this is not json');
    const stats = new TokenStats({ path, now: () => TODAY });
    expect(stats.snapshot().output.today).toBe(0);
  });

  it('tracks context per session and never sums it across sessions', () => {
    const { stats } = make(() => TODAY);
    stats.setContext('a', 100_000);
    stats.setContext('b', 20_000);

    const snap = stats.snapshot();
    expect(snap.context.bySession).toEqual({ a: 100_000, b: 20_000 });
    // The fullest session is the one under pressure; adding them means nothing.
    expect(snap.context.max).toBe(100_000);
  });

  it('a later sample replaces the earlier one, including a drop after compaction', () => {
    const { stats } = make(() => TODAY);
    stats.setContext('a', 150_000);
    stats.setContext('a', 8_000); // compacted
    expect(stats.snapshot().context.max).toBe(8_000);
  });

  it('forgets a session that ended', () => {
    const { stats } = make(() => TODAY);
    stats.setContext('a', 100_000);
    stats.forgetSession('a');
    expect(stats.snapshot().context).toEqual({ bySession: {}, max: 0 });
  });
});
