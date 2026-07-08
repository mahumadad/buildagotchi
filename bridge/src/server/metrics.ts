/**
 * Hand-rolled metrics registry (SA3, SPEC-IMPL-FASE-1A §5.1). `prom-client`
 * doesn't give p50/p95 per-histogram without a Summary and complicates the
 * moving-window gauges required by SPEC §13, so this small registry covers
 * Counter, Gauge and Histogram (ring buffer 512 → p50/p95) plus a Prometheus
 * text exposition.
 */

const RING_BUFFER_SIZE = 512;

function serializeLabels(labelNames: string[], values?: Record<string, string>): string {
  if (labelNames.length === 0) return '';
  const parts = labelNames.map((name) => `${name}="${values?.[name] ?? ''}"`);
  return `{${parts.join(',')}}`;
}

export class Counter {
  #labelNames: string[];
  #series = new Map<string, number>();

  constructor(labelNames: string[] = []) {
    this.#labelNames = labelNames;
  }

  inc(labelValues?: Record<string, string>, n = 1): void {
    const key = serializeLabels(this.#labelNames, labelValues);
    this.#series.set(key, (this.#series.get(key) ?? 0) + n);
  }

  /** Internal: (labelSuffix, value) pairs for exposition. */
  entries(): Array<[string, number]> {
    if (this.#series.size === 0) return [['', 0]];
    return [...this.#series.entries()];
  }
}

export class Gauge {
  #value = 0;
  #collect: (() => number) | undefined;

  constructor(collect?: () => number) {
    this.#collect = collect;
  }

  set(v: number): void {
    this.#value = v;
  }

  value(): number {
    return this.#collect ? this.#collect() : this.#value;
  }
}

export class Histogram {
  #samples: number[] = [];

  observe(ms: number): void {
    this.#samples.push(ms);
    if (this.#samples.length > RING_BUFFER_SIZE) {
      this.#samples.shift();
    }
  }

  #percentile(p: number): number {
    if (this.#samples.length === 0) return 0;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx] as number;
  }

  p50(): number {
    return this.#percentile(0.5);
  }

  p95(): number {
    return this.#percentile(0.95);
  }

  count(): number {
    return this.#samples.length;
  }
}

export class Metrics {
  #counters = new Map<string, Counter>();
  #gauges = new Map<string, Gauge>();
  #histograms = new Map<string, Histogram>();

  counter(name: string, labels: string[] = []): Counter {
    let c = this.#counters.get(name);
    if (!c) {
      c = new Counter(labels);
      this.#counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, collect?: () => number): Gauge {
    let g = this.#gauges.get(name);
    if (!g) {
      g = new Gauge(collect);
      this.#gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string): Histogram {
    let h = this.#histograms.get(name);
    if (!h) {
      h = new Histogram();
      this.#histograms.set(name, h);
    }
    return h;
  }

  exposition(): string {
    const lines: string[] = [];

    for (const [name, counter] of this.#counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labelSuffix, value] of counter.entries()) {
        lines.push(`${name}${labelSuffix} ${value}`);
      }
    }

    for (const [name, gauge] of this.#gauges) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${gauge.value()}`);
    }

    for (const [name, histogram] of this.#histograms) {
      lines.push(`# TYPE ${name} histogram`);
      lines.push(`${name}_p50 ${histogram.p50()}`);
      lines.push(`${name}_p95 ${histogram.p95()}`);
      lines.push(`${name}_count ${histogram.count()}`);
    }

    return `${lines.join('\n')}\n`;
  }
}
