import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type winston from 'winston';
import { readRepoConfig, REPO_CONFIG_FILE } from '../config/repo.js';
import { PRIORITY_FIELD, PRIORITY_VALUES, TASK_LABEL } from '../constants/github.js';
import { createLogger, runLogPath, TERMINAL } from '../utils/logger.js';
import type { CommitIdentity, Config, ProjectMeta, RepoConfig, WorkspaceInfo } from '../types.js';
import { quoteAll } from '../utils/quote-all.js';
import { Claude } from '../wrappers/claude.js';
import { assertGithubOrigin, Git } from '../wrappers/git.js';
import { formatRateLimitObservation, Github } from '../wrappers/github.js';
import { cancelTask } from './cancel.js';
import { SetupError } from './prepare-task.js';
import { runOneTask } from './task.js';
import { readTaskState } from './task-state.js';

/**
 * How many tasks may finish back to back without opening a PR before the loop
 * gives up.
 *
 * Counts thrown passes and cancels alike, because the question worth asking of
 * an unattended run is not "is ramonda working?" but "is ramonda producing
 * anything?". A pass that throws has released whatever it claimed and is safe to
 * follow with another, and a task that cancels did its whole job — claimed,
 * worked, reached a verdict. Both are free of *errors* and both leave the board
 * exactly as they found it, so counting only one of them lets the other run
 * forever: a repo whose `verify` command does not exist cancels every task it is
 * given, three verify retries and a full session at a time, and works through an
 * entire backlog overnight producing nothing but cancelled issues and a bill.
 *
 * One counter over both rather than one each, because separate budgets reset
 * each other — failure, cancel, failure, cancel trips neither — while "did this
 * task open a PR" has exactly one answer per task and so has no such gap.
 *
 * Three is low on purpose. Every tick costs a session.
 */
const MAX_TASKS_WITHOUT_PR = 3;

/** Everything one pass of the loop works from, settled once by startup. */
export type RunOpts = {
  runId: string;
  ghOwner: string;
  ghProject: number;
  meta: ProjectMeta;
  workspacePath: string;
  repoNameWithOwner: string;
  mainLogger: winston.Logger;
  repoConfig: RepoConfig;
  claudeBin: string;
  model?: string;
  /** Authenticates the fetch, the push and every API call a task makes. */
  ghToken: string;
  /** The `GH_TOKEN` account, resolved once at startup. Authors every commit. */
  commitIdentity: CommitIdentity;
  /** The loop's one authenticated client — startup primed its rate-limit tally. */
  github: Github;
  /**
   * The commit every claim ref is pointed at, resolved once from the base
   * branch's head. A marker, never dereferenced: a ref has to point somewhere,
   * and this is a commit certain to exist and certain not to be collected.
   */
  claimSha: string;
  /**
   * Issue number → when this process last finished with it, as epoch ms. Read by
   * the poll to skip an item the project's filter may not have caught up with
   * yet; see `HANDLED_COOLDOWN_MS`.
   */
  recentlyHandled: Map<number, number>;
  /** Aborted on SIGINT, so a stop reaches the pickup and the child, not just the loop. */
  shutdownSignal: AbortSignal;
};

/**
 * What a task actually produced, as against whether it ran cleanly. The loop
 * counts `none` to decide whether the run is still worth continuing.
 */
export type TaskVerdict = { kind: 'pr'; url: string } | { kind: 'none'; reason: string };

/** How a pass ended, in the terms the loop below acts on. */
export type TaskOutcome =
  | { kind: 'ran'; issueNumber: number; worktreePath: string; verdict: TaskVerdict }
  | { kind: 'idle-empty' }
  | { kind: 'idle-all-claimed' }
  /** Every candidate was one this run just finished with — see `HANDLED_COOLDOWN_MS`. */
  | { kind: 'idle-cooling' }
  | { kind: 'aborted' }
  | { kind: 'stop' };

// Filesystem-safe ISO 8601 UTC timestamp: colons swapped for dashes so the
// full runId can be used verbatim as a directory/filename component.
function generateRunId(now: Date = new Date()): string {
  const iso = now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');

  return `${hostname()}-${process.pid}-${iso}`;
}

