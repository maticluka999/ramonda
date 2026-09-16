import { createPrompt, isEnterKey, makeTheme, useEffect, useKeypress, usePrefix, useState } from '@inquirer/core';
import { confirm, input, select, Separator } from '@inquirer/prompts';
import type { Command } from 'commander';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { CONFIG_DIR, CREDENTIALS_PATH, SETTINGS_PATH } from '../config/paths.js';
import {
  assertValidProfileName,
  formatHeader,
  parseConfig,
  upsertProfile,
  type ParsedConfig,
} from '../config/profile-sections.js';
import { DEFAULT_POLL_PAUSE_SECONDS } from '../config/user.js';
import { assertInteractive } from '../utils/assert-interactive.js';
import { asPositiveInteger } from '../utils/cli.js';
import { failure, nextStep, out, success } from '../utils/out.js';
import { quoteAll } from '../utils/quote-all.js';
import { Claude } from '../wrappers/claude.js';
import { Github, TOKEN_MINT_URL } from '../wrappers/github.js';

/** One `*` per character, the way a browser shows a password field. */
function maskSecret(value: string): string {
  return '*'.repeat(value.length);
}

/**
 * A password field that can open already filled in, which neither stock prompt
 * can do: `password` takes no starting value, and `input` prints its default in
 * the clear the moment the field is emptied. The mask is one character per
 * character, so readline's cursor lands where the edit actually happens.
 */
const secretInput = createPrompt<
  string,
  { message: string; prefill?: string; validate: (value: string) => true | string }
>((config, done) => {
  const theme = makeTheme();
  const [status, setStatus] = useState<'idle' | 'done'>('idle');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const prefix = usePrefix({ status, theme });

  useEffect((rl) => {
    if (config.prefill) {
      rl.write(config.prefill);
      setValue(config.prefill);
    }
  }, []);

  useKeypress((key, rl) => {
    if (status !== 'idle') {
      return;
    }

    if (!isEnterKey(key)) {
      setValue(rl.line);
      setError(undefined);

      return;
    }

    const verdict = config.validate(value);

    if (verdict === true) {
      setStatus('done');
      done(value);

      return;
    }

    // Enter has already emptied readline's line; put the answer back so it is
    // fixed rather than retyped.
    rl.write(value);
    setError(verdict);
  });

  const masked = maskSecret(value);
  const shown = status === 'done' ? theme.style.answer(masked) : masked;

  return [`${prefix} ${theme.style.message(config.message, status)} ${shown}`, error && theme.style.error(error)];
});

/**
 * Choices that are not values. Symbols rather than reserved strings, so no
 * answer a user could type — a profile named `new`, a model called `custom` —
 * can ever collide with one.
 */
const NEW_PROFILE = Symbol('new profile');
const LET_CLAUDE_CHOOSE = Symbol('let claude choose');
const TYPE_A_VALUE = Symbol('type a value');

export function addSetupProfileCommand(program: Command): void {
  program
    .command('setup-profile')
    .description('Interactively write a profile into ~/.config/ramonda/{credentials,settings}')
    .option('--profile <profile>', 'profile to write; omit to pick from the ones already there')
    .action(async (opts) => {
      await setupProfile({ profile: (opts.profile as string | undefined)?.trim() || undefined });
    });
}

const CREDENTIAL_KEYS = ['GH_TOKEN'] as const;

const SETTINGS_KEYS = ['CLAUDE_BIN', 'DEFAULT_MODEL', 'DEFAULT_POLL_PAUSE'] as const;

/** Narrows the answers to the keys one file owns, so neither file writes the other's. */
function pick(updates: Map<string, string | null>, keys: readonly string[]): Map<string, string | null> {
  return new Map(keys.map((key) => [key, updates.get(key) ?? null]));
}

function writeSummary(keys: readonly string[], updates: Map<string, string | null>): void {
  for (const key of keys) {
    const value = updates.get(key);

    if (value === null || value === undefined) {
      out(`    ${key} — not set (using default)`);
      continue;
    }

    out(`    ${key}=${key === 'GH_TOKEN' ? maskSecret(value) : value}`);
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw err;
  }
}

async function promptToken(prefill: string | undefined): Promise<string> {
  out(`Mint a classic token at ${TOKEN_MINT_URL}`);
  out(`  It needs the "repo" and "project" scopes — a fine-grained token cannot manage a project.`);

  // `validate` re-prompts in place, since a profile carrying no token cannot be
  // used for anything.
  const token = await secretInput({
    message: 'GH_TOKEN',
    prefill,
    validate: (value) => value.trim() !== '' || 'GH_TOKEN is required.',
  });

  return token.trim();
}

