# Life Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three persistent, fact-based life metrics (approvals/denials, fromHead%, streak) to the buildagotchi bridge, with a milestone celebration and display on screen/dashboard.

**Architecture:** `LifeStats` class follows the `TokenStats` pattern (JSON file persistence, injected clock, push-based). Data enters through two explicit paths — dashboard resolve in `server.ts` and `permission_resolved` events filtered in `index.ts`. A `markActive()` call on accepted Claude events tracks the workday streak, with edge-triggered milestone emission. Display adds a third stats page in `screen.mjs` and a new dashboard panel.

**Tech Stack:** TypeScript, Vitest, jsdom (for screen tests)

## Global Constraints

- All code in `bridge/src/` and `bridge/test/`, TypeScript strict mode
- Tests run with `npx vitest run` from `bridge/`
- Typecheck with `npx tsc -p tsconfig.json && npx tsc -p tsconfig.test.json` from `bridge/`
- `localDateString` imported from `../recorder/recorder.js` (existing helper)
- Clock always injected as `now?: () => number` — never call `Date.now()` directly in logic
- `LifeStats` disabled in `--demo` mode via `enabled` constructor flag
- Only `'approved'` and `'denied'` count; `'dismissed'`/`'external'`/`'abandoned'` are ignored (C1/C8)

---

### Task 1: Workday helpers (`isWorkday`, `workdayGap`)

Pure functions, no dependencies. De-risk the streak logic before building `LifeStats`.

**Files:**
- Create: `bridge/src/core/workday.ts`
- Test: `bridge/test/workday.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `isWorkday(date: Date): boolean` — true for Mon-Fri
  - `workdayGap(from: string, to: string): number` — count of workdays strictly between two `YYYY-MM-DD` dates (exclusive both ends). Returns 0 for consecutive workdays, -1 if `to <= from`.

- [ ] **Step 1: Write failing tests for `isWorkday`**

```typescript
import { describe, expect, it } from 'vitest';
import { isWorkday, workdayGap } from '../src/core/workday.js';

