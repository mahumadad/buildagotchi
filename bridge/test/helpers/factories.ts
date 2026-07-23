import { vi } from 'vitest';
import type { Platform } from '../../src/platform/platform.js';
import type { MetricsLike as AmMetricsLike } from '../../src/core/attention.js';
import type { MetricsLike as SmMetricsLike } from '../../src/core/state-machine.js';
import type { Metrics } from '../../src/server/metrics.js';

export function makePlatform(overrides?: Partial<Platform>): Platform {
  return {
    getSecret: vi.fn().mockResolvedValue(null),
    setSecret: vi.fn(),
    dataDir: () => '/tmp',
    ...overrides,
  } as unknown as Platform;
}

export function makeAmMetrics(): {
  metrics: AmMetricsLike;
  gauges: Record<string, number>;
} {
  const gauges: Record<string, number> = {};
  return {
    metrics: {
      gauge: (name: string) => ({
        set: (v: number) => {
          gauges[name] = v;
        },
      }),
    },
    gauges,
  };
}

export function makeSmMetrics(): {
  metrics: SmMetricsLike;
  counters: Record<string, number>;
  gauges: Record<string, number>;
} {
  const counters: Record<string, number> = {};
  const gauges: Record<string, number> = {};
  return {
    metrics: {
      counter: (name: string) => ({
        inc: (_labelValues?: Record<string, string>, n = 1) => {
          counters[name] = (counters[name] ?? 0) + n;
        },
      }),
      gauge: (name: string) => ({
        set: (v: number) => {
          gauges[name] = v;
        },
      }),
    },
    counters,
    gauges,
  };
}

export function makeStubMetrics(): Metrics {
  return {
    counter: () => ({ inc: vi.fn() }),
    gauge: () => ({ set: vi.fn() }),
    histogram: () => ({ observe: vi.fn() }),
  } as unknown as Metrics;
}

export function makeFullMetrics(): {
  metrics: Metrics;
  counters: Record<string, number>;
  histograms: Record<string, number[]>;
} {
  const counters: Record<string, number> = {};
  const histograms: Record<string, number[]> = {};
  const metrics: Metrics = {
    counter: (name: string) => ({
      inc: (_labelValues?: Record<string, string>, n = 1) => {
        counters[name] = (counters[name] ?? 0) + n;
      },
    }),
    histogram: (name: string) => ({
      observe: (ms: number) => {
        if (!histograms[name]) histograms[name] = [];
        histograms[name]!.push(ms);
      },
    }),
    gauge: (name: string) => ({
      set: (v: number) => {
        counters[name] = v;
      },
    }),
  } as unknown as Metrics;
  return { metrics, counters, histograms };
}
