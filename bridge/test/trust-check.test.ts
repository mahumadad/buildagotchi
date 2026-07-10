import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustCheckAdapter } from '../src/adapters/trust-check.js';
import type { Emotion } from '../src/core/events.js';

/**
 * D22 defines the trust check: how many times a day does the user open Claude
 * while the buddy says everything is fine? A high count means they don't trust
 * the face. It is the hardest of Gate 1's criteria and the only one that was
 * never implemented (was D-09).
 *
 * Three rules, and each one is a test below:
 *   1. It counts the TRANSITION into focus, not the fact of being focused.
 *   2. A re-focus within 30s doesn't count (alt-tab, a notification).
 *   3. It only counts when the buddy claims nothing is pending — otherwise the
 *      user is answering the robot, not distrusting it.
 */

function harness(opts: { emotion?: Emotion } = {}) {
  let now = 1_000_000;
  let front: string | null = null;
  let emotion: Emotion = opts.emotion ?? 'NEUTRAL';
  const recorded: Record<string, unknown>[] = [];

  const adapter = new TrustCheckAdapter({
    watchedBundleId: 'com.anthropic.claudefordesktop',
    frontmostBundleId: () => front,
    currentEmotion: () => emotion,
    record: (data) => recorded.push(data),
    now: () => now,
  });

  return {
    adapter,
    recorded,
    focus: (bundleId: string | null) => {
      front = bundleId;
    },
    setEmotion: (e: Emotion) => {
      emotion = e;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get count() {
      return recorded.length;
    },
  };
}

const CLAUDE = 'com.anthropic.claudefordesktop';
const OTHER = 'com.apple.Safari';
const THIRTY_ONE_SECONDS = 31_000;

describe('TrustCheckAdapter (D22)', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('counts a focus on Claude while the buddy is NEUTRAL', () => {
    h.focus(OTHER);
    h.adapter.poll();
    h.focus(CLAUDE);
    h.adapter.poll();

    expect(h.count).toBe(1);
    expect(h.recorded[0]).toMatchObject({ source: 'trust_check', category: 'trust_check' });
  });

  it('counts the transition, not every poll while focused', () => {
    h.focus(CLAUDE);
    h.adapter.poll();
    h.adapter.poll();
    h.adapter.poll();

    expect(h.count).toBe(1);
  });

  it('does not count a re-focus within 30s — alt-tab is not distrust', () => {
    h.focus(CLAUDE);
    h.adapter.poll();
    h.focus(OTHER);
    h.adapter.poll();
    h.advance(5_000);
    h.focus(CLAUDE);
    h.adapter.poll();

    expect(h.count).toBe(1);
  });

  it('counts a re-focus after 30s away', () => {
    h.focus(CLAUDE);
    h.adapter.poll();
    h.focus(OTHER);
    h.adapter.poll();
    h.advance(THIRTY_ONE_SECONDS);
    h.focus(CLAUDE);
    h.adapter.poll();

    expect(h.count).toBe(2);
  });

  it('does not count when the buddy has something pending (DOUBTFUL)', () => {
    h.setEmotion('DOUBTFUL');
    h.focus(OTHER);
    h.adapter.poll();
    h.focus(CLAUDE);
    h.adapter.poll();

    // The user is answering a permission prompt, not checking up on the robot.
    expect(h.count).toBe(0);
  });

  it('counts when the buddy is HAPPY — "all good" is also a claim to distrust', () => {
    h.setEmotion('HAPPY');
    h.focus(OTHER);
    h.adapter.poll();
    h.focus(CLAUDE);
    h.adapter.poll();

    expect(h.count).toBe(1);
  });

  it('the 30s window is measured from losing focus, not from the last count', () => {
    // Focus Claude while DOUBTFUL (no count), leave, come back 31s later while
    // NEUTRAL. The uncounted visit must still have armed the window.
    h.setEmotion('DOUBTFUL');
    h.focus(CLAUDE);
    h.adapter.poll();
    h.focus(OTHER);
    h.adapter.poll();
    h.advance(THIRTY_ONE_SECONDS);
    h.setEmotion('NEUTRAL');
    h.focus(CLAUDE);
    h.adapter.poll();

    expect(h.count).toBe(1);
  });

  it('a frontmost app that cannot be read does not crash or count', () => {
    h.focus(null); // lsappinfo returned nothing
    h.adapter.poll();
    h.focus(CLAUDE);
    h.adapter.poll();

    expect(h.count).toBe(1); // null is simply "not Claude"
  });

  it('start()/stop() are idempotent and do not leak an interval', () => {
    vi.useFakeTimers();
    const a = harness().adapter;
    a.start();
    a.start();
    a.stop();
    a.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
