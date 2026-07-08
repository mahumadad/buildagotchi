import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/core/duration.js';

describe('parseDuration', () => {
  it.each([
    ['100ms', 100],
    ['0ms', 0],
    ['30s', 30_000],
    ['1s', 1_000],
    ['2m', 120_000],
    ['10m', 600_000],
    ['6h', 21_600_000],
    ['1.5s', 1_500],
    ['0.5m', 30_000],
  ])('parses %s to %d', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("parses 'infinite' to null", () => {
    expect(parseDuration('infinite')).toBeNull();
  });

  it.each(['5d', '5x', '', 'fast', '30', '-5s', '1h30m', ' 30s', '30 s'])(
    'throws on invalid input %j',
    (input) => {
      expect(() => parseDuration(input)).toThrow();
    },
  );

  it('includes the offending input in the error message', () => {
    expect(() => parseDuration('5d')).toThrow(/5d/);
  });
});
