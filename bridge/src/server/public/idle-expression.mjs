// bridge/src/server/public/idle-expression.mjs
// Feature B (spec adopcion-firmware rev 3): micro-expresión idle. Modifier
// cosmético — sólo modula eyes.open de UN ojo (asimétrico, para distinguirse
// del blink que es simétrico), y sólo cuando isIdle() es verdadero. NUNCA
// toca ResolvedState: es "vida", como blink/breath/saccade. El servidor manda
// el "cuándo" (idle) vía state.active===null; este módulo hace el "cómo".

function randomBetween(min, max, rng) {
  return min + (max - min) * rng();
}

export function createIdleExpressionModifier({
  isIdle,
  gapMin = 2000,
  gapMax = 6000,
  durationMs = 400,
  squint = 0.6,
  rng = Math.random,
}) {
  let nextIn = randomBetween(gapMin, gapMax, rng);
  let animating = false;
  let elapsed = 0;
  let side = 'left';
  return (tickMs, face) => {
    if (!isIdle()) {
      // Reset so a fresh gap starts when idle resumes; leave the face untouched.
      animating = false;
      nextIn = randomBetween(gapMin, gapMax, rng);
      return face;
    }
    if (animating) {
      elapsed += tickMs;
      const t = Math.min(elapsed / durationMs, 1);
      const dip = Math.sin(t * Math.PI); // 0 → 1 → 0 over the duration
      face.eyes[side].open *= 1 - squint * dip;
      if (elapsed >= durationMs) {
        animating = false;
        nextIn = randomBetween(gapMin, gapMax, rng);
      }
    } else {
      nextIn -= tickMs;
      if (nextIn <= 0) {
        animating = true;
        elapsed = 0;
        side = rng() < 0.5 ? 'left' : 'right';
      }
    }
    return face;
  };
}
