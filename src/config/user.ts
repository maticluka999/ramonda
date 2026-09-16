import { readFileSync } from 'node:fs';
import type { Config } from '../types.js';
import { asPositiveInteger } from '../utils/cli.js';
import { quoteAll } from '../utils/quote-all.js';
import { CREDENTIALS_PATH, SETTINGS_PATH } from './paths.js';
import { DEFAULT_PROFILE_MARKER, parseConfig, type ParsedConfig, type ProfileSection } from './profile-sections.js';

/** What `run` waits between task lookups where neither the flag nor the setting says. */
export const DEFAULT_POLL_PAUSE_SECONDS = 60;

const parsed = new Map<string, ParsedConfig>();

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * One file, parsed once per process.
 *
 * Memoised per path rather than as a pair, so asking for one never reads the
 * other. `withoutSecrets` wants the key names in `credentials` and runs inside
 * the Stop hook, where a `settings` file somebody has since broken is not this
 * process's business — parsing it there would refuse to run `verify` over a
 * fault that has nothing to do with the task.
 */
function parsedFile(path: string): ParsedConfig {
  let config = parsed.get(path);

  if (!config) {
    config = parseConfig(readIfPresent(path), path);
    parsed.set(path, config);
  }

  return config;
}

/**
 * What a run is called when it holds no profile from the file at all — see
 * `envProfile`. A name rather than a blank, because it is logged (`profile=…`)
 * and named in errors, and "where did these credentials come from?" is the one
 * question those lines exist to answer.
 */
const ENV_PROFILE = 'environment';

/**
 * The profile a run gets from the shell alone.
 *
 * Carries no values of its own: every key it could hold is already resolved
 * from `process.env` first, so an empty section is exactly the profile whose
 * every answer comes from the environment.
 */
function envProfile(): ProfileSection {
  return { name: ENV_PROFILE, isDefault: true, values: new Map(), headerLine: -1 };
}

/**
 * The credentials file is what decides which profiles exist: a profile with no
 * token cannot be used for anything, and every key in `settings` is optional.
 *
 * Unless the shell supplies the token itself. `GH_TOKEN` in the environment
 * outranks the file wherever both have one, and a file that names no profile is
 * the case where only the environment has anything to say — so a machine with
 * no `credentials` at all (a container, a CI job, a one-off `GH_TOKEN=… ramonda
 * run`) resolves rather than being told to run a command that needs a terminal
 * it does not have. A file that does name profiles is left to decide: an
 * exported token is an override there, not a reason to ignore what was written.
 */
function selectProfile(credentials: ParsedConfig, wanted: string | undefined): ProfileSection {
  const { sections } = credentials;
  const names = sections.map((section) => section.name);

  if (wanted !== undefined) {
    const found = sections.find((section) => section.name === wanted);

    if (found) {
      return found;
    }

    throw new Error(
      names.length === 0
        ? `no profile "${wanted}": ${CREDENTIALS_PATH} has no profile sections. Run "ramonda setup-profile --profile=${wanted}".`
        : `no profile "${wanted}" in ${CREDENTIALS_PATH}. It has: ${quoteAll(names)}.`
    );
  }

  const marked = sections.filter((section) => section.isDefault);

  if (marked.length > 1) {
    throw new Error(
      `${quoteAll(marked.map((section) => section.name))} are all marked [default] in ${CREDENTIALS_PATH}. ` +
        `Leave the default profile marker on exactly one of them, or pass --profile.`
    );
  }

  if (marked.length === 1) {
    return marked[0];
  }

  // A file holding nothing but comments parses clean and still names no profile.
  if (sections.length === 0) {
    if (process.env.GH_TOKEN) {
      return envProfile();
    }

    throw new Error(
      `${CREDENTIALS_PATH} has no profile sections. Run "ramonda setup-profile" to write one, ` +
        `or export GH_TOKEN to run without a profile.`
    );
  }

  // A lone profile is the answer to the question the marker would have settled,
  // so there is nothing for the marker to add: with one profile on the machine
  // there is no other set of credentials it could be confused for. Only a file
  // that holds a genuine choice has to have made it.
  if (sections.length === 1) {
    return sections[0];
  }

  throw new Error(
    `${CREDENTIALS_PATH} holds ${sections.length} profiles (${quoteAll(names)}) and none is marked [default]. ` +
      `Pass --profile=<name>, or mark one by making its header read "[${DEFAULT_PROFILE_MARKER} <name>]" ` +
      `(which is what "ramonda setup-profile" writes).`
  );
}

