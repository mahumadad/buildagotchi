import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { CLAUDE_CATEGORIES, CLAUDE_CRITICAL_CATEGORIES } from '../src/adapters/claude-adapter.js';
import { type AmConfig, AttentionManager } from '../src/core/attention.js';
import { newEvent } from '../src/core/events.js';
import { PersonalityManager, type PersonalityPreset } from '../src/personality/personality.js';

/**
 * The two tests that pay for themselves for the life of the project (S2.5.8):
 *   4. TTL guard — for every critical category the adapter can emit, the
 *      AttentionManager MUST compute a null deadline. Prevents the ghost-balloon
 *      bug the council reproduced 2026-07-09.
 *   5. Template contract — for every category × every preset, either a
 *      template exists or the category is in the preset's `silentCategories`.
 *      Prevents the vacuous `PersonalityManager.balloon()` that hid for two
 *      phases with 254 tests green.
 *
 * These tests fail loudly the day someone adds a new critical category or
 * renames a template. That's their whole job.
 */

// ── Test 4: TTL guard ──────────────────────────────────────────────────────

function makeAM(overrides: AmConfig['ttlOverrides']): AttentionManager {
  const cfg: AmConfig = {
    ttlBySeverity: {
      critical: 30_000,
      high: 120_000,
      medium: 300_000,
      low: 600_000,
      ambient: 30_000,
    },
    ttlOverrides: overrides,
    maxQueueSize: 20,
    replacementPolicy: 'higher_severity_interrupts',
    transitionToBackgroundMoodDelay: 2000,
    onModeChange: { toFOCUS: 'drop_below_high', toSLEEP: 'drop_below_critical' },
  };
  return new AttentionManager(cfg, {
    record: vi.fn(),
    metrics: { gauge: () => ({ set: vi.fn() }) },
    onActiveChange: vi.fn(),
  });
}

function loadCriticalOverridesFromConfig(): AmConfig['ttlOverrides'] {
  // Read the SAME config the bridge boots with. Testing against a fixture
  // wouldn't catch the bug — the bug is a mismatch between adapter and config.
  const configPath = join(__dirname, '..', '..', 'config.yaml');
  const raw = parse(readFileSync(configPath, 'utf-8')) as {
    attentionManager?: { ttlOverrides?: unknown[] };
  };
  const overrides = raw.attentionManager?.ttlOverrides ?? [];
  // Map `infinite` string → null the way parseDuration does at load time.
  return overrides.map((entry) => {
    const o = entry as { source?: string; category?: string; ttl: string };
    const result: { source?: string; category?: string; ttl: number | null } = { ttl: null };
    if (o.source !== undefined) result.source = o.source;
    if (o.category !== undefined) result.category = o.category;
    result.ttl = o.ttl === 'infinite' ? null : Number(o.ttl);
    return result;
  });
}

describe('M13 — TTL guard for critical categories (S2.5.8, test 4)', () => {
  const overrides = loadCriticalOverridesFromConfig();

  for (const category of CLAUDE_CRITICAL_CATEGORIES) {
    it(`config.yaml has an infinite ttlOverride for source=claude, category=${category}`, () => {
      // AttentionManager.#computeDeadline is private; we assert on the invariant
      // it depends on: an override must exist and its ttl must be null.
      const match = overrides.find((o) => o.source === 'claude' && o.category === category);
      expect(match).toBeDefined();
      expect(match?.ttl).toBeNull();
    });

    it(`AttentionManager gives a null deadline to a claude/${category} critical event`, () => {
      // End-to-end version: what actually happens at runtime.
      const am = makeAM(overrides);
      const seen: number | null | undefined = am['#computeDeadline' as never];
      // We can't reach the private method, so drive it through push() and
      // observe the deadline in the snapshot.
      const e = newEvent({
        source: 'claude',
        category,
        severity: 'critical',
        payload: {},
      });
      am.push(e);
      const snap = am.snapshot();
      expect(snap.active).not.toBeNull();
      expect(snap.active?.deadline).toBeNull();
      // Silence the unused-variable warning without changing behavior.
      void seen;
    });
  }
});

// ── Test 5: Template ↔ category contract ───────────────────────────────────

const PRESET_NAMES = ['companion', 'critic', 'mascot', 'supervisor'] as const;

function loadPreset(name: string): PersonalityPreset {
  const path = join(__dirname, '..', 'presets', 'personalities', `${name}.yaml`);
  return parse(readFileSync(path, 'utf-8')) as PersonalityPreset;
}

describe('M13 — Template ↔ category contract (S2.5.8, test 5)', () => {
  for (const presetName of PRESET_NAMES) {
    const preset = loadPreset(presetName);
    const manager = new PersonalityManager(preset);
    const silent = new Set(preset.silentCategories ?? []);

    for (const category of CLAUDE_CATEGORIES) {
      it(`${presetName} preset covers "${category}" (template or silent)`, () => {
        const balloon = manager.balloon(category, {});
        if (silent.has(category)) {
          // Deliberately silent: `balloon()` returning null is fine here.
          // The state machine will inherit the previous balloon (S2.5.2).
          expect(balloon).toBeNull();
        } else {
          // Not silent → there MUST be a template. `""` counts as a template
          // (means "clear"), so we assert against null, not falsy.
          expect(balloon).not.toBeNull();
        }
      });
    }
  }

  // Coverage sanity: every category is accounted for exactly once per preset.
  for (const presetName of PRESET_NAMES) {
    it(`${presetName} preset has no overlap between templates and silentCategories`, () => {
      const preset = loadPreset(presetName);
      const templated = new Set(Object.keys(preset.templates));
      for (const s of preset.silentCategories ?? []) {
        expect(templated.has(s)).toBe(false);
      }
    });
  }
});
