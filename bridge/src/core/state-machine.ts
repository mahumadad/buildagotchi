import pino from 'pino';
import type { ActiveAttention } from './attention.js';
import type { Event, ResolvedState, Severity } from './events.js';

const logger = pino({ name: 'state-machine' });

export interface StateRuleMatch {
  source?: string;
  category?: string;
  severity?: Severity;
}

export interface StateRule {
  match: StateRuleMatch;
  state: Partial<ResolvedState> & { emotion: ResolvedState['emotion'] };
}

/** Minimal structural subset of the future server/metrics.ts Metrics registry (SA3, M4). */
export interface MetricsLike {
  counter(name: string): { inc(n?: number): void };
}

export interface StateMachineDeps {
  emit: (state: ResolvedState) => void;
  record: (type: 'state_change', data: Record<string, unknown>) => void;
  metrics: MetricsLike;
}

const BACKGROUND_MOOD: ResolvedState = { emotion: 'NEUTRAL', decorators: [], leds: [] };

function matches(rule: StateRuleMatch, e: Event): boolean {
  if (rule.source !== undefined && rule.source !== e.source) return false;
  if (rule.category !== undefined && rule.category !== e.category) return false;
  if (rule.severity !== undefined && rule.severity !== e.severity) return false;
  return true;
}

function statesEqual(a: ResolvedState, b: ResolvedState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class StateMachine {
  #rules: StateRule[];
  #deps: StateMachineDeps;
  #current: ResolvedState = BACKGROUND_MOOD;

  constructor(rules: StateRule[], deps: StateMachineDeps) {
    this.#rules = rules;
    this.#deps = deps;
  }

  setRules(rules: StateRule[]): void {
    this.#rules = rules;
  }

  current(): ResolvedState {
    return this.#current;
  }

  apply(input: ActiveAttention | null): void {
    const resolved = input ? this.#resolve(input.event) : BACKGROUND_MOOD;
    this.#transition(resolved, input?.event.id);
  }

  forceSafeState(): void {
    this.#transition(BACKGROUND_MOOD, undefined);
  }

  /**
   * First matching rule wins (D3: no emotion is hard-wired in code). The
   * config's own severity-only rules act as the safety-net default — if
   * none of those match either, the config is incomplete: warn and fall
   * back to a bare NEUTRAL rather than guessing an emotion in code.
   */
  #resolve(e: Event): ResolvedState {
    const rule = this.#rules.find((r) => matches(r.match, e));
    let state: ResolvedState;
    if (rule) {
      state = {
        decorators: [],
        leds: [],
        ...rule.state,
      };
    } else {
      logger.warn(
        { source: e.source, category: e.category, severity: e.severity },
        'no stateRule matched (not even a severity default) — incomplete config, falling back to NEUTRAL',
      );
      state = { ...BACKGROUND_MOOD };
    }

    if (e.direction !== undefined && state.gaze === undefined) {
      state = { ...state, gaze: e.direction };
    }

    return state;
  }

  #transition(next: ResolvedState, eventId: string | undefined): void {
    if (statesEqual(this.#current, next)) return;

    const from = this.#current;
    this.#current = next;
    this.#deps.record('state_change', { from, to: next, eventId });
    if (from.emotion !== next.emotion) {
      this.#deps.metrics.counter('face_changes_total').inc();
    }
    this.#deps.emit(next);
  }
}
