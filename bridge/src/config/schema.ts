import { z } from 'zod';
import { parseDuration } from '../core/duration.js';
import { EMOTIONS, type Emotion, SeveritySchema } from '../core/events.js';

/** Duration string ('30s', '2m', …) → ms. `infinite` is NOT legal here. */
const Duration = z.string().transform((val, ctx) => {
  let parsed: number | null;
  try {
    parsed = parseDuration(val);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
    return z.NEVER;
  }
  if (parsed === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `'infinite' is not a valid duration here: ${JSON.stringify(val)}`,
    });
    return z.NEVER;
  }
  return parsed;
});

/** Duration string, where `infinite` is legal and maps to `null` (SA5/ttlOverrides). */
const DurationOrInfinite = z.string().transform((val, ctx) => {
  try {
    return parseDuration(val);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
    return z.NEVER;
  }
});

const ModeSchema = z.enum(['NORMAL', 'FOCUS', 'SLEEP']);

/**
 * LED patterns supported by the `stack-chan` firmware
 * (firmware/stackchan/led/led.ts:60-140). `pulse` was in the emulator but not
 * in the firmware; declaring it as a rule would produce a config that only
 * works on the browser (S2.5.16). Restricting the enum makes typos fail loudly
 * at load time.
 */
const LedCommandSchema = z.object({
  row: z.enum(['left', 'right']),
  index: z.number().optional(),
  color: z.string(),
  pattern: z.enum(['solid', 'blink', 'rainbow', 'off']),
});

const ResolvedStatePartialSchema = z.object({
  // Cast to a literal tuple (not `[string, ...string[]]`, M4 SPEC GAP fix) so
  // the inferred type is `Emotion`, not a widened `string` — needed for this
  // to assign into `StateRule.state.emotion: Emotion` when index.ts wires
  // `config.stateRules` into the real StateMachine.
  emotion: z.enum(EMOTIONS as [Emotion, ...Emotion[]]),
  decorators: z.array(z.string()).default([]),
  gaze: z.enum(['left', 'right', 'center']).optional(),
  leds: z.array(LedCommandSchema).default([]),
  sound: z.string().optional(),
  servo: z.object({ yaw: z.number().optional(), pitch: z.number().optional() }).optional(),
  balloon: z.string().optional(),
});

const TtlOverrideSchema = z
  .object({
    source: z.string().optional(),
    category: z.string().optional(),
    ttl: DurationOrInfinite,
  })
  .refine((v) => v.source !== undefined || v.category !== undefined, {
    message: 'ttlOverrides entry must set at least one of source/category',
  });

const StateRuleSchema = z.object({
  match: z
    .object({
      source: z.string().optional(),
      category: z.string().optional(),
      severity: SeveritySchema.optional(),
    })
    .refine((v) => v.source !== undefined || v.category !== undefined || v.severity !== undefined, {
      message: 'stateRules entry match must set at least one of source/category/severity',
    }),
  /**
   * Lifespan of the balloon this rule produces. Sibling of `state`, NOT nested
   * inside it (S2.5.12): the firmware doesn't need to know about policy —
   * it only receives the resolved text. `undefined` maps to `transient` in the
   * StateMachine, which is what nine out of ten rules want.
   */
  balloonPolicy: z.enum(['sticky', 'transient']).optional(),
  state: ResolvedStatePartialSchema,
});

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  mode: ModeSchema.default('NORMAL'),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().default(1780),
    })
    .default({}),
  attentionManager: z
    .object({
      ttlBySeverity: z
        .object({
          critical: Duration.default('30s'),
          high: Duration.default('2m'),
          medium: Duration.default('5m'),
          low: Duration.default('10m'),
          ambient: Duration.default('30s'),
        })
        .default({}),
      ttlOverrides: z.array(TtlOverrideSchema).default([]),
      maxQueueSize: z.number().default(20),
      replacementPolicy: z
        .enum(['higher_severity_interrupts', 'always_enqueue'])
        .default('higher_severity_interrupts'),
      transitionToBackgroundMoodDelay: Duration.default('2s'),
      onModeChange: z
        .object({
          toFOCUS: z.literal('drop_below_high').default('drop_below_high'),
          toSLEEP: z.literal('drop_below_critical').default('drop_below_critical'),
        })
        .default({}),
    })
    .default({}),
  dedup: z
    .object({
      windowSeconds: z.number().default(60),
      autoMuteAfter: z.number().default(10),
    })
    .default({}),
  external: z
    .object({
      rateLimitPerMinute: z.number().default(60),
      requireToken: z.boolean().default(true),
    })
    .default({}),
  recorder: z
    .object({
      dir: z.string().default('~/.buildagotchi/events'),
      retentionDays: z.number().default(30),
    })
    .default({}),
  ble: z
    .object({
      heartbeatSeconds: z.number().default(5),
      missesBeforeDead: z.number().default(3),
      reconnectBackoff: z
        .object({
          initial: Duration.default('1s'),
          max: Duration.default('10s'),
        })
        .default({}),
    })
    .default({}),
  stateRules: z.array(StateRuleSchema).default([]),
  criticalCommands: z
    .array(z.string())
    .default(['rm', 'sudo', 'drop', 'force push', 'git reset --hard', 'delete']),
  personality: z
    .object({
      preset: z
        .enum(['companion', 'supervisor', 'critic', 'mascot', 'custom'])
        .default('companion'),
      ttsEnabled: z.boolean().default(false),
      templates: z.record(z.string()).optional(),
      /**
       * Max characters of the resolved balloon text (S2.5.4). Firmware wraps at
       * ~60 on the 320×240 LCD; the emulator can afford more. Applied to the
       * final interpolated string, so a huge `{text}` never eats the `[proj]`
       * prefix (S2.5.13).
       */
      balloonMaxChars: z.number().int().positive().default(240),
    })
    .default({}),
  claude: z
    .object({
      staleSessionTimeout: Duration.default('30m'),
      transcriptReadEnabled: z.boolean().default(true),
      unknownLineThreshold: z.number().default(5),
      unknownLineBrokenThreshold: z.number().default(20),
      // Declared, not inferred: no transcript field reports the model's window,
      // and a percentage against a guessed limit would be an invented number.
      contextWindowTokens: z.number().default(200_000),
      contextWarnAt: z.number().min(0).max(1).default(0.7),
      contextHighAt: z.number().min(0).max(1).default(0.9),
      milestoneStreakDays: z.number().int().min(1).default(5),
    })
    .default({}),
  mcp: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      /** M15: how many past balloons to keep for `GET /balloons` + the
       *  Screen history panel. 10 is enough for a couple of minutes of chat. */
      balloonHistorySize: z.number().int().nonnegative().default(10),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