/**
 * Whether a token is worth writing, decided by Github rather than by its shape.
 *
 * The one answer with a real cost to getting wrong: `CLAUDE_BIN` announces
 * itself the moment it is wrong, while a bad token taken on trust would surface
 * two commands later as a GraphQL error about a project. So it is checked where
 * the fix is one prompt away.
 *
 * Only a token Github actually refused is turned down flat. The other two
 * failures are offered rather than enforced: a token of an unsupported kind is
 * a claim about what Github allows today, and an unreachable API is no evidence
 * about the token at all — neither is something to trap somebody in a prompt
 * over.
 */
async function tokenAccepted(token: string): Promise<boolean> {
  const probe = await new Github({ ghToken: token, probing: true }).probeToken();

  switch (probe.kind) {
    case 'ok':
      success(`token → @${probe.login} (scopes: ${probe.scopes.join(', ')})`);

      return true;

    case 'rejected':
      failure(probe.message);
      out(`  Paste another token, or Ctrl-C to abort.`);

      return false;

    case 'unsupported':
      failure(probe.message);

      return confirm({ message: 'Save it anyway?', default: false });

    case 'unknown':
      failure(`could not check this token with Github: ${probe.message}`);

      return confirm({ message: 'Save it anyway?', default: true });
  }
}

/**
 * An existing token opens the field already filled in, so Enter keeps it, and
 * is then checked like any other — a profile that worked last month may be
 * carrying one that has expired since, and this is the command that would
 * otherwise write it straight back unread. A token turned down is not offered
 * again: there is nothing in it worth editing.
 */
async function askToken(existing: string | undefined): Promise<string> {
  let prefill = existing;

  for (;;) {
    const candidate = await promptToken(prefill);

    if (await tokenAccepted(candidate)) {
      return candidate;
    }

    prefill = undefined;
  }
}

/**
 * The binary is reported alongside the value stored for it, since the next
 * question needs something to run even when the answer is recorded as no key.
 */
async function askClaudeBin(existing: string | undefined): Promise<{ claude: Claude; stored: string | null }> {
  const found = await Claude.onPath();
  // Only worth saying when there is no default to show — otherwise the default is
  // the answer to "where is it?".
  const hint = existing === undefined && found === undefined ? ' (not found on PATH)' : '';

  for (;;) {
    const answer = await input({ message: `Path to the claude binary${hint}`, default: existing ?? found?.bin });
    // Nothing found and nothing typed: probe the bare name so the failure below is
    // the real "not on PATH" message rather than silence.
    const bin = answer.trim() === '' ? 'claude' : answer.trim();
    const claude = new Claude(bin);

    try {
      const version = await claude.probeVersion();
      success(`${bin} → ${version}`);
    } catch (err) {
      // Nothing that fails the probe is worth saving — a binary that never
      // started and one that starts but misbehaves both leave `run` with nothing
      // to drive — so the question is simply asked again. That leaves `Ctrl-C`,
      // which writes no files, as the way out for a machine with no working
      // Claude Code.
      failure((err as Error).message);
      out(`  Enter a path to a working Claude Code binary, or Ctrl-C to abort.`);

      continue;
    }

    // A PATH lookup already lands here, so recording it would only pin an absolute
    // path that can move (a node version switch, a reinstall). Anything else is a
    // deliberate override worth keeping.
    return { claude, stored: bin === 'claude' || bin === found?.bin ? null : bin };
  }
}

/**
 * Anything `claude --model` takes, which is more than any list can hold: an
 * alias, or an ID this Claude Code no longer advertises. So the picker never
 * becomes the only way through — typing a value is always one of the choices.
 */
async function askModelFreeform(existing: string | undefined): Promise<string | null> {
  const model = await input({ message: 'Default model (blank = let claude choose)', default: existing });

  return model.trim() === '' ? null : model.trim();
}

/**
 * The full IDs come off the binary the previous question just resolved, so what
 * is offered is what this install actually accepts. A probe that fails only
 * costs the picker: `claude` is what rejects an unknown model, at session start
 * rather than here, so there is nothing for ramonda to refuse a setup over.
 */
