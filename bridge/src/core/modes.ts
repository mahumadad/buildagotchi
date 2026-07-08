import type { Severity } from './events.js';

export type Mode = 'NORMAL' | 'FOCUS' | 'SLEEP';

const MODE_MIN_SEVERITY: Record<Mode, Severity[]> = {
  NORMAL: ['critical', 'high', 'medium', 'low', 'ambient'],
  FOCUS: ['critical', 'high'],
  SLEEP: ['critical'],
};

export function severityPassesMode(s: Severity, m: Mode): boolean {
  return MODE_MIN_SEVERITY[m].includes(s);
}

const MODE_CYCLE: Record<Mode, Mode> = {
  NORMAL: 'FOCUS',
  FOCUS: 'SLEEP',
  SLEEP: 'NORMAL',
};

export function nextMode(m: Mode): Mode {
  return MODE_CYCLE[m];
}
