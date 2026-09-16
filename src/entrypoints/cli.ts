#!/usr/bin/env node
import { Command } from 'commander';
import { addInitCommand } from '../cli-commands/init.js';
import { addRunCommand } from '../cli-commands/run.js';
import { addSetupProfileCommand } from '../cli-commands/setup-profile.js';
import { addSetupProjectCommand } from '../cli-commands/setup-project.js';
import { flushLogs } from '../utils/logger.js';
import { errorOut } from '../utils/out.js';
import { MIN_NODE, VERSION } from '../utils/version.js';

/**
 * The initial version is macOS/Linux only: verify commands run through `sh -c`,
 * and config/state live at POSIX paths. Fail here with a straight answer rather
 * than somewhere deep in a session.
 */
function assertSupportedPlatform(): void {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return;
  }

  throw new Error(
    `unsupported platform "${process.platform}" — ramonda runs on macOS and Linux only. ` +
      'On Windows, run it under WSL.'
  );
}

/**
 * The Node floor, checked rather than merely declared.
 *
 * `package.json` states it in `engines`, which npm reads at install time and
 * never again — so a clone that was linked months ago and is being run today
 * under whatever node is on PATH gets no answer from it. Unchecked, the version
 * surfaces as whichever API went missing first, somewhere deep in a run.
 *
 * Compared component by component rather than through a semver library: the
 * range is ramonda's own `>=x.y`, so there is one form to read. A component
 * that will not parse compares as neither greater nor less and falls through,
 * which is the right way for a version check to fail.
 */
function assertSupportedNode(): void {
  const wanted = MIN_NODE.split('.').map(Number);
  const actual = process.versions.node.split('.').map(Number);

  for (const [index, want] of wanted.entries()) {
    const have = actual[index] ?? 0;

    if (have > want) {
      return;
    }

    if (have < want) {
      throw new Error(`node ${process.versions.node} is too old — ramonda needs node ${MIN_NODE} or newer.`);
    }
  }
}

const program = new Command();

program.name('ramonda').description('Drive Claude Code coding sessions from a Github project.').version(VERSION);

addSetupProfileCommand(program);
addInitCommand(program);
addSetupProjectCommand(program);
addRunCommand(program);

try {
  assertSupportedPlatform();
  assertSupportedNode();
} catch (err) {
  errorOut(`ramonda: ${(err as Error).message}`);
  process.exit(1);
}

program.parseAsync(process.argv).catch(async (err) => {
  // Ctrl-C at a prompt is a deliberate abort rather than a failure, but inquirer
  // can only unwind it as one — so it is named here and reported the way a shell
  // reports a death by SIGINT, rather than as `ramonda: <library message>`.
  if ((err as Error).name === 'ExitPromptError') {
    console.error('aborted');
    await flushLogs();
    process.exit(130);
  }

  errorOut(`ramonda: ${(err as Error).message}`);
  await flushLogs();
  process.exit(1);
});
