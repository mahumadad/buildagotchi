/**
 * The shape of a breath. Pure arithmetic, zero Moddable imports, so it can be
 * tested from the bridge's suite — the only part of the `pulse` effect (D-03)
 * that can be verified without a CoreS3 on the desk.
 */

/**
 * Brightness at time `t` within a cycle of length `dur`, as a raised cosine:
 * 0 → 1 → 0, flat at both ends. A triangle wave hits the same extremes, but the
 * eye reads its corners as a stutter, and breathing has no corners.
 */
export function breathBrightness(t: number, dur: number): number {
  if (dur <= 0) return 0
  const phase = (2 * Math.PI * t) / dur
  return (1 - Math.cos(phase)) / 2
}

/**
 * Quantised to 32 levels. The strand redraws on every tick and an ESP32-S3
 * driving twelve WS2812B pixels has better things to do than repaint a shade
 * nobody can distinguish from the last one.
 */
export function breathStep(t: number, dur: number): number {
  return Math.round(breathBrightness(t, dur) * 31)
}