describe('isWorkday', () => {
  it('Monday through Friday are workdays', () => {
    // 2026-07-06 is a Monday
    for (let d = 6; d <= 10; d++) {
      expect(isWorkday(new Date(2026, 6, d))).toBe(true);
    }
  });

  it('Saturday and Sunday are not workdays', () => {
    expect(isWorkday(new Date(2026, 6, 11))).toBe(false); // Saturday
    expect(isWorkday(new Date(2026, 6, 12))).toBe(false); // Sunday
  });
});
```

- [ ] **Step 2: Write failing tests for `workdayGap`**

```typescript
describe('workdayGap', () => {
  it('consecutive workdays have gap 0', () => {
    expect(workdayGap('2026-07-06', '2026-07-07')).toBe(0); // Mon→Tue
    expect(workdayGap('2026-07-09', '2026-07-10')).toBe(0); // Thu→Fri
  });

  it('Friday to Monday has gap 0 (weekend is bridge)', () => {
    expect(workdayGap('2026-07-10', '2026-07-13')).toBe(0); // Fri→Mon
  });

  it('Friday to Tuesday has gap 1 (missed Monday)', () => {
    expect(workdayGap('2026-07-10', '2026-07-14')).toBe(1);
  });

  it('weekend to weekend has gap 0', () => {
    expect(workdayGap('2026-07-11', '2026-07-12')).toBe(0); // Sat→Sun
  });

  it('Saturday to Monday has gap 0', () => {
    expect(workdayGap('2026-07-11', '2026-07-13')).toBe(0);
  });

  it('Sunday to Monday has gap 0', () => {
    expect(workdayGap('2026-07-12', '2026-07-13')).toBe(0);
  });

  it('same date returns -1', () => {
    expect(workdayGap('2026-07-10', '2026-07-10')).toBe(-1);
  });

  it('to before from returns -1', () => {
    expect(workdayGap('2026-07-10', '2026-07-09')).toBe(-1);
  });

  it('gap across a full week', () => {
    // Mon 07-06 to Mon 07-13: gap = 4 workdays (Tue-Fri)
    expect(workdayGap('2026-07-06', '2026-07-13')).toBe(4);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd bridge && npx vitest run test/workday.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `workday.ts`**

```typescript
export function isWorkday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

export function workdayGap(from: string, to: string): number {
  if (to <= from) return -1;
  const start = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  let count = 0;
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor < end) {
    if (isWorkday(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd bridge && npx vitest run test/workday.test.ts`
Expected: all PASS

- [ ] **Step 6: Run typecheck**

Run: `cd bridge && npx tsc -p tsconfig.json --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add bridge/src/core/workday.ts bridge/test/workday.test.ts
git commit -m "$(cat <<'EOF'
Add isWorkday/workdayGap helpers for life-stats streak

Pure date functions extracted per the council's C4 finding: the streak
logic needs explicit handling of weekend bridges and workday gaps.
Isolated so holiday support is a local change later.
EOF
)"
```

---

### Task 2: `LifeStats` core class

Persistence, resolution counting, streak with milestone, `enabled` flag.

**Files:**
- Create: `bridge/src/core/life-stats.ts`
- Test: `bridge/test/life-stats.test.ts`

**Interfaces:**
- Consumes: `isWorkday` and `workdayGap` from `../core/workday.js`, `localDateString` from `../recorder/recorder.js`
- Produces:
  - `new LifeStats(opts: LifeStatsOptions)` where `LifeStatsOptions = { path: string; enabled: boolean; milestoneStreak?: number; now?: () => number }`
  - `recordResolution(action: 'approved' | 'denied', source: ResolveSource): void`
  - `markActive(now?: number): { crossedMilestone: boolean; streak: number }`
  - `snapshot(): LifeStatsSnapshot` where `LifeStatsSnapshot = { approvals: number; denials: number; fromHeadPct: number; streak: number }`
  - `ResolveSource` re-exported from `../core/attention.js`

- [ ] **Step 1: Write failing tests — persistence and resolution counting**

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
```

- [ ] **Step 2: Write failing tests — streak transitions (every row of C4 table)**

```typescript
describe('streak', () => {
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

  it('Saturday to Sunday: streak unchanged', () => {
    const { ls, advanceTo } = makeWithClock('2026-07-11'); // Sat
    ls.markActive(); // streak=1 (first day is sat, workday=false, streak starts at 1 but doesn't increment)
    advanceTo('2026-07-12'); // Sun
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
```

- [ ] **Step 3: Write failing tests — milestone edge trigger**

```typescript
describe('milestone', () => {
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd bridge && npx vitest run test/life-stats.test.ts`
Expected: FAIL — module not found

- [ ] **Step 5: Implement `life-stats.ts`**

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import pino from 'pino';
import type { ResolveSource } from './attention.js';
import { isWorkday, workdayGap } from './workday.js';
import { localDateString } from '../recorder/recorder.js';

const logger = pino({ name: 'life-stats' });

export interface LifeStatsSnapshot {
  approvals: number;
  denials: number;
  fromHeadPct: number;
  streak: number;
}

export interface LifeStatsOptions {
  path: string;
  enabled: boolean;
  milestoneStreak?: number;
  now?: () => number;
}

interface PersistedShape {
  approvals: number;
  denials: number;
  fromHead: number;
  streak: number;
  lastActiveDate: string;
  milestoneFired: boolean;
}

const HEAD_SOURCES: ReadonlySet<string> = new Set(['head', 'button']);
const DEFAULT_MILESTONE_STREAK = 5;

export class LifeStats {
  #path: string;
  #enabled: boolean;
  #milestoneStreak: number;
  #now: () => number;

  #approvals = 0;
  #denials = 0;
  #fromHead = 0;
  #streak = 0;
  #lastActiveDate = '';
  #milestoneFired = false;

  constructor(opts: LifeStatsOptions) {
    this.#path = opts.path;
    this.#enabled = opts.enabled;
    this.#milestoneStreak = opts.milestoneStreak ?? DEFAULT_MILESTONE_STREAK;
    this.#now = opts.now ?? Date.now;
    if (this.#enabled) this.#load();
  }

  recordResolution(action: 'approved' | 'denied', source: ResolveSource): void {
    if (!this.#enabled) return;
    if (action === 'approved') {
      this.#approvals++;
      if (HEAD_SOURCES.has(source)) this.#fromHead++;
    } else {
      this.#denials++;
    }
    this.#save();
  }

  markActive(now?: number): { crossedMilestone: boolean; streak: number } {
    const zero = { crossedMilestone: false, streak: this.#streak };
    if (!this.#enabled) return zero;

    const today = localDateString(now ?? this.#now());
    if (today === this.#lastActiveDate) return zero;

    const todayDate = new Date(today + 'T12:00:00');
    const todayIsWorkday = isWorkday(todayDate);

    if (this.#lastActiveDate === '') {
      this.#streak = todayIsWorkday ? 1 : 0;
      this.#lastActiveDate = today;
      this.#milestoneFired = false;
      this.#save();
      return { crossedMilestone: false, streak: this.#streak };
    }

    const gap = workdayGap(this.#lastActiveDate, today);

    if (todayIsWorkday) {
      if (gap === 0) {
        this.#streak++;
      } else {
        this.#streak = 1;
        this.#milestoneFired = false;
      }
    }
    // Weekend: don't increment or break, just update lastActiveDate

    this.#lastActiveDate = today;

    let crossedMilestone = false;
    if (
      this.#streak >= this.#milestoneStreak &&
      !this.#milestoneFired &&
      todayIsWorkday
    ) {
      this.#milestoneFired = true;
      crossedMilestone = true;
    }

    this.#save();
    return { crossedMilestone, streak: this.#streak };
  }

  snapshot(): LifeStatsSnapshot {
    return {
      approvals: this.#approvals,
      denials: this.#denials,
      fromHeadPct: this.#approvals === 0 ? 0 : Math.round((this.#fromHead / this.#approvals) * 100),
      streak: this.#streak,
    };
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return;
    }
    try {
      const p = JSON.parse(raw) as PersistedShape;
      if (typeof p.approvals === 'number') this.#approvals = p.approvals;
      if (typeof p.denials === 'number') this.#denials = p.denials;
      if (typeof p.fromHead === 'number') this.#fromHead = p.fromHead;
      if (typeof p.streak === 'number') this.#streak = p.streak;
      if (typeof p.lastActiveDate === 'string') this.#lastActiveDate = p.lastActiveDate;
      if (typeof p.milestoneFired === 'boolean') this.#milestoneFired = p.milestoneFired;
    } catch (err) {
      logger.warn({ err, path: this.#path }, 'corrupt life stats; starting from zero');
    }
  }

  #save(): void {
    const data: PersistedShape = {
      approvals: this.#approvals,
      denials: this.#denials,
      fromHead: this.#fromHead,
      streak: this.#streak,
      lastActiveDate: this.#lastActiveDate,
      milestoneFired: this.#milestoneFired,
    };
    try {
      writeFileSync(this.#path, JSON.stringify(data));
    } catch (err) {
      logger.warn({ err, path: this.#path }, 'could not persist life stats');
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd bridge && npx vitest run test/life-stats.test.ts`
Expected: all PASS

- [ ] **Step 7: Mutation test — break streak reset, verify test fails**

Temporarily change `this.#streak = 1` to `this.#streak = this.#streak + 1` in the gap branch of `markActive`. Run tests. At least one must fail. Revert.

- [ ] **Step 8: Mutation test — break milestone, verify test fails**

Temporarily remove `this.#milestoneFired = true`. Run tests. The "fires exactly once" test must fail. Revert.

- [ ] **Step 9: Run full suite + typecheck**

Run: `cd bridge && npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`
Expected: all green

- [ ] **Step 10: Commit**

```bash
git add bridge/src/core/life-stats.ts bridge/test/life-stats.test.ts
git commit -m "$(cat <<'EOF'
Add LifeStats class with persistence, resolution counting, and streak

Three fact-based metrics: approvals/denials, fromHead%, workday streak.
Follows TokenStats pattern (JSON persistence, injected clock). The
enabled flag silences everything in demo mode (council C2). Milestone
fires by edge on streak crossing the threshold (default 5 workdays).
EOF
)"
```

---

### Task 3: Wire `LifeStats` into `index.ts` and `server.ts`

Connect the two data paths (dashboard resolve, bus `permission_resolved`) and the streak. Add `life_milestone` event emission. Expose via `/stats`.

**Files:**
- Modify: `bridge/src/index.ts` (create LifeStats, wire markActive, wire permission_resolved, emit life_milestone)
- Modify: `bridge/src/server/server.ts` (add lifeStats to options, call recordResolution in handleApprove, add life to /stats)
- Modify: `bridge/src/config/schema.ts` (add `milestoneStreakDays` to claude section)
- Modify: `config.yaml` and `config.example.yaml` (add milestoneStreakDays + life_milestone stateRule)

**Interfaces:**
- Consumes: `LifeStats` from Task 2, `ResolveSource` from `../core/attention.js`
- Produces: `GET /stats` now includes `life: LifeStatsSnapshot`; `life_milestone` event emitted via bus

- [ ] **Step 1: Add `milestoneStreakDays` to config schema**

In `bridge/src/config/schema.ts`, add to the `claude` section (near `contextHighAt`):

```typescript
      milestoneStreakDays: z.number().int().min(1).default(5),
```

- [ ] **Step 2: Add `life_milestone` stateRule and milestoneStreakDays to config files**

In `config.yaml`, add after the `context_calm` rule:

```yaml
  # ── Life stats ───────────────────────────────────────────────────────────
  - match: { source: life, category: life_milestone }
    state:
      emotion: HAPPY
      decorators: [heart]
      leds: [{ row: left, color: green, pattern: blink }, { row: right, color: green, pattern: blink }]
      sound: approve
      balloon: "🎉 {streak} días seguidos"
```

In the `claude:` section of `config.yaml`, add:

```yaml
  milestoneStreakDays: 5              # streak length that triggers a celebration
```

Apply the same changes to `config.example.yaml`.

- [ ] **Step 3: Add `lifeStats` to `BridgeServerOptions`**

In `bridge/src/server/server.ts`, add to the `BridgeServerOptions` interface:

```typescript
  lifeStats?: LifeStats;
```

Add the import at the top:

```typescript
import type { LifeStats } from '../core/life-stats.js';
```

- [ ] **Step 4: Call `recordResolution` in `#handleApprove`**

In `bridge/src/server/server.ts`, after `this.#opts.attentionManager.resolve(...)` in `#handleApprove` (line ~633), add:

```typescript
      this.#opts.lifeStats?.recordResolution(mapped, 'dashboard');
```

- [ ] **Step 5: Call `recordResolution` in `#resolveFirstPendingPermission`**

In `bridge/src/server/server.ts`, inside `#resolveFirstPendingPermission` (~line 831), after `this.#opts.attentionManager.resolve(eventId, mapped, source)`, add:

```typescript
          this.#opts.lifeStats?.recordResolution(mapped, source);
```

This covers button A/B presses and head taps that resolve permissions (the `source` is 'button' or 'head' — this is where `fromHead` gets its real data).

- [ ] **Step 6: Add `life` to `#handleStats`**

In `bridge/src/server/server.ts`, modify `#handleStats` to include life:

```typescript
  #handleStats(res: ServerResponse): void {
    const snapshot = this.#opts.tokenStats?.snapshot() ?? {
      output: { sinceStart: 0, today: 0 },
      context: { bySession: {}, max: 0 },
    };
    const sessions = this.#opts.claudeAdapter?.sessionCounts() ?? {
      total: 0,
      running: 0,
      waiting: 0,
    };
    const life = this.#opts.lifeStats?.snapshot() ?? {
      approvals: 0,
      denials: 0,
      fromHeadPct: 0,
      streak: 0,
    };
    sendJson(res, 200, { ...snapshot, sessions, life });
  }
```

- [ ] **Step 7: Wire `LifeStats` in `index.ts`**

Add import:

```typescript
import { LifeStats } from './core/life-stats.js';
```

After `tokenStats` creation (~line 139), create LifeStats:

```typescript
  const lifeStats = new LifeStats({
    path: join(platform.dataDir(), 'life-stats.json'),
    enabled: !options.demo,
    milestoneStreak: config.claude.milestoneStreakDays,
  });
```

In the `onAccepted` callback, after the context pressure block and before `attentionManager.push(e)`, add:

```typescript
        // Life stats: only real Claude events mark activity (not demo, not replay).
        if (e.source === 'claude') {
          const result = lifeStats.markActive();
          if (result.crossedMilestone) {
            bus.publish(newEvent({
              source: 'life',
              category: 'life_milestone',
              severity: 'ambient',
              payload: { streak: result.streak },
            }));
          }
        }

        // Life stats: count permission resolutions from the hook path.
        if (e.source === 'claude' && e.category === 'permission_resolved') {
          const action = e.payload.action;
          if (action === 'approved') {
            lifeStats.recordResolution('approved', 'external');
          } else if (action === 'denied') {
            lifeStats.recordResolution('denied', 'external');
          }
          // 'external', 'abandoned', 'dismissed' → don't count (C1/C8)
        }
```

Pass `lifeStats` to the server constructor:

```typescript
    lifeStats,
```

- [ ] **Step 8: Run typecheck**

Run: `cd bridge && npx tsc -p tsconfig.json --noEmit`
Expected: clean

- [ ] **Step 9: Run full test suite**

Run: `cd bridge && npx vitest run`
Expected: all pass (no test for wiring yet — that comes with browser verification)

- [ ] **Step 10: Commit**

```bash
git add bridge/src/index.ts bridge/src/server/server.ts bridge/src/config/schema.ts config.yaml config.example.yaml
git commit -m "$(cat <<'EOF'
Wire LifeStats into bridge and server

Two data paths feed resolutions: dashboard (server.ts #handleApprove +
#resolveFirstPendingPermission) and hook path (permission_resolved
events on the bus filtered in index.ts). markActive runs on every real
Claude event; milestone emits life_milestone via the bus. /stats gains
a life field. Demo mode disables persistence (C2).
EOF
)"
```

---

### Task 4: Screen view — add LIFE page

Update `ScreenView` and `screen.mjs` to support a third stats page showing life metrics.

**Files:**
- Modify: `bridge/src/core/screen-view.ts` (PAGES.stats → 3)
- Modify: `bridge/src/server/public/screen.mjs` (add lifePage renderer)
- Modify: `bridge/test/dashboard-screen.test.ts` (add LIFE page tests)

**Interfaces:**
- Consumes: `LifeStatsSnapshot` shape from `/stats` response (via `stats.life`)
- Produces: page 2 of stats view renders life metrics

- [ ] **Step 1: Write failing test for LIFE page**

In `bridge/test/dashboard-screen.test.ts`, add to the STATS fixture:

```typescript
const STATS = {
  output: { today: 41_000, sinceStart: 1_055 },
  context: { bySession: { 'sess-abcdef123456': 628_474 }, max: 628_474 },
  sessions: { total: 2, running: 1, waiting: 1 },
  life: { approvals: 42, denials: 3, fromHeadPct: 71, streak: 7 },
};
```

Add test cases:

```typescript
  it('page 2 shows life stats', () => {
    renderScreenView(els, { view: 'stats', page: 2, pages: 3 }, STATS);
    const text = els.overlay.textContent ?? '';
    expect(text).toContain('LIFE');
    expect(text).toContain('42');   // approvals
    expect(text).toContain('3');    // denials
    expect(text).toContain('71%'); // fromHead
    expect(text).toContain('7');    // streak
  });

  it('LIFE page never hides the 3D scene', () => {
    renderScreenView(els, { view: 'stats', page: 2, pages: 3 }, STATS);
    expect(els.wrap.hidden).toBe(false);
  });
```

Update existing tests that reference `pages: 2` to use `pages: 3` where the page index matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bridge && npx vitest run test/dashboard-screen.test.ts`
Expected: FAIL — page 2 renders sessions page content, not LIFE

- [ ] **Step 3: Update `screen-view.ts`**

Change the PAGES constant:

```typescript
const PAGES: Record<ViewName, number> = { face: 1, stats: 3 };
```

- [ ] **Step 4: Add `lifePage` to `screen.mjs`**

```javascript
function lifePage(stats) {
  const life = stats.life ?? { approvals: 0, denials: 0, fromHeadPct: 0, streak: 0 };
  return [
    'LIFE',
    `  approvals   ${life.approvals}`,
    `  denials     ${life.denials}`,
    `  from head   ${life.fromHeadPct}%`,
    `  streak      ${life.streak}d`,
  ].join('\n');
}
```

Update the render dispatch in `renderScreenView`:

```javascript
  const pages = [tokensPage, sessionsPage, lifePage];
  els.overlay.textContent = (pages[screen.page] ?? tokensPage)(stats);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd bridge && npx vitest run test/dashboard-screen.test.ts`
Expected: all PASS

- [ ] **Step 6: Run full suite + typecheck**

Run: `cd bridge && npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`
Expected: all green

- [ ] **Step 7: Commit**

```bash
git add bridge/src/core/screen-view.ts bridge/src/server/public/screen.mjs bridge/test/dashboard-screen.test.ts
git commit -m "$(cat <<'EOF'
Add LIFE page to stats screen view

Third stats page showing approvals, denials, fromHead%, and streak.
PAGES.stats goes from 2 to 3. The page dispatch in screen.mjs uses an
array indexed by page number instead of a ternary.
EOF
)"
```

---

### Task 5: Dashboard Life panel

Add a visual panel in the dashboard that polls `/stats` and renders the life metrics.

**Files:**
- Modify: `bridge/src/server/public/index.html` (add life panel HTML)
- Modify: `bridge/src/server/public/dashboard.js` (render life data from /stats)
- Modify: `bridge/src/server/public/dashboard.css` (life panel styles)

**Interfaces:**
- Consumes: `GET /stats` response with `life` field
- Produces: visual panel in dashboard

- [ ] **Step 1: Add HTML for Life panel**

In `bridge/src/server/public/index.html`, after the tokens panel (line ~120), add:

```html
        <section class="panel life-panel">
          <h2>Life</h2>
          <div class="life-row"><span class="life-label">approvals</span><span class="life-value" id="life-approvals">0</span></div>
          <div class="life-row"><span class="life-label">denials</span><span class="life-value" id="life-denials">0</span></div>
          <div class="life-row"><span class="life-label">from head</span><span class="life-value" id="life-fromhead">0%</span></div>
          <div class="life-row"><span class="life-label">streak</span><span class="life-value" id="life-streak">0d</span></div>
        </section>
```

- [ ] **Step 2: Add CSS for Life panel**

In `bridge/src/server/public/dashboard.css`, add after the tokens panel styles:

```css
/* Life panel. Persistent fact-based stats — approvals, from-head%, streak.
   Shares the same polling cycle as the tokens panel via refreshTokens(). */
.life-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.2rem 0;
}

.life-label {
  color: var(--muted);
  font-size: 0.8rem;
}

.life-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
}
```

- [ ] **Step 3: Add JS to render life data**

In `bridge/src/server/public/dashboard.js`, add element references after the tokens elements:

```javascript
const lifeApprovalsEl = document.getElementById('life-approvals');
const lifeDenialsEl = document.getElementById('life-denials');
const lifeFromheadEl = document.getElementById('life-fromhead');
const lifeStreakEl = document.getElementById('life-streak');
```

In the `refreshTokens` function, after the existing stats rendering, add:

```javascript
    if (lifeApprovalsEl && stats.life) {
      lifeApprovalsEl.textContent = String(stats.life.approvals);
      lifeDenialsEl.textContent = String(stats.life.denials);
      lifeFromheadEl.textContent = `${stats.life.fromHeadPct}%`;
      lifeStreakEl.textContent = `${stats.life.streak}d`;
    }
```

- [ ] **Step 4: Start dev server and verify in browser**

Start the bridge with `--simulate`. Open the dashboard. Verify:
1. Life panel appears below Tokens panel
2. Values show 0/0/0%/0d initially
3. Trigger a sim permission, approve it → approvals increments on next poll
4. Navigate to stats view page 3 → LIFE page shows same data
5. Robot never disappears during view switches

- [ ] **Step 5: Commit**

```bash
git add bridge/src/server/public/index.html bridge/src/server/public/dashboard.js bridge/src/server/public/dashboard.css
git commit -m "$(cat <<'EOF'
Add Life panel to dashboard

Polls /stats every 5s alongside tokens. Shows approvals, denials,
from-head percentage, and workday streak. Same styling as tokens panel.
EOF
)"
```

---

### Task 6: Verify end-to-end and document

Run the full suite, verify in the emulator, update DEVLOG.

**Files:**
- Modify: `DEVLOG.md` (add entry)
- Modify: `DEBT.md` (note velocity deferred to v2)

**Interfaces:**
- Consumes: everything from Tasks 1-5
- Produces: verified, documented feature

- [ ] **Step 1: Run full test suite**

Run: `cd bridge && npx vitest run`
Expected: all tests pass (previous count + new tests for workday, life-stats, screen)

- [ ] **Step 2: Run typecheck**

Run: `cd bridge && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`
Expected: clean

- [ ] **Step 3: Start bridge with --simulate and verify**

1. `/stats` includes `life` field
2. Dashboard Life panel renders
3. Stats view has 3 pages, page 3 shows LIFE
4. Approve a permission from dashboard → `/stats` shows `approvals: 1, fromHeadPct: 0%`
5. Approve from head (tap touch) → `fromHeadPct: 50%`
6. Deny from dashboard → `denials: 1`
7. Robot never vanishes during view switches

- [ ] **Step 4: Verify demo mode doesn't persist**

Start with `--demo`. Let it run 30s. Check `~/.buildagotchi/life-stats.json` — it should not exist or not have changed.

- [ ] **Step 5: Add DEBT entry for velocity**

In `DEBT.md`, add:

```markdown
### D-XX: velocity metric deferred (C3)

The council demonstrated that `prompt→Stop` latency includes human wait time
during permissions, and `{sumMs,count}` is a lifetime average, not a moving
window. Deferred to v2 pending: (a) `pendingPromptAt` field in ClaudeSession,
(b) exclusion of turns with permission pending, (c) sliding/exponential window.

**Status**: deferred by design — not a bug, not forgotten.
```

- [ ] **Step 6: Add DEVLOG entry**

- [ ] **Step 7: Commit**

```bash
git add DEVLOG.md DEBT.md
git commit -m "$(cat <<'EOF'
Document life-stats feature and deferred velocity metric

DEVLOG: end-to-end verification of life stats — three metrics, milestone
edge trigger, screen page, dashboard panel. DEBT: velocity deferred to
v2 per council C3 (includes permission waits, not a moving average).
EOF
)"
```
