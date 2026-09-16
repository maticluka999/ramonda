import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookEntry, SettingsJson } from '../types.js';

const HOOK_NAME = 'ramonda';

// Resolved from this module's own compiled file, so the hook entries resolve the
// same way whether ramonda runs from `dist` or from a linked checkout.
// `..` because this module sits in `hooks/`, one level under the build root.
const RAMONDA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_STOP_ENTRY = resolve(RAMONDA_DIR, 'entrypoints', 'hook-stop.js');
const HOOK_STOP_FAILURE_ENTRY = resolve(RAMONDA_DIR, 'entrypoints', 'hook-stop-failure.js');

/** Claude Code runs the hook command through a shell, so paths with spaces need it. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * This worktree's hook entries, minus ramonda's own — the `ramonda` name and any
 * `ramonda:<something>` namespaced under it. Dropping them first is what makes
 * re-installing an update rather than a second copy, and the prefix is matched
 * as well as the name so that a worktree reused by a build whose entries are
 * named differently is still left with exactly one set of ramonda's.
 */
function withoutRamondaEntries(entries: HookEntry[] | undefined): HookEntry[] {
  return (entries ?? []).filter((e) => !(e.name === HOOK_NAME || e.name?.startsWith(`${HOOK_NAME}:`)));
}

/**
 * A Stop hook whose entry file is missing fails after the session has already
 * done the work: verify never runs, no verdict is ever written, and the task is
 * cancelled the moment its session ends — a full session per task, until the
 * no-PR budget stops the run. Refuse before anything is claimed.
 *
 * Called by the CLI ahead of the banner rather than from the loop: a refusal
 * that ramonda alone is responsible for should not arrive under a logo that
 * implies the run got started.
 */
export function assertHookEntriesPresent(): void {
  for (const entry of [HOOK_STOP_ENTRY, HOOK_STOP_FAILURE_ENTRY]) {
    if (!existsSync(entry)) {
      throw new Error(
        `hook entry file missing: ${entry} — the Stop hooks are installed as \`node <entry>\` commands ` +
          'and cannot run without it. Rebuild ramonda (`npm run build`).'
      );
    }
  }
}

/**
 * Node is named explicitly rather than relying on the entry files being directly
 * executable: the exec bit is set when the package is installed, not by the
 * build, so a locally built entry would fail as a bare command. Both paths are
 * absolute, so `$PATH` inside Claude Code's non-interactive shell never matters.
 *
 * The entries are standalone files rather than subcommands of the `ramonda` CLI
 * — Claude Code is the only caller, so they stay off the user command surface.
 */
export async function installWorktreeHooks(opts: { worktreePath: string }): Promise<void> {
  const { worktreePath } = opts;
  const node = shellQuote(process.execPath);
  const settingsPath = join(worktreePath, '.claude', 'settings.local.json');
  let settings: SettingsJson = {};

  try {
    const raw = await readFile(settingsPath, 'utf8');
    settings = JSON.parse(raw) as SettingsJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  settings.hooks ??= {};
  settings.hooks.Stop = [
    ...withoutRamondaEntries(settings.hooks.Stop),
    { name: HOOK_NAME, hooks: [{ type: 'command', command: `${node} ${shellQuote(HOOK_STOP_ENTRY)}` }] },
  ];
  settings.hooks.StopFailure = [
    ...withoutRamondaEntries(settings.hooks.StopFailure),
    { name: HOOK_NAME, hooks: [{ type: 'command', command: `${node} ${shellQuote(HOOK_STOP_FAILURE_ENTRY)}` }] },
  ];

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
