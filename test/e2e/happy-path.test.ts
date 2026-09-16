// End-to-end happy-path test for ramonda.
//
// Creates a throwaway Github repo on the fly, seeds it from the
// `test/test-repo/` fixture, builds its project by running the real
// `ramonda setup-project`, then runs the real `ramonda` CLI against the real
// `claude` binary. Ends when both PRs are opened and both issues' project
// status flips to the configured in-review value. Cleans up (deletes repo +
// project) only on success.
//
// Two tasks rather than one, worked back to back by a single run: a second
// `Todo` item is the only thing that covers the loop coming back for the next
// one — off a base branch it has already synced, with the previous task's PR
// still open — which one task can say nothing about.
//
// Completion is detected from ramonda's own stdout, not by polling the project —
// see `waitForNextCompletion`. Github is read only to assert the outcome.
//
// Prerequisites:
//   - `npm run build` has been run (test spawns dist/entrypoints/cli.js).
//   - `claude auth login` has been completed.
//   - Env: RAMONDA_E2E_GH_TOKEN (PAT with repo + project + delete_repo),
//          RAMONDA_E2E_GH_USER (login owning the throwaway repo),
//          RAMONDA_E2E_CLAUDE_BIN (optional override for the claude binary path),
//          RAMONDA_E2E_MODEL (optional override for the session model).
//
// Without RAMONDA_E2E_GH_TOKEN the suite is skipped.
//
// Costs real Anthropic tokens per run. Failed runs leak the throwaway repo
// and project for manual inspection.

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retry } from '@octokit/plugin-retry';
import { Octokit } from '@octokit/rest';
import { execa, type ResultPromise } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { BOT_FIELD, PRIORITY_FIELD, STATUS_FIELD, TASK_LABEL } from '../../src/constants/github.js';
import { Github } from '../../src/wrappers/github.js';
import { slugify } from '../../src/utils/slugify.js';
import type { ProjectField, ProjectShape } from '../../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'entrypoints', 'cli.js');
const FIXTURE_DIR = join(REPO_ROOT, 'test', 'test-repo');

// The `Status` options `setup-project` puts on the project — fixed in ramonda's
// own constants, like the fields and the label imported above.
//
// Spelled out here rather than imported, so a rename that lands in
// `constants/github.ts` but not on the board is still caught: a suite that
// derived these from the same file could never disagree with it.
const STATUS_TODO = 'Todo';
const STATUS_IN_PROGRESS = 'In progress';
const STATUS_IN_REVIEW = 'Ready for review';

// The one `Priority` level the suite parks an item on, spelled out for the same
// reason. The other task is deliberately left with none — see `TASKS`.
const PRIORITY_CRITICAL = 'Critical';

type E2eTaskDef = {
  /** A summary, like a real issue's — what to do is the body's job. */
  title: string;
  body: string;
  /**
   * The `Priority` level to park the item on, or omitted to leave the item
   * untriaged. Not decoration: the poll runs one query per level, filtered on
   * `priority:"<level>"`, and then one last `no:priority` query for the items
   * that carry none — so this is what decides which of the two finds the issue.
   */
  priority?: string;
  /** Patterns `index.js` on this task's PR branch must carry. */
  expected: RegExp[];
  /** Patterns it must no longer carry. */
  absent: RegExp[];
};

