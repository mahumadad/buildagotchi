import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ConfigSchema } from '../src/config/schema.js';

const EXAMPLE_PATH = join(import.meta.dirname, '..', '..', 'config.example.yaml');

describe('ConfigSchema', () => {
  it('validates the real config.example.yaml (source of truth)', () => {
    const raw = parse(readFileSync(EXAMPLE_PATH, 'utf8'));
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it('validates a minimal config with only schemaVersion, filling defaults', () => {
    const result = ConfigSchema.safeParse({ schemaVersion: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.server.port).toBe(1780);
      expect(result.data.dedup.windowSeconds).toBe(60);
      expect(result.data.attentionManager.ttlBySeverity.high).toBe(120_000);
    }
  });

  it('fails with a message naming the path for an invalid duration', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      attentionManager: { ttlBySeverity: { high: 'not-a-duration' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.join('.').includes('attentionManager.ttlBySeverity.high'),
      );
      expect(issue).toBeDefined();
    }
  });

  it('rejects "infinite" in ttlBySeverity', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      attentionManager: { ttlBySeverity: { high: 'infinite' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts "infinite" in a ttlOverride, mapping to null', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      attentionManager: {
        ttlOverrides: [{ source: 'claude', category: 'permission', ttl: 'infinite' }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attentionManager.ttlOverrides[0]?.ttl).toBeNull();
    }
  });

  it('rejects a stateRules entry without any match keys', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      stateRules: [{ match: {}, state: { emotion: 'NEUTRAL' } }],
    });
    expect(result.success).toBe(false);
  });
});
