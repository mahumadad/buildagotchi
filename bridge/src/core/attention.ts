import { type Event, type Severity, severityRank } from './events.js';
import { type Mode, severityPassesMode } from './modes.js';

export interface ActiveAttention {
  event: Event;
  deadline: number | null;
}

export interface TtlOverride {
  // `| undefined` (not just `?:`) so this structurally matches zod's inferred
  // optional-field type under `exactOptionalPropertyTypes` (M4 index.ts wires
  // `config.attentionManager` straight from ConfigSchema's z.infer).
  source?: string | undefined;
  category?: string | undefined;
  ttl: number | null;
}

export interface AmConfig {
  ttlBySeverity: Record<Severity, number>;
  ttlOverrides: TtlOverride[];
  maxQueueSize: number;
  replacementPolicy: 'higher_severity_interrupts' | 'always_enqueue';
  transitionToBackgroundMoodDelay: number;
  onModeChange: { toFOCUS: 'drop_below_high'; toSLEEP: 'drop_below_critical' };
}

/** Minimal structural subset of the future server/metrics.ts Metrics registry (SA3, M4). */
export interface MetricsLike {
  gauge(name: string): { set(v: number): void };
}

export interface AttentionManagerDeps {
  // SPEC GAP: SPEC-IMPL-FASE-1A §4.2 types this as `(type: 'am_decision', …) => void`,
  // but §4.2 point 9 (watchdog) requires recording an `incident` line too. Widened to
  // both literals — the narrower type can't express the documented watchdog behavior.
  record: (type: 'am_decision' | 'incident', data: Record<string, unknown>) => void;
  metrics: MetricsLike;
  onActiveChange: (active: ActiveAttention | null) => void;
}

const WATCHDOG_INTERVAL_MS = 5000;
const WATCHDOG_STALL_MS = 5000;
const TICK_INTERVAL_MS = 1000;

function queueCompare(a: ActiveAttention, b: ActiveAttention): number {
  const rankDiff = severityRank(b.event.severity) - severityRank(a.event.severity);
  if (rankDiff !== 0) return rankDiff;
  return a.event.timestamp - b.event.timestamp;
}

/** Lowest severity, oldest timestamp among the pool (SA7: queue ∪ incoming). */
function pickWorst(pool: ActiveAttention[]): ActiveAttention {
  return pool.reduce((worst, item) => {
    const worstRank = severityRank(worst.event.severity);
    const itemRank = severityRank(item.event.severity);
    if (itemRank < worstRank) return item;
    if (itemRank === worstRank && item.event.timestamp < worst.event.timestamp) return item;
    return worst;
  });
}

export class AttentionManager {
  #cfg: AmConfig;
  #deps: AttentionManagerDeps;
  #mode: Mode = 'NORMAL';
  #active: ActiveAttention | null = null;
  #queue: ActiveAttention[] = [];
  #idleDeadline: number | null = null;
  #idleFired = false;
  #lastTickAt = 0;
  #tickInterval: NodeJS.Timeout | null = null;
  #watchdogInterval: NodeJS.Timeout | null = null;

  constructor(cfg: AmConfig, deps: AttentionManagerDeps) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  setConfig(cfg: AmConfig): void {
    this.#cfg = cfg; // SA5: solo afecta eventos nuevos, no a los ya encolados
  }

  getMode(): Mode {
    return this.#mode;
  }