async function askModel(claude: Claude, existing: string | undefined): Promise<string | null> {
  let models: string[] = [];

  try {
    const listed = await claude.listModels();
    models = listed.ids;

    // Said out loud rather than silently dropped: a list missing the one model
    // somebody came here to pick reads as this Claude Code not offering it.
    if (listed.unresolved.length > 0) {
      failure(`could not resolve model alias(es): ${quoteAll(listed.unresolved)}`);
    }

    if (models.length === 0) {
      failure(`${claude.bin} named no models this build could resolve`);
    }
  } catch (err) {
    failure(`could not list models: ${(err as Error).message}`);
  }

  if (models.length === 0) {
    return askModelFreeform(existing);
  }

  // What the profile already holds may be an alias, or an ID this version stopped
  // listing. It still belongs among the choices, or its own default is the one
  // answer the picker cannot give back.
  const listed = existing !== undefined && !models.includes(existing) ? [existing, ...models] : models;

  const picked = await select<string | typeof LET_CLAUDE_CHOOSE | typeof TYPE_A_VALUE>({
    message: 'Default model',
    default: existing ?? LET_CLAUDE_CHOOSE,
    choices: [
      ...listed.map((model) => ({ value: model })),
      new Separator(),
      { value: LET_CLAUDE_CHOOSE, name: 'Let claude choose (no DEFAULT_MODEL)' },
      { value: TYPE_A_VALUE, name: 'Type a value...' },
    ],
  });

  if (picked === LET_CLAUDE_CHOOSE) {
    return null;
  }

  if (picked === TYPE_A_VALUE) {
    return askModelFreeform(existing);
  }

  return picked;
}

/**
 * Held to the rule `--poll-pause` is held to, since that flag is what overrides
 * this key: an answer the flag would be refused for is refused here too, rather
 * than saved for `run` to choke on later. Blank removes the key, which is how a
 * profile goes back to the built-in wait.
 */
async function askPollPause(existing: string | undefined): Promise<string | null> {
  const answer = await input({
    message: `Idle seconds between task lookups (blank = ${DEFAULT_POLL_PAUSE_SECONDS})`,
    default: existing,
    validate: (value) =>
      value.trim() === '' ||
      asPositiveInteger(value) !== undefined ||
      'Enter a whole number of seconds above zero, or leave it blank.',
  });

  return answer.trim() === '' ? null : answer.trim();
}

