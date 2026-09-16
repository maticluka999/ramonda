import { execa } from 'execa';
import { withoutSecrets } from '../config/user.js';
import type { CommandFailure, ShellCommand } from '../types.js';

/** How long a timed-out command gets to die politely before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * SIGTERMs a whole process group, then SIGKILLs whatever is still standing.
 *
 * The group rather than the pid, which is the entire reason the child is spawned
 * `detached`. `sh -c "npm test"` is a tree — shell, package manager, test
 * runner, whatever the suite forks — and signalling only the shell leaves the
 * runner alive, still holding the worktree and whatever port it bound. That is
 * the exact thing this timeout exists to prevent, so killing narrowly would
 * trade a hung verify for a hung orphan nobody is even waiting on.
 *
 * Returns the SIGKILL timer so the caller can cancel it once the child is reaped.
 */
function killGroup(pid: number): NodeJS.Timeout | undefined {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Already gone between the timer firing and this call.
    return undefined;
  }

  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Exited on the SIGTERM, which is the good case.
    }
  }, KILL_GRACE_MS);

  // Nothing should be held open waiting to escalate a kill.
  forceKill.unref();

  return forceKill;
}

/**
 * Runs a configured list of shell commands in order, and reports the first that
 * fails. Serves `verify` and `worktree.prepare` alike — what differs between
 * them is which process calls it and what that caller does with the failure, not
 * how the command itself is run.
 *
 * Each entry carries its own budget rather than the list sharing one: a lint
 * pass that should take seconds and an integration suite that fairly takes
 * minutes want very different leashes, and one number for both can only be the
 * looser of the two. A command that runs out is reported as an ordinary failure
 * — for `verify` the model is told it timed out and gets another go, and three
 * of them give up through the same path any other failure does.
 */
export async function runCommands(cwd: string, commands: ShellCommand[]): Promise<CommandFailure | null> {
  for (const { command, timeout } of commands) {
    const child = execa('sh', ['-c', command], {
      cwd,
      reject: false,
      // Scrubbed off whichever process is calling: the session's environment for
      // `verify`, which the Stop hook inherits, and the loop's own for
      // `worktree.prepare`. `npm test` runs test files the session just wrote,
      // so a check is no more entitled to ramonda's credentials than the code it
      // is checking — and an install script is no more entitled than either.
      // extendEnv would merge process.env back over this and undo the scrub.
      env: withoutSecrets(process.env),
      extendEnv: false,
      // Its own process group, so the timeout below can take the whole tree.
      detached: true,
    });

    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const budget = setTimeout(() => {
      timedOut = true;

      if (child.pid !== undefined) {
        forceKill = killGroup(child.pid);
      }
    }, timeout);

    let result;

    try {
      result = await child;
    } finally {
      clearTimeout(budget);

      if (forceKill) {
        clearTimeout(forceKill);
      }
    }

    if (timedOut) {
      return {
        command,
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOutAfter: timeout,
      };
    }

    if (result.exitCode !== 0) {
      return {
        command,
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    }
  }

  return null;
}
