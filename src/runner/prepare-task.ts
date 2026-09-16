import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type winston from 'winston';
import { installWorktreeHooks } from '../hooks/install.js';
import { TERMINAL } from '../utils/logger.js';
import type { FoundTask, TaskState, WorktreeConfig } from '../types.js';
import { quoteAll } from '../utils/quote-all.js';
import { truncate } from '../utils/truncate.js';
import { Git } from '../wrappers/git.js';
import type { RunOpts } from './runner.js';
import { buildSessionId } from './session.js';
import { writeTaskState } from './task-state.js';
import { runCommands } from './verify.js';

/**
 * Thrown at a checkpoint between claiming a task and starting its session, so a
 * stop requested during pickup unwinds through the same release path an error
 * takes — rather than spawning a session whose result nobody is waiting for.
 */
export class PickupAborted extends Error {
  constructor() {
    super('pickup aborted before the session started');
  }
}

/**
 * Thrown for a failure that every later pass would hit identically, so the loop
 * exits on it rather than spending the no-PR budget rediscovering
 * the same broken setup three times over.
 */
export class SetupError extends Error {}

/** How much of a failed setup command's output reaches the log line. */
const MAX_SEED_OUTPUT_CHARS = 4096;

/**
 * How much of a discarded worktree's file list reaches the log line. A tree left
 * behind by a failed attempt can hold as many paths as the session touched, and
 * this line goes to the terminal as well as to both logs.
 */
const MAX_DISCARDED_LIST_CHARS = 4096;

/**
 * Makes a bare worktree into a tree the session and its `verify` can work in.
 *
 * `git worktree add` gives tracked files and nothing else: no `node_modules`, no
 * `.env`, no build output. A repo whose `verify` is `yarn test` would otherwise
 * fail every task on the first check with a command that cannot resolve — three
 * times, then a cancel, and the no-PR budget three tasks after that.
 *
 * Run on a reused worktree too. `prepTaskWorktree` cleans with `git clean -fd`
 * and no `-x`, so ignored files survive and there is usually nothing left to do
 * — but installs are idempotent, and re-running is what keeps the reused path
 * and the fresh one the same tree rather than two that differ by whatever the
 * last attempt happened to leave behind.
 *
 * Copies before it runs anything: an install script that reads `.env` needs it
 * to be there already.
 */
async function seedWorktree(args: {
  worktree: WorktreeConfig;
  workspacePath: string;
  worktreePath: string;
  taskLog: winston.Logger;
  mainLogger: winston.Logger;
  issue: number;
}): Promise<void> {
  const { worktree, workspacePath, worktreePath, taskLog, mainLogger, issue } = args;

  for (const relative of worktree.filesToCopy) {
    const from = join(workspacePath, relative);
    const to = join(worktreePath, relative);

    try {
      await mkdir(dirname(to), { recursive: true });
      // `recursive` so a directory works as well as a file. The symlink defaults
      // are both wanted as they are: a link is carried across as a link, so a
      // `.env` symlinked into a shared secrets store keeps pointing at it rather
      // than becoming a copy that goes stale, and a *relative* target is rewritten
      // absolute on the way — which it has to be, since the same relative path
      // resolved from `.worktrees/<branch>/` would point somewhere else entirely.
      await cp(from, to, { recursive: true });
      taskLog.info(`worktree seed: copied ${relative}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }

      // Warn rather than fail. These paths are untracked by definition, so
      // whether one exists is a property of the machine ramonda runs on, not of
      // the repo — and refusing here would mean nobody can run ramonda until
      // every listed path exists on every machine. The task may still fail at
      // verify, and this line is what explains why.
      taskLog.info(`worktree seed: warning: ${relative} not found at ${workspacePath} — skipped`);
      mainLogger.info(
        `warning: #${issue} worktree seed: ${relative} not found in the base checkout — skipped`,
        TERMINAL
      );
    }
  }

  if (worktree.prepare.length === 0) {
    return;
  }

  taskLog.info(`worktree seed: running ${worktree.prepare.length} setup command(s)`);
  const failure = await runCommands(worktreePath, worktree.prepare);

  if (!failure) {
    taskLog.info(`worktree seed: setup commands passed`);

    return;
  }

  const what =
    failure.timedOutAfter === undefined
      ? `exited ${failure.exitCode}`
      : `timed out after ${failure.timedOutAfter}ms and was killed`;
  const combined = truncate([failure.stdout, failure.stderr].filter(Boolean).join('\n'), MAX_SEED_OUTPUT_CHARS);
  taskLog.info(`worktree seed: \`${failure.command}\` ${what}\n${combined}`);

  // Thrown, not signalled: this runs ahead of the task state write, so the claim
  // guard's "no state on disk" path releases the claim and the pass is counted
  // like any other failure. A setup that is broken for good then ends the run
  // through the no-PR budget three tasks later, which is the right speed — a
  // registry that is down for a minute should not stop an overnight run.
  throw new Error(
    `worktree setup command \`${failure.command}\` ${what}. ` +
      `It is configured in "worktree.prepare" and has to pass before the session starts.`
  );
}

/** The prompt the session opens on, and the file `.claude/AGENT_TASK.md` holds. */
function renderTaskBrief(vars: {
  title: string;
  body: string;
  branch: string;
  number: number;
  repoNameWithOwner: string;
}): string {
  return `# Task: ${vars.title}

Issue: ${vars.repoNameWithOwner}#${vars.number}
Branch: \`${vars.branch}\`

## Description

${vars.body}

## Instructions

Implement the task described above in the current working directory. Stay on branch \`${vars.branch}\`.

When you believe the work is done, stop. A Stop hook will run the verify commands defined in \`ramonda.json\`; if they pass, ramonda commits the branch and opens a PR for it. If they fail, the failure output will be surfaced back to you and you can fix and stop again.

Closes #${vars.number}
`;
}