/**
 * Refuses a project that cannot serve the priority order.
 *
 * The order is fixed (`PRIORITY_VALUES`) and `setup-project` puts it on the
 * board, so every failure here has the one fix: point that command at this
 * project. A level the field does not carry queries for a value no issue can
 * hold, so its pass matches nothing and that priority is silently skipped for
 * the life of the run — worth failing startup over rather than discovering by
 * absence.
 */
function assertPrioritiesUsable(args: { meta: ProjectMeta; mainLogger: winston.Logger }): void {
  const { meta, mainLogger } = args;

  if (!meta.priorityFieldId) {
    throw new Error(
      (meta.priorityFieldWrongType
        ? `The project's "${PRIORITY_FIELD}" field is ${meta.priorityFieldWrongType}, not a single-select. ` +
          `Priority ordering needs options to match against, so rename or replace the field on the project. `
        : `The project has no "${PRIORITY_FIELD}" field, and ramonda polls one level at a time. `) +
        `Then run \`ramonda setup-project\`, which puts the field and its options back.`
    );
  }

  // Only a field that actually reported its options can be diffed against —
  // one that did not says nothing about whether the levels are really there.
  const fieldOptions = meta.priorityOptions;

  if (!fieldOptions) {
    return;
  }

  const fieldSet = new Set(fieldOptions);
  const missing = PRIORITY_VALUES.filter((priority) => !fieldSet.has(priority));

  if (missing.length > 0) {
    throw new Error(
      `The project's "${PRIORITY_FIELD}" field is missing the option(s) ramonda polls: ${quoteAll(missing)}. ` +
        `The field has: ${quoteAll(fieldOptions)}. Run \`ramonda setup-project\` to add them.`
    );
  }

  // The other direction is a repo's own business: a board may carry levels of
  // its own, and ramonda polling only its four is not a misconfiguration. Worth
  // saying once, since an issue parked on one of them is never picked up.
  const polled = new Set<string>(PRIORITY_VALUES);
  const uncovered = fieldOptions.filter((option) => !polled.has(option));

  if (uncovered.length > 0) {
    mainLogger.info(
      `warning: project field "${PRIORITY_FIELD}" carries option(s) ramonda does not poll: ${quoteAll(uncovered)}. ` +
        `Issues on those are invisible to ramonda — move them to one of ${quoteAll([...PRIORITY_VALUES])} to be picked up.`,
      TERMINAL
    );
  }
}

/**
 * Which project to poll, read from the repo's own config and nowhere else.
 *
 * Not a flag, because it is not a fact about this invocation — it is a fact
 * about this repo, and it belongs beside `baseBranch` and `verify` in the file
 * that records them. `setup-project` writes it.
 *
 * The two halves are reported separately. A repo that has run `setup-project`
 * has both, and a repo that has not has neither — so a run missing exactly one
 * is a file someone edited by hand, and saying which half is missing is the
 * difference between a fix and a hunt.
 */
function resolveProjectTarget(repoConfig: RepoConfig): { ghOwner: string; ghProject: number } {
  const { owner: ghOwner, number: ghProject } = repoConfig.project;
  const missing: string[] = [];

  if (!ghOwner) {
    missing.push('"project.owner"');
  }

  if (ghProject <= 0) {
    missing.push('"project.number"');
  }

  if (missing.length > 0) {
    throw new Error(
      `No project to poll: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} unset in ${REPO_CONFIG_FILE}. ` +
        `Run \`ramonda setup-project\`, which records the project it resolves.`
    );
  }

  return { ghOwner, ghProject };
}

/** What `preflight` settles, and `startup` then builds a run on top of. */
export type Preflight = {
  workspace: WorkspaceInfo;
  repoConfig: RepoConfig;
  ghOwner: string;
  ghProject: number;
};

/**
 * Everything a run can refuse over without asking anybody anything: the
 * checkout, its config, and the `.gitignore` that decides what a task is allowed
 * to publish.
 *
 * Its own step, ahead of the banner, because these are the setup mistakes — a
 * repo that never ran `init`, a `ramonda.json` still holding no project, a
 * `.gitignore` that was never committed — and a refusal that ramonda alone is
 * responsible for should not arrive under a logo that implies the run got
 * started. Everything `startup` then does needs the network or the `claude`
 * binary, and reports its own progress as it goes, so a failure there arrives
 * with the context that makes it legible.
 */
