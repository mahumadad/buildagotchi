/**
 * Template + truncation utilities shared by PersonalityManager and StateMachine.
 *
 * Extracted from personality.ts so the StateMachine can interpolate `stateRule`
 * balloon defaults (SPEC-FASE-2.5 S2.5.6) without importing the manager.
 */

/**
 * Replace `{key}` with `context[key]`. Missing keys are preserved literally
 * (`{key}`) so a bug in a template is visible in the balloon instead of
 * silently swallowed.
 */
export function interpolate(template: string, context: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => context[key] ?? `{${key}}`);
}

/**
 * Truncate to `max` characters. If clipped, replace the last char with '…' so
 * the total length still equals `max` — the caller's UI budget doesn't overflow.
 * Non-positive `max` short-circuits to `''` rather than throw.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
