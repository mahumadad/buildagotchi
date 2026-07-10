import { describe, expect, it } from 'vitest';
import { breathBrightness, breathStep } from '../../firmware/mods/breath.js';

/**
 * D-03. `pulse` was a pattern the emulator claimed and the firmware could not
 * produce. The effect now exists in `firmware/mods/led-pulse.ts`, written
 * against the real `NeoStrandEffect` API — but it has never run on a strand,
 * because the CoreS3 has not arrived.
 *
 * This is the only part that can be verified from a laptop: the shape of the
 * breath. The tests live in the bridge's suite because the firmware has no test
 * harness of its own, and a curve with no tests is a curve nobody checked.
 */

const DUR = 2000;

describe('breathBrightness', () => {
  it('starts dark, peaks at the half cycle, ends dark', () => {
    expect(breathBrightness(0, DUR)).toBeCloseTo(0);
    expect(breathBrightness(DUR / 2, DUR)).toBeCloseTo(1);
    expect(breathBrightness(DUR, DUR)).toBeCloseTo(0);
  });

  it('never leaves 0..1, so the colour is never scaled past full', () => {
    for (let t = 0; t <= DUR; t += 37) {
      const k = breathBrightness(t, DUR);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    }
  });

  it('rises monotonically to the peak and falls monotonically after it', () => {
    // A raised cosine, not a triangle: the eye reads a triangle's corners as a
    // stutter. Monotonicity is what makes it read as breathing rather than
    // fading in steps.
    let previous = -1;
    for (let t = 0; t <= DUR / 2; t += 10) {
      const k = breathBrightness(t, DUR);
      expect(k).toBeGreaterThanOrEqual(previous);
      previous = k;
    }
    for (let t = DUR / 2; t <= DUR; t += 10) {
      const k = breathBrightness(t, DUR);
      expect(k).toBeLessThanOrEqual(previous + 1e-9);
      previous = k;
    }
  });

  it('is flat at the extremes — that is what a triangle wave would not be', () => {
    // Near the peak the curve barely moves; near a triangle's peak it moves at
    // full speed and reverses. Compare the slope over the same small window.
    const nearPeak = breathBrightness(DUR / 2, DUR) - breathBrightness(DUR / 2 - 20, DUR);
    const midRise = breathBrightness(DUR / 4 + 10, DUR) - breathBrightness(DUR / 4 - 10, DUR);
    expect(Math.abs(nearPeak)).toBeLessThan(Math.abs(midRise));
  });

  it('a zero-length cycle is dark, not a division by zero', () => {
    expect(breathBrightness(5, 0)).toBe(0);
    expect(Number.isNaN(breathBrightness(5, 0))).toBe(false);
  });
});

describe('breathStep', () => {
  it('quantises to 32 levels, 0 through 31', () => {
    expect(breathStep(0, DUR)).toBe(0);
    expect(breathStep(DUR / 2, DUR)).toBe(31);
  });

  it('holds the same step across ticks the eye cannot tell apart', () => {
    // Two ticks 1ms apart near the peak must land on the same step, or the
    // strand repaints for nothing.
    expect(breathStep(DUR / 2, DUR)).toBe(breathStep(DUR / 2 + 1, DUR));
  });

  it('does not hold the same step across a visible change', () => {
    // ...but a quarter of the cycle apart, it must move. Otherwise the guard
    // above would pass on a function that returned a constant.
    expect(breathStep(DUR / 4, DUR)).not.toBe(breathStep(DUR / 2, DUR));
  });
});
