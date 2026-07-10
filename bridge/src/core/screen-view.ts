export type ViewName = 'face' | 'stats';

export interface ScreenViewState {
  view: ViewName;
  page: number;
  pages: number;
}

/** Pages per view. The face is the face; stats has tokens and sessions. */
const PAGES: Record<ViewName, number> = { face: 1, stats: 2 };
const ORDER: ViewName[] = ['face', 'stats'];

/**
 * Which page the robot's 320×240 screen is showing.
 *
 * Server state, never client state (S2.5.1). The CoreS3 firmware cannot run
 * browser JS, so display policy living in `dashboard.js` has to be written twice
 * and the two copies drift. That divergence produced four balloon bugs before
 * S2.5.1 moved the balloon here; there is no reason to repeat it for views.
 *
 * Navigation is by button, following `claude-desktop-buddy`. Not by touch: the
 * head's swipes already mean petting upstream, and the screen's touch reports
 * raw x/y with no gesture recognizer behind it (D-13).
 */
export class ScreenView {
  #view: ViewName = 'face';
  #page = 0;

  current(): ScreenViewState {
    return { view: this.#view, page: this.#page, pages: PAGES[this.#view] };
  }

  nextView(): ScreenViewState {
    const index = ORDER.indexOf(this.#view);
    this.#view = ORDER[(index + 1) % ORDER.length] as ViewName;
    // Landing on page 2 of a screen you left minutes ago is disorienting on a
    // robot you only glance at.
    this.#page = 0;
    return this.current();
  }

  nextPage(): ScreenViewState {
    this.#page = (this.#page + 1) % PAGES[this.#view];
    return this.current();
  }

  /** Safe mode (D16): a page nobody can update describes nothing. */
  reset(): ScreenViewState {
    this.#view = 'face';
    this.#page = 0;
    return this.current();
  }
}
