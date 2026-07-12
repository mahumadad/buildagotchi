import { describe, it, expect } from 'vitest';
import { createIdleExpressionModifier } from '../src/server/public/idle-expression.mjs';

function freshFace() {
  return { eyes: { left: { open: 1, gazeX: 0, gazeY: 0 }, right: { open: 1, gazeX: 0, gazeY: 0 } } };
}

describe('createIdleExpressionModifier', () => {
  it('does nothing while not idle', () => {
    const mod = createIdleExpressionModifier({ isIdle: () => false, gapMin: 0, gapMax: 0, rng: () => 0 });
    const face = freshFace();
    mod(5000, face); // even a long tick past the gap
    expect(face.eyes.left.open).toBe(1);
    expect(face.eyes.right.open).toBe(1);
  });

  it('squints exactly one eye when idle and the gap elapses', () => {
    // rng: first call picks the gap (→0 with gapMin=gapMax=0), a later call picks the side.
    const mod = createIdleExpressionModifier({
      isIdle: () => true, gapMin: 0, gapMax: 0, durationMs: 400, squint: 0.6,
      rng: () => 0, // side < 0.5 → 'left'
    });
    const face = freshFace();
    mod(16, face);            // arm: gap 0 → animation starts this tick
    mod(200, face);           // ~mid animation: max dip
    expect(face.eyes.left.open).toBeLessThan(1);   // left squints
    expect(face.eyes.right.open).toBe(1);          // right untouched (asymmetric)
  });

  it('returns the eye to open after the animation duration', () => {
    const mod = createIdleExpressionModifier({
      isIdle: () => true, gapMin: 0, gapMax: 0, durationMs: 400, rng: () => 0,
    });
    const face1 = freshFace();
    mod(16, face1);
    mod(400, face1); // consume full duration → animation ends
    const face2 = freshFace();
    mod(16, face2);  // next tick after end: not animating yet (new gap), eye open
    expect(face2.eyes.left.open).toBe(1);
  });
});
