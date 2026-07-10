import { describe, expect, it } from 'vitest';
import { ScreenView } from '../src/core/screen-view.js';

/**
 * Which page the robot's 320×240 screen is showing. Server state, not client
 * state (S2.5.1): the CoreS3 firmware cannot run browser JS, so any policy that
 * lives in `dashboard.js` has to be written twice and the two copies diverge.
 * That is the bug S2.5.1 exists to prevent, and it already bit us four times.
 *
 * The precedent is `claude-desktop-buddy`: a display mode cycled by one button,
 * a page cycled by another, and a `3/6` indicator so you know where you are.
 * Navigation is by button, not by touch — the head's swipes are taken by petting
 * and the screen's touch reports raw x/y with no gesture recognizer (D-13).
 */

describe('ScreenView', () => {
  it('starts on the face', () => {
    expect(new ScreenView().current()).toEqual({ view: 'face', page: 0, pages: 1 });
  });

  it('cycles face → stats → face', () => {
    const v = new ScreenView();
    v.nextView();
    expect(v.current().view).toBe('stats');
    v.nextView();
    expect(v.current().view).toBe('face');
  });

  it('the face has a single page, so paging is a no-op there', () => {
    const v = new ScreenView();
    v.nextPage();
    expect(v.current()).toEqual({ view: 'face', page: 0, pages: 1 });
  });

  it('pages wrap within the stats view', () => {
    const v = new ScreenView();
    v.nextView(); // stats: tokens, sessions
    expect(v.current().pages).toBe(2);
    v.nextPage();
    expect(v.current().page).toBe(1);
    v.nextPage();
    expect(v.current().page).toBe(0);
  });

  it('leaving a view and coming back forgets the page', () => {
    // Coming back to page 2 of a screen you left minutes ago is disorienting on
    // a robot you glance at. The precedent resets too.
    const v = new ScreenView();
    v.nextView();
    v.nextPage();
    v.nextView(); // back to face
    v.nextView(); // stats again
    expect(v.current().page).toBe(0);
  });

  it('a safe-mode reset drops back to the face', () => {
    // The link died. Whatever page was up describes a state nobody can update.
    const v = new ScreenView();
    v.nextView();
    v.nextPage();
    v.reset();
    expect(v.current()).toEqual({ view: 'face', page: 0, pages: 1 });
  });
});
