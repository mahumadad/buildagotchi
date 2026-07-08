import { type Event, EventSchema, type Severity } from './events.js';

export type PublishOutcome =
  | { kind: 'accepted'; event: Event }
  | { kind: 'deduped'; hash: string; count: number }
  | { kind: 'muted'; hash: string; count: number }
  | { kind: 'invalid'; issues: string[] };

export interface DedupConfig {
  windowMs: number;
  autoMuteAfter: number;
}

export interface EventBusHooks {
  onAccepted?: (e: Event) => void; // recorder + AM se suscriben acá
  onOutcome?: (o: PublishOutcome) => void; // métricas
}

interface DedupEntry {
  count: number;
  lastSeen: number;
  severity: Severity;
  muted: boolean;
}

export class EventBus {
  #cfg: DedupConfig;
  #hooks: EventBusHooks;
  #dedup = new Map<string, DedupEntry>();

  constructor(cfg: DedupConfig, hooks: EventBusHooks) {
    this.#cfg = cfg;
    this.#hooks = hooks;
  }

  setDedupConfig(cfg: DedupConfig): void {
    this.#cfg = cfg;
  }

  publish(raw: unknown): PublishOutcome {
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) {
      const outcome: PublishOutcome = {
        kind: 'invalid',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
      this.#hooks.onOutcome?.(outcome);
      return outcome;
    }

    const event = parsed.data;
    this.#purgeExpired();

    const outcome = this.#applyDedup(event);
    if (outcome.kind === 'accepted') {
      this.#hooks.onAccepted?.(event);
    }
    this.#hooks.onOutcome?.(outcome);
    return outcome;
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [hash, entry] of this.#dedup) {
      if (now - entry.lastSeen >= this.#cfg.windowMs) {
        this.#dedup.delete(hash);
      }
    }
  }

  #applyDedup(event: Event): PublishOutcome {
    const now = Date.now();
    const existing = this.#dedup.get(event.hash);

    if (!existing) {
      this.#dedup.set(event.hash, {
        count: 1,
        lastSeen: now,
        severity: event.severity,
        muted: false,
      });
      return { kind: 'accepted', event };
    }

    if (existing.severity !== event.severity) {
      this.#dedup.set(event.hash, {
        count: 1,
        lastSeen: now,
        severity: event.severity,
        muted: false,
      });
      return { kind: 'accepted', event };
    }

    existing.count += 1;
    existing.lastSeen = now;

    if (existing.muted || existing.count >= this.#cfg.autoMuteAfter) {
      existing.muted = true;
      return { kind: 'muted', hash: event.hash, count: existing.count };
    }

    return { kind: 'deduped', hash: event.hash, count: existing.count };
  }
}
