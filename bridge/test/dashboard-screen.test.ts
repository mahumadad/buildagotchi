// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { formatTokens, renderScreenView } from '../src/server/public/screen.mjs';

/**
 * D-14: the emulator's JS had no tests at all, and it is the only evidence we
 * have that the firmware will do the right thing. The vanishing-robot bug lived
 * here — the view switched correctly on the server while the 3D canvas collapsed
 * to 0×0 — and the user found it by pressing the buttons.
 */

const STATS = {
  output: { today: 41_000, sinceStart: 1_055 },
  context: { bySession: { 'sess-abcdef123456': 628_474 }, max: 628_474 },
  sessions: { total: 2, running: 1, waiting: 1 },
};

function dom() {
  document.body.innerHTML = `
    <div class="face-panel">
      <div id="badge"></div>
      <div id="overlay" hidden></div>
      <div class="viewport-3d-wrap"><canvas id="viewport-3d"></canvas></div>
    </div>`;
  return {
    badge: document.getElementById('badge') as HTMLElement,
    overlay: document.getElementById('overlay') as HTMLElement,
    wrap: document.querySelector('.viewport-3d-wrap') as HTMLElement,
  };
}

describe('formatTokens', () => {
  it('abbreviates so 184502 fits a 320px screen', () => {
    expect(formatTokens(184_502)).toBe('184.5K');
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(950)).toBe('950');
  });

  it('does not abbreviate the boundary below 1000', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_000)).toBe('1.0K');
  });
});

describe('renderScreenView', () => {
  let els: ReturnType<typeof dom>;
  beforeEach(() => {
    els = dom();
  });

  it('names the view, and the page only when there is more than one', () => {
    renderScreenView(els, { view: 'face', page: 0, pages: 1 }, STATS);
    expect(els.badge.textContent).toBe('face');

    renderScreenView(els, { view: 'stats', page: 1, pages: 2 }, STATS);
    expect(els.badge.textContent).toBe('stats 2/2');
  });

  it('hides the overlay on the face and shows it on stats', () => {
    renderScreenView(els, { view: 'face', page: 0, pages: 1 }, STATS);
    expect(els.overlay.hidden).toBe(true);

    renderScreenView(els, { view: 'stats', page: 0, pages: 2 }, STATS);
    expect(els.overlay.hidden).toBe(false);
  });

  it('NEVER hides the 3D scene — the bug that made the robot disappear', () => {
    // Hiding `.viewport-3d-wrap` collapsed it to 0×0, and StackchanScene#resize
    // only runs on a window resize, so the canvas never came back. The overlay
    // must be drawn OVER the scene, never instead of it.
    renderScreenView(els, { view: 'stats', page: 0, pages: 2 }, STATS);
    expect(els.wrap.hidden).toBe(false);

    renderScreenView(els, { view: 'face', page: 0, pages: 1 }, STATS);
    expect(els.wrap.hidden).toBe(false);
  });

  it('page 0 shows the token counters', () => {
    renderScreenView(els, { view: 'stats', page: 0, pages: 2 }, STATS);
    const text = els.overlay.textContent ?? '';
    expect(text).toContain('TOKENS');
    expect(text).toContain('41.0K');
    expect(text).toContain('628.5K');
  });

  it('page 1 lists sessions with their context', () => {
    renderScreenView(els, { view: 'stats', page: 1, pages: 2 }, STATS);
    const text = els.overlay.textContent ?? '';
    expect(text).toContain('SESSIONS');
    expect(text).toContain('1 run / 1 wait'); // counts from the adapter
    expect(text).toContain('628.5K');
    // Truncated to fit 320px. Asserting the PREFIX is present proves nothing —
    // it is there either way. What distinguishes is that the rest is gone.
    expect(text).toContain('sess-abcdef1');
    expect(text).not.toContain('sess-abcdef123456');
  });

  it('says so when there are no live sessions', () => {
    const empty = { output: { today: 0, sinceStart: 0 }, context: { bySession: {}, max: 0 } };
    renderScreenView(els, { view: 'stats', page: 1, pages: 2 }, empty);
    expect(els.overlay.textContent).toContain('none');
  });

  it('shows an em dash rather than a zero when nothing is in context', () => {
    const empty = { output: { today: 5, sinceStart: 5 }, context: { bySession: {}, max: 0 } };
    renderScreenView(els, { view: 'stats', page: 0, pages: 2 }, empty);
    expect(els.overlay.textContent).toContain('—');
  });

  it('a missing screen leaves the DOM untouched rather than throwing', () => {
    els.badge.textContent = 'unchanged';
    renderScreenView(els, undefined, STATS);
    expect(els.badge.textContent).toBe('unchanged');
  });
});
