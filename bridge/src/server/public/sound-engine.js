const TONES = {
  tap:        { freq: 880,  dur: 40,  type: 'sine',     gain: 0.15 },
  swipe:      { freq: 660,  dur: 60,  type: 'sine',     gain: 0.12, slide: 880 },
  hold:       { freq: 330,  dur: 200, type: 'triangle',  gain: 0.1 },
  buttonA:    { freq: 1047, dur: 50,  type: 'square',    gain: 0.08 },
  buttonB:    { freq: 784,  dur: 50,  type: 'square',    gain: 0.08 },
  buttonC:    { freq: 523,  dur: 50,  type: 'square',    gain: 0.08 },
  approve:    [
    { freq: 523, dur: 80, type: 'sine', gain: 0.15 },
    { freq: 659, dur: 80, type: 'sine', gain: 0.15, delay: 90 },
    { freq: 784, dur: 120, type: 'sine', gain: 0.18, delay: 180 },
  ],
  deny:       [
    { freq: 440, dur: 100, type: 'sawtooth', gain: 0.12 },
    { freq: 330, dur: 150, type: 'sawtooth', gain: 0.1, delay: 110 },
  ],
  permission: [
    { freq: 880,  dur: 60, type: 'sine', gain: 0.2 },
    { freq: 1047, dur: 60, type: 'sine', gain: 0.2, delay: 80 },
    { freq: 880,  dur: 60, type: 'sine', gain: 0.18, delay: 160 },
    { freq: 1047, dur: 80, type: 'sine', gain: 0.22, delay: 240 },
  ],
  notification: [
    { freq: 784,  dur: 80, type: 'sine', gain: 0.15 },
    { freq: 1047, dur: 120, type: 'sine', gain: 0.18, delay: 100 },
  ],
  modeChange: { freq: 440, dur: 150, type: 'triangle', gain: 0.1, slide: 660 },
  error:      [
    { freq: 200, dur: 80, type: 'sawtooth', gain: 0.15 },
    { freq: 200, dur: 80, type: 'sawtooth', gain: 0.15, delay: 120 },
    { freq: 200, dur: 80, type: 'sawtooth', gain: 0.15, delay: 240 },
  ],
};

export class SoundEngine {
  #ctx = null;
  #volume = 0.6;
  #muted = false;

  get volume() { return this.#volume; }
  set volume(v) { this.#volume = Math.max(0, Math.min(1, v)); }

  get muted() { return this.#muted; }
  set muted(m) { this.#muted = m; }

  #ensureCtx() {
    if (!this.#ctx) this.#ctx = new AudioContext();
    if (this.#ctx.state === 'suspended') this.#ctx.resume();
    return this.#ctx;
  }

  play(name) {
    if (this.#muted || this.#volume === 0) return;
    const tone = TONES[name];
    if (!tone) return;

    if (Array.isArray(tone)) {
      for (const t of tone) this.#scheduleTone(t, t.delay ?? 0);
    } else {
      this.#scheduleTone(tone, 0);
    }
  }

  #scheduleTone(t, delayMs) {
    const ctx = this.#ensureCtx();
    const now = ctx.currentTime + delayMs / 1000;
    const dur = t.dur / 1000;

    const osc = ctx.createOscillator();
    osc.type = t.type;
    osc.frequency.setValueAtTime(t.freq, now);
    if (t.slide) {
      osc.frequency.linearRampToValueAtTime(t.slide, now + dur);
    }

    const gain = ctx.createGain();
    const peak = t.gain * this.#volume;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.005);
    gain.gain.setValueAtTime(peak, now + dur * 0.7);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }
}
