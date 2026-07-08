import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runShutdown } from '../src/core/lifecycle.js';

describe('runShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs steps in order', async () => {
    const order: string[] = [];
    const steps = [
      { name: 'a', run: async () => void order.push('a') },
      { name: 'b', run: async () => void order.push('b') },
      { name: 'c', run: async () => void order.push('c') },
    ];

    const result = await runShutdown(steps, 3000);

    expect(order).toEqual(['a', 'b', 'c']);
    expect(result).toBe('clean');
  });

  it('resolves via timeout when a step hangs', async () => {
    const steps = [
      { name: 'a', run: async () => {} },
      { name: 'hangs', run: () => new Promise<void>(() => {}) },
    ];

    const resultPromise = runShutdown(steps, 3000);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;

    expect(result).toBe('timeout');
  });
});
