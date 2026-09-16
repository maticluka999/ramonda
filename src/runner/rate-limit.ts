import { open } from 'node:fs/promises';
import type { LimitHit } from '../types.js';

/** What to wait when the transcript will not say — a Claude subscription window. */
const RATE_LIMIT_FALLBACK_MS = 5 * 60 * 60_000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** However long a transcript claims to want, nothing waits longer than this. */
const MAX_WAIT_MS = 8 * 60 * 60_000;
/**
 * And nothing waits less than this either. A reset that has already passed —
 * read off a stale header, or simply overtaken while the child was torn down —
 * clamps to a zero wait, and a respawn that instant walks straight back into the
 * same limit. The hook then reports it again, and the loop spins on spawning
 * sessions that cannot run. A floor costs a minute in the honest case and is the
 * difference between retrying and thrashing in the rest.
 */
const MIN_RATE_LIMIT_WAIT_MS = 60_000;

export type RateLimitWait = {
  waitMs: number;
  /**
   * Where the wait came from: the reset the session reported, the transcript, or
   * the fallback window.
   *
   * Reported rather than kept private because a fallback is indistinguishable
   * from the outside: five hours is a plausible reset, so it looks exactly like a
   * reset that really was five hours away. Both the session's output and the
   * transcript are Claude Code's, with no format promise about either, so the day
   * a field is renamed every wait silently becomes the fallback — and a run that
   * could have resumed in twenty minutes idles most of a working day instead.
   * The caller logs it, which is what turns that from invisible into noticed.
   */
  source: 'session' | 'transcript' | 'fallback';
};

/**
 * How long a `rate_limit` hit has to sit out: when the session said the limit
 * resets, else what the transcript says, else the fallback window.
 *
 * Only `rate_limit` reaches here. The other two retryable types — `overloaded`
 * and `server_error` — are backend trouble rather than a quota, carry no reset to
 * read, and are paced by the session loop's exponential backoff instead.
 */
export async function computeWaitMs(hit: LimitHit): Promise<RateLimitWait> {
  const reported = hit.resetsAt === undefined ? NaN : Date.parse(hit.resetsAt);

  // The floor holds for every source, the fallback included: all of them are
  // waits, and none may hand back a delay that respawns into a live limit.
  if (Number.isFinite(reported)) {
    return { waitMs: Math.max(clampWait(reported - Date.now()), MIN_RATE_LIMIT_WAIT_MS), source: 'session' };
  }

  const parsed = hit.transcriptPath ? await tryParseResetFromTranscript(hit.transcriptPath) : null;

  return {
    waitMs: Math.max(parsed ?? RATE_LIMIT_FALLBACK_MS, MIN_RATE_LIMIT_WAIT_MS),
    source: parsed === null ? 'fallback' : 'transcript',
  };
}

async function tryParseResetFromTranscript(path: string): Promise<number | null> {
  const tail = await readTail(path, TRANSCRIPT_TAIL_BYTES);

  if (!tail) {
    return null;
  }

  const now = Date.now();
  const epochSeconds = matchNumber(tail, /"anthropic-ratelimit-unified-reset"\s*:\s*"?(\d{9,11})(?:\.\d+)?"?/gi);

  if (epochSeconds !== null) {
    return clampWait(epochSeconds * 1000 - now);
  }

  // The `quotaLimits` Claude Code records on the error entry itself, in epoch
  // seconds and unquoted — which the ISO match below cannot see.
  const quotaResetSeconds = matchNumber(tail, /"resetsAt"\s*:\s*(\d{9,11})/g);

  if (quotaResetSeconds !== null) {
    return clampWait(quotaResetSeconds * 1000 - now);
  }

  const resetsAt = matchIso(tail, /"(?:resets_at|reset_at|resetsAt)"\s*:\s*"([^"]+)"/gi);

  if (resetsAt !== null) {
    return clampWait(resetsAt - now);
  }

  const retryAfterSeconds = matchNumber(tail, /"retry-?after"\s*:\s*"?(\d{1,7})"?/gi);

  if (retryAfterSeconds !== null) {
    return clampWait(retryAfterSeconds * 1000);
  }

  return null;
}

async function readTail(path: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(path, 'r');

    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - bytes);
      const length = size - start;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);

      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The capture of the *last* match, not the first.
 *
 * A transcript is append-only, so a session that was rate-limited earlier and
 * recovered carries that older reset ahead of the current one. Taking the first
 * match reads a timestamp that has long since passed, which is exactly the zero
 * wait `MIN_RATE_LIMIT_WAIT_MS` exists to survive — the last match is the one
 * describing the limit the session is actually sitting behind. Requires a global
 * regex, which is what `matchAll` iterates.
 */
function lastCapture(text: string, re: RegExp): string | null {
  let captured: string | null = null;

  for (const match of text.matchAll(re)) {
    captured = match[1];
  }

  return captured;
}

function matchNumber(text: string, re: RegExp): number | null {
  const captured = lastCapture(text, re);

  if (captured === null) {
    return null;
  }

  const n = Number(captured);

  return Number.isFinite(n) ? n : null;
}

function matchIso(text: string, re: RegExp): number | null {
  const captured = lastCapture(text, re);

  if (captured === null) {
    return null;
  }

  const ms = Date.parse(captured);

  return Number.isFinite(ms) ? ms : null;
}

function clampWait(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    return 0;
  }

  return Math.min(ms, MAX_WAIT_MS);
}
