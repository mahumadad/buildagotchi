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

export type { ResolveSource };

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
      this.#streak = 1;
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
