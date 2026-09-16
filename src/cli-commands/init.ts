import type { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_REPO_CONFIG } from '../config/repo-defaults.js';
import { REPO_CONFIG_FILE } from '../config/repo.js';
import { nextStep, out, success, warning } from '../utils/out.js';
import { Git } from '../wrappers/git.js';

export function addInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      `Write a ${REPO_CONFIG_FILE} with default values, and add ramonda's entries to .gitignore, ` +
        `at the root of the repo you run it from`
    )
    .action(async () => {
      await init({ cwd: process.cwd() });
    });
}

export async function init(opts: { cwd: string }): Promise<void> {
  // The repo root, not the cwd. `run`, `setup-project` and the Stop hook all
  // read this file from the root, so one written into a subdirectory is one
  // nothing would ever find — and the failure would be "no ramonda.json",
  // reported from a command that just said it wrote one.
  const workspacePath = await new Git(opts.cwd).repoRoot();
  const path = join(workspacePath, REPO_CONFIG_FILE);
  const body = `${JSON.stringify(DEFAULT_REPO_CONFIG, null, 2)}\n`;

  // Before the config write below, not after it, so that `ramonda init` in a
  // repo that already has a ramonda.json still repairs a .gitignore missing an
  // entry a newer version added — even though the write then refuses. The append
  // is additive and idempotent, so a re-run that changes nothing costs nothing.
  const gitignorePath = join(workspacePath, '.gitignore');
  const addedToGitignore = await new Git(workspacePath).addMissingGitignoreEntries();

  // Said either way. "Nothing to add" and "added five entries" are the same
  // outcome — a checkout that ignores what ramonda needs ignored — and saying so
  // on the quiet one is what keeps a re-run from reading as a step that was
  // skipped.
  if (addedToGitignore.length > 0) {
    success(`Added to ${gitignorePath}:`);
    out('');

    for (const entry of addedToGitignore) {
      out(`  ${entry}`);
    }
  } else {
    success(`${gitignorePath} already ignores everything ramonda needs ignored`);
  }

  out('');

  // `wx` rather than a stat and then a write: the file is committed config
  // carrying the repo's own verify commands, and there is no window in which a
  // command that only writes defaults should overwrite them.
  try {
    await writeFile(path, body, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${REPO_CONFIG_FILE} already exists at ${path}. ` +
          `Edit it, or delete it first if you want to create a fresh one.`
      );
    }

    throw err;
  }

  success(`Wrote ${path}:`);
  out('');

  for (const line of body.trimEnd().split('\n')) {
    out(`  ${line}`);
  }

  out('');

  // Both defaults are guesses, and both are guesses that fail the whole task
  // when wrong — a setup command that does not resolve ends the pickup, and a
  // `verify` command that does not exist burns a session and three retries. So
  // the two lines below are not a formality: they are the only thing standing
  // between a repo on another package manager and three cancelled tasks.
  out(`Make sure to adjust "worktree" and "verify" per your project needs.`);
  out('');

  // The commit is named as the step *after* setup-project rather than as the
  // one after this command. setup-project writes the project it resolves back
  // into ramonda.json, so a repo that commits here commits a file that is about
  // to change again — and pushing is not a formality either: a task worktree is
  // cut from `origin/<baseBranch>`, so a .gitignore committed only locally
  // reaches no session, and ramonda refuses the first task rather than let it
  // stage ramonda's own state files into a PR.
  nextStep({
    command: 'ramonda setup-project',
    notes: ['Creates/updates new/existing Github project and records the project it resolves in ramonda.json.'],
  });
}
