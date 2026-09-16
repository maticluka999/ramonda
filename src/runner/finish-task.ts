import type winston from 'winston';
import { STATUS_VALUES } from '../constants/github.js';
import { TERMINAL } from '../utils/logger.js';
import type { CommitIdentity, RepoConfig, TaskState } from '../types.js';
import { assertGithubOrigin, Git } from '../wrappers/git.js';
import type { Github } from '../wrappers/github.js';
import { claimRefFor, releaseTask } from './claim.js';
import { updateTaskState } from './task-state.js';

const MAX_COMMIT_SUBJECT_LEN = 72;

/**
 * What became of a branch the Stop hook verified.
 *
 * `refused` is not an error: nothing failed, ramonda declined to publish work it
 * will not stand behind. The caller cancels the task on it and stops the run —
 * the cause is the session having done something to the checkout, and the next
 * task would be handed the same one.
 */
export type FinishResult =
  | { kind: 'pr'; url: string; reused: boolean; inReview: boolean }
  | { kind: 'refused'; errorType: string; message: string };

/**
 * `subject` is capped for the commit's first line; `title` keeps the whole
 * thing, newlines flattened. Only git cares about 72 columns — a PR title has
 * no such limit and reads worse truncated.
 */
function sanitizeTitle(title: string): {
  title: string;
  subject: string;
  truncated: boolean;
} {
  const single = title.replace(/\s*\n+\s*/g, ' ').trim();
  const truncated = single.length > MAX_COMMIT_SUBJECT_LEN;

  return {
    title: single,
    subject: truncated ? single.slice(0, MAX_COMMIT_SUBJECT_LEN - 3).trimEnd() + '...' : single,
    truncated,
  };
}

/**
 * Why the repo's origin cannot be pushed to, or null when it checks out.
 *
 * Startup checked origin once, but a session runs with every tool call
 * auto-approved and can `git remote set-url` the checkout it works in. This is
 * where the push and the PR are about to go, so it is re-read here rather than
 * inherited from a check made before the session.
 *
 * Both halves of the origin are checked, not just the host. `github.com` alone
 * would wave through a `set-url` to any other repo on it — the push would carry
 * this task's branch, authenticated with ramonda's PAT, into a repo nobody asked
 * for, and the PR that follows would fail against the configured one with an
 * error about a missing branch rather than about the redirect that caused it.
 *
 * Fails closed: a git call that cannot name the origin at all leaves it unknown,
 * and unknown is not an origin to send a token to.
 */