/**
 * Everything between a won claim and the first `claude` process: the worktree
 * the session works in, the brief it opens on, the hooks that report back, the
 * task state those hooks talk through, and the project move that says the item
 * is being worked.
 *
 * All of it is git and filesystem work with no child to signal, so a stop
 * arriving inside it has to be read rather than delivered — hence the two
 * checkpoints. Past the task state write the item carries project state that
 * only the Cancel path unwinds, so that is where reading a stop stops being
 * free and the session takes over.
 */
export async function prepareTask(args: {
  opts: RunOpts;
  task: FoundTask;
  /** Bound to the base checkout — the only tree ramonda runs `fetch` against. */
  git: Git;
  branch: string;
  worktreePath: string;
  taskLog: winston.Logger;
  /** Recorded in the task state, so the hooks log to the log the loop opened. */
  taskLogFile: string;
}): Promise<{ brief: string; taskState: TaskState }> {
  const { opts, task, git, branch, worktreePath, taskLog, taskLogFile } = args;
  const checkpoint = (): void => {
    if (opts.shutdownSignal.aborted) {
      throw new PickupAborted();
    }
  };

  // A fetch and nothing more. The base checkout is shared — with other ramonda
  // processes, and with whoever is using it — so the task is cut from the
  // remote-tracking ref rather than from a local branch ramonda would have to
  // check out and fast-forward first.
  await git.fetchOrigin();

  const prep = await git.prepTaskWorktree({
    worktreePath,
    branch,
    baseRef: `origin/${opts.repoConfig.baseBranch}`,
  });
  taskLog.info(`worktree prepared (reused=${prep.reused})`);

  // The authoritative gitignore check, as against startup's pre-flight: this is
  // the tree the session actually gets, and a `.gitignore` committed but never
  // pushed reaches no worktree. Nothing downstream re-screens what gets staged,
  // so this is the last chance to establish that `git add -A` in this tree
  // cannot pick up ramonda's own files — hence a `SetupError` rather than a
  // failed pass, since every later task would be cut from the same base.
  const unignored = await new Git(worktreePath).unignoredEntries();

  if (unignored.length > 0) {
    throw new SetupError(
      `worktree ${worktreePath} does not ignore ${quoteAll(unignored)}. ` +
        `It was cut from origin/${opts.repoConfig.baseBranch}, so .gitignore has to be committed and pushed there — ` +
        `run "ramonda init" if it is missing entries, then commit and push it.`
    );
  }

  // Worth the terminal: the discarded work is the previous attempt's, and this
  // line is the only record that it was ever there.
  if (prep.discarded) {
    const msg =
      `reused worktree for #${task.issue.number} still held uncommitted work from an earlier attempt — ` +
      `discarded so it cannot be committed into this task's PR:\n` +
      truncate(prep.discarded, MAX_DISCARDED_LIST_CHARS);
    taskLog.info(msg);
    opts.mainLogger.info(msg, TERMINAL);
  }

  // Before the brief, so a worktree the session cannot work in costs a setup
  // command rather than a whole session — and before the task state write, so a
  // failure here unwinds through the claim guard with no cancel to deliver.
  await seedWorktree({
    worktree: opts.repoConfig.worktree,
    workspacePath: opts.workspacePath,
    worktreePath,
    taskLog,
    mainLogger: opts.mainLogger,
    issue: task.issue.number,
  });

  const brief = renderTaskBrief({
    title: task.issue.title,
    body: task.issue.body || '(no description provided)',
    branch,
    number: task.issue.number,
    repoNameWithOwner: opts.repoNameWithOwner,
  });

  const briefPath = join(worktreePath, '.claude', 'AGENT_TASK.md');
  await mkdir(dirname(briefPath), { recursive: true });
  await writeFile(briefPath, brief, 'utf8');
  taskLog.info(`brief written: ${briefPath}`);

  await installWorktreeHooks({ worktreePath });
  taskLog.info(`hooks installed: ${worktreePath}/.claude/settings.local.json`);

  // The last point at which stopping is free. Past the task state write the item
  // carries project state — status on the in-progress value — that only the cancel path
  // unwinds, so a stop after this one goes through the session instead.
  checkpoint();

  const taskState: TaskState = {
    runId: opts.runId,
    // Minted before the state is written, so the session's identity is settled
    // ahead of the child and `--resume` always has a target.
    claudeSessionId: buildSessionId(),
    ghOwner: opts.ghOwner,
    ghProject: opts.ghProject,
    issue: task.issue.number,
    issueTitle: task.issue.title,
    branch,
    baseBranch: opts.repoConfig.baseBranch,
    repoNameWithOwner: opts.repoNameWithOwner,
    workspacePath: opts.workspacePath,
    worktreePath,
    projectItemId: task.itemId,
    projectId: opts.meta.projectId,
    botFieldId: opts.meta.botFieldId,
    statusFieldId: opts.meta.statusFieldId,
    statusOptionInReviewId: opts.meta.statusOptionInReviewId,
    statusOptionCancelledId: opts.meta.statusOptionCancelledId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    verifyFailures: 0,
    taskLogPath: taskLogFile,
  };
  await writeTaskState(worktreePath, taskState);

  return { brief, taskState };
}
