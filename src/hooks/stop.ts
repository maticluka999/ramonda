import { readRepoConfig } from '../config/repo.js';
import { createFileLogger } from '../utils/logger.js';
import { readPendingTaskState, updateTaskState } from '../runner/task-state.js';
import { runCommands } from '../runner/verify.js';
import { truncate } from '../utils/truncate.js';
import { Git } from '../wrappers/git.js';

const MAX_VERIFY_FAILURES = 3;
/** Characters, not bytes — `truncate` counts them, and the task state holds JSON. */
const MAX_VERIFY_STDERR_CHARS = 4096;

/**
 * Records an unexpected failure as a signal the parent loop will act on.
 *
 * Anything this hook throws — a `ramonda.json` the session left unparseable, a
 * `verify` command that could not be spawned at all — would otherwise reach the
 * entry point as a bare throw, and a task state carrying no verdict at all reads
 * to the parent as an ordinary end of session. It would move on, leaving the
 * claim ref of a task nothing will ever finish — and every later run refused that
 * issue by a claim nobody holds. Non-fatal, because the next task is no more
 * likely to hit this than the last one was.
 */
async function recordHookFailure(worktreePath: string, err: Error): Promise<void> {
  try {
    await updateTaskState(worktreePath, {
      sessionError: {
        errorType: 'hook_failed',
        fatal: false,
        detectedAt: new Date().toISOString(),
        message: err.message,
      },
    });
  } catch {
    // Nothing left to try: the task state is how this hook talks to the parent at
    // all. The loop's own no-verdict path is what catches the task from here.
  }
}

export async function runStopHook(worktreePath: string): Promise<number> {
  try {
    return await stopHook(worktreePath);
  } catch (err) {
    await recordHookFailure(worktreePath, err as Error);

    throw err;
  }
}

/**
 * Everything a task needs the session to still be alive for, and nothing else.
 *
 * The hook exists for one thing the loop cannot do from outside: run `verify`
 * while the model is still there to be handed its output. A failure comes back
 * as a `block` decision, which is what re-prompts the session; a pass is
 * reported to the loop as `verifyPassedAt` and the loop takes it from there.
 *
 * So this runs no git command that writes, resolves no credentials and makes no
 * network call. It inherits the session's scrubbed environment, and now needs
 * nothing out of it.
 */
async function stopHook(worktreePath: string): Promise<number> {
  const taskState = await readPendingTaskState(worktreePath);

  if (!taskState) {
    return 0;
  }

  // A session that stops again after its work was already verified — nothing
  // re-runs verify on a branch the loop is about to publish.
  if (taskState.verifyPassedAt) {
    return 0;
  }

  // The task state carries the path of the log the loop opened for this task.
  // File-only: stdout is Claude Code's channel — see `createFileLogger`.
  const taskLog = createFileLogger(taskState.taskLogPath);
  // Config lives on the base checkout, not inside the worktree.
  const repoConfig = await readRepoConfig(taskState.workspacePath);

  taskLog.info(`stop-hook: running verify`);
  const failure = await runCommands(worktreePath, repoConfig.verify);

  if (failure) {
    const updated = await updateTaskState(worktreePath, {
      verifyFailures: taskState.verifyFailures + 1,
    });
    const failures = updated?.verifyFailures ?? taskState.verifyFailures + 1;
    const combined = [failure.stdout, failure.stderr].filter(Boolean).join('\n');

    taskLog.info(
      `stop-hook: verify ${failure.timedOutAfter === undefined ? 'failed' : 'timed out'} ` +
        `[${failures}/${MAX_VERIFY_FAILURES}] cmd=${failure.command} exit=${failure.exitCode}`
    );

    if (failures >= MAX_VERIFY_FAILURES) {
      taskLog.info(`stop-hook: max verify failures reached; giving up`);
      await updateTaskState(worktreePath, {
        verifyGaveUp: true,
        lastVerifyStderr: truncate(combined, MAX_VERIFY_STDERR_CHARS),
      });

      return 0;
    }

    // A timeout gets its own opening line. "exit 143" on its own reads as a
    // crash, and the fix for a command that never returns — drop the watch mode,
    // stop waiting on stdin — is not the fix for one that failed.
    const headline =
      failure.timedOutAfter === undefined
        ? `Verify command failed: \`${failure.command}\` (exit ${failure.exitCode})`
        : `Verify command timed out after ${failure.timedOutAfter}ms and was killed: \`${failure.command}\`\n\n` +
          `It never returned. Make sure it runs once and exits — no watch mode, no prompt waiting on input.`;
    const reason =
      `${headline}\n\n` + `${combined}\n\n` + `Failure ${failures} of ${MAX_VERIFY_FAILURES}. Fix and stop again.`;
    process.stderr.write(reason + '\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');

    return 2;
  }

  taskLog.info(`stop-hook: verify passed`);

  const git = new Git(worktreePath);
  const status = await git.status();
  const baseRef = await git.resolveBaseRef(taskState.baseBranch);
  const alreadyCommitted = await git.commitsAhead(baseRef);

  // A clean tree does not mean no work: sessions routinely commit before they
  // stop. Only a branch with neither uncommitted changes nor commits of its own
  // is genuinely empty. Checked here rather than by the loop, so `verifyPassedAt`
  // means "verified, and there is something to publish" with no second question
  // hanging off it.
  if (!status && alreadyCommitted === 0) {
    taskLog.info(`stop-hook: empty diff — signaling cancel`);
    await updateTaskState(worktreePath, { emptyDiff: true });

    return 0;
  }

  taskLog.info(`stop-hook: handing the branch to the loop to publish`);
  await updateTaskState(worktreePath, { verifyPassedAt: new Date().toISOString() });

  return 0;
}
