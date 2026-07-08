const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parses a human-readable duration string ('30s', '1.5m', 'infinite') into
 * milliseconds. 'infinite' maps to `null` (AM semantics: no time-based
 * expiration, SPEC §7). Anything else that doesn't match throws.
 */
export function parseDuration(input: string): number | null {
  if (input === 'infinite') {
    return null;
  }

  const match = DURATION_RE.exec(input);
  if (!match) {
    throw new Error(`Invalid duration: ${JSON.stringify(input)}`);
  }

  const amount = match[1] as string;
  const unit = match[2] as string;
  const ms = UNIT_MS[unit];
  if (ms === undefined) {
    throw new Error(`Invalid duration: ${JSON.stringify(input)}`);
  }
  return Number(amount) * ms;
}