// Neither issue pins the shape of what it asks for, and neither set of patterns
// does either: both say the endpoint "returns" a string, so `res.json({ message })`
// and `res.send(...)` are equally correct readings — a real run has produced each.
// Quote style is open for the same reason: the file is written in single quotes
// and the issue text asks for double. What is checked is the route, the new
// string, and the absence of the old one; pinning the rest would fail a paid run
// over house style rather than over the change the task asked for.
//
// This used to be the fixture verify command's job, and a `grep` for one shape
// could afford to be strict because it sent the model back to try again. With
// verify no longer checking content, the first reading the model commits to is
// the one that opens the PR.
const TASKS: E2eTaskDef[] = [
  {
    title: 'Fix /hello endpoint',
    body: `Update 'GET /hello' endpoint to return "Hello, world!"`,
    priority: PRIORITY_CRITICAL,
    expected: [/app\.get\(\s*['"]\/hello['"]/, /Hello, world!/],
    // The old message, quoted — `'Hello, world!'` does not contain it.
    absent: [/['"]Hello!['"]/],
  },
  {
    title: 'Add /goodbye endpoint',
    body: `Add 'GET /goodbye' endpoint which returns "Goodbye, world!"`,
    // Left untriaged on purpose, so the second pickup exercises the fallback: all
    // four level queries come back empty and the `no:priority` one finds it. That
    // costs no extra session — the suite would have run this task either way —
    // and it is the path a real board hits the moment somebody files an issue
    // without setting a level.
    // `/hello` is checked only for still being there — a guard that the app was
    // added to rather than rewritten. Its *message* is not: this branch is cut
    // from main, so it still carries the old one, and a model that helpfully
    // fixes that too is not worth ending a paid run over.
    expected: [/app\.get\(\s*['"]\/goodbye['"]/, /Goodbye, world!/, /app\.get\(\s*['"]\/hello['"]/],
    absent: [],
  },
];

// Pinned so a run's cost and behaviour don't drift with whatever the local
// `claude` binary defaults to. Both fixture tasks are a handful of lines, well
// within Sonnet's reach.
const MODEL = process.env.RAMONDA_E2E_MODEL ?? 'claude-sonnet-5';

type E2eTask = E2eTaskDef & {
  issueNumber: number;
  issueNodeId: string;
  itemId: string;
  slug: string;
  branch: string;
};

type E2eCtx = {
  user: string;
  octokit: Octokit;
  repoName: string;
  workDir: string;
  /** Temp $XDG_CONFIG_HOME, so the run reads a credentials file instead of the real one. */
  configHome: string;
  projectId: string;
  projectNumber: number;
  botFieldId: string;
  statusFieldId: string;
  todoOptionId: string;
  /**
   * In `TASKS` order, which is also the order the run picks them up in: a level
   * beats no level. Nothing below depends on that — the harness matches
   * whichever task lands first, so a re-levelling costs no assertions.
   */
  tasks: E2eTask[];
};

/**
 * Node passes `NODE_OPTIONS` to every descendant, so running this suite from a
 * debug terminal attaches an inspector to `node dist/entrypoints/cli.js` and
 * then to the `claude` it spawns — where the port conflict makes `claude --help`
 * exit 1 with no output, and the startup check reports a current binary as too
 * old. The debugger also stops the child from ever exiting ("Waiting for the
 * debugger to disconnect..."), which is what turns that failure into a
 * nine-minute hang.
 *
 * ramonda scrubs this for the `claude` processes it spawns itself; the suite
 * scrubs it here so the run under test is never the debugged process either.
 */
function withoutDebugger(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_OPTIONS: undefined,
    VSCODE_INSPECTOR_OPTIONS: undefined,
    NODE_INSPECTOR_IPC: undefined,
  };
}

/** A literal for use inside a `RegExp` — PR URLs carry `/` and `.`. */
function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One timestamp for both, so a leftover project can be traced back to its repo. */
function makeTestNames(): { repoName: string; projectTitle: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(2).toString('hex');

  return {
    repoName: `ramonda-e2e-${ts}-${rand}`,
    projectTitle: `Ramonda e2e test - ${ts}`,
  };
}

async function graphql<T>(octokit: Octokit, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await octokit.request('POST /graphql', { query, variables });
  const body = res.data as { data?: T; errors?: Array<{ message: string }> };

  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  if (!body.data) {
    throw new Error('GraphQL: empty response');
  }

  return body.data;
}

type SingleSelectField = Extract<ProjectField, { kind: 'singleSelect' }>;

function requireTextField(shape: ProjectShape, name: string): ProjectField {
  const field = shape.fields.find((f) => f.name === name);

  if (field?.kind !== 'text') {
    throw new Error(`setup-project left no text field "${name}" on the project`);
  }

  return field;
}

function requireSelectField(shape: ProjectShape, name: string): SingleSelectField {
  const field = shape.fields.find((f) => f.name === name);

  if (field?.kind !== 'singleSelect') {
    throw new Error(`setup-project left no single-select field "${name}" on the project`);
  }

  return field;
}

function requireOption(field: SingleSelectField, name: string): string {
  const option = field.options.find((o) => o.name === name);

  if (!option) {
    throw new Error(`Project field "${field.name}" has no "${name}" option`);
  }

  return option.id;
}

/**
 * The project is built by the real `setup-project` command rather than by
 * hand-rolled mutations, so the run below is pointed at the project users
 * actually get — and the command itself is covered on the way through.
 *
 * Pointed at the throwaway $XDG_CONFIG_HOME for the same reason `run` is, and
 * with GH_TOKEN withheld: sourcing the token from the test's own credentials
 * file is what keeps the result independent of whatever profiles the developer
 * happens to have in ~/.config/ramonda.
 */
async function runSetupProject(opts: {
  user: string;
  configHome: string;
  workDir: string;
  projectTitle: string;
}): Promise<number> {
  const res = await execa(
    'node',
    [CLI_PATH, 'setup-project', `--gh-owner=${opts.user}`, `--title=${opts.projectTitle}`, '--yes'],
    {
      cwd: opts.workDir,
      env: withoutDebugger({ ...process.env, GH_TOKEN: undefined, XDG_CONFIG_HOME: opts.configHome }),
    }
  );

  process.stdout.write(`${res.stdout}\n`);

  const match = /created project #(\d+)/.exec(res.stdout);

  if (!match) {
    throw new Error(`setup-project printed no project number:\n${res.stdout}`);
  }

  return Number.parseInt(match[1], 10);
}

async function setup(): Promise<E2eCtx> {
  const token = process.env.RAMONDA_E2E_GH_TOKEN as string;
  const user = process.env.RAMONDA_E2E_GH_USER;

  if (!user) {
    throw new Error('RAMONDA_E2E_GH_USER must be set');
  }

  const RetryingOctokit = Octokit.plugin(retry);
  const octokit = new RetryingOctokit({ auth: token });

  const { repoName, projectTitle } = makeTestNames();
  await octokit.rest.repos.createForAuthenticatedUser({
    name: repoName,
    auto_init: false,
    // `run` refuses a public repo outright, so the fixture has to match what
    // ramonda is actually supported on rather than what is convenient to create.
    private: true,
  });

  const workDir = await mkdtemp(join(tmpdir(), 'ramonda-e2e-work-'));

  // The credentials file is the setup `ramonda setup-profile` writes and the one
  // the docs describe, so the run under test resolves its token the way a real
  // one does. Point XDG_CONFIG_HOME at a throwaway config directory rather than
  // writing the e2e token into the developer's real ~/.config.
  const configHome = await mkdtemp(join(tmpdir(), 'ramonda-e2e-config-'));
  await mkdir(join(configHome, 'ramonda'), { recursive: true, mode: 0o700 });
  // Written as a named profile, which is the shape `ramonda setup-profile`
  // produces — and the shape the run below selects with --profile.
  await writeFile(join(configHome, 'ramonda', 'credentials'), `[default ${user}]\nGH_TOKEN=${token}\n`, {
    mode: 0o600,
  });

  await cp(FIXTURE_DIR, workDir, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: workDir });
  await execa('git', ['config', 'user.email', 'ramonda.e2e@example.com'], {
    cwd: workDir,
  });
  await execa('git', ['config', 'user.name', 'ramonda e2e'], { cwd: workDir });
  await execa('git', ['add', '-A'], { cwd: workDir });
  await execa('git', ['commit', '-m', 'seed'], { cwd: workDir });
  await execa('git', ['remote', 'add', 'origin', `https://github.com/${user}/${repoName}.git`], { cwd: workDir });
  await execa('git', ['config', `url.https://x-access-token:${token}@github.com/.insteadOf`, 'https://github.com/'], {
    cwd: workDir,
  });
  await execa('git', ['push', '-u', 'origin', 'main'], { cwd: workDir });

  const projectNumber = await runSetupProject({ user, configHome, workDir, projectTitle });
  // The harness drives Github through its own retry-plugged Octokit; this reads
  // the project the way ramonda itself does, so the ids below come from one source.
  const shape = await new Github({ ghToken: token }).fetchProjectShape({
    ghOwner: user,
    ghProject: projectNumber,
  });
  const projectId = shape.projectId;
  const botFieldId = requireTextField(shape, BOT_FIELD).id;
  const statusField = requireSelectField(shape, STATUS_FIELD);
  const statusFieldId = statusField.id;
  const todoOptionId = requireOption(statusField, STATUS_TODO);
  requireOption(statusField, STATUS_IN_REVIEW);
  // Asserted here as well as read: a project missing this field is one whose
  // every item is invisible to the poll, and the run would idle rather than fail.
  const priorityField = requireSelectField(shape, PRIORITY_FIELD);

  // Seeded one at a time rather than in parallel, so the issue numbers follow
  // `TASKS` order and a log line can be read back against the task it came from.
  const tasks: E2eTask[] = [];

  for (const def of TASKS) {
    tasks.push(
      await seedTask({
        def,
        octokit,
        user,
        repoName,
        projectId,
        statusFieldId,
        todoOptionId,
        priorityFieldId: priorityField.id,
        priorityOptionId: def.priority === undefined ? undefined : requireOption(priorityField, def.priority),
      })
    );
  }

  return {
    user,
    octokit,
    repoName,
    workDir,
    configHome,
    projectId,
    projectNumber,
    botFieldId,
    statusFieldId,
    todoOptionId,
    tasks,
  };
}

/**
 * One labelled issue, on the project, in `Todo` and on a priority level — the
 * state the run polls for. `Status` always; `Priority` only where the task names
 * a level, since an item left without one is what the poll's last query is for.
 */
async function seedTask(args: {
  def: E2eTaskDef;
  octokit: Octokit;
  user: string;
  repoName: string;
  projectId: string;
  statusFieldId: string;
  todoOptionId: string;
  priorityFieldId: string;
  /** Undefined leaves the item with no level, for the `no:priority` pass to find. */
  priorityOptionId?: string;
}): Promise<E2eTask> {
  const { def, octokit, user, repoName, projectId, statusFieldId, todoOptionId } = args;

  const issueRes = await octokit.rest.issues.create({
    owner: user,
    repo: repoName,
    title: def.title,
    body: def.body,
    labels: [TASK_LABEL],
  });
  const issueNumber = issueRes.data.number;
  const issueNodeId = issueRes.data.node_id;

  const addedItem = await graphql<{
    addProjectV2ItemById: { item: { id: string } };
  }>(
    octokit,
    `
      mutation ($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }
    `,
    { projectId, contentId: issueNodeId }
  );
  const itemId = addedItem.addProjectV2ItemById.item.id;

  const setSelect = async (fieldId: string, optionId: string): Promise<void> => {
    await graphql(
      octokit,
      `
        mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(
            input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $optionId }
            }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `,
      { projectId, itemId, fieldId, optionId }
    );
  };

  await setSelect(statusFieldId, todoOptionId);

  if (args.priorityOptionId !== undefined) {
    await setSelect(args.priorityFieldId, args.priorityOptionId);
  }

  const slug = slugify(def.title);

  return {
    ...def,
    issueNumber,
    issueNodeId,
    itemId,
    slug,
    branch: `${issueNumber}-${slug}`,
  };
}

/**
 * What `cli.ts` prints to stderr before exiting non-zero. Watched because the
 * exit itself is not dependable: a child that cannot complete `process.exit`
 * never fires 'exit', and waiting on that alone costs the whole timeout. The
 * one `ramonda:` line on stderr that is *not* fatal is excluded by name.
 */
const FATAL_STDERR = /^ramonda: (?!log write failed)/;

type RamondaRun = {
  child: ResultPromise;
  /**
   * Resolves with the first stdout line matching `re`, including lines that
   * arrived before the call. Rejects if the child exits, or reports a fatal
   * error, first — so a run that dies on startup fails here with the reason
   * ramonda gave instead of sitting out the whole timeout.
   */
  waitForLine: (re: RegExp, timeoutMs: number) => Promise<string>;
  /**
   * Whether any stdout line so far matched `re`. For steps that leave nothing
   * behind to read back afterwards — the log is the only record they happened.
   */
  sawLine: (re: RegExp) => boolean;
};

function spawnRamonda(ctx: E2eCtx): RamondaRun {
  const child = execa(
    'node',
    [
      CLI_PATH,
      'run',
      // Which project to poll is not passed, because `run` takes no flag for it:
      // `setup-project` recorded it in ramonda.json, and reading it back from
      // there is the only path there is.
      //
      // The profile is named explicitly, so profile selection is exercised
      // rather than left to the [default] marker.
      `--profile=${ctx.user}`,
      '--poll-pause=60',
      `--model=${MODEL}`,
    ],
    {
      cwd: ctx.workDir,
      env: withoutDebugger({
        ...process.env,
        // Unset, so the run has to resolve the token out of the credentials file
        // under XDG_CONFIG_HOME rather than inheriting the developer's own.
        GH_TOKEN: undefined,
        XDG_CONFIG_HOME: ctx.configHome,
        CLAUDE_BIN: process.env.RAMONDA_E2E_CLAUDE_BIN ?? 'claude',
        // Mirrors the main log to stdout, which is what the test watches to
        // learn how the task landed.
        RAMONDA_LOG_STDOUT: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    }
  );

  type Waiter = {
    onLine: (line: string) => void;
    onFail: (err: Error) => void;
  };

  const seen: string[] = [];
  const waiters = new Set<Waiter>();
  let partial = '';
  let errPartial = '';
  let fatal: string | null = null;

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);

    // Chunks split wherever the pipe felt like it, so lines are reassembled
    // before matching — a regex against a raw chunk can miss a straddled line.
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop() ?? '';

    for (const line of lines) {
      seen.push(line);

      for (const waiter of waiters) {
        waiter.onLine(line);
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);

    const lines = (errPartial + chunk.toString()).split('\n');
    errPartial = lines.pop() ?? '';

    for (const line of lines) {
      if (fatal || !FATAL_STDERR.test(line)) {
        continue;
      }

      fatal = line.trim();

      for (const waiter of waiters) {
        waiter.onFail(new Error(`ramonda failed: ${fatal}`));
      }
    }
  });

  const waitForLine = (re: RegExp, timeoutMs: number): Promise<string> => {
    const already = seen.find((line) => re.test(line));

    if (already) {
      return Promise.resolve(already);
    }

    if (fatal) {
      return Promise.reject(new Error(`ramonda failed: ${fatal}`));
    }

    return new Promise<string>((resolve, reject) => {
      let cleanup = (): void => {};

      const waiter: Waiter = {
        onLine: (line) => {
          if (re.test(line)) {
            cleanup();
            resolve(line);
          }
        },
        onFail: (err) => {
          cleanup();
          reject(err);
        },
      };
      const onExit = (): void => {
        cleanup();
        reject(new Error(`ramonda exited before logging ${re}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ramonda to log ${re}`));
      }, timeoutMs);

      cleanup = (): void => {
        clearTimeout(timer);
        waiters.delete(waiter);
        child.off('exit', onExit);
      };

      waiters.add(waiter);
      child.once('exit', onExit);
    });
  };

  const sawLine = (re: RegExp): boolean => seen.some((line) => re.test(line));

  return { child, waitForLine, sawLine };
}

/** Either is null when the field carries no value — cleared, or never set. */
type ItemFields = { status: string | null; bot: string | null };

async function readItemFields(ctx: E2eCtx, task: E2eTask): Promise<ItemFields> {
  const data = await graphql<{
    node: {
      fieldValues: {
        nodes: Array<{
          name?: string;
          text?: string;
          field?: { id: string };
        }>;
      };
    };
  }>(
    ctx.octokit,
    `
      query ($itemId: ID!) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            fieldValues(first: 30) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    ... on ProjectV2FieldCommon {
                      id
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { itemId: task.itemId }
  );
  const nodes = data.node.fieldValues.nodes;
  const status = nodes.find((n) => n.field?.id === ctx.statusFieldId);
  const bot = nodes.find((n) => n.field?.id === ctx.botFieldId);

  // A cleared text field drops out of `fieldValues` altogether, so an absent
  // node and an empty one both mean the claim was released.
  return { status: status?.name ?? null, bot: bot?.text || null };
}

/**
 * Both writes land before ramonda logs completion, so the first read normally
 * settles it. The retry is for a read that trails its own write by a beat —
 * cheap here, where a false failure costs a whole paid run. Whatever the last
 * read saw is returned either way, so the caller's assertion is what reports it.
 */
async function readItemFieldsSettled(ctx: E2eCtx, task: E2eTask): Promise<ItemFields> {
  let fields = await readItemFields(ctx, task);

  for (let attempt = 0; attempt < 5; attempt++) {
    if (fields.status === STATUS_IN_REVIEW && fields.bot === null) {
      return fields;
    }

    await new Promise((r) => setTimeout(r, 3000));
    fields = await readItemFields(ctx, task);
  }

  return fields;
}

async function findPr(
  ctx: E2eCtx,
  task: E2eTask
): Promise<{
  base: { ref: string };
  head: { ref: string };
  body: string | null;
  html_url: string;
} | null> {
  const list = await ctx.octokit.rest.pulls.list({
    owner: ctx.user,
    repo: ctx.repoName,
    state: 'open',
    head: `${ctx.user}:${task.branch}`,
  });

  return list.data[0] ?? null;
}

/**
 * The project is not polled to find out when the run landed: ramonda's own loop
 * already knows, and says so on the main log it mirrors to stdout. Watching for
 * that line keeps the entire wait off Github's rate-limit budget, which a
 * 5s-interval project poll would otherwise burn ~100 GraphQL points on per run —
 * points the run under test is itself competing for. The project is still read
 * below, once, to check the outcome rather than to detect it.
 *
 * Both terminal outcomes are matched, so a cancelled task fails fast with the
 * reason ramonda gave instead of hanging until the timeout.
 *
 * Whichever of `pending` lands first is the one returned. A level beats no level,
 * so that is `TASKS` order — but nothing here leans on it: a task re-levelled or
 * a project-items query that answers in its own order would otherwise break the
 * wait rather than the assertion. Only the pending issue
 * numbers go into the pattern, so a verdict already handled cannot match again
 * when `waitForLine` replays the lines it has seen.
 */
async function waitForNextCompletion(run: RamondaRun, pending: E2eTask[], timeoutMs: number): Promise<E2eTask> {
  // Anchored: session output reaches the same stdout, but only ever prefixed
  // ("claude: ..."), so nothing the model writes can pass for a loop verdict.
  const numbers = pending.map((task) => task.issueNumber).join('|');
  const line = await run.waitForLine(new RegExp(`^task #(${numbers}) (complete|cancelled)\\b`), timeoutMs);
  const [, matched, verdict] = /^task #(\d+) (complete|cancelled)\b/.exec(line) as RegExpExecArray;

  if (verdict !== 'complete') {
    throw new Error(`ramonda did not finish the task: ${line}`);
  }

  return pending.find((task) => task.issueNumber === Number.parseInt(matched, 10)) as E2eTask;
}

/**
 * The PR exists before ramonda logs completion, but `pulls.list` is filtered
 * server-side and can trail the create by a beat. A handful of retries costs
 * far less than a false failure — and in the happy case it is one call.
 */
async function findPrSettled(ctx: E2eCtx, task: E2eTask): Promise<NonNullable<Awaited<ReturnType<typeof findPr>>>> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const pr = await findPr(ctx, task);

    if (pr) {
      return pr;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(`ramonda logged completion but no open PR for ${task.branch} is visible`);
}

async function getFileOnBranch(ctx: E2eCtx, path: string, ref: string): Promise<string> {
  const res = await ctx.octokit.rest.repos.getContent({
    owner: ctx.user,
    repo: ctx.repoName,
    path,
    ref,
  });

  if (Array.isArray(res.data) || res.data.type !== 'file') {
    throw new Error(`${path} is not a file on ${ref}`);
  }

  return Buffer.from(res.data.content, 'base64').toString('utf8');
}

/** Long enough for ramonda's own SIGINT shutdown, which is a project write or two. */
const SHUTDOWN_GRACE_MS = 20_000;

/**
 * Ctrl-C is the documented way out, so that is what the run is given. It is not
 * trusted to land, though: a child holding the suite open past the grace period
 * — a wedged network call, an attached debugger — gets SIGKILL rather than a
 * hang with no output.
 */
async function shutDown(run: RamondaRun): Promise<void> {
  run.child.kill('SIGINT');

  const exited = await Promise.race([
    once(run.child, 'exit').then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS).unref();
    }),
  ]).catch(() => true);

  if (exited) {
    return;
  }

  process.stderr.write(`[test] ramonda did not exit ${SHUTDOWN_GRACE_MS}ms after SIGINT — killing\n`);
  run.child.kill('SIGKILL');
  await once(run.child, 'exit').catch(() => {});
}

async function cleanup(ctx: E2eCtx): Promise<void> {
  try {
    await graphql(
      ctx.octokit,
      `
        mutation ($projectId: ID!) {
          deleteProjectV2(input: { projectId: $projectId }) {
            projectV2 {
              id
            }
          }
        }
      `,
      { projectId: ctx.projectId }
    );
  } catch (err) {
    console.warn(`cleanup: deleteProjectV2 failed: ${(err as Error).message}`);
  }

  try {
    await ctx.octokit.rest.repos.delete({
      owner: ctx.user,
      repo: ctx.repoName,
    });
  } catch (err) {
    console.warn(`cleanup: repos.delete failed: ${(err as Error).message}`);
  }

  await rm(ctx.workDir, { recursive: true, force: true });
  await rm(ctx.configHome, { recursive: true, force: true });
}

/** One task's whole outcome, read back off Github and the task state on disk. */
async function assertTaskLanded(run: RamondaRun, ctx: E2eCtx, task: E2eTask): Promise<void> {
  // The in-progress status is set at pickup and overwritten long before these
  // assertions run, so the log line the loop writes only on a successful move is
  // the only evidence of it left to check.
  expect(run.sawLine(new RegExp(`^#${task.issueNumber} project status → ${STATUS_IN_PROGRESS}$`))).toBe(true);

  const taskStatePath = join(ctx.workDir, '.worktrees', task.branch, '.claude', 'ramonda-task.json');
  const taskState = JSON.parse(await readFile(taskStatePath, 'utf8'));
  expect(taskState.completedAt).toEqual(expect.any(String));

  const pr = await findPrSettled(ctx, task);
  expect(pr.base.ref).toBe('main');
  expect(pr.head.ref).toBe(task.branch);
  expect(pr.body ?? '').toContain(`Closes #${task.issueNumber}`);
  // The URL the loop announced has to be the PR that actually exists. It is
  // reported straight off the `createPullRequest` result now, so a mismatch here
  // means the loop is telling the operator about a PR nobody opened.
  expect(
    run.sawLine(new RegExp(`^task #${task.issueNumber} complete — PR (opened|updated) ${escapeRe(pr.html_url)} `))
  ).toBe(true);

  // Read straight from the project rather than from anything ramonda recorded:
  // the point of the assertion is that the move actually stuck.
  const fields = await readItemFieldsSettled(ctx, task);
  expect(fields.status).toBe(STATUS_IN_REVIEW);
  // A claim nobody clears leaves the issue invisible to this bot and every
  // other one, forever — so releasing it matters as much as opening the PR.
  expect(fields.bot).toBeNull();

  const fileOnBranch = await getFileOnBranch(ctx, 'index.js', pr.head.ref);

  for (const pattern of task.expected) {
    expect(fileOnBranch).toMatch(pattern);
  }

  for (const pattern of task.absent) {
    expect(fileOnBranch).not.toMatch(pattern);
  }
}

/** What one task is allowed; the run's whole budget is this times the task count. */
const TASK_TIMEOUT_MS = 9 * 60_000;

describe.skipIf(!process.env.RAMONDA_E2E_GH_TOKEN)('happy path', () => {
  let ctx: E2eCtx;

  beforeAll(async () => {
    ctx = await setup();
  });

  it('polls → claims → session → PR → in-review status, for every task in turn', async () => {
    const run = spawnRamonda(ctx);
    let succeeded = false;

    try {
      // One whole-run budget, shared: the loop works the tasks one at a time, so
      // a clock that restarted per task would be a different allowance depending
      // on an order the suite does not control.
      const deadline = Date.now() + TASK_TIMEOUT_MS * ctx.tasks.length;
      const pending = new Set(ctx.tasks);

      // Each task is checked the moment its own verdict lands, rather than after
      // every task has finished. Github's built-in "Pull request linked to issue"
      // workflow sets the item back to In Progress asynchronously, and the loop's
      // publish step can only outrun it for as long as its confirm loop runs (spec
      // step 17a.6) — so a project read held back until the last task completes is
      // asking whether the workflow has caught up yet, not whether ramonda's write
      // landed.
      while (pending.size > 0) {
        const task = await waitForNextCompletion(run, [...pending], deadline - Date.now());
        pending.delete(task);

        await assertTaskLanded(run, ctx, task);
      }

      succeeded = true;
    } finally {
      await shutDown(run);

      if (succeeded) {
        await cleanup(ctx);
      }
    }
  });
});
