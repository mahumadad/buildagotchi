import type { AttentionManager } from '../core/attention.js';
import type { EventBus } from '../core/bus.js';
import {
  type Adapter,
  type AdapterHealth,
  type Event,
  type Severity,
  newEvent,
} from '../core/events.js';

const LOOP_MS = 30_000;
const RESOLVE_DELAY_MS = 14_000; // permission fires at t+6s; resolving at t+20s

export interface DemoAdapterDeps {
  attentionManager: AttentionManager;
}

/**
 * Loops the canonical demo sequence from SPEC-IMPL-FASE-1A §5.6 (also the
 * scenario asserted in test/attention.test.ts's canonical DECISIONS test):
 * meeting (high) -> exception (critical) -> permission (critical, TTL
 * infinite via config.example.yaml's ttlOverride) -> auto-resolve (simulated
 * approve) -> idle until the loop repeats at t+30s. Used by `--demo` (test 1
 * of the ROADMAP): no real hardware or adapters needed to see the pipeline
 * work end to end.
 */
export class DemoAdapter implements Adapter {
  readonly name = 'demo';
  #am: AttentionManager;
  #bus: EventBus | null = null;
  #timers: NodeJS.Timeout[] = [];
  #lastEventAt: number | undefined;
  // SPEC GAP (§5.6): the spec doesn't say the payload must vary between
  // loops. With byte-identical payloads the hash (SA9) never changes, so the
  // default 60s dedup window (> the 30s loop) would silently swallow every
  // repeat after the first as `deduped` instead of `accepted` — defeating
  // the point of a repeating demo. Tagging each publish with the loop
  // iteration keeps the canonical scenario intact while giving each cycle a
  // distinct hash.
  #iteration = 0;

  constructor(deps: DemoAdapterDeps) {
    this.#am = deps.attentionManager;
  }

  async start(bus: EventBus): Promise<void> {
    this.#bus = bus;
    this.#scheduleLoop();
  }

  async stop(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
  }

  health(): { status: AdapterHealth; lastEventAt?: number; detail?: string } {
    const result: { status: AdapterHealth; lastEventAt?: number } = { status: 'HEALTHY' };
    if (this.#lastEventAt !== undefined) result.lastEventAt = this.#lastEventAt;
    return result;
  }

  #scheduleLoop(): void {
    this.#iteration += 1;
    this.#at(0, () => this.#publish('calendar', 'meeting-soon', 'high'));
    this.#at(3_000, () => this.#publish('chrome', 'exception', 'critical'));
    this.#at(6_000, () => {
      const permission = this.#publish('claude', 'permission', 'critical');
      this.#at(RESOLVE_DELAY_MS, () => this.#am.resolve(permission.id, 'approved', 'head'));
    });
    this.#at(LOOP_MS, () => this.#scheduleLoop());
  }

  #at(delayMs: number, fn: () => void): void {
    this.#timers.push(setTimeout(fn, delayMs));
  }

  #publish(source: string, category: string, severity: Severity): Event {
    const event = newEvent({ source, category, severity, payload: { iteration: this.#iteration } });
    this.#lastEventAt = event.timestamp;
    this.#bus?.publish(event);
    return event;
  }
}