export async function preflight(): Promise<Preflight> {
  const workspace = await new Git(process.cwd()).workspaceInfo();
  // The checkout is validated before its config is read, so a repo ramonda
  // cannot work at all says so — rather than answering a wrong-host origin with
  // a complaint about a missing ramonda.json, which points the fix elsewhere.
  assertGithubOrigin(workspace);
  const repoConfig = await readRepoConfig(workspace.workspacePath);
  // The file is what `setup-project` wrote, so the everyday invocation carries
  // no flag for it. Resolved here rather than in the CLI because this is where
  // ramonda.json is read, and reading it twice to answer one question would mean
  // two chances to disagree about the answer.
  const { ghOwner, ghProject } = resolveProjectTarget(repoConfig);

  const baseGit = new Git(workspace.workspacePath);
  await baseGit.assertGitignoreEntries();
  // Alongside the entries check, and for the same reason: both ask whether this
  // checkout is wired so that a task's worktree can be prepared without
  // committing something nobody chose to commit.
  await baseGit.assertCopiedPathsIgnored(repoConfig.worktree.filesToCopy);

  return { workspace, repoConfig, ghOwner, ghProject };
}

/**
 * Everything else that has to be true before a task is claimed, checked in the
 * order that reports each failure as itself: the binary that runs the sessions,
 * then the account, then the project.
 */
async function startup(opts: {
  config: Config;
  model?: string;
  pollPauseSeconds: number;
  preflight: Preflight;
}): Promise<Omit<RunOpts, 'shutdownSignal' | 'recentlyHandled'>> {
  const { config } = opts;
  const { workspace, repoConfig, ghOwner, ghProject } = opts.preflight;

  const runId = generateRunId();
  const mainLogger = createLogger(runLogPath(runId));
  mainLogger.info(
    `ramonda start: runId=${runId} profile=${config.profile} owner=${ghOwner} project=${ghProject} repo=${workspace.repoNameWithOwner} poll-pause=${opts.pollPauseSeconds}s log=${runLogPath(runId)}`,
    TERMINAL
  );

  const claude = new Claude(config.claudeBin);
  const version = await claude.probeVersion();
  mainLogger.info(`claude version: ${version}`);
  mainLogger.info(`claude model: ${opts.model ?? '(claude default)'}`);
  await claude.assertHeadlessSupported();
  mainLogger.info(`claude headless flags supported`);

  const github = new Github({
    ghToken: config.ghToken,
    onRateLimit: (observation) => mainLogger.info(formatRateLimitObservation(observation)),
  });
  await github.primeRateLimitTally();

  // Held for the whole run: it authors every commit ramonda makes, and rides
  // into each session's environment so the commits the model makes itself carry
  // the same author as the one the loop makes on top of them.
  const commitIdentity = await github.fetchCommitIdentity();
  mainLogger.info(`commit identity: ${commitIdentity.name} <${commitIdentity.email}>`);

  // Both checked in `preflight`, before the banner. Logged here, where there is
  // a log to write to: the run log opens on the run ID, and a line written
  // before that would have nowhere to go.
  mainLogger.info('gitignore entries present');
  mainLogger.info(
    `worktree seed: ${repoConfig.worktree.filesToCopy.length} file(s) to copy, ` +
      `${repoConfig.worktree.prepare.length} setup command(s)`
  );

  // Before the label check and everything after it: the rest of startup asks
  // whether this project is set up correctly, and this asks whether ramonda
  // should be pointed at it at all.
  await github.assertPrivateRepo({ repoNameWithOwner: workspace.repoNameWithOwner });
  mainLogger.info(`${workspace.repoNameWithOwner} is private`);

  await github.assertLabelExists({ repoNameWithOwner: workspace.repoNameWithOwner });
  mainLogger.info(`label "${TASK_LABEL}" exists`);

  const { meta, rateLimit } = await github.fetchProjectMeta({ ghOwner, ghProject });

  assertPrioritiesUsable({ meta, mainLogger });

  // Resolved here rather than per claim: it is only ever a marker for the claim
  // refs to point at, so one lookup serves the whole run, and a base branch that
  // does not resolve is worth refusing over before any task is picked up.
  const claimSha = await github.resolveBranchSha({
    repoNameWithOwner: workspace.repoNameWithOwner,
    branch: repoConfig.baseBranch,
  });
  mainLogger.info(`claim refs anchored at ${repoConfig.baseBranch}@${claimSha.slice(0, 7)}`);

  mainLogger.info(
    `project meta loaded: projectId=${meta.projectId} botField=${meta.botFieldId} statusField=${meta.statusFieldId ?? 'n/a'} rate-limit remaining=${rateLimit.remaining ?? '?'}/${rateLimit.limit ?? '?'}`
  );

  return {
    runId,
    ghOwner,
    ghProject,
    meta,
    workspacePath: workspace.workspacePath,
    repoNameWithOwner: workspace.repoNameWithOwner,
    mainLogger,
    repoConfig,
    claudeBin: config.claudeBin,
    model: opts.model,
    ghToken: config.ghToken,
    commitIdentity,
    github,
    claimSha,
  };
}

