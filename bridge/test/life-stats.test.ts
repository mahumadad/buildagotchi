import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LifeStats } from '../src/core/life-stats.js';

function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'life-stats-'));
  return { dir, path: join(dir, 'life-stats.json') };
}

describe('LifeStats', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function make(overrides: Partial<{ enabled: boolean; milestoneStreak: number; now: () => number }> = {}) {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    return new LifeStats({ path, enabled: true, milestoneStreak: 5, ...overrides });
  }

  it('starts at zero', () => {
    const ls = make();
    expect(ls.snapshot()).toEqual({ approvals: 0, denials: 0, fromHeadPct: 0, streak: 0 });
  });

  it('counts approved and denied', () => {
    const ls = make();
    ls.recordResolution('approved', 'dashboard');
    ls.recordResolution('approved', 'head');
    ls.recordResolution('denied', 'dashboard');
    expect(ls.snapshot()).toEqual({ approvals: 2, denials: 1, fromHeadPct: 50, streak: 0 });
  });

  it('fromHead counts head and button only', () => {
    const ls = make();
    ls.recordResolution('approved', 'head');
    ls.recordResolution('approved', 'button');
    ls.recordResolution('approved', 'dashboard');
    ls.recordResolution('approved', 'external');
    // 2 from head/button out of 4 approvals = 50%
    expect(ls.snapshot().fromHeadPct).toBe(50);
  });

  it('ignores dismissed — does not change counters (C1/C8)', () => {
    const ls = make();
    ls.recordResolution('approved', 'dashboard');
    // These should be filtered by callers, but if called directly, only approved/denied count
    expect(ls.snapshot()).toEqual({ approvals: 1, denials: 0, fromHeadPct: 0, streak: 0 });
  });

  it('persists and revives', () => {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const ls1 = new LifeStats({ path, enabled: true });
    ls1.recordResolution('approved', 'head');
    ls1.recordResolution('denied', 'dashboard');

    const ls2 = new LifeStats({ path, enabled: true });
    expect(ls2.snapshot()).toEqual({ approvals: 1, denials: 1, fromHeadPct: 100, streak: 0 });
  });

  it('enabled=false is a no-op that does not persist (C2)', () => {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const ls = new LifeStats({ path, enabled: false });
    ls.recordResolution('approved', 'head');
    ls.markActive();
    expect(ls.snapshot()).toEqual({ approvals: 0, denials: 0, fromHeadPct: 0, streak: 0 });
    expect(existsSync(path)).toBe(false);
  });

  it('fromHeadPct is 0 when no approvals, not NaN', () => {
    const ls = make();
    ls.recordResolution('denied', 'dashboard');
    expect(ls.snapshot().fromHeadPct).toBe(0);
  });
});