  setMode(m: Mode): void {
    this.#mode = m;
    if (m === 'NORMAL') return;

    if (this.#active && !severityPassesMode(this.#active.event.severity, m)) {
      this.#record('dropped', 'mode_change', this.#active.event);
      this.#active = null;
    }

    this.#queue = this.#queue.filter((item) => {
      const keep = severityPassesMode(item.event.severity, m);
      if (!keep) this.#record('dropped', 'mode_change', item.event);
      return keep;
    });

    this.#promote(Date.now());
    this.#updateQueueGauge();
  }

  push(e: Event): void {
    const now = Date.now();

    // An event may declare that it retires another one (D3: the mechanism is
    // generic, not Claude-specific — a "CI green" retires a "CI red"). This is
    // bookkeeping, not attention, so it runs BEFORE the mode filter: otherwise
    // an ambient resolver arriving in SLEEP would be dropped and its target
    // would stay active forever. That is exactly the deadlock that shipped:
    // approving a permission from the chat left `permission_critical` — which
    // carries an infinite TTL (S2.5.8) and can't be preempted by an ambient
    // event — as the active event, with the robot showing a warning for an
    // operation the user had already approved.
    const resolvesEventId = e.payload.resolvesEventId;
    if (typeof resolvesEventId === 'string') {
      this.resolve(resolvesEventId, 'dismissed');
    }

    if (!severityPassesMode(e.severity, this.#mode)) {
      this.#deps.record('am_decision', {
        action: 'rejected',
        reason: 'mode_filter',
        eventId: e.id,
      });
      return;
    }

    this.#cancelIdle();

    const candidate: ActiveAttention = { event: e, deadline: this.#computeDeadline(e, now) };

    if (!this.#active) {
      this.#active = candidate;
      this.#deps.onActiveChange(this.#active);
      this.#updateQueueGauge();
      return;
    }

    const interrupts =
      this.#cfg.replacementPolicy === 'higher_severity_interrupts' &&
      severityRank(e.severity) > severityRank(this.#active.event.severity);

    if (interrupts) {
      const previousActive = this.#active;
      this.#enqueue(previousActive);
      this.#active = candidate;
      this.#deps.record('am_decision', {
        action: 'interrupted',
        interrupted: previousActive.event.id,
        eventId: e.id,
      });
      this.#deps.onActiveChange(this.#active);
    } else {
      this.#enqueue(candidate);
    }

    this.#updateQueueGauge();
  }

  resolve(eventId: string, reason: 'approved' | 'denied' | 'dismissed'): void {
    if (this.#active && this.#active.event.id === eventId) {
      this.#deps.record('am_decision', { action: 'resolved', reason, eventId });
      this.#active = null;
      this.#promote(Date.now());
      this.#updateQueueGauge();
      return;
    }

    const index = this.#queue.findIndex((item) => item.event.id === eventId);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      this.#updateQueueGauge();
      return;
    }
    // Not found — no-op (spec: no-op con debug log; sin logger inyectado en M3, se omite).
  }

  snapshot(): { active: ActiveAttention | null; queue: Event[]; mode: Mode } {
    return {
      active: this.#active,
      queue: this.#queue.map((item) => item.event),
      mode: this.#mode,
    };
  }

  start(): void {
    this.tick(Date.now());
    this.#tickInterval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.#watchdogInterval = setInterval(() => this.#checkWatchdog(), WATCHDOG_INTERVAL_MS);
  }

  stop(): void {
    if (this.#tickInterval) clearInterval(this.#tickInterval);
    if (this.#watchdogInterval) clearInterval(this.#watchdogInterval);
    this.#tickInterval = null;
    this.#watchdogInterval = null;
  }

  tick(now: number = Date.now()): void {
    if (this.#active && this.#active.deadline !== null && now >= this.#active.deadline) {
      this.#deps.record('am_decision', { action: 'expired', eventId: this.#active.event.id });
      this.#active = null;
    }

    const expiredFromQueue = this.#queue.filter(
      (item) => item.deadline !== null && now >= item.deadline,
    );
    for (const item of expiredFromQueue) {
      this.#deps.record('am_decision', { action: 'expired', eventId: item.event.id });
    }
    if (expiredFromQueue.length > 0) {
      this.#queue = this.#queue.filter((item) => !expiredFromQueue.includes(item));
    }

    this.#promote(now);
    this.#lastTickAt = now;
    this.#updateQueueGauge();
  }

  #promote(now: number): void {
    if (this.#active) return;

    if (this.#queue.length > 0) {
      this.#queue.sort(queueCompare);
      this.#active = this.#queue.shift() as ActiveAttention;
      this.#idleDeadline = null;
      this.#idleFired = false;
      this.#deps.onActiveChange(this.#active);
      return;
    }

    if (this.#idleDeadline === null && !this.#idleFired) {
      this.#idleDeadline = now + this.#cfg.transitionToBackgroundMoodDelay;
    }
    if (this.#idleDeadline !== null && !this.#idleFired && now >= this.#idleDeadline) {
      this.#idleFired = true;
      this.#deps.onActiveChange(null);
    }
  }

  #cancelIdle(): void {
    this.#idleDeadline = null;
    this.#idleFired = false;
  }

  #enqueue(candidate: ActiveAttention): void {
    if (this.#queue.length + 1 > this.#cfg.maxQueueSize) {
      const pool = [...this.#queue, candidate];
      const worst = pickWorst(pool);
      if (worst === candidate) {
        this.#record('dropped', 'queue_full', candidate.event);
        return;
      }
      this.#queue = this.#queue.filter((item) => item !== worst);
      this.#record('dropped', 'queue_full', worst.event);
    }
    this.#queue.push(candidate);
    this.#queue.sort(queueCompare);
  }

  #computeDeadline(e: Event, now: number): number | null {
    if (e.ttlMs !== undefined) return now + e.ttlMs;

    const overrides = this.#cfg.ttlOverrides;
    const bothMatch = overrides.find((o) => o.source === e.source && o.category === e.category);
    const sourceOnlyMatch = overrides.find(
      (o) => o.source === e.source && o.category === undefined,
    );
    const categoryOnlyMatch = overrides.find(
      (o) => o.category === e.category && o.source === undefined,
    );
    const match = bothMatch ?? sourceOnlyMatch ?? categoryOnlyMatch;
    if (match) {
      return match.ttl === null ? null : now + match.ttl;
    }

    return now + this.#cfg.ttlBySeverity[e.severity];
  }

  #record(action: 'dropped', reason: string, event: Event): void {
    this.#deps.record('am_decision', { action, reason, dropped: event.id, eventId: event.id });
  }

  #updateQueueGauge(): void {
    this.#deps.metrics.gauge('am_queue_size').set(this.#queue.length);
  }

  #checkWatchdog(): void {
    const now = Date.now();
    if (now - this.#lastTickAt >= WATCHDOG_STALL_MS) {
      this.#deps.record('incident', { reason: 'am_tick_stalled' });
      this.#deps.onActiveChange(null);
    }
  }
}
