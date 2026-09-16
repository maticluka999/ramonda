import type { Command } from 'commander';
import { printBanner } from '../banner/banner.js';
import { loadConfig } from '../config/user.js';
import { assertHookEntriesPresent } from '../hooks/install.js';
import { preflight as runPreflight, run as runLoop } from '../runner/runner.js';
import { positiveInteger, trimmedFlag } from '../utils/cli.js';

const USAGE = 'usage: ramonda run [--profile=<profile>] [--poll-pause=<seconds>] [--model=<model>] [--no-banner]';

export function addRunCommand(program: Command): void {
  program
    .command('run')
    .description('Loop: claim the next "ramonda"-labelled task and start a Claude Code session')
    // No commander default, or an omitted flag would arrive as "60" and there
    // would be nothing left to tell "not given" from "asked for 60".
    .option(
      '--poll-pause <seconds>',
      'idle wait between project checks when no task is available (defaults to $DEFAULT_POLL_PAUSE, then to 60)'
    )
    .option(
      '--model <model>',
      "model for the Claude Code session (defaults to $DEFAULT_MODEL, then to claude's own default)"
    )
    .option('--profile <profile>', 'credentials profile to run as (default: the one marked [default])')
    .option('--no-banner', 'skip the startup logo')
    .action(async (opts) => {
      // Startup step 1 before step 2: a missing GH_TOKEN — or an unknown
      // --profile — is reported as such, not masked by whichever flag the user
      // also got wrong.
      const config = loadConfig({ profile: trimmedFlag(opts.profile) });

      // Which project to poll is a fact about the repo, so it lives in
      // ramonda.json beside the base branch and the verify commands, and the loop
      // reads it there. Only per-machine and per-invocation choices are flags.
      const pollPauseSeconds =
        opts.pollPause === undefined
          ? config.pollPauseSeconds
          : positiveInteger(opts.pollPause, {
              flag: '--poll-pause',
              usage: USAGE,
              unit: 'seconds',
            });
      // Not `trimmedFlag`: an explicit `--model ""` is a mistake worth naming,
      // where that would quietly read it as "fall back to DEFAULT_MODEL".
      const model = (opts.model as string | undefined)?.trim();

      if (model === '') {
        throw new Error('--model must not be empty.');
      }

      // A build with no hook entries cannot finish a task at all, so it is
      // refused alongside the flags rather than after the logo.
      assertHookEntriesPresent();

      // The rest of what ramonda can refuse on its own: the checkout, its
      // config, and the .gitignore. These are the setup mistakes, so they are
      // settled here — before the logo — and everything left in the run's own
      // startup needs the network to answer.
      const preflight = await runPreflight();

      // After validation, so a mistyped flag or an unfinished setup fails
      // against a bare terminal rather than under a logo that implies the run
      // got started.
      printBanner({ enabled: opts.banner });

      await runLoop({
        config,
        pollPauseSeconds,
        model,
        preflight,
      });
    });
}
