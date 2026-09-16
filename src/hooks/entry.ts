import { flushLogs } from '../utils/logger.js';

/**
 * Runs a hook to completion and exits on its code.
 *
 * Both hooks are spawned by Claude Code from the per-worktree
 * `settings.local.json` that step 14 writes, and both are standalone entry files
 * rather than subcommands of the `ramonda` CLI: no user ever runs them, so they
 * stay off the command surface.
 *
 * The flush is what the shared wrapper exists for. Winston hands lines to a
 * write stream rather than awaiting the append, so an exit taken straight after
 * a log call drops whatever is still queued — which for a hook is the part of
 * the log saying how the task ended.
 */
export async function runHookEntry(hook: (worktreePath: string) => Promise<number>): Promise<never> {
  // Claude Code names the worktree it is running the session in; `cwd` is the
  // fallback for a hook reached any other way.
  const worktreePath = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  try {
    const code = await hook(worktreePath);
    await flushLogs();
    process.exit(code);
  } catch (err) {
    console.error(`ramonda: ${(err as Error).message}`);
    await flushLogs();
    process.exit(1);
  }
}
