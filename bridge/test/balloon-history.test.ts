import { describe, expect, it } from 'vitest';
import { BalloonHistory } from '../src/core/balloon-history.js';

/**
 * M15 §6.4. The history is server-side because the server owns the balloon
 * (S2.5.1). Everything it stores was already public via SSE — no auth needed.
 *
 * The 9 tests below map 1:1 to the checklist in SPEC-IMPL-FASE-2.5 §6.4.
 */

describe('BalloonHistory (M15)', () => {
  it('#1: keeps up to `capacity` entries', () => {
    const h = new BalloonHistory(10);
    for (let i = 0; i < 15; i++) h.push(`msg ${i}`);
    expect(h.recent().length).toBe(10);
  });

  it('#2: newest entry first', () => {
    const h = new BalloonHistory(10);
    h.push('A');
    h.push('B');
    expect(h.recent()[0]?.text).toBe('B');
    expect(h.recent()[1]?.text).toBe('A');
  });

  it('#3: dedupes the same text consecutively (spec §6.1)', () => {
    // The caller (StateMachine.#transition) already avoids emitting when the
    // resolved state didn't change, but this is a belt-and-braces guard for
    // paths that push directly (e.g. mcp:set_face with the same balloon
    // twice). Two DIFFERENT eventIds with the same TEXT still collapse into
    // one entry — the history is about what was seen, not what caused it.
    const h = new BalloonHistory(10);
    h.push('A', 'e1');
    h.push('A', 'e2');
    expect(h.recent().length).toBe(1);
  });

  it('#4: ignores empty strings', () => {
    const h = new BalloonHistory(10);
    h.push('');
    expect(h.recent().length).toBe(0);
  });

  it('#5: stores the eventId when provided', () => {
    const h = new BalloonHistory(10);
    h.push('x', 'e1');
    expect(h.recent()[0]?.eventId).toBe('e1');
  });

  it('#6: entries carry a timestamp from the injected clock', () => {
    let t = 100;
    const h = new BalloonHistory(10, () => t);
    h.push('A');
    t = 200;
    h.push('B');
    expect(h.recent()[0]?.ts).toBe(200);
    expect(h.recent()[1]?.ts).toBe(100);
  });

  it('#7: recent() returns a defensive copy — callers cannot corrupt the buffer', () => {
    const h = new BalloonHistory(3);
    h.push('A');
    // recent() returns readonly on purpose; the double cast is the point of the test.
    const snap = h.recent() as unknown as { text: string }[];
    // Mutating the returned array shouldn't affect the buffer.
    snap.push({ text: 'X' } as unknown as (typeof snap)[number]);
    expect(h.recent().length).toBe(1);
  });

  it('#8: capacity default is 10 when not provided', () => {
    const h = new BalloonHistory();
    for (let i = 0; i < 12; i++) h.push(`m${i}`);
    expect(h.recent().length).toBe(10);
  });

  it('#9: `capacity: 0` behaves like a no-op sink (never grows)', () => {
    const h = new BalloonHistory(0);
    h.push('A');
    h.push('B');
    expect(h.recent().length).toBe(0);
  });
});
