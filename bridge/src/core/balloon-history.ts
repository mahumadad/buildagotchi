/**
 * Server-side ring buffer of balloons the face has shown (SPEC-FASE-2.5 §6).
 * Fed from `StateMachine.#transition` whenever the resolved balloon text
 * changes, exposed via `GET /balloons` and rendered in the dashboard's Screen
 * history panel.
 *
 * The buffer is trivial by design: no dedup, no timers, no filtering. That
 * logic lives in the StateMachine (it only calls push() on actual balloon
 * changes) so the same one-place-for-policy rule that fixed the four-writer
 * bug applies here too. See test/balloon-history.test.ts #3 for the rationale.
 */
export interface BalloonEntry {
  ts: number;
  text: string;
  eventId?: string;
}

const DEFAULT_CAPACITY = 10;

export class BalloonHistory {
  readonly #capacity: number;
  #buffer: BalloonEntry[] = [];
  #now: () => number;

  constructor(capacity: number = DEFAULT_CAPACITY, now: () => number = Date.now) {
    // Negative capacity would produce an unbounded buffer via `slice(-cap)`
    // arithmetic; clamp to 0 (a no-op sink) so a bad config can't leak memory.
    this.#capacity = Math.max(0, Math.floor(capacity));
    this.#now = now;
  }

  /** Push a new balloon. No-op if `text` is empty (the empty balloon isn't
   *  worth remembering — the screen was cleared, not showing something) or if
   *  it's identical to the most recent entry (spec §6.1). */
  push(text: string, eventId?: string): void {
    if (this.#capacity === 0) return;
    if (text === '') return;
    const last = this.#buffer[this.#buffer.length - 1];
    if (last?.text === text) return;
    const entry: BalloonEntry = { ts: this.#now(), text };
    if (eventId !== undefined) entry.eventId = eventId;
    this.#buffer.push(entry);
    if (this.#buffer.length > this.#capacity) {
      this.#buffer.shift();
    }
  }

  /** Newest first. Returns a fresh array so external callers can't mutate the
   *  internal buffer. */
  recent(): readonly BalloonEntry[] {
    return [...this.#buffer].reverse();
  }
}
