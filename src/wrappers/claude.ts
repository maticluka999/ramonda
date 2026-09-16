import { execa } from 'execa';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const INSPECTOR_FLAGS =
  /(?:^|\s)--(?:inspect|inspect-brk|inspect-port|inspect-publish-uid|debug|debug-brk|debug-port)(?:=\S*)?(?=\s|$)/g;

/**
 * A copy of `env` that will not hand this process's debugger to a child.
 *
 * Node inherits `NODE_OPTIONS` into every descendant, so a ramonda started from
 * a debug terminal passes its inspector down to `claude` — and a second process
 * on the same port makes `claude --help` exit 1 with no output at all, which
 * reads exactly like a binary too old to support the headless flags. The
 * debugger belongs to ramonda; the session it spawns is not what is being
 * debugged.
 */
export function withoutInspector(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  const nodeOptions = scrubbed.NODE_OPTIONS?.replace(INSPECTOR_FLAGS, ' ').trim();

  if (nodeOptions) {
    scrubbed.NODE_OPTIONS = nodeOptions;
  } else {
    delete scrubbed.NODE_OPTIONS;
  }

  // VS Code's auto-attach injects its bootloader with `--require` and configures
  // it through these. Removing the configuration is enough — the bootloader
  // no-ops without it — so an unrelated `--require` the user meant to keep, and
  // any other NODE_OPTIONS, survive.
  delete scrubbed.VSCODE_INSPECTOR_OPTIONS;
  delete scrubbed.NODE_INSPECTOR_IPC;

  return scrubbed;
}

function notRunnableMessage(bin: string, code: string): string {
  if (code === 'ENOENT') {
    // Both fixes named, because the two failures look identical from here: a
    // CLAUDE_BIN pointing at a path that no longer exists, and a bare `claude`
    // that $PATH cannot resolve.
    return `Could not find "${bin}". Install Claude Code so $PATH resolves it, or set CLAUDE_BIN to the binary itself.`;
  }

  if (code === 'EACCES') {
    return `Could not run "${bin}" — not an executable file. Give the path to the claude binary itself, not to a directory.`;
  }

  return `Could not run "${bin}" (${code}).`;
}

/** `Usage: /model <name>. Available: opus, sonnet, ..., or a full model ID.` */
const AVAILABLE_ALIASES = /Available:\s*(.*?)(?:,\s*)?or a full model ID/;

function parseAliases(usage: string): string[] {
  const match = AVAILABLE_ALIASES.exec(usage);

  if (match === null) {
    return [];
  }

  return match[1]
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias !== '');
}

/** The full ID an alias landed on, off the `stream-json` session-init event. */
function initModel(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    try {
      const event = JSON.parse(line) as { type?: string; subtype?: string; model?: string };

      if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
        return event.model;
      }
    } catch {
      // A line that is not an event says nothing about the model; only init does.
    }
  }

  return undefined;
}

/** The two flags the unattended session model depends on. */
const REQUIRED_FLAGS = ['--session-id', '--permission-mode'];

/**
 * What `listModels` came back with.
 *
 * The aliases that would not resolve are handed back rather than swallowed:
 * losing one is not worth failing the whole list over, but a picker quietly
 * missing the model somebody came to choose reads as this Claude Code not
 * having it, so the caller gets to say which ones went missing.
 */
export type ModelList = {
  /** Full model IDs, deduplicated and ordered alphabetically. */
  ids: string[];
  /** Aliases `/model` named that no probe could turn into an ID. */
  unresolved: string[];
};

/**
 * The installed Claude Code CLI, behind one class.
 *
 * An instance is bound to one binary path — whatever the profile named, or what
 * a bare `claude` resolves to — so no call site repeats it and the argv for any
 * given probe is written once. Instances carry no state beyond that path, so
 * constructing one is free.
 *
 * Nothing here starts a session; that is `runner/session.ts`'s job. These are
 * the questions asked *about* a binary before ramonda commits to driving it:
 * what version it is, which models it accepts, whether it is new enough to run
 * unattended.
 */
export class Claude {
  readonly #bin: string;

  constructor(bin: string) {
    this.#bin = bin;
  }

  /**
   * What a bare `claude` resolves to right now, so setup-profile can offer the
   * real binary instead of a bare name. Same first-match-wins walk the shell does,
   * minus the shell: aliases and functions are deliberately not consulted, since
   * ramonda spawns the binary directly and would never see them.
   */
  static async onPath(): Promise<Claude | undefined> {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');

    for (const dir of dirs) {
      const candidate = join(dir, 'claude');

      try {
        await access(candidate, constants.X_OK);

        return new Claude(candidate);
      } catch {
        // Missing, or there but not executable — the shell skips it too.
      }
    }

    return undefined;
  }