export function loadConfig(opts?: { profile?: string }): Config {
  const credentials = parsedFile(CREDENTIALS_PATH);
  const settings = parsedFile(SETTINGS_PATH);
  const profile = selectProfile(credentials, opts?.profile);
  const section = settings.sections.find((s) => s.name === profile.name);

  /**
   * The shell environment wins over both files, as it always has. Under it a key
   * resolves only from the file that owns it — secrets from `credentials`,
   * settings from `settings` — so the two halves stay the split `setup-profile`
   * writes them as. Within one file only the resolved profile's own section is read:
   * a key outside a section belongs to no profile, and there is no layer under
   * one for it to be.
   */
  const resolver =
    (sectionValues: Map<string, string> | undefined) =>
    (name: string): string | undefined =>
      name in process.env ? process.env[name] : sectionValues?.get(name);

  const secret = resolver(profile.values);
  const setting = resolver(section?.values);

  const ghToken = secret('GH_TOKEN');

  if (!ghToken) {
    throw new Error(
      `GH_TOKEN not set for profile "${profile.name}". Export it, run "ramonda setup-profile", ` +
        `or add it under the "[${profile.name}]" header in ${CREDENTIALS_PATH}.`
    );
  }

  return {
    profile: profile.name,
    ghToken,
    claudeBin: setting('CLAUDE_BIN') ?? 'claude',
    model: setting('DEFAULT_MODEL')?.trim() || undefined,
    pollPauseSeconds: pollPause(setting('DEFAULT_POLL_PAUSE'), 'DEFAULT_POLL_PAUSE' in process.env),
  };
}

/**
 * Held to the rule `--poll-pause` is held to, since the flag is what overrides
 * it: a value the flag would be refused for is named here rather than quietly
 * read as some other number of seconds.
 *
 * The fix names wherever the value actually came from. A key exported in the
 * shell wins over the file, so pointing at the file regardless would send
 * someone to edit a line that was never the one being read.
 */
function pollPause(raw: string | undefined, fromEnv: boolean): number {
  if (!raw?.trim()) {
    return DEFAULT_POLL_PAUSE_SECONDS;
  }

  const seconds = asPositiveInteger(raw);

  if (seconds === undefined) {
    const fix = fromEnv
      ? 'It is set in the environment — fix or unset it there.'
      : `Fix it in ${SETTINGS_PATH}, or run "ramonda setup-profile".`;

    throw new Error(`DEFAULT_POLL_PAUSE must be a positive integer (seconds), got "${raw}". ${fix}`);
  }

  return seconds;
}

/**
 * Every key the credentials file defines, in every profile — not just the active
 * one's. `withoutSecrets` runs where the profile is nobody's business (a spawned
 * session, a verify command), and deleting a variable that was never set costs
 * nothing.
 */
function credentialFileKeys(): string[] {
  const { sections } = parsedFile(CREDENTIALS_PATH);
  const keys = new Set<string>();

  for (const section of sections) {
    for (const key of section.values.keys()) {
      keys.add(key);
    }
  }

  return [...keys];
}

/**
 * A copy of `env` with ramonda's own credentials removed.
 *
 * Not aimed at a hostile brief — startup refuses a public repo and a public
 * project, so everyone who can word one is already trusted with the repository.
 * Aimed at the ordinary accident: a session running `bypassPermissions`, and
 * verify commands running repo code that session just wrote, either of which can
 * print an environment into a commit message, a PR body or a log while
 * debugging. A token pasted into a private repo's PR is still a leaked token.
 * Everything the credentials file defines is dropped alongside `GH_TOKEN`, since
 * that file holds only secrets.
 *
 * This is not a boundary: both run as the same uid and can read the credentials
 * file directly. It stops a mistake, not an intent. Real isolation needs a
 * sandbox or a repo-scoped token.
 */
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };

  for (const key of ['GH_TOKEN', ...credentialFileKeys()]) {
    delete scrubbed[key];
  }

  return scrubbed;
}
