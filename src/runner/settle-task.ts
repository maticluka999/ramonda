import type winston from 'winston';
import { STATUS_VALUES } from '../constants/github.js';
import { TERMINAL } from '../utils/logger.js';
import type { FoundTask, SessionResult, TaskState } from '../types.js';
import { cancelTask, type CancelReason } from './cancel.js';
import { finishTask } from './finish-task.js';
import type { RunOpts, TaskOutcome } from './runner.js';

/**
 * What the session left behind, turned into the task's outcome.
 *
 * A session ends in one of three states, and this is the one place that tells
 * them apart: a signal a hook wrote (which cancels), a branch the Stop hook
 * verified (which publishes), or neither — which cancels as a missing verdict,
 * unless the task is already cancelled or a stop is in flight, where the cancel
 * has been made already or the caller is about to make it. Either way the item
 * comes off the board and the claim is released: a task that reaches here and is
 * left holding one is invisible to every bot from then on.
 */
export async function settleTask(args: {
  opts: RunOpts;
  task: FoundTask;
  worktreePath: string;
  taskLog: winston.Logger;
  /** Re-read after the child exited: the hooks patch the file the loop wrote. */
  taskState: TaskState;
  /** What the session itself reported — the hooks' signals among it. */
  session: SessionResult;
}): Promise<TaskOutcome> {
  const { opts, task, worktreePath, taskLog, taskState, session } = args;
  const { github } = opts;
  const cancel = async (reason: CancelReason): Promise<string> =>
    cancelTask({ github, taskState, worktreePath, reason, logger: taskLog });

  const signalled = signalledCancel(session, taskState);

  if (signalled) {
    // The reason comes back from the cancel rather than being rebuilt here, so
    // the main log says what the issue comment says — the error type and its
    // detail, not just which kind of verdict it was.
    const reason = await cancel(signalled);
    const fatal = signalled.kind === 'sessionError' && signalled.fatal;
    opts.mainLogger.info(
      `task #${task.issue.number} cancelled — ${reason}` + (fatal ? ' (fatal, stopping)' : ''),
      TERMINAL
    );

    return fatal
      ? { kind: 'stop' }
      : { kind: 'ran', issueNumber: task.issue.number, worktreePath, verdict: { kind: 'none', reason } };
  }

  // The hook verified the branch and stopped there. Publishing it is the loop's,
  // because all of it wants the PAT — which the hook, running inside the
  // session's scrubbed environment, has no way to hold.
  //
  // Done even under a stop request, and before the caller gets to see one. It is
  // a commit, a push and one API call against work that has already passed
  // verify; abandoning it to a Ctrl-C that arrived in this gap would cancel a
  // task that had done everything asked of it.
  if (taskState.verifyPassedAt) {
    const finish = await finishTask({
      taskState,
      repoConfig: opts.repoConfig,
      github,
      ghToken: opts.ghToken,
      commitIdentity: opts.commitIdentity,
      worktreePath,
      taskLog,
    });

    if (finish.kind === 'refused') {
      // Fatal: the session repointed the checkout, and the next task would be
      // handed the same workspace. Stopping is the only thing that does not
      // repeat it.
      const reason = await cancel({ kind: 'refused', errorType: finish.errorType, message: finish.message });
      opts.mainLogger.info(`task #${task.issue.number} cancelled — ${reason} (fatal, stopping)`, TERMINAL);

      return { kind: 'stop' };
    }

    // The status move is best-effort, so claiming it unconditionally would hide
    // a failed project update behind a success line.
    opts.mainLogger.info(
      `task #${task.issue.number} complete — PR ${finish.reused ? 'updated' : 'opened'} ${finish.url} — project status ` +
        (finish.inReview
          ? `→ ${STATUS_VALUES.readyForReview}`
          : `unchanged (${STATUS_VALUES.readyForReview} move did not succeed)`),
      TERMINAL
    );

    return {
      kind: 'ran',
      issueNumber: task.issue.number,
      worktreePath,
      verdict: { kind: 'pr', url: finish.url },
    };
  }

  if (!taskState.cancelledAt && !opts.shutdownSignal.aborted) {
    // No completion, no cancel, and no signal to act on: the Stop hook never got
    // to write one — killed outright, or unable to reach the task state at all. The
    // claim is held by this run and nothing else on this path clears it, so a
    // silent `continue` would hide the issue from every bot for good. Cancel it
    // the way any other unfinished task is cancelled, and say so.
    //
    // Not under a stop request, though: a session the operator just Ctrl-C'd
    // reaches here in exactly this state, and the loop cancels it as the signal
    // stop it is — which is the true reason, and the one the issue comment
    // should carry.
    const reason = await cancel({ kind: 'noVerdict' });
    // `cancelled`, like every other terminal outcome: one anchored pattern on
    // this log is how a watcher — the e2e suite among them — tells a task that
    // landed from one that did not, and a verdict spelled any other way is a
    // task it sits out the whole timeout waiting for.
    opts.mainLogger.info(`task #${task.issue.number} cancelled — ${reason}`, TERMINAL);

    return { kind: 'ran', issueNumber: task.issue.number, worktreePath, verdict: { kind: 'none', reason } };
  }

  // Already cancelled, or a stop is in flight and the caller will deal with it.
  // Either way this task opened no PR.
  return {
    kind: 'ran',
    issueNumber: task.issue.number,
    worktreePath,
    verdict: { kind: 'none', reason: taskState.cancelReason ?? 'cancelled' },
  };
}

/**
 * The cancel a hook's signal asks for, or null where the session reported none.
 * Order is the order the session loop detected them in, so at most one is ever
 * set — this only turns it back into the reason the issue comment carries.
 */
function signalledCancel(session: SessionResult, taskState: TaskState): CancelReason | null {
  if (session.sessionError) {
    return {
      kind: 'sessionError',
      errorType: session.sessionError.errorType,
      fatal: session.sessionError.fatal,
      message: session.sessionError.message,
    };
  }

  if (session.verifyGaveUp) {
    return { kind: 'verifyGaveUp', lastStderr: taskState.lastVerifyStderr ?? '' };
  }

  if (session.emptyDiff) {
    return { kind: 'emptyDiff' };
  }

  return null;
}