/** Re-asks rather than aborting: a typo should cost the prompt, not the command. */
async function askProfileName(question: string, fallback?: string): Promise<string> {
  const answer = await input({
    message: question,
    default: fallback,
    validate: (value) => {
      try {
        assertValidProfileName(value.trim());

        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });

  return answer.trim();
}

/**
 * Which profile this run edits. A first-time install has nothing to choose
 * between, so it is asked for outright rather than picked from a list — hence
 * the undefined.
 */
async function chooseProfile(credentials: ParsedConfig, wanted: string | undefined): Promise<string | undefined> {
  if (wanted !== undefined) {
    return wanted;
  }

  if (credentials.sections.length === 0) {
    return undefined;
  }

  // Falls back to the first section when nothing carries the default profile
  // marker, so the question always opens on a real profile rather than on
  // "create a new one".
  const fallback = credentials.sections.find((s) => s.isDefault)?.name ?? credentials.sections[0].name;

  const chosen = await select<string | typeof NEW_PROFILE>({
    message: 'Profile to configure',
    default: fallback,
    choices: [
      ...credentials.sections.map((section) => ({
        value: section.name,
        name: section.isDefault ? `${section.name}  (default)` : section.name,
      })),
      new Separator(),
      { value: NEW_PROFILE, name: 'Create a new profile...' },
    ],
  });

  return chosen === NEW_PROFILE ? undefined : chosen;
}

/**
 * Defaults for the questions: what this profile already says, across both files.
 * The two never own the same key, so the merge is a join rather than a contest.
 * A profile being created for the first time has nothing to say and seeds none
 * of the answers.
 */
function existingValues(files: ParsedConfig[], profile: string | undefined): Map<string, string> {
  const merged = new Map<string, string>();

  for (const file of files) {
    const section = profile === undefined ? undefined : file.sections.find((s) => s.name === profile);

    for (const [key, value] of section?.values ?? []) {
      merged.set(key, value);
    }
  }

  return merged;
}

export async function setupProfile(opts: { profile?: string }): Promise<void> {
  assertInteractive('setup-profile');

  if (opts.profile !== undefined) {
    assertValidProfileName(opts.profile);
  }

  const credentialsRaw = await readIfPresent(CREDENTIALS_PATH);
  const settingsRaw = await readIfPresent(SETTINGS_PATH);
  // Both are parsed before the first question: a file ramonda cannot read is a
  // file it must not rewrite, and finding that out after the answers are given
  // would throw them away.
  const credentials = parseConfig(credentialsRaw ?? '', CREDENTIALS_PATH);
  const settings = parseConfig(settingsRaw ?? '', SETTINGS_PATH);

  out(`Writing ${CONFIG_DIR}/`);
  out(`  credentials  ${credentialsRaw === undefined ? '(new file)' : '(updating)'}`);
  out(`  settings     ${settingsRaw === undefined ? '(new file)' : '(updating)'}`);
  out('');

  const updates = new Map<string, string | null>();
  const chosen = await chooseProfile(credentials, opts.profile);
  // The name is a label for this set of credentials, not a claim about the
  // account — two profiles may hold two tokens for the same login, so there is
  // nothing to seed the answer with. Asked here rather than after the answers it
  // labels: which profile is being written settles before anything is written
  // for it.
  const profile = chosen ?? (await askProfileName('Profile name'));

  if (chosen !== undefined) {
    out(`Profile: ${chosen}`);
  }

  out('');

  const existing = existingValues([credentials, settings], chosen);
  updates.set('GH_TOKEN', await askToken(existing.get('GH_TOKEN')));
  out('');

  const { claude, stored } = await askClaudeBin(existing.get('CLAUDE_BIN'));
  updates.set('CLAUDE_BIN', stored);
  out('');

  updates.set('DEFAULT_MODEL', await askModel(claude, existing.get('DEFAULT_MODEL')));
  out('');

  updates.set('DEFAULT_POLL_PAUSE', await askPollPause(existing.get('DEFAULT_POLL_PAUSE')));

  const others = credentials.sections.filter((s) => s.name !== profile);
  const wasDefault = credentials.sections.find((s) => s.name === profile)?.isDefault ?? false;
  // The only profile on the machine gets the default profile marker unasked —
  // nothing else can claim it, and without it no command that omits --profile
  // resolves anything. A profile that is already the default stays it, which is
  // also nothing to ask.
  let isDefault = others.length === 0 || wasDefault;

  if (others.length > 0 && !wasDefault) {
    out('');
    isDefault = await confirm({
      message: `Make "${profile}" the default (used when --profile is omitted)?`,
      default: others.every((s) => !s.isDefault),
    });
  }

  out('');

  // Both files are rendered before either is written. `upsertProfile` refuses a
  // value it cannot store in a form that reads back intact, and a refusal raised
  // between the two writes would leave the profile half on disk — a token saved
  // into `credentials` under a `settings` section that never got its keys.
  const credentialsBody = upsertProfile(credentialsRaw ?? '', {
    profile,
    isDefault,
    updates: pick(updates, CREDENTIAL_KEYS),
  });
  const settingsBody = upsertProfile(settingsRaw ?? '', {
    profile,
    isDefault,
    updates: pick(updates, SETTINGS_KEYS),
  });

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // `mode` on the write as well as the chmod below: without it the file is
  // created at 0666 & ~umask — 0644 on a default setup — and spends the moment
  // between here and the chmod holding the token where anyone on the box can
  // read it.
  await writeFile(CREDENTIALS_PATH, credentialsBody, { mode: 0o600 });
  await writeFile(SETTINGS_PATH, settingsBody, { mode: 0o600 });
  // The modes above only apply where the write created the entry, so a directory
  // or file already on disk — made by hand, or by an editor — keeps whatever it
  // was made with until this.
  await chmod(CONFIG_DIR, 0o700);
  await chmod(CREDENTIALS_PATH, 0o600);
  await chmod(SETTINGS_PATH, 0o600);

  const header = formatHeader(profile, isDefault);
  success(`Saved ${CREDENTIALS_PATH} (mode 0600):`);
  out(`  ${header}`);
  writeSummary(CREDENTIAL_KEYS, updates);

  success(`Saved ${SETTINGS_PATH} (mode 0600):`);
  out(`  ${header}`);
  writeSummary(SETTINGS_KEYS, updates);

  nextStep({
    command: 'ramonda init',
    notes: ['Run it from inside the repository you want ramonda to work on.'],
  });
}
