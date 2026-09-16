import { confirm, input } from '@inquirer/prompts';
import type { Command } from 'commander';
import { readRepoConfig, REPO_CONFIG_FILE, writeProjectIdentity } from '../config/repo.js';
import { loadConfig } from '../config/user.js';
import {
  BOT_FIELD,
  PRIORITY_FIELD,
  PRIORITY_VALUES,
  STATUS_FIELD,
  STATUS_VALUES,
  type StatusRole,
  TASK_LABEL,
} from '../constants/github.js';
import type { Config, NewOption, ProjectField, ProjectShape, SelectOption, WantedOption } from '../types.js';
import { assertInteractive } from '../utils/assert-interactive.js';
import { positiveInteger, trimmedFlag } from '../utils/cli.js';
import { nextStep, out, success, warning } from '../utils/out.js';
import { assertGithubOrigin, Git } from '../wrappers/git.js';
import { Github } from '../wrappers/github.js';

const USAGE =
  'usage: ramonda setup-project [--gh-owner=<owner>] ' +
  '[--title=<title>] [--gh-project=<number>] [--profile=<profile>] [--yes]';

export function addSetupProjectCommand(program: Command): void {
  program
    .command('setup-project')
    .description('Create or converge a Github project (and the "ramonda" label) to match ramonda.json')
    .option('--gh-owner <owner>', `Github user or organization owning the project (default: ${REPO_CONFIG_FILE}'s)`)
    .option(
      '--gh-project <number>',
      `existing project number to converge (default: ${REPO_CONFIG_FILE}'s; none there creates one)`
    )
    .option('--profile <profile>', 'credentials profile to use (default: the one marked [default])')
    .option('--title <title>', 'title for the project (asked when creating one, rejected when converging)')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (opts) => {
      const profile = trimmedFlag(opts.profile);
      const config = loadConfig({ profile });
      const ghProject =
        opts.ghProject === undefined
          ? undefined
          : positiveInteger(opts.ghProject, { flag: '--gh-project', usage: USAGE });
      const title = trimmedFlag(opts.title);

      await setupProject({
        config,
        ghOwner: trimmedFlag(opts.ghOwner),
        ghProject,
        title,
        yes: Boolean(opts.yes),
      });
    });
}

/**
 * A flag this command will ask for rather than refuse over — but only where
 * there is somebody to ask.
 *
 * Without a terminal the fix is the flag, so the flag is what the message
 * names. `assertInteractive`'s "needs a terminal" is the right answer for a
 * command that is a questionnaire end to end; this one is a questionnaire only
 * where an argument is missing, and saying so sends a script to its own command
 * line rather than to a TTY it is never going to have.
 */
function assertAskable(flag: string): void {
  if (!process.stdin.isTTY) {
    throw new Error(`${flag} is required when there is no terminal to ask on.\n\n${USAGE}`);
  }
}

/**
 * Who owns the *project*, which is not always who owns the repo — a personal
 * board driving a work repo, an org board driving a fork. So the repo's owner is
 * offered as the default rather than assumed to be the answer.
 */
async function askOwner(repoOwner: string): Promise<string> {
  assertAskable('--gh-owner');
  out(`The project can live under a different account than the repo — the repo's owner is the default.`);

  const answer = await input({
    message: 'Github user or organization to own the project',
    default: repoOwner,
    validate: (value) => {
      const owner = value.trim();

      if (owner === '') {
        return 'An owner is required.';
      }

      // A pasted "owner/repo" is the likely slip, and it fails later as an owner
      // Github cannot find — which reads as a typo rather than as one field too many.
      return /^[A-Za-z0-9-]+$/.test(owner) || 'A Github login only — no slashes, spaces or URLs.';
    },
  });

  return answer.trim();
}

/** Only ever asked on the create path: an existing project keeps its own title. */
async function askTitle(repoName: string): Promise<string> {
  assertAskable('--title');

  const answer = await input({
    message: 'Title for the new project',
    default: repoName,
    validate: (value) => value.trim() !== '' || 'A title is required.',
  });

  return answer.trim();
}

/**
 * Colors are cosmetic on Github's side, but a project where the cancelled status
 * is red and the in-review one purple reads at a glance, so pick deliberately.
 * Keyed by role, so a column and its color are matched by what it is for rather
 * than by a name repeated in two places.
 *
 * Ten columns share Github's eight colors, so two repeat — `tested` and
 * `delivered`, each far enough along the board from the column it shares a
 * color with that no two neighbours look alike.
 */
