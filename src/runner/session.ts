import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { withoutSecrets } from '../config/user.js';
import type { LimitHit, SessionError, SessionResult, StartSessionOpts, TaskState } from '../types.js';
import { withoutInspector } from '../wrappers/claude.js';
import { withCommitIdentity } from '../wrappers/git.js';
import { computeWaitMs, type RateLimitWait } from './rate-limit.js';
import { apiErrorPatch, readTaskState, updateTaskState } from './task-state.js';

const TASK_STATE_POLL_MS = 2000;
const CHILD_EXIT_GRACE_MS = 5000;

const RESUME_PROMPT = 'Rate limit / backend error cleared. Continue where you left off on this task.';

const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000, 900_000];

function nthBackoff(consecutive: number): number {
  const idx = Math.min(consecutive, BACKOFF_SCHEDULE_MS.length - 1);

  return BACKOFF_SCHEDULE_MS[idx];
}

/**
 * Minted by ramonda rather than scraped from child output, so the session's
 * identity is known before the child starts and `--resume` always has a target.
 */
export function buildSessionId(): string {
  return randomUUID();
}

/**
 * SIGTERM, then SIGKILL once the grace period is up. Without the escalation a
 * child that ignores SIGTERM would hold the loop open indefinitely, and with no
 * terminal attached there is nobody to notice.
 */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  const escalate = setTimeout(() => {
    child.kill('SIGKILL');
  }, CHILD_EXIT_GRACE_MS);
  escalate.unref();
  child.once('exit', () => {
    clearTimeout(escalate);
  });
}

type LimitHandlers = {
  onLimitHit?: (info: {
    hit: LimitHit;
    waitMs: number;
    reason: RateLimitWait['source'] | 'backoff';
  }) => void | Promise<void>;
  onResume?: (info: { hit: LimitHit }) => void | Promise<void>;
};

/**
 * The one thing the hooks write into the task state that this loop has to act on, or
 * null while the session is running normally. Only the first is reported: they
 * are all terminal for the current child, and which one arrived first is what
 * decides whether the loop respawns or hands the result back.
 */
type TaskStateSignal =
  | { kind: 'limit'; hit: LimitHit }
  | { kind: 'error'; error: SessionError }
  | { kind: 'verifyGaveUp' }
  | { kind: 'emptyDiff' };

function signalOf(
  taskState: Pick<TaskState, 'limitHit' | 'sessionError' | 'verifyGaveUp' | 'emptyDiff'>
): TaskStateSignal | null {
  if (taskState.limitHit) {
    return { kind: 'limit', hit: taskState.limitHit };
  }

  if (taskState.sessionError) {
    return { kind: 'error', error: taskState.sessionError };
  }

  if (taskState.verifyGaveUp) {
    return { kind: 'verifyGaveUp' };
  }

  if (taskState.emptyDiff) {
    return { kind: 'emptyDiff' };
  }

  return null;
}

/** An unreadable task state is not a signal (see `readTaskState`), and the caller keeps polling. */
async function readTaskStateSignal(worktreePath: string): Promise<TaskStateSignal | null> {
  const taskState = await readTaskState(worktreePath);

  return taskState ? signalOf(taskState) : null;
}

