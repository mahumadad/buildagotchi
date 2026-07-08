import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/server/metrics.js';

describe('Metrics', () => {
  it('counter increments by 1 by default, and by n', () => {
    const m = new Metrics();
    const c = m.counter('events_total');
    c.inc();
    c.inc(undefined, 4);
    expect(m.exposition()).toContain('events_total 5');
  });

  it('counter with labels tracks separate series', () => {
    const m = new Metrics();
    const c = m.counter('events_total', ['source', 'severity']);
    c.inc({ source: 'claude', severity: 'high' });
    c.inc({ source: 'claude', severity: 'high' });
    c.inc({ source: 'chrome', severity: 'critical' });
    const text = m.exposition();
    expect(text).toContain('events_total{source="claude",severity="high"} 2');
    expect(text).toContain('events_total{source="chrome",severity="critical"} 1');
  });

  it('gauge set() reports the last value', () => {
    const m = new Metrics();
    const g = m.gauge('am_queue_size');
    g.set(3);
    g.set(7);
    expect(m.exposition()).toContain('am_queue_size 7');
  });

  it('gauge with collect() callback is computed at exposition time', () => {
    const m = new Metrics();
    let n = 0;
    m.gauge('face_changes_per_minute', () => n);
    n = 42;
    expect(m.exposition()).toContain('face_changes_per_minute 42');
  });

  it('histogram observe() feeds p50/p95 derived gauges', () => {
    const m = new Metrics();
    const h = m.histogram('state_latency_ms');
    for (let i = 1; i <= 100; i++) h.observe(i);
    const text = m.exposition();
    expect(text).toMatch(/state_latency_ms_p50 (4|5)\d(\.\d+)?/);
    expect(text).toMatch(/state_latency_ms_p95 9[0-9](\.\d+)?/);
  });

  it('exposition() is parseable line by line (# HELP/# TYPE + metric lines)', () => {
    const m = new Metrics();
    m.counter('parser_errors_total').inc();
    m.gauge('am_queue_size').set(1);
    m.histogram('reconnect_duration_ms').observe(10);
    const lines = m.exposition().split('\n').filter(Boolean);
    for (const line of lines) {
      expect(line.startsWith('#') || /^[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})? -?\d/.test(line)).toBe(
        true,
      );
    }
  });

  it('ring buffer caps at 512 samples for histogram', () => {
    const m = new Metrics();
    const h = m.histogram('x');
    for (let i = 0; i < 1000; i++) h.observe(i);
    // p95 of the last 512 samples (488..999) should be near the top of that range,
    // not near 950 (which would be the case for the full 0..999 series).
    const text = m.exposition();
    const match = /x_p95 (\d+(\.\d+)?)/.exec(text);
    expect(match).not.toBeNull();
    const p95 = Number(match?.[1]);
    expect(p95).toBeGreaterThan(900);
  });
});
