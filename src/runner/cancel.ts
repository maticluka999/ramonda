import type winston from 'winston';
import { STATUS_VALUES } from '../constants/github.js';
import type { TaskState } from '../types.js';
import { truncate } from '../utils/truncate.js';
import type { Github } from '../wrappers/github.js';
import { claimRefFor, releaseTask } from './claim.js';
import { updateTaskState } from './task-state.js';

export type CancelReason =
  | { kind: 'sessionError'; errorType: string; fatal: boolean; message?: string }
  | { kind: 'verifyGaveUp'; lastStderr: string }
  | { kind: 'emptyDiff' }
  /** Ctrl-C, or a supervisor stopping the service. */
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'noVerdict' }
  /**
   * Verify passed and ramonda declined to publish the branch anyway — an origin
   * the session repointed. Nothing failed; the work is refused.
   */
  | { kind: 'refused'; errorType: string; message: string }
  /** ramonda itself threw somewhere between claiming the task and finishing it. */
  | { kind: 'internalError'; message: string };

function describeCancelReason(reason: CancelReason): string {
  switch (reason.kind) {
    case 'sessionError':
      // Capped like the verify snippet: this ends up in an issue comment, and
      // an error message is as unbounded as the thing that raised it.
      return reason.message ? `${reason.errorType}: ${truncate(reason.message, 500)}` : reason.errorType;
    case 'verifyGaveUp': {
      const snippet = reason.lastStderr ? truncate(reason.lastStderr, 500) : '(no stderr captured)';

      return `3 verify failures — last stderr: ${snippet}`;
    }
    case 'emptyDiff':
      return 'model produced no diff';
    case 'signal':
      return reason.signal === 'SIGINT' ? 'SIGINT at terminal' : `stopped by ${reason.signal}`;
    case 'noVerdict':
      return 'session ended without a verdict — the Stop hook did not complete';
    // Capped like the rest: the message quotes a path or an origin the session
    // chose, so its length is the session's to decide.
    case 'refused':
      return `${reason.errorType}: ${truncate(reason.message, 500)}`;
    // Capped like the rest: this is whatever an unanticipated throw carried.
    case 'internalError':
      return `ramonda error: ${truncate(reason.message, 500)}`;
  }
}

/**
 * Every project write a cancel makes is best-effort. What must not be skipped is
 * the task state update at the end — a failed Github call that propagated would
 * leave the task reading as still running.
 */
async function attempt(logger: winston.Logger, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.info(`cancel: failed to ${what}: ${(err as Error).message}`);
  }
}

/**
 * Ends a task and hands back the reason it ended, in the words the issue comment
 * carries. The caller logs that on the main log — every cancel path reaches it
 * through here, so this is the one place the wording is decided, and the loop
 * cannot describe an outcome differently from the issue it just commented on.
 */
export async function cancelTask(opts: {
  github: Github;
  taskState: TaskState;
  worktreePath: string;
  reason: CancelReason;
  logger: winston.Logger;
}): Promise<string> {
  const reasonText = describeCancelReason(opts.reason);
  // Every project coordinate comes off the task state, which took them from
  // startup's own lookup when the task was picked up. One source, so a cancel
  // cannot name one item's field while clearing another's.
  const { projectId, projectItemId, statusFieldId, statusOptionCancelledId } = opts.taskState;

  opts.logger.info(`cancel: ${reasonText}`);

  if (statusFieldId && statusOptionCancelledId) {
    await attempt(opts.logger, `move status → ${STATUS_VALUES.cancelled}`, () =>
      opts.github.setProjectItemStatus({
        projectId,
        itemId: projectItemId,
        fieldId: statusFieldId,
        optionId: statusOptionCancelledId,
      })
    );
  }

  // The claim first: this is what another process is blocked on. The field after
  // it is only the board's label for who was working the item.
  await attempt(opts.logger, `delete ${claimRefFor(opts.taskState.branch)}`, () =>
    releaseTask({
      github: opts.github,
      repoNameWithOwner: opts.taskState.repoNameWithOwner,
      branch: opts.taskState.branch,
    })
  );

  await attempt(opts.logger, 'clear Bot field', () =>
    opts.github.clearBotField({
      projectId,
      itemId: projectItemId,
      fieldId: opts.taskState.botFieldId,
    })
  );

  await attempt(opts.logger, 'post comment', () =>
    opts.github.postIssueComment({
      repoNameWithOwner: opts.taskState.repoNameWithOwner,
      issueNumber: opts.taskState.issue,
      body: `Cancelled by ramonda (${new Date().toISOString()}): ${reasonText}`,
    })
  );

  await updateTaskState(opts.worktreePath, {
    cancelledAt: new Date().toISOString(),
    cancelReason: reasonText,
  });

  return reasonText;
}
