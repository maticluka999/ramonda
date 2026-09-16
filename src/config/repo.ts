import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig, RepoConfig, ShellCommand, WorktreeConfig } from '../types.js';

export const REPO_CONFIG_FILE = 'ramonda.json';

/**
 * What a `verify` or `worktree.prepare` entry gets when it names no `timeout` of
 * its own. Ten minutes: a hang detector rather than a performance budget, so it
 * sits above anything a real suite or install does and below forever.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Reads the repo's `ramonda.json`. Every key is required bar the `timeout` on a
 * command entry: the file is generated whole by `ramonda init` and committed
 * with the code, so a key that is absent is a key someone removed rather than
 * one they meant to leave to a default. Filling it in silently would mean a repo
 * whose config reads one way behaving another.
 *
 * The budget is the one exception, because it has a right answer for almost
 * every repo and no wrong-behaviour failure mode (see `parseTimeout`).
 */
export async function readRepoConfig(workspacePath: string): Promise<RepoConfig> {
  const path = join(workspacePath, REPO_CONFIG_FILE);
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${REPO_CONFIG_FILE} not found at ${path}. Run \`ramonda init\` in this repo to write one.`);
    }

    throw err;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Every other complaint in this file names the file and the key. A raw
    // SyntaxError names neither, and this one is read by the Stop hook too —
    // where "Unexpected token }" arrives with no hint of which file it came from.
    throw new Error(`${REPO_CONFIG_FILE} at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (!isObject(parsed)) {
    throw new Error(`${REPO_CONFIG_FILE} at ${path} must be a JSON object.`);
  }

  return {
    baseBranch: requireString(parsed.baseBranch, 'baseBranch', path),
    project: parseProject(parsed.project, path),
    worktree: parseWorktree(parsed.worktree, path),
    verify: parseCommands(parsed.verify, 'verify', path),
  };
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * The one shape every key complaint takes. A key that is simply absent gets the
 * extra sentence: the only optional key in the file defaults rather than
 * complaining, so anything reaching here absent has to be put back, and `init`
 * is the shortest way to see what it looked like.
 */
function invalid(key: string, must: string, opts: { path: string; raw: unknown }): Error {
  const hint =
    opts.raw === undefined ? ` This key is required — \`ramonda init\` writes a file carrying all of them.` : '';

  return new Error(`${REPO_CONFIG_FILE} at ${opts.path}: "${key}" ${must}.${hint}`);
}

function requireString(raw: unknown, key: string, path: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw invalid(key, 'must be a non-empty string', { path, raw });
  }

  return raw;
}

function requireObject(raw: unknown, key: string, path: string): Record<string, unknown> {
  if (!isObject(raw)) {
    throw invalid(key, 'must be an object', { path, raw });
  }

  return raw;
}

function requireStringArray(
  raw: unknown,
  key: string,
  opts: { path: string; must: string; allowEmpty?: boolean }
): string[] {
  const ok =
    Array.isArray(raw) &&
    (opts.allowEmpty === true || raw.length > 0) &&
    raw.every((v) => typeof v === 'string' && v.length > 0);

  if (!ok) {
    throw invalid(key, opts.must, { path: opts.path, raw });
  }

  return raw as string[];
}

/**
 * An ordered list of shell commands with their budgets — `verify` and
 * `worktree.prepare` both.
 *
 * Either may be empty: a repo with nothing to run says so. Required all the
 * same, so that is a choice on record rather than a key someone dropped.
 */
function parseCommands(raw: unknown, key: string, path: string): ShellCommand[] {
  if (!Array.isArray(raw)) {
    throw invalid(key, 'must be an array of { command, timeout? } objects (empty runs nothing)', { path, raw });
  }

  return raw.map((entry, i) => {
    const r = requireObject(entry, `${key}[${i}]`, path);

    return {
      command: requireString(r.command, `${key}[${i}].command`, path),
      timeout: parseTimeout(r.timeout, `${key}[${i}].timeout`, path),
    };
  });
}

/**
 * What turns a bare checkout into a tree the repo's own checks can run in.
 *
 * Both halves are required and both may be empty, on the same reasoning as
 * `verify`: a repo that genuinely needs no setup — no dependencies to install,
 * no untracked config — should have said so rather than left the keys out, since
 * the two states have very different failure modes and only one of them is
 * anybody's intent.
 */
function parseWorktree(raw: unknown, path: string): WorktreeConfig {
  const r = requireObject(raw, 'worktree', path);

  return {
    filesToCopy: requireStringArray(r.filesToCopy, 'worktree.filesToCopy', {
      path,
      allowEmpty: true,
      must:
        'must be an array of non-empty repo-root-relative paths, each of them gitignored ' + '(empty copies nothing)',
    }),
    prepare: parseCommands(r.prepare, 'worktree.prepare', path),
  };
}

/**
 * The one optional key in the file, and the only place a default is filled in
 * rather than refused.
 *
 * It earns the exception by being the key with a right answer for almost every
 * repo: a budget is there to catch a command that hangs, so most only need one
 * when their own suite is unusually slow or they want a tighter leash. Omitting
 * it never means "no limit" — an unbounded command is the failure this exists to
 * prevent, and it is the likelier failure for `worktree.prepare` than for
 * `verify`, since an install reaching a wedged registry hangs where a test suite
 * would at least fail. `init` writes the number explicitly, so a repo starting
 * from the defaults still has it on record rather than inheriting it invisibly.
 */
function parseTimeout(raw: unknown, key: string, path: string): number {
  if (raw === undefined) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw invalid(key, 'must be a positive integer number of milliseconds', { path, raw });
  }

  return raw;
}

function parseProject(raw: unknown, path: string): ProjectConfig {
  const r = requireObject(raw, 'project', path);

  return {
    owner: parseProjectOwner(r.owner, path),
    number: parseProjectNumber(r.number, path),
  };
}

/**
 * Which project this repo's tasks live on. Both are required keys with an
 * explicitly empty value — `""` and `0` — rather than keys `init` leaves out,
 * because the file is the record of how this repo is wired and "not set up yet"
 * is a state worth being able to see in it. `setup-project` fills them in.
 */
function parseProjectOwner(raw: unknown, path: string): string {
  if (typeof raw !== 'string') {
    throw invalid('project.owner', 'must be a string ("" until `ramonda setup-project` fills it in)', { path, raw });
  }

  return raw.trim();
}

function parseProjectNumber(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw invalid('project.number', 'must be a non-negative integer (0 until `ramonda setup-project` fills it in)', {
      path,
      raw,
    });
  }

  return raw;
}

/**
 * Records the project `setup-project` just resolved, so `ramonda run` needs no
 * flags. Reports whether it had to write.
 *
 * Edits the *raw* parsed JSON rather than re-serialising the config
 * `readRepoConfig` returns: that one carries defaults already filled in, and
 * writing it back would materialise every `verify[].timeout` the repo chose to
 * leave out. Keys ramonda does not know about survive for the same reason.
 */
export async function writeProjectIdentity(
  workspacePath: string,
  identity: { owner: string; number: number }
): Promise<boolean> {
  const path = join(workspacePath, REPO_CONFIG_FILE);
  const raw = JSON.parse(await readFile(path, 'utf8')) as { project?: Record<string, unknown> };

  if (!isObject(raw.project)) {
    throw new Error(`${REPO_CONFIG_FILE} at ${path}: "project" must be an object.`);
  }

  if (raw.project.owner === identity.owner && raw.project.number === identity.number) {
    return false;
  }

  raw.project.owner = identity.owner;
  raw.project.number = identity.number;
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  return true;
}