const STATUS_COLORS: Record<StatusRole, string> = {
  backlog: 'GRAY',
  cancelled: 'RED',
  todo: 'BLUE',
  inProgress: 'YELLOW',
  readyForReview: 'PURPLE',
  readyForTest: 'ORANGE',
  testing: 'PINK',
  tested: 'BLUE',
  delivered: 'PURPLE',
  done: 'GREEN',
};

/** Highest-priority-first, so the default Critical→Low list runs red→green. */
const PRIORITY_PALETTE = ['RED', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE', 'PINK', 'GRAY'];

function priorityColor(index: number): string {
  return PRIORITY_PALETTE[index % PRIORITY_PALETTE.length];
}

/**
 * The built-in project workflows that move items on their own, each with what it
 * does for the plan line to say.
 *
 * `Pull request linked to issue` undoes ramonda's own work. It sets an item to
 * `In progress` when a pull request is linked to its issue — which every task
 * does, since the PR body closes the issue. So it fires moments after `run` moves
 * the item to `Ready for review`, asynchronously, and drags a finished task back
 * to the column it was in an hour ago. `run` re-reads and re-applies its own
 * write for a few seconds, which loses to a workflow slower than that window, and
 * no amount of waiting wins a race against a system reacting to ramonda's own
 * pull request. Removing the other writer is the only thing that settles it.
 *
 * The other three tie the board to the issue's open/closed state, which the
 * board's second half does not follow: a merged pull request closes its issue
 * while the work still has testing and delivery ahead of it. `Pull request
 * merged` and `Item closed` would move the item past those columns to `Done`,
 * and `Auto-close issue` is the same coupling run the other way. With all four
 * gone, an item's column is only ever set by `run` or by a person.
 *
 * Matched by name because that is all Github gives: `ProjectV2Workflow` carries
 * no kind, trigger or target. A board whose workflow is named differently keeps
 * it, and `run` falls back to the confirm-and-retry loop for its own write.
 */
const CONFLICTING_WORKFLOWS = [
  {
    name: 'Pull request linked to issue',
    effect: `it moves items back to "${STATUS_VALUES.inProgress}" when a PR is linked`,
  },
  { name: 'Auto-close issue', effect: `it closes an item's issue when the item moves to "${STATUS_VALUES.done}"` },
  { name: 'Item closed', effect: `it moves items to "${STATUS_VALUES.done}" when their issue is closed` },
  { name: 'Pull request merged', effect: `it moves items to "${STATUS_VALUES.done}" when their PR is merged` },
];

type Action =
  | { kind: 'createLabel' }
  | { kind: 'deleteWorkflow'; workflowId: string; name: string; effect: string }
  | { kind: 'createTextField'; name: string }
  | { kind: 'createSelectField'; name: string; options: NewOption[] }
  | {
      kind: 'addSelectOptions';
      name: string;
      fieldId: string;
      existing: SelectOption[];
      added: NewOption[];
    }
  | {
      kind: 'replaceSelectOptions';
      name: string;
      fieldId: string;
      /** The field's whole option list afterwards, in board order. */
      options: WantedOption[];
      /** Names about to disappear, so the plan line says so before it happens. */
      dropped: string[];
    };

/**
 * What to do about a single-select field the project already has. `append` is the
 * safe default and the only thing an existing project ever gets: removing an
 * option clears that value from every item holding it, and this command has no
 * way of knowing what is on someone's board. `replace` is for a project ramonda
 * created moments ago, which has no items to lose and whose only options are the
 * three Github seeded it with.
 */
type FieldMode = 'append' | 'replace';

/** 'plan' reads as something about to happen, 'done' as something that just did. */
type Tense = 'plan' | 'done';

function describe(action: Action, tense: Tense): string {
  const create = tense === 'plan' ? 'create' : 'created';

  switch (action.kind) {
    case 'createLabel':
      return `${create} label "${TASK_LABEL}"`;

    // Named as a project workflow rather than just by its name: it is the one
    // action here that removes something, and the line has to be legible to
    // somebody who has never opened the project's settings.
    case 'deleteWorkflow':
      return `${tense === 'plan' ? 'delete' : 'deleted'} project workflow "${action.name}" — ${action.effect}`;

    case 'createTextField':
      return `${create} text field "${action.name}"`;

    case 'createSelectField':
      return `${create} single-select field "${action.name}" with options ${action.options
        .map((o) => `"${o.name}"`)
        .join(', ')}`;

    case 'addSelectOptions':
      return `${tense === 'plan' ? 'add' : 'added'} option(s) to "${action.name}": ${action.added
        .map((o) => `"${o.name}"`)
        .join(', ')}`;

    // "set" reads the same either tense, which is the one case the pair above
    // does not need spelling out.
    case 'replaceSelectOptions':
      return (
        `set "${action.name}" options to ${action.options.map((o) => `"${o.name}"`).join(', ')}` +
        (action.dropped.length > 0 ? `, dropping ${action.dropped.map((n) => `"${n}"`).join(', ')}` : '')
      );
  }
}

type SingleSelectField = Extract<ProjectField, { kind: 'singleSelect' }>;

function findField(shape: ProjectShape, name: string): ProjectField | undefined {
  return shape.fields.find((f) => f.name === name);
}

/**
 * A field of the wrong type can't be converted in place, and deleting one takes
 * every value on the project with it — so this is always a hand-fix. Every field
 * ramonda wants is fixed by name, so there is no config key to point elsewhere
 * and the message stops at the project. Both asserters narrow, so a caller that
 * gets past one is holding the field kind it asked for.
 */
function wrongKind(field: ProjectField, want: string): Error {
  const found = field.kind === 'other' ? field.describedAs : `a ${field.kind} field`;

  return new Error(
    `Project field "${field.name}" is ${found}, but ramonda needs ${want}. Delete or rename it on the project.`
  );
}

function assertTextField(field: ProjectField): asserts field is Extract<ProjectField, { kind: 'text' }> {
  if (field.kind !== 'text') {
    throw wrongKind(field, 'a text field');
  }
}

function assertSelectField(field: ProjectField): asserts field is SingleSelectField {
  if (field.kind !== 'singleSelect') {
    throw wrongKind(field, 'a single-select field');
  }
}

/**
 * What it takes to get one single-select field carrying `wanted`: create it when
 * the project has no such field, and otherwise reconcile the options it has
 * against the ones it should have, however `mode` says to.
 *
 * Under `append` — everything but a project ramonda just made — options are only
 * ever added, because removing one blanks that value on every item already
 * holding it.
 */
function planSelectField(opts: {
  shape: ProjectShape;
  name: string;
  wanted: NewOption[];
  mode: FieldMode;
}): Action | null {
  const field = findField(opts.shape, opts.name);

  if (!field) {
    return { kind: 'createSelectField', name: opts.name, options: opts.wanted };
  }

  assertSelectField(field);

  if (opts.mode === 'replace') {
    return planReplaceOptions({ name: opts.name, field, wanted: opts.wanted });
  }

  const present = new Set(field.options.map((o) => o.name));
  const added = opts.wanted.filter((o) => !present.has(o.name));

  if (added.length === 0) {
    return null;
  }

  return {
    kind: 'addSelectOptions',
    name: opts.name,
    fieldId: field.id,
    existing: field.options,
    added,
  };
}

/**
 * The field's whole option list, set to exactly `STATUS_VALUES`.
 *
 * Only ever planned against a project ramonda has just created, where Github has
 * pre-seeded `Status` with `Todo`, `In Progress` and `Done`. Appending to those
 * leaves a board carrying both Github's vocabulary and ramonda's — `In Progress`
 * sitting next to `In progress` — which is nobody's board.
 *
 * An existing option whose name matches one that is wanted is **kept and edited
 * in place**, by id, rather than dropped and re-made. That is what preserves the
 * option ID, and the ID is what a project's built-in workflows target: `Item
 * added to project` points at `Todo`, and re-creating that option under the same
 * name would leave the workflow aimed at an option that no longer exists — which
 * is to say, no default column on a brand-new board.
 *
 * Matching is case-insensitive, so Github's `In Progress` is recognised as the
 * option ramonda's `In progress` renames rather than as one to sit beside.
 */
function planReplaceOptions(opts: { name: string; field: SingleSelectField; wanted: NewOption[] }): Action | null {
  const byName = new Map(opts.field.options.map((o) => [o.name.toLowerCase(), o]));
  const options: WantedOption[] = opts.wanted.map((want) => {
    const existing = byName.get(want.name.toLowerCase());

    return existing ? { ...want, id: existing.id } : want;
  });
  const kept = new Set(options.map((o) => o.id).filter((id) => id !== undefined));
  const dropped = opts.field.options.filter((o) => !kept.has(o.id));
  const unchanged =
    dropped.length === 0 &&
    options.length === opts.field.options.length &&
    options.every((o, i) => o.id === opts.field.options[i].id && o.name === opts.field.options[i].name);

  if (unchanged) {
    return null;
  }

  return {
    kind: 'replaceSelectOptions',
    name: opts.name,
    fieldId: opts.field.id,
    options,
    dropped: dropped.map((o) => o.name),
  };
}

/**
 * All ten columns, in the order `STATUS_VALUES` declares them, so a project
 * built from scratch reads left to right the way the work actually moves. Exact
 * under `replace` and on a field being created; best-effort under `append`,
 * which can only add to the order already there.
 */
function planStatus(shape: ProjectShape, mode: FieldMode): Action | null {
  return planSelectField({
    shape,
    mode,
    name: STATUS_FIELD,
    wanted: Object.entries(STATUS_VALUES).map(([role, name]) => ({
      name,
      color: STATUS_COLORS[role as StatusRole],
    })),
  });
}

/** All four levels, highest first, so the palette runs red → green down the list. */
function planPriority(shape: ProjectShape, mode: FieldMode): Action | null {
  return planSelectField({
    shape,
    mode,
    name: PRIORITY_FIELD,
    wanted: PRIORITY_VALUES.map((priority, i) => ({ name: priority, color: priorityColor(i) })),
  });
}

function planBotField(shape: ProjectShape): Action | null {
  const field = findField(shape, BOT_FIELD);

  if (!field) {
    return { kind: 'createTextField', name: BOT_FIELD };
  }

  assertTextField(field);

  return null;
}

/**
 * One deletion per conflicting workflow the project carries, in the order
 * `CONFLICTING_WORKFLOWS` lists them. Nothing to do where the project never had
 * one, which is also the state a re-run finds — so this is idempotent by being a
 * diff like every other step, rather than by a delete that shrugs at a 404.
 */
function planWorkflows(shape: ProjectShape): Action[] {
  return CONFLICTING_WORKFLOWS.flatMap(({ name, effect }) => {
    const workflow = shape.workflows.find((w) => w.name === name);

    return workflow ? [{ kind: 'deleteWorkflow' as const, workflowId: workflow.id, name, effect }] : [];
  });
}

function planProject(shape: ProjectShape, mode: FieldMode): Action[] {
  return [
    ...planWorkflows(shape),
    ...[planBotField(shape), planStatus(shape, mode), planPriority(shape, mode)].filter((action) => action !== null),
  ];
}

async function applyProject(opts: {
  github: Github;
  projectId: string;
  repoNameWithOwner: string;
  actions: Action[];
}): Promise<void> {
  for (const action of opts.actions) {
    switch (action.kind) {
      case 'createLabel':
        await opts.github.createLabel({ repoNameWithOwner: opts.repoNameWithOwner });
        break;

      case 'deleteWorkflow':
        await opts.github.deleteProjectWorkflow({ workflowId: action.workflowId });
        break;

      case 'createTextField':
        await opts.github.createTextField({
          projectId: opts.projectId,
          name: action.name,
        });
        break;

      case 'createSelectField':
        await opts.github.createSingleSelectField({
          projectId: opts.projectId,
          name: action.name,
          options: action.options,
        });
        break;

      case 'addSelectOptions':
        await opts.github.appendSelectOptions({
          fieldId: action.fieldId,
          existing: action.existing,
          added: action.added,
        });
        break;

      case 'replaceSelectOptions':
        await opts.github.replaceSelectOptions({
          fieldId: action.fieldId,
          options: action.options,
        });
        break;
    }

    // Green with a tick, like every other step that went the way it was meant
    // to: the plan above is printed plain and dashed, so the two read as the
    // preview and the record rather than as the same list twice.
    success(describe(action, 'done'));
  }
}

/**
 * Printed before the first mutation on every path that has one, --yes included:
 * skipping the confirmation is a decision about being *asked*, not about being
 * told what is happening. Each action is logged again as it is taken, so the
 * plan reads as a preview rather than as the record.
 */
function printIntent(opts: {
  creating: boolean;
  projectTitle: string;
  ghOwner: string;
  repoNameWithOwner: string;
  actions: Action[];
}): void {
  if (opts.creating) {
    out(`- create project "${opts.projectTitle}" under ${opts.ghOwner}, linked to ${opts.repoNameWithOwner}`);
  }

  for (const action of opts.actions) {
    out(`- ${describe(action, 'plan')}`);
  }

  // A project that does not exist yet cannot be diffed, so its field work — and
  // the workflows Github is about to seed it with — are stated as intent here and
  // logged concretely once the project is there.
  if (opts.creating) {
    out(`- add "${BOT_FIELD}" / "${STATUS_FIELD}" / "${PRIORITY_FIELD}" fields as needed`);
    out(`- delete the ${CONFLICTING_WORKFLOWS.map((w) => `"${w.name}"`).join(' / ')} workflows the new project has`);
  }

  out('');
}

/**
 * The real proof a project is usable is not that the plan came out empty but that
 * startup step 8's own validator passes against it — so every path that ends
 * with a project in place runs it, the one that had nothing to change included.
 */
async function verifyProject(opts: { github: Github; ghOwner: string; ghProject: number }): Promise<void> {
  await opts.github.fetchProjectMeta({
    ghOwner: opts.ghOwner,
    ghProject: opts.ghProject,
  });
  success("project verified — ramonda's startup checks pass against it");
  out('');
}

/**
 * Writes the project this run resolved into `ramonda.json`, so `ramonda run`
 * takes no flags.
 *
 * This is the only command that knows both halves — `init` runs before the
 * project exists, and `run` should not have to be told every time what
 * `setup-project` already worked out. Only reached on the paths that leave a
 * usable project behind: a declined confirmation returns before it, so a run
 * that changed nothing on Github changes nothing on disk.
 */
async function recordProject(opts: { workspacePath: string; ghOwner: string; ghProject: number }): Promise<void> {
  const written = await writeProjectIdentity(opts.workspacePath, {
    owner: opts.ghOwner,
    number: opts.ghProject,
  });

  if (written) {
    success(`recorded project.owner "${opts.ghOwner}" and project.number ${opts.ghProject} in ${REPO_CONFIG_FILE}`);
  }

  out('');
}

/**
 * How every path that leaves a usable project behind ends. The commit is named
 * here rather than by `init`, which runs before this command has written the
 * project into `ramonda.json` and so cannot be the last word on what to commit.
 */
function signOff(): void {
  nextStep({
    command: 'ramonda run',
    notes: [
      warning('Commit and push .gitignore and ramonda.json first — every task worktree is cut from'),
      warning('origin/<baseBranch>, so a run refuses to work until the pushed branch carries them.'),
      `Then label an issue "${TASK_LABEL}" and put it on the project's "${STATUS_VALUES.todo}" column.`,
    ],
  });
}

async function setupProject(opts: {
  config: Config;
  /** Asked for against the repo's own owner when the flag is absent. */
  ghOwner?: string;
  ghProject?: number;
  /** Asked for when creating and absent; an existing project keeps its own title. */
  title?: string;
  yes: boolean;
}): Promise<void> {
  const { config } = opts;

  // Origin first, config second, as in `run` startup: a repo whose origin points
  // somewhere ramonda cannot work is refused as that, not as a missing ramonda.json.
  const workspace = await new Git(process.cwd()).workspaceInfo();
  assertGithubOrigin(workspace);
  const repoConfig = await readRepoConfig(workspace.workspacePath);

  // Which project this run is about, answered in this order: what the flags
  // said, then what `ramonda.json` already records, then a question.
  //
  // The record is the half that matters. This command wrote it, `run` reads it,
  // and a repo that has one is a repo whose project exists — so a bare
  // `setup-project` there is a request to bring *that* project up to date, not
  // an invitation to build a second board and then overwrite the number
  // pointing at the first.
  const [repoOwner, repoName] = workspace.repoNameWithOwner.split('/');
  const recorded = repoConfig.project;
  const ghProject = opts.ghProject ?? (recorded.number > 0 ? recorded.number : undefined);
  const ghOwner = opts.ghOwner ?? (recorded.owner || (await askOwner(repoOwner)));

  // Only a run that creates a project has a title to supply: converging one
  // leaves its title alone, so a `--title` on that path names something nothing
  // reads. Rejected rather than dropped, since dropping it would look like a
  // rename that did not take — and worded by whichever of the two settled the
  // project, because only one of them is something the command line can see.
  if (ghProject !== undefined && opts.title !== undefined) {
    throw new Error(
      opts.ghProject !== undefined
        ? `--title cannot be used with --gh-project: an existing project keeps its own title. ` +
            `Rename it on the project itself.\n\n${USAGE}`
        : `--title cannot be used here: ${REPO_CONFIG_FILE} already records project #${ghProject}, so this ` +
            `run converges it, and an existing project keeps its own title. Rename it on the project itself, ` +
            `or clear "project.number" in ${REPO_CONFIG_FILE} to build a fresh one.\n\n${USAGE}`
    );
  }

  // Said before the fetch, so the answer to "why is it not asking me anything?"
  // arrives ahead of the plan rather than being inferred from it.
  if (opts.ghProject === undefined && ghProject !== undefined) {
    out(`${REPO_CONFIG_FILE} records project #${ghProject} under "${ghOwner}" — converging it.`);
    out('');
  }

  // A title exactly on the create path, and empty on the converge path, where
  // nothing reads it. Resolved before the plan, so both it and the createProject
  // mutation hold a title rather than a maybe-title.
  const createTitle = ghProject !== undefined ? '' : (opts.title ?? (await askTitle(repoName)));

  const github = new Github({ ghToken: config.ghToken });

  // Before anything is planned, let alone created. `run` refuses a public repo,
  // so a board built against one is a board nothing can ever poll — and the
  // refusal belongs at the command that would have built it, not two commands
  // later. The project half is checked wherever a project is read: on the
  // converge path by `fetchProjectShape` below, and on the create path by
  // `createProject`, which makes the project private itself.
  await github.assertPrivateRepo({ repoNameWithOwner: workspace.repoNameWithOwner });

  const labelAction: Action | null = (await github.labelExists({
    repoNameWithOwner: workspace.repoNameWithOwner,
  }))
    ? null
    : { kind: 'createLabel' };

  // An existing project can be diffed exactly up front. A project that does not
  // exist yet cannot, so its field actions get computed — and logged — only
  // once the project is there. `shape === null` is therefore "still to create".
  let shape: ProjectShape | null = null;
  let actions: Action[] = labelAction ? [labelAction] : [];

  if (ghProject !== undefined) {
    shape = await github.fetchProjectShape({
      ghOwner,
      ghProject,
    });
    out(`project: #${shape.number} "${shape.title}" — ${shape.url}`);
    out('');
    actions = [...actions, ...planProject(shape, 'append')];

    if (actions.length === 0) {
      success('project already matches config — nothing to do');
      out('');
      await verifyProject({ github, ghOwner, ghProject: shape.number });
      // Even here, where nothing on Github changed: a project that already
      // matches config is still one `run` has to be told about, and this may be
      // the first time it has been named in a repo that was set up by hand.
      await recordProject({
        workspacePath: workspace.workspacePath,
        ghOwner,
        ghProject: shape.number,
      });
      signOff();

      return;
    }
  }

  printIntent({
    creating: shape === null,
    projectTitle: createTitle,
    ghOwner,
    repoNameWithOwner: workspace.repoNameWithOwner,
    actions,
  });

  if (!opts.yes) {
    assertInteractive('setup-project');

    if (!(await confirm({ message: 'Apply?', default: true }))) {
      out('aborted');

      return;
    }

    out('');
  }

  let projectId: string;
  let projectNumber: number;

  if (shape) {
    projectId = shape.projectId;
    projectNumber = shape.number;
  } else {
    const [ownerId, repositoryId] = await Promise.all([
      github.fetchOwnerId(ghOwner),
      github.fetchRepositoryId(workspace.repoNameWithOwner),
    ]);
    const created = await github.createProject({
      ownerId,
      title: createTitle,
      repositoryId,
    });
    projectId = created.projectId;
    projectNumber = created.number;
    // The repo link rides along in the same mutation, so it is one step, not two.
    success(
      `created project #${created.number} "${createTitle}" linked to ${workspace.repoNameWithOwner} — ${created.url}`
    );

    // A fresh project already ships a Status field (Todo/In Progress/Done), so
    // re-read rather than assume. `replace` rather than `append`, because those
    // three are Github's vocabulary and not ramonda's: on a project with no
    // items yet there is nothing for dropping them to cost, and appending would
    // leave the board carrying both sets at once.
    const fresh = await github.fetchProjectShape({
      ghOwner,
      ghProject: created.number,
    });
    actions = [...actions, ...planProject(fresh, 'replace')];
  }

  await applyProject({
    github,
    projectId,
    repoNameWithOwner: workspace.repoNameWithOwner,
    actions,
  });

  await verifyProject({ github, ghOwner, ghProject: projectNumber });
  await recordProject({
    workspacePath: workspace.workspacePath,
    ghOwner,
    ghProject: projectNumber,
  });
  signOff();
}
