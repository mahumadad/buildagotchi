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
