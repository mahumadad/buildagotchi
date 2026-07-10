import { NeoStrandEffect, type NeoStrandEffectDictionary } from 'neostrand'
import { breathBrightness, breathStep } from './breath.js'

/**
 * `pulse` — a breathing LED, as opposed to `blink`, which switches on and off.
 *
 * This closes D-03. The emulator had `pulse`; the firmware only had `on`, `off`,
 * `blink` and `rainbow`, so S2.5.16 removed it from the config enum rather than
 * keep shipping a pattern the robot could not produce.
 *
 * It lives here, in buildagotchi, and not in `stack-chan/`: that directory is a
 * clone of the upstream repo, is not tracked by our git, and anything written
 * there is lost on the next pull. `Led extends NeoStrand`, and `setScheme` and
 * `start` are public, so an effect of our own needs no fork.
 *
 * NOT VERIFIED ON HARDWARE. The CoreS3 has not arrived. `pulse` must stay out of
 * the bridge's `pattern` enum until this runs on a real strand — re-adding it
 * first would put the emulator back to claiming a capability nobody has seen,
 * which is the exact bug D-03 records.
 */

export class Pulse extends NeoStrandEffect {
  #r: number
  #g: number
  #b: number
  #lastStep = -1

  constructor(
    dictionary: NeoStrandEffectDictionary & {
      rgb: { r: number; g: number; b: number }
      index?: number
      count?: number
      duration?: number
    },
  ) {
    super(dictionary)
    this.name = 'Pulse'
    this.loop = 1

    if (dictionary.index) {
      this.start = dictionary.index
    }
    if (dictionary.count) {
      this.size = dictionary.count
      this.end = this.start + this.size
      if (this.end > this.strand.length) this.end = this.strand.length
    }
    this.dur = dictionary.duration ?? 2000 // slower than blink: this is calm, not urgent

    this.#r = dictionary.rgb.r
    this.#g = dictionary.rgb.g
    this.#b = dictionary.rgb.b
  }

  activate(effect: NeoStrandEffect): void {
    effect.timeline.on(effect, { effectValue: [0, effect.dur] }, effect.dur, null, 0)
    effect.reset(effect)
  }

  set effectValue(value: number) {
    // Skip the repaints the eye cannot tell apart (see breath.ts).
    const step = breathStep(value, this.dur)
    if (step === this.#lastStep) return
    const k = breathBrightness(value, this.dur)
    this.#lastStep = step

    const color = this.strand.makeRGB(
      Math.round(this.#r * k),
      Math.round(this.#g * k),
      Math.round(this.#b * k),
    )
    for (let i = this.start; i < this.end; i++) {
      this.strand.set(i, color)
    }
  }
}

/**
 * Drives `led` with a breathing effect. `led` is a `stack-chan` `Led`, which
 * extends `NeoStrand`; `setScheme` replaces whatever effect was running.
 */
export function pulse(
  led: {
    setScheme: (effects: NeoStrandEffect[]) => void
    start: (interval: number) => void
    length: number
  },
  rgb: { r: number; g: number; b: number },
  duration = 2000,
): void {
  const effect = new Pulse({ strand: led, rgb, duration } as never)
  led.setScheme([effect])
  led.start(100)
}