  /** The binary every probe on this instance spawns. */
  get bin(): string {
    return this.#bin;
  }

  /**
   * Every probe spawns the binary the same way and every one has to tell "never
   * started" from "started and unhappy". `reject: false` reports a spawn that
   * failed as a result carrying an OS error code and no exit code at all, rather
   * than by throwing, so the check has to come first — an exit-code comparison
   * alone reports it as `exited undefined` and buries the one message the user
   * could act on.
   *
   * stdin is detached because `setup-profile` asks its questions on the terminal
   * the child would otherwise inherit, and no probe here has anything to read.
   */
  async #run(args: string[]) {
    const result = await execa(this.#bin, args, {
      reject: false,
      stdin: 'ignore',
      env: withoutInspector(process.env),
      extendEnv: false,
    });

    // The binary never started: no such file, or not an executable one.
    if (result.code !== undefined) {
      throw new Error(notRunnableMessage(this.#bin, result.code));
    }

    return result;
  }

  /**
   * How every probe reports a binary that ran and came back unhappy: the argv
   * that was tried, the code it exited on, and whichever stream it said anything
   * on. stderr first — a failing CLI puts its complaint there, and stdout at that
   * point is as likely as not to be a half-written banner.
   */
  #exited(args: string[], result: { exitCode?: number; stdout: string; stderr: string }): string {
    return `\`${this.#bin} ${args.join(' ')}\` exited ${result.exitCode}: ${
      result.stderr || result.stdout || '(no output)'
    }`;
  }

  /**
   * Runs `/model` as a one-shot headless prompt. The slash command is answered
   * locally, so no model turn happens and nothing is billed — the session exists
   * only long enough to print. `--no-session-persistence` keeps it from leaving
   * a resumable session behind.
   */
  async #runSlashModel(extraArgs: string[]): Promise<string> {
    const args = ['--no-session-persistence', '--print', ...extraArgs, '/model'];
    const result = await this.#run(args);

    if (result.exitCode !== 0) {
      throw new Error(this.#exited(args, result));
    }

    return result.stdout;
  }

  async #resolveAlias(alias: string): Promise<string | undefined> {
    try {
      return initModel(await this.#runSlashModel(['--model', alias, '--output-format', 'stream-json', '--verbose']));
    } catch {
      // One alias that will not resolve is not worth losing the rest of the
      // list, so it is reported rather than raised — see `ModelList`.
      return undefined;
    }
  }

  async probeVersion(): Promise<string> {
    const result = await this.#run(['--version']);

    if (result.exitCode !== 0) {
      throw new Error(
        `${this.#exited(['--version'], result)}. ` +
          `Check that CLAUDE_BIN — or "${this.#bin}" on PATH — points at a working Claude Code CLI.`
      );
    }

    return result.stdout.trim() || result.stderr.trim();
  }

  /**
   * The full model IDs this binary accepts, asked of it rather than hardcoded so
   * the list cannot go stale between Claude Code releases.
   *
   * `/model` names only aliases, so each is resolved through a second probe. The
   * routing aliases (`best`, `default`, `opusplan`) name a policy rather than a
   * model — `opusplan` plans on one and executes on another — but each resolves
   * onto an ID some family alias already produced, so deduplicating drops them
   * without a skip-list to maintain, and every surviving entry names one model.
   */
  async listModels(): Promise<ModelList> {
    const aliases = parseAliases(await this.#runSlashModel([]));
    const probed = await Promise.all(aliases.map(async (alias) => ({ alias, id: await this.#resolveAlias(alias) })));

    return {
      ids: [...new Set(probed.map((p) => p.id).filter((id): id is string => id !== undefined))].sort(),
      unresolved: probed.filter((p) => p.id === undefined).map((p) => p.alias),
    };
  }

  async assertHeadlessSupported(): Promise<void> {
    const result = await this.#run(['--help']);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    // A probe that printed no help proves nothing about which flags the binary
    // supports, so report the probe instead of accusing the binary of being old.
    if (result.exitCode !== 0 || output.trim() === '') {
      throw new Error(
        `\`${this.#bin} --help\` exited ${result.exitCode} without printing help, so its flags could not be checked: ` +
          `${output.trim() || '(no output)'}`
      );
    }

    const missing = REQUIRED_FLAGS.filter((flag) => !output.includes(flag));

    if (missing.length > 0) {
      throw new Error(
        `\`${this.#bin}\` does not appear to support ${missing.join(' / ')} (not found in --help output). ` +
          `Upgrade Claude Code, or set CLAUDE_BIN to a newer binary.`
      );
    }
  }
}