export async function run(opts: {
  config: Config;
  pollPauseSeconds: number;
  model?: string;
  preflight: Preflight;
}): Promise<void> {
  // --model beats DEFAULT_MODEL; neither set leaves the choice to claude itself.
  const model = opts.model ?? opts.config.model;
  const context = await startup({
    config: opts.config,
    model,
    pollPauseSeconds: opts.pollPauseSeconds,
    preflight: opts.preflight,
  });
  const { mainLogger, github, repoNameWithOwner } = context;

  // One controller carries the stop request everywhere it has to reach: the
  // poll-pause sleep, the checkpoints between claiming a task and starting its
  // session, and the child once there is one. A plain flag could only be read
  // between iterations, which left a Ctrl-C arriving during pickup to be
  // noticed only after a whole session had run to completion.
  const shutdown = new AbortController();
  const runOpts: RunOpts = { ...context, recentlyHandled: new Map(), shutdownSignal: shutdown.signal };
  let fatalExit = false;
  // The reasons of the tasks since the last PR, newest last. Doubles as the
  // counter — its length is the run — and carries the detail the exit message
  // needs, since "stopped after 3" sends you to the logs to find out which 3.
  // Emptied by any task that opens a PR, so this is a run rather than a total
  // over a loop that may stay up for weeks.
  const tasksWithoutPr: string[] = [];

  /** Ends the run once too many tasks in a row have produced nothing. */
  const assertProducingWork = (): void => {
    if (tasksWithoutPr.length < MAX_TASKS_WITHOUT_PR) {
      return;
    }

    throw new Error(
      `${tasksWithoutPr.length} tasks in a row produced no PR — stopping. ` +
        `ramonda is running, but nothing is coming out of it:\n` +
        tasksWithoutPr.map((line) => `  ${line}`).join('\n')
    );
  };
  // Which signal asked for the stop, so the issue comment names it. First one
  // wins: a supervisor that escalates SIGTERM → SIGINT is still one stop.
  let stopSignal: NodeJS.Signals | null = null;
  const onStopSignal = (signal: NodeJS.Signals): void => {
    stopSignal ??= signal;
    shutdown.abort();
  };
  process.on('SIGINT', onStopSignal);
  // SIGTERM is how a supervisor asks a service to stop, which is how ramonda is
  // meant to run. Without it here the signal only ever reached the child:
  // the session died, the task was cancelled, and the loop calmly picked up the
  // *next* one — which then had its claim stranded when the supervisor gave up
  // waiting and sent SIGKILL, since nothing runs on that.
  process.on('SIGTERM', onStopSignal);

  /** Resolves early when a stop arrives, rather than sitting out the whole pause. */
  const pollPause = async (): Promise<void> => {
    try {
      await sleep(opts.pollPauseSeconds * 1000, undefined, {
        signal: shutdown.signal,
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        throw err;
      }
    }
  };

  try {
    while (!shutdown.signal.aborted) {
      let outcome: TaskOutcome;

      try {
        outcome = await runOneTask(runOpts);
      } catch (err) {
        // The task already put back whatever it had claimed on its way out, so
        // the project is consistent and the next pass is free to start. What is
        // left to decide is only whether to keep going: a Github blip or a wedged
        // task is worth another pass, while the same failure over and over is a
        // broken setup that no amount of polling will fix.
        //
        // Some failures say that up front. A setup the next pass would hit in the
        // same place is not worth two more claims and two more poll-pauses to
        // confirm.
        if (err instanceof SetupError) {
          throw err;
        }

        // Counted the same as a cancel, and against the same budget. A thrown
        // pass and a cancelled task differ in whether an error was raised, not in
        // what they left behind: no PR either way. Two counters would let one
        // reset the other, and a run alternating between them would trip neither.
        tasksWithoutPr.push(`pass failed: ${(err as Error).message}`);
        mainLogger.info(
          `task failed [${tasksWithoutPr.length}/${MAX_TASKS_WITHOUT_PR}]: ${(err as Error).message}`,
          TERMINAL
        );
        assertProducingWork();

        mainLogger.info(`retrying after ${opts.pollPauseSeconds}s`, TERMINAL);
        await pollPause();

        continue;
      }

      if (shutdown.signal.aborted) {
        // A stop signal arrived mid-task. If the current task is still marked
        // as running (no completion/cancel yet), cancel it as a signal stop. An
        // `aborted` pickup released its own claim and touched no project state,
        // so there is nothing here for it to undo.
        if (outcome.kind === 'ran') {
          const taskState = await readTaskState(outcome.worktreePath);

          if (taskState && !taskState.completedAt && !taskState.cancelledAt) {
            const signal = stopSignal ?? 'SIGINT';
            const reason = await cancelTask({
              github,
              taskState,
              worktreePath: outcome.worktreePath,
              reason: { kind: 'signal', signal },
              logger: mainLogger,
            });
            mainLogger.info(`task #${taskState.issue} cancelled — ${reason}`, TERMINAL);
          }
        }

        break;
      }

      if (outcome.kind === 'stop') {
        fatalExit = true;
        break;
      }

      // Outside the try above, deliberately: the throw this can raise is the
      // loop's exit, not a failed pass, and raising it in there would land it in
      // that catch — counted a second time and folded into its own message.
      // Past the stop checks too, so a run being shut down does not trip it.
      if (outcome.kind === 'ran') {
        if (outcome.verdict.kind === 'pr') {
          tasksWithoutPr.length = 0;
        } else {
          tasksWithoutPr.push(`#${outcome.issueNumber} produced no PR: ${outcome.verdict.reason}`);
          mainLogger.info(
            `no PR from #${outcome.issueNumber} [${tasksWithoutPr.length}/${MAX_TASKS_WITHOUT_PR}]`,
            TERMINAL
          );
          assertProducingWork();
        }
      }

      // `aborted` only happens under a stop request, which the loop condition
      // has already seen — it re-polls for exactly as long as it takes to exit.
      if (outcome.kind === 'ran' || outcome.kind === 'aborted') {
        continue;
      }

      if (outcome.kind === 'idle-all-claimed') {
        mainLogger.info(
          `candidate claimed elsewhere in ${repoNameWithOwner} — sleeping ${opts.pollPauseSeconds}s before re-poll`,
          TERMINAL
        );
      } else if (outcome.kind === 'idle-cooling') {
        mainLogger.info(
          `only just-handled tasks in ${repoNameWithOwner} — the project is still catching up; ` +
            `sleeping ${opts.pollPauseSeconds}s before re-poll`,
          TERMINAL
        );
      } else {
        mainLogger.info(`no eligible tasks in ${repoNameWithOwner} — sleeping ${opts.pollPauseSeconds}s`, TERMINAL);
      }

      await pollPause();
    }
  } finally {
    process.off('SIGINT', onStopSignal);
    process.off('SIGTERM', onStopSignal);
    mainLogger.info(`ramonda stopped`, TERMINAL);
  }

  if (fatalExit) {
    throw new Error('fatal session error — see logs above');
  }
}
