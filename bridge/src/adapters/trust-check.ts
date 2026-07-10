import { execFileSync } from 'node:child_process';
import pino from 'pino';
import type { Emotion } from '../core/events.js';

const logger = pino({ name: 'trust-check' });

/** D22: a re-focus sooner than this is alt-tab, not a trust check. */
/** The app D22 means by "the user opened Claude to check". */
export const CLAUDE_DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop';

const REFOCUS_WINDOW_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

export interface TrustCheckDeps {
  /** Bundle id that counts as "the user went to look at Claude". */
  watchedBundleId: string;
  /** Frontmost app's bundle id, or null when it can't be read. */
  frontmostBundleId: () => string | null;
  /** The face the robot is showing right now. */
  currentEmotion: () => Emotion;
  /** Writes the synthetic event straight to the Event Recorder. */
  record: (data: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * The trust check (D22): how often does the user go look at Claude *while the
 * buddy is claiming nothing is pending*? A high count means they don't believe
 * the face. Gate 1 (D20) wants ≤ 2 per day in weeks 2 and 3.
 *
 * It writes to the Event Recorder directly, not through the bus. A trust check
 * is telemetry about the user, not something the robot should react to — and
 * routing it through the AttentionManager would make it the active event,
 * displacing the background mood the metric depends on observing.
 *
 * D22 assumed this needed `kTCCServiceAccessibility` and a consent dialog.
 * It doesn't: `lsappinfo` is public LaunchServices and needs no permission.
 * The burn-in of the first 3 days is a query-time concern, not a runtime one —
 * the lines are written from day 0 and discarded when Gate 1 is evaluated.
 */
export class TrustCheckAdapter {
  readonly name = 'trust-check';

  #deps: TrustCheckDeps;
  #now: () => number;
  #wasFocused = false;
  /** When Claude last stopped being frontmost. Null = never focused yet. */
  #lastBlurAt: number | null = null;
  #interval: NodeJS.Timeout | null = null;

  constructor(deps: TrustCheckDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.#interval) return;
    this.#interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.#interval.unref?.();
  }

  stop(): void {
    if (!this.#interval) return;
    clearInterval(this.#interval);
    this.#interval = null;
  }

  /** Exposed for tests; `start()` just calls it on a timer. */
  poll(): void {
    const isFocused = this.#deps.frontmostBundleId() === this.#deps.watchedBundleId;

    if (!isFocused) {
      if (this.#wasFocused) this.#lastBlurAt = this.#now();
      this.#wasFocused = false;
      return;
    }

    // Focused. Only the transition counts, not each poll while it stays focused.
    if (this.#wasFocused) return;
    this.#wasFocused = true;

    // The window runs from losing focus, not from the last recorded check: a
    // visit that didn't count (buddy was busy) still has to arm it.
    const blurredAt = this.#lastBlurAt;
    if (blurredAt !== null && this.#now() - blurredAt < REFOCUS_WINDOW_MS) return;

    const emotion = this.#deps.currentEmotion();
    if (!isCalm(emotion)) return; // answering the robot, not distrusting it

    this.#deps.record({
      source: 'trust_check',
      category: 'trust_check',
      severity: 'ambient',
      payload: { emotion },
    });
  }
}

/** The buddy claims nothing is pending. Distrusting *this* is what we measure. */
function isCalm(e: Emotion): boolean {
  return e === 'NEUTRAL' || e === 'HAPPY';
}

/**
 * Frontmost app via LaunchServices. No TCC permission, no consent dialog, no
 * osascript (which would need Automation consent). Returns null on any failure:
 * losing a sample is better than killing the poll loop.
 */
export function readFrontmostBundleId(): string | null {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8', timeout: 1000 }).trim();
    if (!asn) return null;
    const raw = execFileSync('lsappinfo', ['info', '-only', 'bundleid', asn], {
      encoding: 'utf8',
      timeout: 1000,
    });
    // `"CFBundleIdentifier"="com.anthropic.claudefordesktop"`
    const match = raw.match(/"CFBundleIdentifier"="([^"]+)"/);
    return match?.[1] ?? null;
  } catch (err) {
    logger.debug({ err }, 'could not read the frontmost app');
    return null;
  }
}
