import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { GITHUB_API_URL, GITHUB_HOST } from '../constants/github.js';
import type { CommitIdentity, WorkspaceInfo } from '../types.js';
import { quoteAll } from '../utils/quote-all.js';

/**
 * The entries `.gitignore` has to carry for a repo ramonda drives. Written into
 * the working tree by ramonda or by the session it launches, owned by neither
 * the project nor — in `settings.local.json`'s case — ramonda itself, and
 * tracked by none of them.
 *
 * `ramonda init` adds the missing ones; `ramonda run` refuses to start without
 * them, and refuses each task again against the worktree it actually gets. That
 * check is the whole of what keeps ramonda's own files out of a PR: `git add -A`
 * stages what git does not ignore, so what git ignores is what does not get
 * published.
 *
 * Nothing commits them — that is the operator's to do, along with the
 * `ramonda.json` beside it.
 */
export const GITIGNORE_ENTRIES = [
  '.claude/AGENT_TASK.md',
  '.claude/ramonda-task.json',
  // The lock and the tmp files of an in-flight atomic write, which would
  // otherwise be staged by `git add -A` like any other untracked file.
  '.claude/ramonda-task.json.*',
  '.claude/settings.local.json',
  '.worktrees/',
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);

    return true;
  } catch {
    return false;
  }
}

/**
 * The variable the push credential helper reads the PAT out of.
 *
 * Its own name rather than `GH_TOKEN`, so the one process that puts a token in
 * a child environment on purpose does not do it under the name every other part
 * of ramonda takes as a secret to be stripped.
 */
const PUSH_TOKEN_ENV = 'RAMONDA_PUSH_TOKEN';

/**
 * A `credential.helper` that answers a push with ramonda's own PAT.
 *
 * The token is read from the environment rather than written into the argv,
 * because argv is world-readable through `ps` for the life of the call. Git
 * appends the operation (`get`, `store`, `erase`) as `$1`, and only `get` has an
 * answer worth giving.
 */
const PUSH_CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${PUSH_TOKEN_ENV}"; }; f`;

/**
 * `env` with the commit identity added, for the Claude session.
 *
 * A headless session routinely commits its own work before it stops, and those
 * commits reach the PR alongside the one ramonda makes. Git reads these
 * four variables ahead of `user.name`/`user.email`, so passing them down is what
 * makes the whole commit list read as one author.
 *
 * Environment rather than `git config`: a linked worktree shares `.git/config`
 * with the base checkout, so writing the identity there would rewrite what the
 * operator's own commits in that clone are authored with, and the per-worktree
 * alternative needs `extensions.worktreeConfig` turned on for the whole
 * repository.
 */
