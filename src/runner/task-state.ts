import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LimitHit, TaskState } from '../types.js';

const RETRYABLE_TYPES = new Set(['rate_limit', 'overloaded', 'server_error']);
const FATAL_TYPES = new Set(['authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'model_not_found']);

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 50;

/**
 * Deliberately not `ramonda.json`, which is the repo's committed config. The two
 * hold opposite things — one hand-written and versioned, this one ephemeral and
 * gitignored — and the Stop hook reads both within a few lines of
 * each other. A shared basename made every grep, every `.gitignore` line and
 * every "ramonda.json is malformed" ambiguous about which file was meant.
 */
const TASK_STATE_FILE = 'ramonda-task.json';

function taskStatePath(worktreePath: string): string {
  return join(worktreePath, '.claude', TASK_STATE_FILE);
}

function taskStateLockPath(worktreePath: string): string {
  return taskStatePath(worktreePath) + '.lock';
}

async function withTaskStateLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
  const path = taskStateLockPath(worktreePath);
  await mkdir(dirname(path), { recursive: true });
  const start = Date.now();

  while (true) {
    try {
      const handle = await open(path, 'wx');
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      // A holder that crashed leaves its lockfile behind with nobody to remove it.
      try {
        const st = await stat(path);

        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await unlink(path).catch(() => {});
          continue;
        }
      } catch {
        // Lock file vanished between EEXIST and stat — retry immediately.
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`ramonda: could not acquire task state lock at ${path} after ${LOCK_TIMEOUT_MS}ms`);
      }

      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}

export async function writeTaskState(worktreePath: string, taskState: TaskState): Promise<void> {
  const path = taskStatePath(worktreePath);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(taskState, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

/**
 * The task state, or null when there is nothing usable to read.
 *
 * Unreadable counts as absent, malformed JSON included. The file lives inside a
 * worktree a `bypassPermissions` session has full run of, so a state file the
 * session truncated or overwrote is a thing that happens — and every caller
 * already treats a missing one as "no verdict", which ends the task through the
 * Cancel path. Throwing instead would escalate one lost task into a dead loop
 * and an item stranded mid-board, since nothing above the loop catches,
 * and the same corrupt file would also stop the Cancel from recording itself.
 */
export async function readTaskState(worktreePath: string): Promise<TaskState | null> {
  let raw: string;

  try {
    raw = await readFile(taskStatePath(worktreePath), 'utf8');
  } catch {
    return null;
  }

  try {
    return JSON.parse(raw) as TaskState;
  } catch {
    return null;
  }
}

/**
 * The state of a task still awaiting a verdict, or null when there is nothing
 * for a hook to act on — no state file at all, or one the loop has already
 * settled. Both hooks open on this check: a task that has completed or cancelled
 * must not be re-verified, re-pushed, or have a stale error written over its
 * outcome.
 */
export async function readPendingTaskState(worktreePath: string): Promise<TaskState | null> {
  const taskState = await readTaskState(worktreePath);

  if (!taskState || taskState.completedAt || taskState.cancelledAt) {
    return null;
  }

  return taskState;
}

/**
 * What an API error that ended a session records: a `limitHit` for the types
 * that waiting fixes, and a `sessionError` for the rest — fatal where no later
 * task would get any further.
 *
 * Written once for both places that see these errors. The StopFailure hook
 * reports them from inside the session, and the session loop reads them off the
 * session's own output, because Claude Code does not wait for that hook before
 * a `--print` session exits.
 */
export function apiErrorPatch(report: Omit<LimitHit, 'detectedAt'>): Pick<TaskState, 'limitHit' | 'sessionError'> {
  const detectedAt = new Date().toISOString();

  if (RETRYABLE_TYPES.has(report.errorType)) {
    return { limitHit: { ...report, detectedAt } };
  }

  return {
    sessionError: {
      errorType: report.errorType,
      fatal: FATAL_TYPES.has(report.errorType),
      transcriptPath: report.transcriptPath,
      detectedAt,
    },
  };
}

export async function updateTaskState(worktreePath: string, patch: Partial<TaskState>): Promise<TaskState | null> {
  return withTaskStateLock(worktreePath, async () => {
    const current = await readTaskState(worktreePath);

    if (!current) {
      return null;
    }

    const next = { ...current, ...patch };
    await writeTaskState(worktreePath, next);

    return next;
  });
}
