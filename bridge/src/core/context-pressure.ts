export type PressureLevel = 'calm' | 'warn' | 'high';

export interface ContextPressureConfig {
  /**
   * The model's context window, in tokens. Declared, never inferred: no field in
   * the transcript reports it, and a percentage computed against a guessed limit
   * would look authoritative while being invented.
   */
  windowTokens: number;
  warnAt: number;
  highAt: number;
}

export interface ContextPressureDeps {
  onLevelChange: (
    level: PressureLevel,
    ctx: { sessionId: string; pct: number; cwd: string },
  ) => void;
}

/**
 * Turns context occupancy into events the AttentionManager can arbitrate.
 *
 * Edge-triggered, like `ProtocolSession.onLinkChange`: a session sitting at 75%
 * for an hour is one event, not one per response. A session that compacts drops
 * back to `calm`, which is the signal that the pressure is over — the robot
 * stops worrying without anyone telling it to.
 *
 * Sessions are tracked independently: `forget()` is death, not relief, and a
 * dead session must not announce that its pressure eased.
 */
export class ContextPressureMonitor {
  #cfg: ContextPressureConfig;
  #deps: ContextPressureDeps;
  #levels = new Map<string, PressureLevel>();

  constructor(cfg: ContextPressureConfig, deps: ContextPressureDeps) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  setConfig(cfg: ContextPressureConfig): void {
    this.#cfg = cfg;
  }

  observe(sessionId: string, contextTokens: number, cwd = ''): void {
    if (this.#cfg.windowTokens <= 0) return; // nothing to be a percentage of

    const pct = Math.min(1, contextTokens / this.#cfg.windowTokens);
    const level: PressureLevel =
      pct >= this.#cfg.highAt ? 'high' : pct >= this.#cfg.warnAt ? 'warn' : 'calm';

    const previous = this.#levels.get(sessionId) ?? 'calm';
    if (level === previous) return;

    this.#levels.set(sessionId, level);
    this.#deps.onLevelChange(level, { sessionId, pct, cwd });
  }

  forget(sessionId: string): void {
    this.#levels.delete(sessionId);
  }
}
