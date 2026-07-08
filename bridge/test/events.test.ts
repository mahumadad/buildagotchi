import { describe, expect, it } from 'vitest';
import { EventSchema, newEvent, severityRank } from '../src/core/events.js';

const validEvent = {
  schemaVersion: 1 as const,
  id: '018f000000000000000000000000',
  source: 'claude',
  category: 'permission',
  severity: 'critical' as const,
  hash: 'abc123',
  timestamp: Date.now(),
  payload: {},
};

describe('EventSchema', () => {
  it('accepts a valid event', () => {
    expect(EventSchema.safeParse(validEvent).success).toBe(true);
  });

  it.each([
    'schemaVersion',
    'id',
    'source',
    'category',
    'severity',
    'hash',
    'timestamp',
    'payload',
  ])('rejects a missing required field: %s', (field) => {
    const { [field]: _omit, ...rest } = validEvent as Record<string, unknown>;
    expect(EventSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects extra fields (strict contract, D26)', () => {
    expect(EventSchema.safeParse({ ...validEvent, extra: 'nope' }).success).toBe(false);
  });

  it('accepts optional direction and ttlMs', () => {
    const result = EventSchema.safeParse({ ...validEvent, direction: 'left', ttlMs: 1000 });
    expect(result.success).toBe(true);
  });
});

describe('severityRank', () => {
  it('ranks critical highest and ambient lowest', () => {
    expect(severityRank('critical')).toBe(4);
    expect(severityRank('high')).toBe(3);
    expect(severityRank('medium')).toBe(2);
    expect(severityRank('low')).toBe(1);
    expect(severityRank('ambient')).toBe(0);
  });
});

describe('newEvent', () => {
  it('generates distinct, time-ordered ids', () => {
    const e1 = newEvent({ source: 'a', category: 'b', severity: 'low', payload: {} });
    const e2 = newEvent({ source: 'a', category: 'b', severity: 'low', payload: {} });
    expect(e1.id).not.toBe(e2.id);
    expect(e1.id < e2.id).toBe(true);
  });

  it('fills schemaVersion and timestamp', () => {
    const before = Date.now();
    const e = newEvent({ source: 'a', category: 'b', severity: 'low', payload: {} });
    expect(e.schemaVersion).toBe(1);
    expect(e.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('computes a stable hash for the same input', () => {
    const e1 = newEvent({ source: 'a', category: 'b', severity: 'low', payload: { x: 1 } });
    const e2 = newEvent({ source: 'a', category: 'b', severity: 'low', payload: { x: 1 } });
    expect(e1.hash).toBe(e2.hash);
  });

  it('computes a different hash for a different payload', () => {
    const e1 = newEvent({ source: 'a', category: 'b', severity: 'low', payload: { x: 1 } });
    const e2 = newEvent({ source: 'a', category: 'b', severity: 'low', payload: { x: 2 } });
    expect(e1.hash).not.toBe(e2.hash);
  });

  it('preserves an explicit hash instead of computing one', () => {
    const e = newEvent({ source: 'a', category: 'b', severity: 'low', payload: {}, hash: 'given' });
    expect(e.hash).toBe('given');
  });

  it('produces an event that validates against EventSchema', () => {
    const e = newEvent({ source: 'a', category: 'b', severity: 'low', payload: {} });
    expect(EventSchema.safeParse(e).success).toBe(true);
  });
});