export async function startSessionWithRateLimitLoop(
  opts: StartSessionOpts & { shutdownSignal?: AbortSignal } & LimitHandlers
): Promise<SessionResult> {
  let prompt = opts.initialPrompt;
  let resuming = false;
  let consecutiveBackendFailures = 0;

  while (true) {
    await updateTaskState(opts.cwd, {
      limitHit: null,
      sessionError: null,
      verifyGaveUp: false,
      emptyDiff: false,
    });

    const { child, exit, sawModelResponse, endedOnApiError } = spawnClaude(
      {
        claudeBin: opts.claudeBin,
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        initialPrompt: prompt,
        model: opts.model,
        commitIdentity: opts.commitIdentity,
        onSessionOutput: opts.onSessionOutput,
      },
      resuming
    );

    // Ctrl-C ends the session the same way every other stop path does, so the
    // child never sees a signal the rest of the shutdown flow isn't written for.
    const onStop = (): void => {
      terminate(child);
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    opts.shutdownSignal?.addEventListener('abort', onStop);

    // A stop requested before this child existed has no signal left to deliver
    // — the SIGINT that carried it arrived while there was nothing to kill.
    // Reading it here is what keeps a Ctrl-C during pickup from being answered
    // with a fresh session.
    if (opts.shutdownSignal?.aborted) {
      terminate(child);
    }

    let detected: TaskStateSignal | null = null;

    const poller = setInterval(() => {
      void (async () => {
        if (detected) {
          return;
        }

        detected = await readTaskStateSignal(opts.cwd);

        if (detected) {
          terminate(child);
        }
      })();
    }, TASK_STATE_POLL_MS);

    let result: SessionResult;

    try {
      result = await exit;
    } finally {
      clearInterval(poller);
      process.off('SIGINT', onStop);
      process.off('SIGTERM', onStop);
      opts.shutdownSignal?.removeEventListener('abort', onStop);
    }

    // Final read: a hook may have written its signal between the last poll and
    // the child's exit.
    //
    // The session's own output is read last, and is what an API error is usually
    // found in. The error ends the turn before any Stop hook runs, and Claude Code
    // starts the StopFailure hook without waiting on it — so a `--print` session
    // exits while that hook is still starting, and the task state says nothing at
    // all. Read as no verdict, a limit hit would cancel the task and hand the
    // loop the next one, straight into the same limit.
    const apiError = endedOnApiError();
    const signal: TaskStateSignal | null =
      detected ?? (await readTaskStateSignal(opts.cwd)) ?? (apiError ? signalOf(apiErrorPatch(apiError)) : null);

    if (signal?.kind === 'error') {
      return { ...result, sessionError: signal.error };
    }

    if (signal?.kind === 'verifyGaveUp') {
      return { ...result, verifyGaveUp: true };
    }

    if (signal?.kind === 'emptyDiff') {
      return { ...result, emptyDiff: true };
    }

    if (signal?.kind !== 'limit') {
      return result;
    }

    const { hit } = signal;
    const isBackend = hit.errorType === 'overloaded' || hit.errorType === 'server_error';

    let waitMs: number;
    let reason: RateLimitWait['source'] | 'backoff';

    if (isBackend) {
      // "Consecutive" means back-to-back failures with no working session in
      // between. A respawn that got the model talking again did its job, so the
      // escalation starts over rather than climbing for the life of the task.
      if (sawModelResponse()) {
        consecutiveBackendFailures = 0;
      }

      waitMs = nthBackoff(consecutiveBackendFailures);
      reason = 'backoff';
      consecutiveBackendFailures += 1;
    } else {
      const wait = await computeWaitMs(hit);
      waitMs = wait.waitMs;
      reason = wait.source;
      consecutiveBackendFailures = 0;
    }

    await opts.onLimitHit?.({ hit, waitMs, reason });

    const interrupted = await sleepInterruptible(waitMs, opts.shutdownSignal);

    if (interrupted) {
      return { exitCode: null, signal: 'SIGINT' };
    }

    await opts.onResume?.({ hit });
    prompt = RESUME_PROMPT;
    resuming = true;
  }
}

const MAX_SUMMARY_LEN = 200;

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One log line, flattened and bounded.
 *
 * The cap is on the finished line rather than on each piece that went into it:
 * an assistant event carries as many content blocks as the model felt like
 * emitting, so capping per block bounds nothing — three 200-char blocks are a
 * 600-char line. A task log is a live view of a session, not a transcript of it.
 */
function oneLine(text: string): string {
  const flat = flatten(text);

  return flat.length > MAX_SUMMARY_LEN ? flat.slice(0, MAX_SUMMARY_LEN - 3) + '...' : flat;
}

/** One stream-json event, reduced to what ramonda does with it. */
type EventSummary = {
  /** Line to append to the task log, or null for an event not worth one. */
  line: string | null;
  /**
   * Whether the model itself produced output. `system init` is emitted locally
   * before the first API call, a `result` closes the turn however it ended, and
   * an API error arrives dressed as an assistant message — so only an assistant
   * message that is not one proves a (re)spawn actually got through to the
   * backend.
   */
  modelResponded: boolean;
  /** The type of the API error an assistant message wraps — `rate_limit`, `overloaded`, … */
  apiError?: string;
  /**
   * What a `rate_limit_event` said: when a rejected limit resets, in epoch
   * seconds, or null once the limit is not rejecting. Undefined for any other event.
   */
  rejectedUntil?: number | null;
};

const NOTHING: EventSummary = { line: null, modelResponded: false };

/**
 * Collapses one stream-json event into a log line. Deliberately tolerant: an
 * unparseable or unfamiliar event must never take down the session.
 */
function summarizeEvent(raw: string): EventSummary {
  if (!raw.trim()) {
    return NOTHING;
  }

  let evt: Record<string, unknown>;

  try {
    evt = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { line: oneLine(raw) || null, modelResponded: false };
  }

  if (evt.type === 'system' && evt.subtype === 'init') {
    return {
      line: `session init: model=${String(evt.model ?? '?')}`,
      modelResponded: false,
    };
  }

  if (evt.type === 'assistant') {
    // "You've hit your session limit" is Claude Code's text, not the model's.
    const apiError = typeof evt.error === 'string' ? evt.error : undefined;
    const modelResponded = apiError === undefined;
    const content = (evt.message as { content?: unknown[] } | undefined)?.content;

    if (!Array.isArray(content)) {
      return { line: null, modelResponded, apiError };
    }

    const parts: string[] = [];

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = flatten(block.text);

        if (text) {
          parts.push(text);
        }
      } else if (block.type === 'tool_use') {
        parts.push(`tool: ${String(block.name ?? '?')}`);
      }
    }

    // Capped once, on the join: the blocks are the parts of a single line, so
    // the cap belongs to the line rather than to each part of it.
    return {
      line: parts.length > 0 ? oneLine(parts.join(' | ')) : null,
      modelResponded,
      apiError,
    };
  }

  if (evt.type === 'result') {
    const cost = typeof evt.total_cost_usd === 'number' ? ` cost=$${evt.total_cost_usd.toFixed(4)}` : '';

    return {
      line: `session result: ${String(evt.subtype ?? '?')} turns=${String(evt.num_turns ?? '?')}${cost}`,
      modelResponded: false,
    };
  }

  if (evt.type === 'rate_limit_event') {
    const info = (evt.rate_limit_info ?? {}) as { status?: unknown; resetsAt?: unknown };

    return {
      ...NOTHING,
      rejectedUntil: info.status === 'rejected' && typeof info.resetsAt === 'number' ? info.resetsAt : null,
    };
  }

  return NOTHING;
}