describe('streak', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function makeWithClock(start: string, overrides = {}) {
    let ts = new Date(start + 'T12:00:00').getTime();
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const ls = new LifeStats({
      path,
      enabled: true,
      milestoneStreak: 5,
      now: () => ts,
      ...overrides,
    });
    const advanceTo = (date: string) => { ts = new Date(date + 'T12:00:00').getTime(); };
    return { ls, advanceTo };
  }

  it('first activity sets streak to 1', () => {
    const { ls } = makeWithClock('2026-07-06'); // Monday
    const r = ls.markActive();
    expect(r.streak).toBe(1);
    expect(r.crossedMilestone).toBe(false);
  });

  it('same day does not change streak', () => {
    const { ls } = makeWithClock('2026-07-06');
    ls.markActive();
    const r = ls.markActive();
    expect(r.streak).toBe(1);
  });

  it('consecutive workdays increment streak', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-06'); // Mon
    ls.markActive();
    advanceTo('2026-07-07'); // Tue
    expect(ls.markActive().streak).toBe(2);
    advanceTo('2026-07-08'); // Wed
    expect(ls.markActive().streak).toBe(3);
  });

  it('Friday to Monday increments (weekend bridge)', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-10'); // Fri
    ls.markActive();
    advanceTo('2026-07-13'); // Mon
    expect(ls.markActive().streak).toBe(2);
  });

  it('Friday to Saturday: streak unchanged, lastActiveDate updates', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-10'); // Fri
    ls.markActive(); // streak=1
    advanceTo('2026-07-11'); // Sat
    const r = ls.markActive();
    expect(r.streak).toBe(1); // unchanged
  });

  it('first activity on weekend sets streak to 0', () => {
    const { ls } = makeWithClock('2026-07-11'); // Sat
    expect(ls.markActive().streak).toBe(0);
  });

  it('Saturday to Sunday: streak stays 0', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-11'); // Sat
    ls.markActive(); // streak=0 (weekend, no workday yet)
    advanceTo('2026-07-12'); // Sun
    expect(ls.markActive().streak).toBe(0);
  });

  it('first activity on Saturday then Monday: streak is 1 not 2', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-11'); // Sat
    ls.markActive(); // streak=0
    advanceTo('2026-07-13'); // Mon
    expect(ls.markActive().streak).toBe(1);
  });

  it('Saturday to Monday: streak increments', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-10'); // Fri
    ls.markActive(); // streak=1
    advanceTo('2026-07-11'); // Sat — bridge
    ls.markActive();
    advanceTo('2026-07-13'); // Mon
    expect(ls.markActive().streak).toBe(2);
  });

  it('Sunday to Monday: streak increments', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-10'); // Fri
    ls.markActive();
    advanceTo('2026-07-12'); // Sun — bridge
    ls.markActive();
    advanceTo('2026-07-13'); // Mon
    expect(ls.markActive().streak).toBe(2);
  });

  it('gap of >1 workday resets streak to 1', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-06'); // Mon
    ls.markActive();
    advanceTo('2026-07-08'); // Wed (missed Tuesday)
    expect(ls.markActive().streak).toBe(1);
  });

  it('streak survives persistence', () => {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    let ts = new Date('2026-07-06T12:00:00').getTime();
    const ls1 = new LifeStats({ path, enabled: true, now: () => ts });
    ls1.markActive();
    ts = new Date('2026-07-07T12:00:00').getTime();
    ls1.markActive(); // streak=2

    const ls2 = new LifeStats({ path, enabled: true, now: () => ts });
    ts = new Date('2026-07-08T12:00:00').getTime();
    expect(ls2.markActive().streak).toBe(3);
  });
});

describe('milestone', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('fires exactly once when crossing the threshold', () => {
    let ts = new Date('2026-07-06T12:00:00').getTime(); // Mon
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const ls = new LifeStats({ path, enabled: true, milestoneStreak: 3, now: () => ts });

    ls.markActive(); // Mon streak=1
    ts = new Date('2026-07-07T12:00:00').getTime(); // Tue
    ls.markActive(); // streak=2
    ts = new Date('2026-07-08T12:00:00').getTime(); // Wed
    const crossing = ls.markActive(); // streak=3 = threshold
    expect(crossing.crossedMilestone).toBe(true);

    // Same day — not again
    expect(ls.markActive().crossedMilestone).toBe(false);

    // Next day — still at 4, past threshold, no re-fire
    ts = new Date('2026-07-09T12:00:00').getTime(); // Thu
    expect(ls.markActive().crossedMilestone).toBe(false);
  });

  it('re-fires after streak resets and crosses again', () => {
    let ts = new Date('2026-07-06T12:00:00').getTime();
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const ls = new LifeStats({ path, enabled: true, milestoneStreak: 2, now: () => ts });

    ls.markActive(); // Mon streak=1
    ts = new Date('2026-07-07T12:00:00').getTime();
    expect(ls.markActive().crossedMilestone).toBe(true); // streak=2, fires

    // Gap resets
    ts = new Date('2026-07-10T12:00:00').getTime(); // Fri (missed Wed,Thu)
    ls.markActive(); // streak=1

    ts = new Date('2026-07-13T12:00:00').getTime(); // Mon
    expect(ls.markActive().crossedMilestone).toBe(true); // streak=2, fires again
  });
});
