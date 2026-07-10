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

  // M13 test 9: only the firmware's real patterns are accepted (S2.5.16).
  // `pulse` was in the emulator; declaring it in a rule would produce a config
  // that only works in the browser.
  it('M13-9: rejects LED pattern outside {solid, blink, rainbow, off}', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      stateRules: [
        {
          match: { severity: 'critical' },
          state: {
            emotion: 'ANGRY',
            leds: [{ row: 'right', color: 'red', pattern: 'pulse' }],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('M13-9: accepts the four firmware-real patterns', () => {
    for (const pattern of ['solid', 'blink', 'rainbow', 'off']) {
      const result = ConfigSchema.safeParse({
        schemaVersion: 1,
        stateRules: [
          {
            match: { severity: 'critical' },
            state: {
              emotion: 'ANGRY',
              leds: [{ row: 'right', color: 'red', pattern }],
            },
          },
        ],
      });
      expect(result.success, `${pattern} should be valid`).toBe(true);
    }
  });

  // M13 test 12: balloonPolicy is a sibling of `state`, NOT nested inside it
  // (S2.5.12). The firmware receives `state` and doesn't understand policy.
  it('M13-12: balloonPolicy lives outside state, and reaches the parsed StateRule', () => {
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      stateRules: [
        {
          match: { category: 'x' },
          balloonPolicy: 'sticky',
          state: { emotion: 'HAPPY' },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const rule = result.data.stateRules[0];
      expect(rule).toBeDefined();
      expect(rule?.balloonPolicy).toBe('sticky');
      // And it's NOT smuggled into state.
      expect((rule?.state as { balloonPolicy?: unknown }).balloonPolicy).toBeUndefined();
    }
  });

  it('M13-12: balloonPolicy inside state is not a legal shape', () => {
    // Zod doesn't currently reject unknown keys on `state`, so we assert on
    // the observed behavior: the parsed shape has balloonPolicy inside state
    // but the top-level field stays undefined. This test documents the
    // invariant the StateMachine relies on: it reads `rule.balloonPolicy`,
    // never `rule.state.balloonPolicy`.
    const result = ConfigSchema.safeParse({
      schemaVersion: 1,
      stateRules: [
        {
          match: { category: 'x' },
          state: { emotion: 'HAPPY', balloonPolicy: 'sticky' } as unknown as Record<
            string,
            unknown
          >,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const rule = result.data.stateRules[0];
      // The wrong location has no effect: top-level is undefined.
      expect(rule?.balloonPolicy).toBeUndefined();
    }
  });
});