export function withCommitIdentity(env: NodeJS.ProcessEnv, identity: CommitIdentity): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/** Every origin form git writes, each capturing the host then the owner/name. */
const ORIGIN_URL_PATTERNS = [
  /^git@([^:]+):([^/]+\/[^/]+?)(?:\.git)?$/,
  /^ssh:\/\/git@([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/,
  /^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/,
];

function parseOriginUrl(url: string): { host: string; nameWithOwner: string } {
  for (const pattern of ORIGIN_URL_PATTERNS) {
    const match = pattern.exec(url);

    if (match) {
      return { host: match[1], nameWithOwner: match[2] };
    }
  }

  throw new Error(`Could not parse origin URL: ${url}`);
}

/**
 * Checks the repo's origin points at the one host ramonda talks to. A free
 * function rather than a method: callers already hold the `WorkspaceInfo`, and
 * re-reading origin to answer would cost a second git call for nothing.
 */
export function assertGithubOrigin(workspace: WorkspaceInfo): void {
  if (workspace.host !== GITHUB_HOST) {
    throw new Error(
      `origin host "${workspace.host}" is not ${GITHUB_HOST}. ramonda works against ${GITHUB_API_URL} only.`
    );
  }
}

/**
 * Everything ramonda does with git, behind one class.
 *
 * An instance is bound to one working directory — the workspace checkout, or a
 * task worktree — so no call site repeats `cwd`, and the argv for any given git
 * command is written once. A run holds several instances at a time; they carry
 * no state beyond the directory, so constructing one is free.
 *
 * The lower half is plain git primitives. The upper half is the handful of
 * multi-step operations ramonda actually asks for — preparing a task worktree,
 * settling the gitignore entries, vetting the paths a worktree is seeded from —
 * which live here rather than in their own modules so that no other file has to
 * know how git is driven.
 */
export class Git {
  readonly #cwd: string;
  readonly #ghToken?: string;
  readonly #commitIdentity?: CommitIdentity;

  constructor(cwd: string, opts?: { ghToken?: string; commitIdentity?: CommitIdentity }) {
    this.#cwd = cwd;
    this.#ghToken = opts?.ghToken;
    this.#commitIdentity = opts?.commitIdentity;
  }

  /** Runs git, throwing on a non-zero exit. Returns trimmed stdout. */
  async #run(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await execa('git', args, { cwd: this.#cwd, env });

    return result.stdout.trim();
  }

  /**
   * Runs git and hands back the exit code instead of throwing — for the commands
   * whose failure *is* the answer (`check-ignore` on a tracked path, `rev-parse`
   * on a branch that does not exist yet).
   */
  async #tryRun(args: string[], env?: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string }> {
    const result = await execa('git', args, { cwd: this.#cwd, reject: false, env });

    // A process killed by a signal reports no exit code; treat that as failure
    // rather than letting `undefined` read as success.
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
  }

  /**
   * The `-c` overrides and environment that let a push authenticate as ramonda.
   *
   * Every push ramonda makes runs somewhere the ambient git credentials may not
   * reach — a task worktree cut minutes ago, on a machine whose shell git auth
   * belongs to whoever owns the clone rather than to the bot account. The PAT is
   * the credential the operator gave ramonda, so it is the one the push uses,
   * and it is what keeps the pushed branch attributable to the bot.
   *
   * The empty helper first is what resets the inherited chain, so a stale entry
   * in a keychain cannot answer ahead of the token this run was configured with.
   * Harmless on an SSH origin, which never consults a credential helper at all.
   */
  #pushAuth(): { args: string[]; env: NodeJS.ProcessEnv | undefined } {
    if (!this.#ghToken) {
      return { args: [], env: undefined };
    }

    return {
      args: ['-c', 'credential.helper=', '-c', `credential.helper=${PUSH_CREDENTIAL_HELPER}`],
      env: { [PUSH_TOKEN_ENV]: this.#ghToken },
    };
  }

  // ---- primitives ----------------------------------------------------------

  /**
   * Absolute path of the repository root `cwd` sits in.
   *
   * The first git call every command makes, and the one most likely to be made
   * somewhere it cannot work — so its two failures are answered in ramonda's own
   * words. Unhandled, both arrive as git's, and `Command failed with exit code
   * 128: git rev-parse --show-toplevel` names neither the problem nor the fix.
   */
  async repoRoot(): Promise<string> {
    try {
      return await this.#run(['rev-parse', '--show-toplevel']);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('git was not found on PATH. ramonda drives git directly, so it has to be installed.');
      }

      throw new Error(
        `${this.#cwd} is not a git repository (nor is any directory above it). ` +
          'Run ramonda from inside the repository you want it to work on.'
      );
    }
  }

  /**
   * The `origin` URL. A checkout with no `origin` is a real first-run state — a
   * `git init` that has not been given a remote yet — so it is named as that
   * rather than as git's own "No such remote".
   */
  async originUrl(): Promise<string> {
    try {
      return await this.#run(['remote', 'get-url', 'origin']);
    } catch {
      throw new Error(
        `${this.#cwd} has no "origin" remote. ramonda cuts every task worktree from origin/<baseBranch>, ` +
          'so the repository has to have one: `git remote add origin <url>`.'
      );
    }
  }

  async currentBranch(): Promise<string> {
    return this.#run(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  /** `git status --porcelain`, trimmed — empty string means a clean tree. */
  async status(): Promise<string> {
    return this.#run(['status', '--porcelain']);
  }

  async refExists(ref: string): Promise<boolean> {
    const result = await this.#tryRun(['rev-parse', '--verify', '--quiet', ref]);

    return result.exitCode === 0;
  }

  async localBranchExists(branch: string): Promise<boolean> {
    return this.refExists(`refs/heads/${branch}`);
  }

  /** How many commits HEAD is ahead of `baseRef`; 0 if the range cannot be resolved. */
  async commitsAhead(baseRef: string): Promise<number> {
    const result = await this.#tryRun(['rev-list', '--count', `${baseRef}..HEAD`]);

    if (result.exitCode !== 0) {
      return 0;
    }

    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  /** `<short-sha> <subject>` per commit HEAD holds over `baseRef`, newest first. */
  async commitsSince(baseRef: string): Promise<string[]> {
    const result = await this.#tryRun(['log', '--oneline', `${baseRef}..HEAD`]);

    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout.split('\n').filter((line) => line.trim() !== '');
  }

  async isIgnored(path: string): Promise<boolean> {
    const result = await this.#tryRun(['check-ignore', '-q', path]);

    return result.exitCode === 0;
  }

  /**
   * Updates the remote-tracking refs, and nothing else.
   *
   * This is the only git command ramonda runs against the shared base checkout,
   * and it is chosen for what it does not do: `fetch` touches neither the index
   * nor the working tree, so it takes no `index.lock` and cannot race a second
   * ramonda process — or the human whose checkout this is.
   */
  async fetchOrigin(): Promise<void> {
    await this.#run(['fetch', 'origin']);
  }

  async checkout(branch: string): Promise<void> {
    await this.#run(['checkout', branch]);
  }

  async addAll(): Promise<void> {
    await this.#run(['add', '-A']);
  }

  /**
   * Commits as the `GH_TOKEN` account rather than as whoever owns the clone.
   *
   * `-c` rather than the environment, because this runs in the loop process —
   * which never had `GIT_AUTHOR_*` set on it. Those go to the *session*, so the
   * commits a model makes itself match this one; here the flags are what carries
   * the identity at all. Setting `user.*` covers author and committer together.
   */
  async commit(message: string): Promise<void> {
    const identity = this.#commitIdentity;

    if (!identity) {
      throw new Error(`refusing to commit in ${this.#cwd}: this Git was built without a commit identity`);
    }

    await this.#run([
      '-c',
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
      'commit',
      '-m',
      message,
    ]);
  }

  /** Pushes to origin and sets the branch's upstream in the same call. */
  async pushToOrigin(branch: string): Promise<void> {
    const { args, env } = this.#pushAuth();
    await this.#run([...args, 'push', '-u', 'origin', branch], env);
  }

  // ---- ramonda operations --------------------------------------------------

  /**
   * Where this repository lives and which Github repo it points at. Resolves the
   * root itself, so it is safe on a Git bound to a subdirectory of the checkout.
   */
  async workspaceInfo(): Promise<WorkspaceInfo> {
    const workspacePath = await this.repoRoot();
    const { host, nameWithOwner } = parseOriginUrl(await new Git(workspacePath).originUrl());

    return { workspacePath, repoNameWithOwner: nameWithOwner, host };
  }

  /** Where the worktree for an issue lives, under this workspace. */
  worktreePathFor(opts: { issue: number; slug: string }): string {
    return join(this.#cwd, '.worktrees', `${opts.issue}-${opts.slug}`);
  }

  /**
   * Brings a worktree left behind by an earlier attempt back to a known state:
   * on its own branch, with nothing uncommitted.
   *
   * The discard is the point. A task that ended in a Cancel — three verify
   * failures, an empty diff, a stop signal — leaves the model's work sitting
   * uncommitted in the worktree, and nothing removes worktrees. So the next
   * attempt on that issue would open on a tree already carrying the failed
   * changes, and the `git add -A` that precedes a commit would take them into the new PR
   * alongside the real work. The branch itself is kept, since a second run on an
   * issue is how an open PR gets iterated on.
   *
   * `clean -fd` without `-x` leaves ignored files alone, so the task state, the brief
   * and the hook settings survive — and they are rewritten straight after anyway.
   */
  async #restoreWorktree(worktreePath: string, branch: string): Promise<{ discarded: string | null }> {
    const worktree = new Git(worktreePath);
    // A directory that is not the root of its own worktree resolves `--show-toplevel`
    // to the *workspace* — it sits inside it — so comparing the two is what tells a
    // real worktree from a leftover directory a `git worktree remove` never cleared.
    // Both sides go through realpath first: git reports the resolved path, and on
    // macOS a workspace under /tmp or /var reaches this as a symlink to /private.
    const toplevel = await worktree.#tryRun(['rev-parse', '--show-toplevel']);

    if (toplevel.exitCode !== 0 || (await realpath(toplevel.stdout.trim())) !== (await realpath(worktreePath))) {
      throw new Error(
        `${worktreePath} exists but is not a git worktree. Remove it (or run \`git worktree prune\`) ` +
          'and start the task again.'
      );
    }

    if ((await worktree.currentBranch()) !== branch) {
      await worktree.checkout(branch);
    }

    const dirty = await worktree.status();

    if (!dirty) {
      return { discarded: null };
    }

    await worktree.#run(['reset', '--hard', 'HEAD']);
    await worktree.#run(['clean', '-fd']);

    // Handed back rather than thrown away: this listing is the only record that
    // the previous attempt's work ever existed, and the caller logs it. The two
    // commands above have already taken it, so there is nothing left to ask git.
    return { discarded: dirty };
  }

  async prepTaskWorktree(opts: {
    worktreePath: string;
    branch: string;
    baseRef: string;
  }): Promise<{ reused: boolean; discarded: string | null }> {
    if (await pathExists(opts.worktreePath)) {
      const { discarded } = await this.#restoreWorktree(opts.worktreePath, opts.branch);

      return { reused: true, discarded };
    }

    // Past that branch the directory is known not to exist, so a registration git
    // still holds for it is one a hand-deleted worktree left behind — `rm -rf
    // .worktrees/` unregisters nothing. Without this, both `add`s below refuse
    // the path as "missing but already registered" and keep refusing it: every
    // later task on that issue is a failed pass, and three of them end the run,
    // with nothing in ramonda that ever clears it.
    //
    // Aimed at this one path rather than a repo-wide `git worktree prune`, which
    // would do the same job and then some: prune honours no expiry on a missing
    // directory, so it would unregister a sibling process's worktree the moment
    // that directory is briefly absent — and a shared clone is the case ramonda
    // is built for. `--force` is safe only because of the check above; it would
    // remove a live worktree just as readily. Best-effort: a path that was never
    // registered is the ordinary case, and it answers "is not a working tree".
    await this.#tryRun(['worktree', 'remove', '--force', opts.worktreePath]);

    if (await this.localBranchExists(opts.branch)) {
      await this.#run(['worktree', 'add', opts.worktreePath, opts.branch]);

      return { reused: false, discarded: null };
    }

    // `baseRef` is a remote-tracking ref, so nothing here reads or writes a local
    // branch. That is what keeps the shared base checkout out of a task's way:
    // no `checkout`, no `pull`, no index touched, and the human working in it
    // keeps whatever branch they were on.
    await this.#run(['worktree', 'add', '-b', opts.branch, opts.worktreePath, opts.baseRef]);

    return { reused: false, discarded: null };
  }

  /**
   * The ref a task's own commits are measured against.
   *
   * The remote-tracking ref is what the worktree was cut from (see
   * `prepTaskWorktree`), so it is the one that yields the session's commits and
   * nothing else. Falls back to the local branch, which is all that exists in
   * some test setups, and then to the name as given, so the caller always has
   * something to hand to git.
   */
  async resolveBaseRef(baseBranch: string): Promise<string> {
    for (const ref of [`origin/${baseBranch}`, baseBranch]) {
      if (await this.refExists(ref)) {
        return ref;
      }
    }

    return baseBranch;
  }

  /**
   * Which of `GITIGNORE_ENTRIES` this checkout does not already ignore.
   *
   * Asked of `check-ignore` rather than matched against the text of
   * `.gitignore`, so a repo that ignores `.claude/` wholesale — or carries the
   * entries in `info/exclude` — is read as covered rather than as missing four.
   *
   * Answers for whichever tree this `Git` is pointed at, which is the point:
   * asked of the base checkout it is a startup pre-flight, asked of a task
   * worktree it is the real thing.
   */
  async unignoredEntries(): Promise<string[]> {
    const missing: string[] = [];

    for (const entry of GITIGNORE_ENTRIES) {
      const ignored = await this.isIgnored(entry);

      if (!ignored) {
        missing.push(entry);
      }
    }

    return missing;
  }

  /**
   * Appends any of `GITIGNORE_ENTRIES` this repo does not ignore to
   * `.gitignore`, and returns the ones it added. `ramonda init` only.
   *
   * Writes the file and stops there — no `add`, no commit, no push. Ramonda
   * puts nothing on the operator's base branch: `.gitignore` is a config change
   * like the `ramonda.json` written beside it, and both are theirs to commit.
   * `run` refuses to start until they have.
   */
  async addMissingGitignoreEntries(): Promise<string[]> {
    const missing = await this.unignoredEntries();

    if (missing.length === 0) {
      return [];
    }

    const path = join(this.#cwd, '.gitignore');
    const existing = await readFile(path, 'utf8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }

      throw err;
    });

    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const addition =
      (needsLeadingNewline ? '\n' : '') +
      (existing.length > 0 ? '\n# ramonda\n' : '# ramonda\n') +
      missing.join('\n') +
      '\n';
    await writeFile(path, existing + addition, 'utf8');

    return missing;
  }

  /**
   * Startup pre-flight: refuses a repo whose checkout ignores none of
   * `GITIGNORE_ENTRIES`, so the overwhelmingly common misconfiguration — nobody
   * ever ran `ramonda init` — costs one message and no claimed issue.
   *
   * Deliberately not the authority. A task worktree is cut from
   * `origin/<baseBranch>`, so this working tree only stands in for it, and a
   * `.gitignore` committed but not pushed passes here and fails there. The
   * worktree check after `prepTaskWorktree` is the one that decides.
   */
  async assertGitignoreEntries(): Promise<void> {
    const missing = await this.unignoredEntries();

    if (missing.length === 0) {
      return;
    }

    throw new Error(
      `.gitignore at ${this.#cwd} does not ignore ${quoteAll(missing)}. ` +
        `Without ${missing.length === 1 ? 'that entry' : 'those entries'} every task would commit ramonda's own state files. ` +
        `Run "ramonda init" to add ${missing.length === 1 ? 'it' : 'them'}, then commit and push .gitignore.`
    );
  }

  /**
   * Startup pre-flight: refuses a `worktree.filesToCopy` naming a path this repo
   * does not ignore.
   *
   * Copying is only ever meant to carry across what git deliberately does not
   * track — a `.env` the tests read, a local cert. A path that is *not* ignored
   * is one of two mistakes, and both end the same way. A tracked path means
   * overwriting the checkout with whatever the operator has locally; an
   * untracked and unignored one means putting a file there that was never in the
   * repo. Either way `git add -A` stages it and the task's PR carries it, which
   * is the one thing this key must not be able to do by accident.
   *
   * Asked of the base checkout, which is both where the files are read from and
   * — via `origin/<baseBranch>` — what the worktree inherits its `.gitignore`
   * from.
   */
  async assertCopiedPathsIgnored(filesToCopy: string[]): Promise<void> {
    const unignored: string[] = [];

    for (const path of filesToCopy) {
      if (!(await this.isIgnored(path))) {
        unignored.push(path);
      }
    }

    if (unignored.length === 0) {
      return;
    }

    const one = unignored.length === 1;

    throw new Error(
      `"worktree.filesToCopy" lists ${quoteAll(unignored)}, but ${one ? 'it is' : 'they are'} not ignored ` +
        `in ${this.#cwd}. Only a gitignored path can be copied into a worktree — anything else is either ` +
        `tracked already, so copying it would overwrite the checkout, or untracked and unignored, so ` +
        `"git add -A" would commit it into the task's PR. Add ${one ? 'it' : 'them'} to .gitignore, or drop ` +
        `${one ? 'it' : 'them'} from "worktree.filesToCopy".`
    );
  }
}