async function originMismatch(workspacePath: string, expectedRepo: string): Promise<string | null> {
  try {
    const workspace = await new Git(workspacePath).workspaceInfo();
    assertGithubOrigin(workspace);

    if (workspace.repoNameWithOwner !== expectedRepo) {
      throw new Error(
        `origin points at ${workspace.repoNameWithOwner}, but this task was claimed for ${expectedRepo}. ` +
          `The session repointed the checkout it was working in.`
      );
    }

    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function buildPrBody(opts: { issueNumber: number; verifyCommands: string[] }): string {
  const verifyLine =
    opts.verifyCommands.length > 0 ? `verify: ${opts.verifyCommands.join(', ')} — passed` : 'verify: (none configured)';

  return `Closes #${opts.issueNumber}\n\n---\n${verifyLine}\n`;
}

/**
 * Something went wrong that the task carries on past. The terminal as well as
 * the log: these are all project writes, and an operator watching the board is
 * owed the reason an item did not move where the PR says it should have.
 */
function warn(taskLog: winston.Logger, message: string): void {
  taskLog.info(message, TERMINAL);
}

/**
 * Publishes a branch the Stop hook has already verified: commit, push, PR, and
 * the project writes that follow.
 *
 * Runs in the loop rather than in the hook, which is why the hook needs no
 * credentials at all. Everything here wants the PAT, and the hook is a
 * descendant of the session — it inherits an environment `withoutSecrets` has
 * stripped, so a token reaching ramonda through the shell alone was unreachable
 * from down there. The loop has held it since startup.
 *
 * Every project write past the PR is best-effort. The PR is the task's result;
 * a status that would not move is worth a warning, not throwing away a branch
 * that is already pushed and already open.
 */
export async function finishTask(opts: {
  taskState: TaskState;
  repoConfig: RepoConfig;
  github: Github;
  ghToken: string;
  commitIdentity: CommitIdentity;
  worktreePath: string;
  taskLog: winston.Logger;
}): Promise<FinishResult> {
  const { taskState, repoConfig, github, worktreePath, taskLog } = opts;
  const git = new Git(worktreePath, { ghToken: opts.ghToken, commitIdentity: opts.commitIdentity });

  // Before the index is touched and well before the token is put on the wire:
  // an origin the session repointed is not a thing to push a session's work to.
  const mismatch = await originMismatch(taskState.workspacePath, taskState.repoNameWithOwner);

  if (mismatch) {
    const message = `refusing to push — ${mismatch}`;
    taskLog.info(`finish: ${message}`);

    return { kind: 'refused', errorType: 'origin_mismatch', message };
  }

  const baseRef = await git.resolveBaseRef(taskState.baseBranch);
  const status = await git.status();
  // Everything the worktree holds that git does not ignore. What keeps ramonda's
  // own files and the repo's secrets out of this is `.gitignore` — asserted
  // against this very worktree before the session started, so by here it has
  // already been established that the tree cannot stage them.
  await git.addAll();

  const { title, subject, truncated } = sanitizeTitle(taskState.issueTitle);
  // `title`, not `taskState.issueTitle`: the untruncated form still has to be the
  // newline-flattened one, or a multi-line issue title reshapes the commit body.
  const body = truncated ? `${title}\n\nCloses #${taskState.issue}` : `Closes #${taskState.issue}`;

  if (status) {
    await git.commit(`${subject}\n\n${body}`);
    taskLog.info(`finish: commit created`);
  } else {
    // Named, not just counted: this is the one record of what the PR is built
    // from on the path where ramonda commits nothing of its own.
    const commits = await git.commitsSince(baseRef);
    taskLog.info(
      `finish: tree clean; using ${commits.length} commit(s) made by the session` +
        (commits.length > 0 ? `: ${commits.join('; ')}` : '')
    );
  }

  await git.pushToOrigin(taskState.branch);
  taskLog.info(`finish: pushed ${taskState.branch}`);

  const prBody = buildPrBody({
    issueNumber: taskState.issue,
    verifyCommands: repoConfig.verify.map((v) => v.command),
  });
  // `reused` is a second run on an issue whose PR is still open — the push above
  // has already updated it, so that PR is this task's result too.
  const { url, reused } = await github.createPullRequest({
    repoNameWithOwner: taskState.repoNameWithOwner,
    base: taskState.baseBranch,
    head: taskState.branch,
    title,
    body: prBody,
  });
  taskLog.info(`finish: PR ${reused ? 'updated (already open)' : 'opened'} ${url}`);

  let inReview = false;
  const readyForReview = STATUS_VALUES.readyForReview;

  if (taskState.statusFieldId && taskState.statusOptionInReviewId) {
    try {
      inReview = await github.setProjectItemStatusConfirmed({
        projectId: taskState.projectId,
        itemId: taskState.projectItemId,
        fieldId: taskState.statusFieldId,
        optionId: taskState.statusOptionInReviewId,
      });

      if (inReview) {
        taskLog.info(`finish: project status → ${readyForReview}`);
      } else {
        warn(taskLog, `warning: project status did not stay on "${readyForReview}" — a project workflow overwrote it`);
      }
    } catch (err) {
      warn(taskLog, `warning: failed to move project item to "${readyForReview}": ${(err as Error).message}`);
    }
  }

  // The claim first: it is what another process is blocked on, and the branch it
  // guards is already pushed and already open as a PR.
  try {
    await releaseTask({ github, repoNameWithOwner: taskState.repoNameWithOwner, branch: taskState.branch });
    taskLog.info(`finish: claim released`);
  } catch (err) {
    warn(
      taskLog,
      `warning: failed to release the claim: ${(err as Error).message} — ` +
        `delete it by hand with: git push origin --delete ${claimRefFor(taskState.branch)}`
    );
  }

  try {
    await github.clearBotField({
      projectId: taskState.projectId,
      itemId: taskState.projectItemId,
      fieldId: taskState.botFieldId,
    });
    taskLog.info(`finish: Bot field cleared`);
  } catch (err) {
    warn(taskLog, `warning: failed to clear Bot field: ${(err as Error).message}`);
  }

  // Last, and after the claim is released: this is what marks the task settled,
  // so the unwind paths above stop treating it as something to put back.
  await updateTaskState(worktreePath, { completedAt: new Date().toISOString() });

  return { kind: 'pr', url, reused, inReview };
}
