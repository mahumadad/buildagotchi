import pino from 'pino';
import { interpolate, truncate } from '../personality/interpolate.js';
import type { PersonalityManager } from '../personality/personality.js';
import type { ActiveAttention } from './attention.js';
import type { BalloonHistory } from './balloon-history.js';
import type { Emotion, Event, LedCommand, ResolvedState, Severity } from './events.js';

const logger = pino({ name: 'state-machine' });

/**
 * Lifespan of the balloon produced by a rule (SPEC-FASE-2.5 S2.5.2).
 * - `transient` (default) — dies when its event stops being active, by any
 *   route: resolve, TTL expiry, mode-drop, watchdog. The bug from §1.1 (a
 *   permission text hanging under an unrelated promoted event) is prevented
 *   here and only here.
 * - `sticky` — survives its event's death; only another balloon replaces it.
 *   Chosen for `response`: it's information, not urgency.
 */
export type BalloonPolicy = 'sticky' | 'transient';

export interface StateRuleMatch {
  // `| undefined` (not just `?:`) so this structurally matches zod's inferred
  // optional-field type under `exactOptionalPropertyTypes` (M4 index.ts wires
  // `config.stateRules` straight from ConfigSchema's z.infer).
  source?: string | undefined;
  category?: string | undefined;
  severity?: Severity | undefined;
}

export interface StateRule {
  match: StateRuleMatch;
  /**
   * Balloon lifespan for the balloon this rule produces. Default `transient`.
   * Lives OUTSIDE `state` (S2.5.12) — it's bridge policy, not something the
   * firmware receives.
   */
  balloonPolicy?: BalloonPolicy | undefined;
  state: Partial<ResolvedState> & { emotion: ResolvedState['emotion'] };
}

/** Minimal structural subset of the future server/metrics.ts Metrics registry (SA3, M4). */
export interface MetricsLike {
  counter(name: string): { inc(labelValues?: Record<string, string>, n?: number): void };
  gauge(name: string, collect?: () => number): { set(v: number): void };
}

export interface StateMachineDeps {
  emit: (state: ResolvedState) => void;
  record: (type: 'state_change', data: Record<string, unknown>) => void;
  metrics: MetricsLike;
  now?: () => number;
  /** Optional. When present, every effective balloon change is recorded (M15). */
  balloonHistory?: BalloonHistory;
}

/** Internal representation. The `text` is what leaves the machine as
 *  `ResolvedState.balloon`; the `policy` never crosses the frontier. */
interface Balloon {
  text: string;
  policy: BalloonPolicy;
}

const BACKGROUND_MOOD_EMOTION: Emotion = 'NEUTRAL';
const EMPTY_BALLOON: Balloon = { text: '', policy: 'transient' };

/** Same shape `interpolate()` substitutes; what it leaves behind is an unresolved key. */
const UNRESOLVED_PLACEHOLDER = /\{\w+\}/;
const CRITICAL_WINDOW_MS = 60 * 60 * 1000; // 60 min
const DEFAULT_BALLOON_MAX_CHARS = 240;

function matches(rule: StateRuleMatch, e: Event): boolean {
  if (rule.source !== undefined && rule.source !== e.source) return false;
  if (rule.category !== undefined && rule.category !== e.category) return false;
  if (rule.severity !== undefined && rule.severity !== e.severity) return false;
  return true;
}

function ledsEqual(a: LedCommand[], b: LedCommand[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((led, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      led.row === other.row &&
      led.index === other.index &&
      led.color === other.color &&
      led.pattern === other.pattern
    );
  });
}

function servoEqual(a: ResolvedState['servo'], b: ResolvedState['servo']): boolean {
  return a?.yaw === b?.yaw && a?.pitch === b?.pitch;
}

/**
 * Structural comparison, field by field (D-01).
 *
 * This was `JSON.stringify(a) === JSON.stringify(b)`, which preserves key
 * insertion order. `#resolve` builds its object through conditional spreads —
 * `gaze` lands mid-object when a rule declares it and last when it comes from
 * `e.direction` — so two semantically identical states could serialize
 * differently and be recorded as a real transition: a `state_change` line that
 * lies, a bumped `face_changes_total`, a redundant SSE broadcast, a duplicate
 * BalloonHistory entry. It never fired because no adapter emits `direction`
 * yet. Fase 3's Jira and GitHub adapters do.
 *
 * Order matters for `decorators` (the renderer draws them in sequence) and for
 * `leds` (each entry addresses a physical position), so those compare in order.
 * `balloon` is normalized: the initial state carries `''`, an untouched one may
 * carry `undefined`, and they mean the same thing to the firmware.
 */
