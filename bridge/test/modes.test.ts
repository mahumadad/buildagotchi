import { describe, expect, it } from 'vitest';
import { nextMode, severityPassesMode } from '../src/core/modes.js';

describe('severityPassesMode', () => {
  it('NORMAL passes every severity', () => {
    for (const s of ['critical', 'high', 'medium', 'low', 'ambient'] as const) {
      expect(severityPassesMode(s, 'NORMAL')).toBe(true);
    }
  });

  it('FOCUS passes only critical and high', () => {
    expect(severityPassesMode('critical', 'FOCUS')).toBe(true);
    expect(severityPassesMode('high', 'FOCUS')).toBe(true);
    expect(severityPassesMode('medium', 'FOCUS')).toBe(false);
    expect(severityPassesMode('low', 'FOCUS')).toBe(false);
    expect(severityPassesMode('ambient', 'FOCUS')).toBe(false);
  });

  it('SLEEP passes only critical', () => {
    expect(severityPassesMode('critical', 'SLEEP')).toBe(true);
    expect(severityPassesMode('high', 'SLEEP')).toBe(false);
    expect(severityPassesMode('medium', 'SLEEP')).toBe(false);
  });
});

describe('nextMode', () => {
  it('cycles NORMAL -> FOCUS -> SLEEP -> NORMAL', () => {
    expect(nextMode('NORMAL')).toBe('FOCUS');
    expect(nextMode('FOCUS')).toBe('SLEEP');
    expect(nextMode('SLEEP')).toBe('NORMAL');
  });
});