function spawnClaude(
  opts: StartSessionOpts,
  resuming: boolean
): {
  child: ChildProcess;
  exit: Promise<SessionResult>;
  /** Whether the model has produced output since this child started. */
  sawModelResponse: () => boolean;
  /** The API error this child's session ended on, or null where it ended on none. */
  endedOnApiError: () => Omit<LimitHit, 'detectedAt'> | null;
} {
  // Headless and unattended: --print gives the session a single prompt and no
  // REPL to ask questions from, bypassPermissions auto-approves tool calls, and
  // stdin is /dev/null so nothing can ever block on the terminal. stream-json
  // is what keeps the run observable — plain --print stays silent until the
  // session ends, which for a long task means minutes of nothing in the log.
  const args = [
    ...(resuming ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId]),
    ...(opts.model ? ['--model', opts.model] : []),
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--print',
    opts.initialPrompt,
  ];
  const child = spawn(opts.claudeBin, args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The brief is built from issue text and every tool call is auto-approved,
    // so the session must not be handed ramonda's PAT. Nothing downstream of
    // here needs it: the Stop hook only runs verify, and the push and the PR are
    // the loop's. The inspector goes too — a debugged ramonda would otherwise
    // kill every session it spawns on a port conflict. The commit identity goes
    // the other way, added so commits the session makes itself carry the same
    // author as the one the loop makes on top of them.
    env: withCommitIdentity(withoutInspector(withoutSecrets(process.env)), opts.commitIdentity),
  });

  const emit = opts.onSessionOutput;
  let sawModelResponse = false;
  let apiError: string | null = null;
  let rejectedUntil: number | null = null;

  // Read stdout even with no logger attached: the stream is also what tells the
  // backoff whether this spawn ever reached the model, and the loop whether the
  // session ended on an API error.
  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (raw) => {
      const summary = summarizeEvent(raw);

      // Only the error the session ended on counts: one the model carried on
      // past did not end anything.
      if (summary.modelResponded) {
        sawModelResponse = true;
        apiError = null;
      }

      if (summary.apiError !== undefined) {
        apiError = summary.apiError;
      }

      if (summary.rejectedUntil !== undefined) {
        rejectedUntil = summary.rejectedUntil;
      }

      if (summary.line && emit) {
        emit(summary.line);
      }
    });
  }

  if (emit && child.stderr) {
    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      if (line.trim()) {
        emit(`stderr: ${line.trim()}`);
      }
    });
  } else {
    child.stderr?.resume();
  }

  const exit = new Promise<SessionResult>((resolve, reject) => {
    let exited = false;

    child.on('exit', (code, signal) => {
      exited = true;
      resolve({ exitCode: code, signal });
    });

    child.on('error', (err) => {
      if (exited) {
        return;
      }

      reject(new Error(`Failed to start ${opts.claudeBin}: ${err.message}`));
    });
  });

  return {
    child,
    exit,
    sawModelResponse: () => sawModelResponse,
    endedOnApiError: () =>
      apiError === null
        ? null
        : {
            errorType: apiError,
            ...(rejectedUntil !== null && { resetsAt: new Date(rejectedUntil * 1000).toISOString() }),
          },
  };
}

/** Resolves true when the wait was cut short by a stop rather than run to term. */
async function sleepInterruptible(ms: number, shutdownSignal?: AbortSignal): Promise<boolean> {
  // A rate-limit wait can be hours long, so a stop that arrived while the child
  // was still being torn down must not be answered with a respawn.
  if (shutdownSignal?.aborted) {
    return true;
  }

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  shutdownSignal?.addEventListener('abort', onSigint);

  try {
    await sleep(ms, undefined, { signal: controller.signal });

    return false;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return true;
    }

    throw err;
  } finally {
    process.off('SIGINT', onSigint);
    shutdownSignal?.removeEventListener('abort', onSigint);
  }
}