function statesEqual(a: ResolvedState, b: ResolvedState): boolean {
  return (
    a.emotion === b.emotion &&
    a.gaze === b.gaze &&
    a.sound === b.sound &&
    (a.balloon ?? '') === (b.balloon ?? '') &&
    a.decorators.length === b.decorators.length &&
    a.decorators.every((d, i) => d === b.decorators[i]) &&
    ledsEqual(a.leds, b.leds) &&
    servoEqual(a.servo, b.servo)
  );
}

/**
 * All primitive fields of the event's payload become interpolation keys, plus
 * two derived ones. `undefined` values are dropped (never appear as literal
 * `"undefined"` in the balloon). Everything else stays as a `{key}` literal so
 * template bugs are visible instead of silently swallowed (see interpolate.ts).
 */
function templateContext(e: Event): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.payload)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      ctx[k] = String(v);
    }
  }
  // Derived, not in the raw payload.
  ctx.project = typeof e.payload.cwd === 'string' ? (e.payload.cwd.split('/').pop() ?? '') : '';
  ctx.session = typeof e.payload.sessionId === 'string' ? e.payload.sessionId.slice(0, 8) : '';
  return ctx;
}

export class StateMachine {
  #rules: StateRule[];
  #deps: StateMachineDeps;
  #current: ResolvedState = {
    emotion: BACKGROUND_MOOD_EMOTION,
    decorators: [],
    leds: [],
    balloon: '',
  };
  #balloon: Balloon = { ...EMPTY_BALLOON };
  #balloonMaxChars: number = DEFAULT_BALLOON_MAX_CHARS;
  #now: () => number;
  #criticalSamples: { ts: number; critical: boolean }[] = [];
  #lastSeverity: string | undefined = undefined;
  #personality: PersonalityManager | null = null;

  constructor(rules: StateRule[], deps: StateMachineDeps, personality?: PersonalityManager) {
    this.#rules = rules;
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#personality = personality ?? null;
    deps.metrics.gauge('time_in_critical_state_ratio', () => this.#criticalRatio());
  }

  setPersonality(p: PersonalityManager | null): void {
    this.#personality = p;
  }

  setRules(rules: StateRule[]): void {
    this.#rules = rules;
  }

  setBalloonMaxChars(max: number): void {
    this.#balloonMaxChars = max > 0 ? Math.floor(max) : DEFAULT_BALLOON_MAX_CHARS;
  }

  current(): ResolvedState {
    return this.#current;
  }

  apply(input: ActiveAttention | null): void {
    const isCritical = input !== null && input.event.severity === 'critical';
    this.#recordCriticalSample(isCritical);
    this.#lastSeverity = input?.event.severity;

    const resolved = input ? this.#resolve(input.event) : this.#backgroundMood();

    // Assign the balloon BEFORE #transition (SPEC-IMPL-FASE-2.5 §2.4, test #21).
    // If two rules produce visibly identical states with different policies,
    // statesEqual short-circuits the emit — but the policy MUST update, or the
    // previous policy is stuck forever. Setting it here decouples policy
    // updates from wire emissions.
    this.#balloon = resolved.balloon;
    this.#transition(resolved.state, input?.event.id, input?.event.timestamp);
  }

  #backgroundMood(): { state: ResolvedState; balloon: Balloon } {
    // Sticky balloons survive idle; transient (or the initial empty) go away.
    const balloon: Balloon =
      this.#balloon.policy === 'sticky' ? { ...this.#balloon } : { ...EMPTY_BALLOON };
    const emotion = this.#personality?.idleEmotion() ?? BACKGROUND_MOOD_EMOTION;
    return {
      state: { emotion, decorators: [], leds: [], balloon: balloon.text },
      balloon,
    };
  }

  forceSafeState(): void {
    // Safe state means no history, no lingering text (S2.5.14). Bypasses
    // apply() because there is no event driving this.
    this.#balloon = { ...EMPTY_BALLOON };
    this.#transition(
      { emotion: BACKGROUND_MOOD_EMOTION, decorators: [], leds: [], balloon: '' },
      undefined,
    );
  }

  /**
   * First matching rule wins (D3: no emotion is hard-wired in code). The
   * config's own severity-only rules act as the safety-net default — if
   * none of those match either, the config is incomplete: warn and fall
   * back to a bare NEUTRAL rather than guessing an emotion in code.
   */
  #resolve(e: Event): { state: ResolvedState; balloon: Balloon } {
    const rule = this.#rules.find((r) => matches(r.match, e));
    let state: ResolvedState;
    if (rule) {
      state = {
        decorators: [],
        leds: [],
        balloon: '',
        ...rule.state,
      };
    } else {
      logger.warn(
        { source: e.source, category: e.category, severity: e.severity },
        'no stateRule matched (not even a severity default) — incomplete config, falling back to NEUTRAL',
      );
      state = { emotion: BACKGROUND_MOOD_EMOTION, decorators: [], leds: [], balloon: '' };
    }

    if (e.direction !== undefined && state.gaze === undefined) {
      state = { ...state, gaze: e.direction };
    }

    // Resolve the balloon (S2.5.2, S2.5.9). Order matters: personality wins the
    // TEXT (D28: expression layer), the rule wins the POLICY (S2.5.12 —
    // mechanics, not expression).
    const ctx = templateContext(e);
    let rawText: string | undefined = rule?.state.balloon;
    const fromPersonality = this.#personality?.balloon(e.category, ctx) ?? null;
    if (fromPersonality !== null) rawText = fromPersonality;

    // Inheritance, as a silent rule would do (S2.5.2). Only `sticky` survives.
    const inherit = (): Balloon =>
      this.#balloon.policy === 'sticky' ? { ...this.#balloon } : { ...EMPTY_BALLOON };

    let balloon: Balloon;
    if (rawText === undefined) {
      // Inheritance on a silent rule (S2.5.2). Only `sticky` balloons survive
      // the arrival of a new active event; a `transient` one dies here — the
      // AttentionManager can resolve/expire the previous event and promote a
      // new one directly (attention.ts:210-220) without passing through
      // apply(null), so `#backgroundMood()` alone doesn't cover this path.
      // Bug found in the M13 integration verification 2026-07-09: a permission
      // (transient) approved from chat would leak its balloon onto whatever
      // next event was promoted from the queue.
      balloon = inherit();
    } else {
      const text = interpolate(rawText, ctx);
      if (UNRESOLVED_PLACEHOLDER.test(text)) {
        // D-08. `interpolate()` keeps an unknown `{key}` literal on purpose, so a
        // broken template is loud rather than silent. Loud belongs in the log; the
        // robot's screen can't explain itself. `{text}` is missing whenever the
        // `Stop` hook carries no `last_assistant_message` and `transcriptReadEnabled`
        // is off — a supported config — and the screen used to read `[proj] {text}`.
        logger.warn(
          { category: e.category, template: rawText, rendered: text },
          'balloon template left placeholders unresolved; falling back to inheritance',
        );
        balloon = inherit();
      } else {
        balloon = {
          text: truncate(text, this.#balloonMaxChars),
          policy: rule?.balloonPolicy ?? 'transient',
        };
      }
    }

    // The extra decorators from personality feed the state, not the balloon.
    if (this.#personality) {
      const extraDecorators = this.#personality.decorators(e.severity);
      if (extraDecorators.length > 0) {
        state = { ...state, decorators: [...new Set([...state.decorators, ...extraDecorators])] };
      }
    }

    // mcp:set_face override (S2.5.14). Explicit emotion wins; balloon comes
    // from payload if present, otherwise CLEARS — never inherits, because an
    // agent forcing a face has no business dragging another event's text.
    if (e.source === 'mcp:set_face' && typeof e.payload.emotion === 'string') {
      state = { ...state, emotion: e.payload.emotion as Emotion };
      const explicit = typeof e.payload.balloon === 'string' ? (e.payload.balloon as string) : '';
      balloon = { text: explicit, policy: 'transient' };
    }

    // The wire state carries the balloon text (S2.5.11: always a string).
    state = { ...state, balloon: balloon.text };
    return { state, balloon };
  }

  #recordCriticalSample(critical: boolean): void {
    const now = this.#now();
    this.#criticalSamples.push({ ts: now, critical });
    const cutoff = now - CRITICAL_WINDOW_MS;
    while (this.#criticalSamples.length > 0 && (this.#criticalSamples[0]?.ts ?? 0) < cutoff) {
      this.#criticalSamples.shift();
    }
  }

  #criticalRatio(): number {
    if (this.#criticalSamples.length === 0) return 0;
    const criticalCount = this.#criticalSamples.filter((s) => s.critical).length;
    return criticalCount / this.#criticalSamples.length;
  }

  #transition(next: ResolvedState, eventId: string | undefined, eventTs?: number): void {
    if (statesEqual(this.#current, next)) return;

    const from = this.#current;
    this.#current = next;
    this.#deps.record('state_change', {
      from,
      to: next,
      eventId,
      // D-10: the bridge's half of D23's budget (event → face resolved). The
      // firmware half is `state_latency_ms` in ble/protocol.ts. Persisted on the
      // line rather than kept in a histogram, which dies on restart while Gate 1
      // needs a p95 over three weeks. Clamped at 0: an NTP step or a sleep/wake
      // can put the event in the future, and a negative sample poisons the p95
      // without ever looking wrong.
      ...(eventTs === undefined ? {} : { latencyMs: Math.max(0, this.#now() - eventTs) }),
    });
    if (from.emotion !== next.emotion) {
      this.#deps.metrics.counter('face_changes_total').inc();
    }
    if (
      this.#deps.balloonHistory &&
      typeof next.balloon === 'string' &&
      next.balloon !== '' &&
      next.balloon !== from.balloon
    ) {
      this.#deps.balloonHistory.push(next.balloon, eventId);
    }
    this.#deps.emit(next);
  }
}
