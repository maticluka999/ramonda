/**
 * The flag handling every command repeats.
 *
 * Commander hands options through as strings and enforces nothing beyond their
 * presence, so each command was parsing and refusing the same shapes in the same
 * words. Deliberately not `requiredOption`s: commander checks those during
 * parsing, which would put flag errors ahead of the env load that startup step 1
 * does first — so an unknown `--profile` stays reported as such.
 */

/** A string option, trimmed, with a blank answer read as "not given". */
export function trimmedFlag(value: unknown): string | undefined {
  return (value as string | undefined)?.trim() || undefined;
}

/**
 * The shape every count ramonda takes, wherever it was written down: digits end
 * to end and above zero, `undefined` for anything else.
 *
 * The digits have to be the whole value. `Number.parseInt` alone stops at the
 * first thing it cannot read, so `--gh-project=5abc` would poll project 5 and
 * `--poll-pause=1.9` would pause for 1 second — both of them a value that was
 * mistyped, silently answered with a number nobody asked for.
 *
 * Exported because a settings key can hold the same answer a flag does
 * (`DEFAULT_POLL_PAUSE` behind `--poll-pause`), and the two must be held to one
 * rule rather than to two spellings of it.
 */
export function asPositiveInteger(text: string): number | undefined {
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;

  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Every numeric flag ramonda takes is a count, so zero and below are refused with the rest. */
export function positiveInteger(raw: unknown, opts: { flag: string; usage: string; unit?: string }): number {
  const value = asPositiveInteger(String(raw));

  if (value !== undefined) {
    return value;
  }

  const unit = opts.unit ? ` (${opts.unit})` : '';

  throw new Error(`${opts.flag} must be a positive integer${unit}, got "${raw}"\n\n${opts.usage}`);
}
