export type GestureAction =
  | { type: 'tap' }
  | { type: 'hold' }
  | { type: 'pet' }
  | { type: 'swipe'; direction: 'forward' | 'backward' };

export interface GestureRecognizerOptions {
  tapMs?: number;
  holdMs?: number;
  now?: () => number;
}

export class GestureRecognizer {
  readonly #tapMs: number;
  readonly #holdMs: number;
  readonly #now: () => number;
  #pressStartAt = 0;
  #holdTimer: ReturnType<typeof setTimeout> | null = null;
  #state: 'idle' | 'pressed' | 'hold-fired' = 'idle';
  #onAction: ((action: GestureAction) => void) | null = null;

  constructor(opts?: GestureRecognizerOptions) {
    this.#tapMs = opts?.tapMs ?? 300;
    this.#holdMs = opts?.holdMs ?? 2000;
    this.#now = opts?.now ?? Date.now;
  }

  set onAction(cb: (action: GestureAction) => void) {
    this.#onAction = cb;
  }

  get touchState(): 'idle' | 'pressed' | 'hold-fired' {
    return this.#state;
  }

  input(gesture: string): void {
    switch (gesture) {
      case 'press':
        this.#pressStartAt = this.#now();
        this.#state = 'pressed';
        if (this.#holdTimer) clearTimeout(this.#holdTimer);
        this.#holdTimer = setTimeout(() => {
          this.#state = 'hold-fired';
          this.#holdTimer = null;
          this.#onAction?.({ type: 'hold' });
        }, this.#holdMs);
        return;

      case 'release': {
        if (this.#holdTimer) {
          clearTimeout(this.#holdTimer);
          this.#holdTimer = null;
        }
        const duration = this.#now() - this.#pressStartAt;
        if (this.#state === 'hold-fired') {
          this.#state = 'idle';
          return;
        }
        this.#state = 'idle';
        if (duration <= this.#tapMs) {
          this.#onAction?.({ type: 'tap' });
        }
        return;
      }

      case 'pet':
        this.#onAction?.({ type: 'pet' });
        return;

      case 'forwardSwipe':
        this.#onAction?.({ type: 'swipe', direction: 'forward' });
        return;

      case 'backwardSwipe':
        this.#onAction?.({ type: 'swipe', direction: 'backward' });
        return;
    }
  }

  dispose(): void {
    if (this.#holdTimer) {
      clearTimeout(this.#holdTimer);
      this.#holdTimer = null;
    }
  }
}
