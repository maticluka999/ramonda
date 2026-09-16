import { setTimeout as sleep } from 'node:timers/promises';
import { retry } from '@octokit/plugin-retry';
import { Octokit } from '@octokit/rest';
import {
  BOT_FIELD,
  CLAIM_REF_PREFIX,
  GITHUB_API_URL,
  NO_PRIORITY,
  PRIORITY_FIELD,
  PRIORITY_VALUES,
  STATUS_FIELD,
  STATUS_VALUES,
  TASK_LABEL,
} from '../constants/github.js';
import {
  PROJECT_SHAPE_QUERY,
  CLEAR_ITEM_FIELD_MUTATION,
  CREATE_PROJECT_MUTATION,
  CREATE_SELECT_FIELD_MUTATION,
  CREATE_TEXT_FIELD_MUTATION,
  DELETE_PROJECT_WORKFLOW_MUTATION,
  OWNER_ID_QUERY,
  PROJECT_ITEMS_QUERY,
  PROJECT_META_QUERY,
  READ_ITEM_SELECT_QUERY,
  REPOSITORY_ID_QUERY,
  SET_ITEM_SELECT_MUTATION,
  SET_ITEM_TEXT_MUTATION,
  SET_PROJECT_PRIVATE_MUTATION,
  UPDATE_SELECT_FIELD_MUTATION,
} from '../constants/github-graphql.js';
import type {
  CommitIdentity,
  FoundTask,
  NewOption,
  ProjectField,
  ProjectMeta,
  ProjectShape,
  ProjectWorkflow,
  RateLimitCall,
  RateLimitHeaders,
  RateLimitObservation,
  SelectOption,
  TaskNode,
  TokenProbe,
  WantedOption,
} from '../types.js';
import { quoteAll } from '../utils/quote-all.js';

/**
 * What a `GH_TOKEN` has to carry. `repo` reaches the private repository — the
 * only kind ramonda works on — and `project` reaches the board, which no other
 * scope covers and which is the half people miss, since a token minted for a
 * repository looks complete right up until the first project call.
 */
const REQUIRED_TOKEN_SCOPES = ['repo', 'project'] as const;

/** Where to mint a token that already has both, with the boxes pre-ticked. */
export const TOKEN_MINT_URL = 'https://github.com/settings/tokens/new?scopes=repo,project&description=ramonda';

/**
 * How many project items one poll reads — not how many it claims, which is at
 * most one.
 *
 * A project item can hold a pull request or a draft issue as readily as an issue,
 * and only an issue is a task. Reading a single item meant one mislabelled PR
 * sitting at the top of a column reported the whole column as empty, on every
 * poll, for as long as it stayed there. A small batch steps past it. The batch is
 * then walked until a claim lands — losing one settles nothing about the next
 * candidate — and whatever is left over is discarded rather than remembered, so
 * every claim is made against a query moments old.
 */
const CANDIDATE_BATCH = 10;

/** How long to let Github's own project workflows land before re-checking. */
const SETTLE_MS = 2000;
const CONFIRM_ATTEMPTS = 3;

/**
 * Every owner-scoped query goes through `repositoryOwner`, which resolves a login
 * to whichever of User/Organization holds it. One wording for the one way that
 * lookup fails, shared by all of them.
 */
function ownerNotFound(ghOwner: string): string {
  return `Github owner "${ghOwner}" not found (or the token cannot see it).`;
}

/** `owner/name` split into the pair every REST call names separately. */
function splitRepo(repoNameWithOwner: string): { owner: string; repo: string } {
  const [owner, repo] = repoNameWithOwner.split('/');

  return { owner, repo };
}

/**
 * The `projectV2` an owner-scoped query asked for, or the reason there isn't one.
 *
 * A login matching no user or org comes back as a plain null with no GraphQL
 * error, so an owner typo has to be told apart from a real owner here or it gets
 * reported as a missing project.
 */
function requireProject<T>(
  data: { repositoryOwner?: { projectV2: T | null } | null } | undefined,
  opts: { ghOwner: string; ghProject: number }
): T {
  const owner = data?.repositoryOwner;

  if (!owner) {
    throw new Error(ownerNotFound(opts.ghOwner));
  }

  if (!owner.projectV2) {
    throw new Error(`Project #${opts.ghProject} not found for ${opts.ghOwner}.`);
  }

  return owner.projectV2;
}

function parseRateLimit(headers: Record<string, string | undefined>): RateLimitHeaders {
  const num = (key: string): number | undefined => {
    const v = headers[key];

    return v === undefined ? undefined : Number.parseInt(v, 10);
  };

  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    used: num('x-ratelimit-used'),
    reset: num('x-ratelimit-reset'),
  };
}

/**
 * The budget half of a rate-limit log line. Rendered here rather than by the
 * caller because this is where the headers are read: one module decides both
 * what the numbers mean and how they are spelled.
 */
export function formatRateLimitHeaders(rl: RateLimitHeaders): string {
  const reset = rl.reset ? new Date(rl.reset * 1000).toISOString() : '?';

  return `used=${rl.used ?? '?'}/${rl.limit ?? '?'} remaining=${rl.remaining ?? '?'} reset=${reset}`;
}

/** One Github call's rate-limit footprint. Log-only — it is noise on a terminal. */
export function formatRateLimitObservation(observation: RateLimitObservation): string {
  return (
    `api ${observation.resource} ${observation.route} cost=${observation.cost ?? '?'} ` +
    formatRateLimitHeaders(observation.rateLimit)
  );
}

/**
 * Github meters REST and GraphQL against separate hourly budgets, so a call's
 * cost is only meaningful as a delta within its own resource. One process talks
 * to Github with one token, so a module-wide tally is the whole picture — it
 * deliberately outlives any single `Github` instance.
 */
const lastUsed = new Map<string, number>();

function costOf(resource: string, used: number | undefined): number | undefined {
  if (used === undefined) {
    return undefined;
  }

  const previous = lastUsed.get(resource);
  lastUsed.set(resource, used);

  if (previous === undefined || used < previous) {
    // First call of the process, or the hourly window reset under us.
    return undefined;
  }

  return used - previous;
}

function report(
  onRateLimit: (observation: RateLimitObservation) => void,
  options: { method?: string; url?: string },
  headers: Record<string, string | undefined>
): void {
  const rateLimit = parseRateLimit(headers);

  // Every field, not the two that are usually there together: a response
  // carrying only part of the set still said something about the budget, and
  // reporting it as `?=?` beats leaving a gap in the tally. Nothing at all is a
  // response that never reached the API — a redirect, a 304 — and has no budget
  // to report.
  if (Object.values(rateLimit).every((value) => value === undefined)) {
    return;
  }

  const resource = headers['x-ratelimit-resource'] ?? 'unknown';

  onRateLimit({
    route: `${options.method ?? '?'} ${options.url ?? '?'}`,
    resource,
    rateLimit,
    cost: costOf(resource, rateLimit.used),
  });
}

/**
 * How many times a call Github answered with a 5xx — or with a secondary
 * rate-limit refusal — is tried again before it becomes the caller's problem.
 *
 * A loop meant to poll for weeks meets these routinely, and without a retry a
 * single 502 propagated all the way out of `run` and ended the process.
 */
const REQUEST_RETRIES = 3;

/**
 * Whether a failed call is worth another attempt, or *is* the answer.
 *
 * The policy is ramonda's rather than the retry plugin's, because the plugin
 * decides on the status code alone and the case that matters most here cannot be
 * told apart that way. `403` is both "this token may not do that" — an answer,
 * and one no number of attempts improves — and, on Github's older path, a
 * secondary rate limit, which is exactly the transient refusal a run polling for
 * weeks has to ride out. So the body and the headers decide, not the number.
 *
 * Everything else in the 4xx range reaches the caller intact, which several call
 * sites depend on: `labelExists` reads a 404 as "no label", `createClaimRef`
 * reads a 422 as "another process holds the claim", and `createPullRequest`
 * reads one as "the PR is already open".
 *
 * A *primary* rate limit is deliberately not retried. It resets on the hour, so
 * three attempts seconds apart could only spend what is left of the budget
 * confirming it — the wait it wants is far longer than a retry is for.
 */
function isRetryable(error: unknown): boolean {
  const { status, message, response } = error as {
    status?: number;
    message?: string;
    response?: { headers?: Record<string, string | undefined> };
  };

  if (status !== undefined && status >= 500) {
    return true;
  }

  if (status !== 403 && status !== 429) {
    return false;
  }

  // Github words a secondary limit in the body and sends `retry-after` alongside
  // it; a primary one carries no such header and reports an exhausted budget in
  // the rate-limit headers instead.
  return /secondary rate limit/i.test(message ?? '') || response?.headers?.['retry-after'] !== undefined;
}

/** The `Octokit` a plugin is handed, taken off `retry`'s own signature so no transitive import is needed. */
type PluginHost = Parameters<typeof retry>[0];

/**
 * Ramonda's retry policy, applied ahead of `@octokit/plugin-retry`'s own.
 *
 * The plugin owns the *mechanism* — the scheduler, the backoff, and the
 * synthetic 500 it raises for GraphQL's own "Something went wrong while
 * executing your query" — and this owns the *decision*, which is `isRetryable`'s
 * to make. `doNotRetry: []` on the constructor is what hands it over: with no
 * status excluded, the plugin retries whatever budget it is left holding, and
 * zeroing that budget here is how an error is declared final.
 *
 * Registered as a plugin rather than through `octokit.hook.error` after
 * construction because hook order is registration order, and only a hook that
 * runs *inside* the plugin's own gets to set the budget before it is read.
 */
function retryPolicy(octokit: PluginHost): void {
  octokit.hook.error('request', (error, options) => {
    if (!isRetryable(error)) {
      options.request.retries = 0;
    }

    throw error;
  });
}

/** Swallows octokit's own console warnings. See `probing` on the constructor. */
const SILENT_LOG = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createOctokit(opts: {
  ghToken: string;
  probing?: boolean;
  onRateLimit?: (observation: RateLimitObservation) => void;
}): Octokit {
  // Order matters: `retryPolicy` has to register its hook before `retry` does.
  const RetryingOctokit = Octokit.plugin(retryPolicy, retry);
  const octokit = new RetryingOctokit({
    auth: opts.ghToken,
    baseUrl: GITHUB_API_URL,
    // A probe asks one question and reads the refusal as the answer, so there is
    // nothing for a retry to improve — and octokit logs each attempt on its own
    // console, which would put four raw `GET /user - 401` lines above the one
    // sentence `setup-profile` wrote to explain them.
    request: { retries: opts.probing ? 0 : REQUEST_RETRIES },
    // Every status decision belongs to `isRetryable`; see `retryPolicy`.
    retry: { doNotRetry: [] },
    ...(opts.probing ? { log: SILENT_LOG } : {}),
  });
  const { onRateLimit } = opts;

  if (onRateLimit) {
    // `after` only fires on success; a failed call still spends its points, so
    // `error` reports too rather than leaving a gap in the tally.
    octokit.hook.after('request', (response, options) => {
      report(onRateLimit, options, response.headers as Record<string, string | undefined>);
    });
    octokit.hook.error('request', (error, options) => {
      const headers = (error as { response?: { headers?: Record<string, string | undefined> } }).response?.headers;

      if (headers) {
        report(onRateLimit, options, headers);
      }

      throw error;
    });
  }

  return octokit;
}

function assertNoErrors(errors: Array<{ message: string }> | undefined): void {
  if (errors && errors.length > 0) {
    throw new Error(`GraphQL error(s): ${errors.map((e) => e.message).join('; ')}`);
  }
}

/**
 * Backslashes first, then quotes: escaping the quotes first would have this pass
 * double the escapes back over them. Without the backslash rule a value ending in
 * one escapes the closing quote instead of itself, and the rest of the filter —
 * the label gate among it — is swallowed into an unterminated string.
 */
function quoteFilterValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Which items are worth *considering*. Not which are free — that is the claim
 * ref's to answer, and it answers it atomically.
 *
 * So this deliberately does not filter on `BOT_FIELD`. A filter there would be
 * reading a value written best-effort and never confirmed, which means a run
 * killed mid-task could hide its issue from every future poll; and it would buy
 * nothing, since a candidate still has to survive the claim either way. Letting
 * claimed items through and losing the ref race costs one API call.
 */
function buildBaseFilter(opts: { repoNameWithOwner: string }): string {
  const statusQ = STATUS_FIELD.toLowerCase();

  return (
    `label:${quoteFilterValue(TASK_LABEL)} ` +
    `${statusQ}:${quoteFilterValue(STATUS_VALUES.todo)} ` +
    `repo:${quoteFilterValue(opts.repoNameWithOwner)} is:open`
  );
}

/**
 * Oldest first, by issue number.
 *
 * Only the untriaged pass is reordered. A level's items keep the project's own
 * order, which is the board owner saying what to work next — but an issue nobody
 * gave a level to carries no such statement, and the card's position on a column
 * nobody has sorted is not one either. Age is the tiebreak that cannot be an
 * accident: first queued, first worked, so an untriaged issue cannot be starved
 * by newer ones landing above it.
 *
 * Numbers stand in for timestamps because Github allocates them in order within a
 * repo, and every candidate here came through a filter pinned to one repo — so
 * the lower number is the older issue without a second field to fetch.
 */
function oldestFirst(candidates: FoundTask[]): FoundTask[] {
  return [...candidates].sort((a, b) => a.issue.number - b.issue.number);
}

/** Project items also carry pull requests and draft issues; only issues are tasks. */
function nodeToTask(node: TaskNode, priority: string): FoundTask | null {
  const { content } = node;

  if (content.__typename !== 'Issue' || content.number === undefined) {
    return null;
  }

  return {
    itemId: node.id,
    issue: {
      number: content.number,
      title: content.title ?? '',
      body: content.body ?? '',
    },
    priorityHit: priority,
  };
}

type RawField = {
  __typename: string;
  id?: string;
  name?: string;
  /**
   * Only meaningful on a `ProjectV2Field`, which is the one typename covering
   * more than one kind of field: `TEXT`, `NUMBER`, `DATE` and every built-in
   * column arrive under it, so the typename alone cannot tell them apart.
   */
  dataType?: string;
  options?: SelectOption[];
};

type RawProject = {
  id: string;
  number: number;
  title: string;
  url: string;
  public: boolean;
  fields: { nodes: RawField[] };
  // Nullable all the way down, so a project whose workflows this token cannot
  // read reports none rather than failing a query the rest of the plan needs.
  workflows?: { nodes?: Array<{ id?: string; name?: string }> } | null;
};

/**
 * Refuses a public project.
 *
 * A public board publishes every issue title and body on it, and shows anyone
 * who finds it exactly what ramonda is being asked to do. Both queries that read
 * a project ask for `public`, so this is checked wherever one is read rather
 * than at one command's startup — a board `setup-project` converges is a board
 * `run` will be pointed at.
 */
function assertPrivateProject(project: { public: boolean }, ghProject: number): void {
  if (!project.public) {
    return;
  }

  throw new Error(
    `Project ${ghProject} is public, and ramonda runs on private projects only. ` +
      `Change its visibility to private in the project's settings.`
  );
}

/**
 * The most specific thing Github said about a field's type, for the messages
 * that have to name it. `ProjectV2Field` is the generic typename — `TEXT`,
 * `NUMBER`, `DATE` and every built-in column arrive under it — so its `dataType`
 * is the half worth reporting; the other typenames describe themselves.
 */
function describeFieldType(raw: RawField): string {
  const what = raw.dataType ? `${raw.dataType} field` : raw.__typename;

  // The article comes with the phrase, since half of Github's dataTypes open on
  // a vowel and every caller of this is mid-sentence.
  return `${/^[AEIOU]/i.test(what) ? 'an' : 'a'} ${what}`;
}

function toProjectField(raw: RawField): ProjectField | null {
  if (!raw.id || !raw.name) {
    return null;
  }

  if (raw.__typename === 'ProjectV2SingleSelectField') {
    return {
      kind: 'singleSelect',
      id: raw.id,
      name: raw.name,
      options: raw.options ?? [],
    };
  }

  // `dataType` and not the typename alone: a field somebody created as a number
  // or a date is a `ProjectV2Field` too, so reading the typename as "text" would
  // wave through a `Ramonda-run-ID` that every write to it then fails against.
  if (raw.__typename === 'ProjectV2Field' && raw.dataType === 'TEXT') {
    return { kind: 'text', id: raw.id, name: raw.name };
  }

  return {
    kind: 'other',
    id: raw.id,
    name: raw.name,
    describedAs: describeFieldType(raw),
  };
}

/**
 * Everything ramonda asks of Github, behind one client.
 *
 * One instance holds one authenticated Octokit, so the token and API host are
 * settled at construction and no call site carries them. The rate-limit tally the
 * reporting hooks feed is module-wide rather than per-instance, so cost deltas
 * stay exact even where one process builds more than one client.
 */
export class Github {
  readonly #octokit: Octokit;

  /**
   * `probing` is for a client whose only job is to ask whether this token works
   * — `setup-profile`'s. A refusal is that client's answer rather than an
   * incident, so it neither retries one nor lets octokit narrate it.
   */
  constructor(opts: { ghToken: string; probing?: boolean; onRateLimit?: (observation: RateLimitObservation) => void }) {
    this.#octokit = createOctokit(opts);
  }

  /**
   * Without a baseline the first call against each resource can only report
   * `cost=?`. `GET /rate_limit` is documented as not counting against any budget,
   * so priming from it makes every subsequent call's cost exact — including the
   * first, which is the one a short-lived command spends most of its calls on.
   */
  async primeRateLimitTally(): Promise<void> {
    try {
      const response = await this.#octokit.request('GET /rate_limit');
      const resources = response.data.resources as Record<string, { used?: number }> | undefined;

      for (const [resource, value] of Object.entries(resources ?? {})) {
        if (typeof value.used === 'number') {
          lastUsed.set(resource, value.used);
        }
      }
    } catch {
      // Best-effort: the only cost of failing here is a `cost=?` on the first call.
    }
  }

  /**
   * A GraphQL call made through `request` rather than the `graphql` helper, so
   * the response headers — and with them the rate-limit budget — survive. The
   * helper hands back only the `data` payload, which is why the two project reads
   * that report their cost both come through here.
   */
  async #graphqlWithRateLimit<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<{ data: T | undefined; rateLimit: RateLimitHeaders }> {
    const response = await this.#octokit.request('POST /graphql', { query, variables });
    const body = response.data as { data?: T; errors?: Array<{ message: string }> };
    assertNoErrors(body.errors);

    return {
      data: body.data,
      rateLimit: parseRateLimit(response.headers as Record<string, string | undefined>),
    };
  }

  async fetchProjectMeta(opts: {
    ghOwner: string;
    ghProject: number;
  }): Promise<{ meta: ProjectMeta; rateLimit: RateLimitHeaders }> {
    const { data, rateLimit } = await this.#graphqlWithRateLimit<{
      repositoryOwner?: {
        projectV2: { id: string; public: boolean; fields: { nodes: RawField[] } } | null;
      } | null;
    }>(PROJECT_META_QUERY, { login: opts.ghOwner, number: opts.ghProject });
    const project = requireProject(data, opts);
    // Read off the query that was being made anyway, rather than a call of its own.
    assertPrivateProject(project, opts.ghProject);

    const fields = project.fields.nodes;

    const botField = fields.find((f) => f.name === BOT_FIELD);

    if (!botField?.id) {
      throw new Error(
        `Project field "${BOT_FIELD}" not found on the project. ` +
          `Add a text field named "${BOT_FIELD}", or run \`ramonda setup-project\` to have it created.`
      );
    }

    // `dataType` as well as the typename: `ProjectV2Field` covers `TEXT`,
    // `NUMBER`, `DATE` and every built-in column alike, so a field of the right
    // name under the wrong one would otherwise pass startup and then fail on
    // every write the run makes to it.
    if (botField.__typename !== 'ProjectV2Field' || botField.dataType !== 'TEXT') {
      throw new Error(
        `Project field "${BOT_FIELD}" must be a plain text field (found ${describeFieldType(botField)}).`
      );
    }

    // Found by name first, so a field that is there under the wrong type is
    // reported as such rather than as missing — the two need different fixes.
    const statusField = fields.find((f) => f.name === STATUS_FIELD);

    if (!statusField?.id) {
      throw new Error(
        `Project field "${STATUS_FIELD}" not found on the project. ` +
          `Add a single-select field named "${STATUS_FIELD}", or run \`ramonda setup-project\` to have it created.`
      );
    }

    if (statusField.__typename !== 'ProjectV2SingleSelectField') {
      throw new Error(
        `Project field "${STATUS_FIELD}" must be a single-select field (found ${statusField.__typename}).`
      );
    }

    const options = statusField.options ?? [];
    const requireOption = (name: string): string => {
      const opt = options.find((o) => o.name === name);

      if (!opt) {
        throw new Error(`Status option "${name}" not found on field "${STATUS_FIELD}".`);
      }

      return opt.id;
    };

    // Only the statuses this run actually uses are asserted. `backlog` and
    // `readyForTest` through `done` are the human half of the board —
    // `setup-project` creates them, nothing here ever writes them — so a project
    // that has since dropped one is not a reason to refuse to work a task that
    // never touches it.
    //
    // The poll matches Todo by *name*, so the filter needs no id. This one is for
    // putting an item back: status moves to In progress the moment a claim is won,
    // which means a pickup that fails before its session has a move of its own to
    // undo, and Todo is where it belongs.
    const statusOptionTodoId = requireOption(STATUS_VALUES.todo);
    const statusOptionInProgressId = requireOption(STATUS_VALUES.inProgress);
    const statusOptionInReviewId = requireOption(STATUS_VALUES.readyForReview);
    const statusOptionCancelledId = requireOption(STATUS_VALUES.cancelled);

    // A field of the right name but the wrong type is unusable for ordering:
    // it has no options to match a configured priority against. Report it as
    // wrong-typed rather than resolving an ID that would silently match nothing.
    const priorityField = fields.find((f) => f.name === PRIORITY_FIELD);
    const prioritySelect = priorityField?.__typename === 'ProjectV2SingleSelectField' ? priorityField : undefined;
    const priorityOptions = prioritySelect?.options?.map((o) => o.name);

    return {
      meta: {
        projectId: project.id,
        botFieldId: botField.id,
        statusFieldId: statusField.id,
        priorityFieldId: prioritySelect?.id,
        priorityOptions,
        priorityFieldWrongType: priorityField && !prioritySelect ? describeFieldType(priorityField) : undefined,
        statusOptionTodoId,
        statusOptionInProgressId,
        statusOptionInReviewId,
        statusOptionCancelledId,
      },
      rateLimit,
    };
  }

  async #runTaskQuery(opts: {
    ghOwner: string;
    ghProject: number;
    filter: string;
    first: number;
  }): Promise<{ nodes: TaskNode[]; rateLimit: RateLimitHeaders }> {
    const { data, rateLimit } = await this.#graphqlWithRateLimit<{
      repositoryOwner?: {
        projectV2: { items: { nodes: TaskNode[] } } | null;
      } | null;
    }>(PROJECT_ITEMS_QUERY, {
      login: opts.ghOwner,
      number: opts.ghProject,
      q: opts.filter,
      first: opts.first,
    });

    return { nodes: requireProject(data, opts).items.nodes, rateLimit };
  }

  async fetchCandidateTasks(opts: {
    ghOwner: string;
    ghProject: number;
    repoNameWithOwner: string;
  }): Promise<{ candidates: FoundTask[]; calls: RateLimitCall[] }> {
    const base = buildBaseFilter({ repoNameWithOwner: opts.repoNameWithOwner });
    const priorityQ = PRIORITY_FIELD.toLowerCase();
    const calls: RateLimitCall[] = [];
    // One pass per level, highest first, taking the first that yields an issue —
    // and then one for the issues carrying no level at all.
    //
    // That last pass is what keeps a queue moving that nobody has triaged. Every
    // other pass filters on a value, so an issue left without one matched no
    // query ramonda made: labelled, in `Todo`, and invisible for as long as it sat
    // there, with `no eligible tasks` the only thing said about it. It comes last
    // because a stated priority outranks an unstated one, whichever the level.
    const passes: Array<{ priority: string; filter: string }> = [
      ...PRIORITY_VALUES.map((priority) => ({
        priority: priority as string,
        filter: `${base} ${priorityQ}:${quoteFilterValue(priority)}`,
      })),
      { priority: NO_PRIORITY, filter: `${base} no:${priorityQ}` },
    ];

    for (const pass of passes) {
      const { nodes, rateLimit } = await this.#runTaskQuery({
        ghOwner: opts.ghOwner,
        ghProject: opts.ghProject,
        filter: pass.filter,
        first: CANDIDATE_BATCH,
      });
      calls.push({ priority: pass.priority, rateLimit });

      const candidates = nodes.map((node) => nodeToTask(node, pass.priority)).filter((task) => task !== null);

      if (candidates.length > 0) {
        return {
          candidates: pass.priority === NO_PRIORITY ? oldestFirst(candidates) : candidates,
          calls,
        };
      }
    }

    return { candidates: [], calls };
  }

  /**
   * Asks Github what this token is and what it may do, so `setup-profile` can
   * answer for it while the question is still one prompt away.
   *
   * `GET /user` is the cheapest call that authenticates, and its response
   * carries the whole answer: the account in the body, and the token's scopes in
   * `x-oauth-scopes` — a header Github sends for classic tokens and omits
   * entirely for the kinds that have no OAuth scopes to report. So one call
   * separates a mistyped token from an under-scoped one from a fine-grained one,
   * and each gets said in its own words rather than surfacing two commands later
   * as a GraphQL error about a project.
   *
   * Reports rather than throws. "Github says no" and "Github could not be
   * reached" are different enough that the caller has to be able to tell them
   * apart, and only one of them is a reason to refuse an answer.
   */
  async probeToken(): Promise<TokenProbe> {
    let response;

    try {
      response = await this.#octokit.rest.users.getAuthenticated();
    } catch (err) {
      const status = (err as { status?: number }).status;

      if (status === 401) {
        return {
          kind: 'rejected',
          message: 'Github rejected this token (401). It is mistyped, revoked, or expired.',
        };
      }

      if (status === 403) {
        return { kind: 'rejected', message: `Github refused this token (403): ${(err as Error).message}` };
      }

      return { kind: 'unknown', message: (err as Error).message };
    }

    const header = response.headers['x-oauth-scopes'];

    // No scope header at all is what a fine-grained PAT and a Github App token
    // look like: both authenticate fine, and neither can drive ProjectV2, which
    // is most of what ramonda does with this token.
    if (header === undefined) {
      return {
        kind: 'unsupported',
        message:
          `this token authenticates as @${response.data.login}, but Github reports no OAuth scopes for it — ` +
          `which is what a fine-grained or Github App token looks like. ramonda needs a classic token, ` +
          `because project management is not available to the others.`,
      };
    }

    const scopes = header
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope !== '');
    const missing = REQUIRED_TOKEN_SCOPES.filter((scope) => !scopes.includes(scope));

    if (missing.length > 0) {
      return {
        kind: 'rejected',
        message:
          `this token authenticates as @${response.data.login} but is missing the ${quoteAll(missing)} ` +
          `scope${missing.length > 1 ? 's' : ''}. It carries: ${scopes.length > 0 ? quoteAll(scopes) : '(none)'}.`,
      };
    }

    return { kind: 'ok', login: response.data.login, scopes };
  }

  /**
   * Who ramonda's commits are authored by: the account `GH_TOKEN` belongs to.
   *
   * Read from the API rather than from the clone's `user.name`, because Github
   * only links a commit to an account when the author address is verified on it.
   * The operator's local git config carries no such guarantee, so taking it
   * would leave the commits rendering unattributed — the very thing authoring as
   * the operator is meant to fix.
   *
   * A profile with no public email falls back to the account's noreply address.
   * That form is keyed on the numeric account **ID**, not on the login, so it
   * cannot be inherited by whoever registers the name next — unlike the bare
   * `<login>@users.noreply.github.com`, which is attributed by login alone.
   */
  async fetchCommitIdentity(): Promise<CommitIdentity> {
    const { data } = await this.#octokit.rest.users.getAuthenticated();

    return {
      // A profile that never set a display name has only the login to go on.
      name: data.name?.trim() || data.login,
      email: data.email?.trim() || `${data.id}+${data.login}@users.noreply.github.com`,
    };
  }

  /**
   * Refuses a public repository.
   *
   * ramonda points a `bypassPermissions` session at whatever an issue body says,
   * with every tool call auto-approved. That is only defensible while everyone
   * who can write an issue body is someone already trusted with the repo — which
   * a private repo guarantees and a public one does not, since anyone may open an
   * issue there and edit it afterwards. The label gates who can queue work, not
   * who can word it.
   */
  async assertPrivateRepo(opts: { repoNameWithOwner: string }): Promise<void> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);
    const { data } = await this.#octokit.rest.repos.get({ owner, repo });

    if (data.private) {
      return;
    }

    throw new Error(
      `${opts.repoNameWithOwner} is a public repository, and ramonda runs on private repositories only. ` +
        `Sessions run with every tool call auto-approved on a prompt built from the issue body, so ramonda ` +
        `is only safe where writing an issue already means being trusted with the repo.`
    );
  }

  async assertLabelExists(opts: { repoNameWithOwner: string }): Promise<void> {
    if (await this.labelExists(opts)) {
      return;
    }

    throw new Error(
      `Label "${TASK_LABEL}" does not exist in ${opts.repoNameWithOwner}. ` +
        `Create it once with: gh label create "${TASK_LABEL}" -R ${opts.repoNameWithOwner}`
    );
  }

  async labelExists(opts: { repoNameWithOwner: string }): Promise<boolean> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);

    try {
      await this.#octokit.rest.issues.getLabel({ owner, repo, name: TASK_LABEL });

      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return false;
      }

      throw err;
    }
  }

  async createLabel(opts: { repoNameWithOwner: string }): Promise<void> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);

    await this.#octokit.rest.issues.createLabel({
      owner,
      repo,
      name: TASK_LABEL,
      color: '5319e7',
      description: 'Eligible for autonomous pickup by ramonda',
    });
  }

  /**
   * Takes the claim on a task, or reports that someone else already holds it.
   *
   * The whole of the claim protocol: one call, no pre-check, nothing to confirm.
   * `POST /git/refs` creates a ref only if it does not exist, so `201` means this
   * process is the one that created it and `422` means another one got there
   * first. There is no third answer and no window between deciding and acting,
   * which is what a field-based claim could never offer.
   *
   * `sha` is a marker rather than a pointer: nothing ever reads what the ref
   * points at, it only has to be a commit the repo already has.
   */
  async createClaimRef(opts: { repoNameWithOwner: string; branch: string; sha: string }): Promise<boolean> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);

    try {
      // `createRef` wants the ref fully qualified; `deleteRef` below wants it
      // without the leading `refs/`. That asymmetry is Github's, not ours.
      await this.#octokit.rest.git.createRef({
        owner,
        repo,
        ref: `${CLAIM_REF_PREFIX}${opts.branch}`,
        sha: opts.sha,
      });

      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 422) {
        return false;
      }

      throw err;
    }
  }

  /**
   * Releases a claim. A ref that is already gone is a success: the only thing the
   * caller wants is for it not to be there, and every release path is best-effort
   * unwinding where a second complaint helps nobody.
   */
  async deleteClaimRef(opts: { repoNameWithOwner: string; branch: string }): Promise<void> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);

    try {
      await this.#octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `${CLAIM_REF_PREFIX.replace(/^refs\//, '')}${opts.branch}`,
      });
    } catch (err) {
      if ((err as { status?: number }).status === 422 || (err as { status?: number }).status === 404) {
        return;
      }

      throw err;
    }
  }

  /**
   * A commit SHA for claim refs to point at, resolved once at startup from the
   * base branch's head. Any commit the repo holds would do; this one is certain
   * to exist and certain not to be garbage-collected.
   */
  async resolveBranchSha(opts: { repoNameWithOwner: string; branch: string }): Promise<string> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);
    const { data } = await this.#octokit.rest.git.getRef({ owner, repo, ref: `heads/${opts.branch}` });

    return data.object.sha;
  }

  async setBotField(opts: { projectId: string; itemId: string; fieldId: string; value: string }): Promise<void> {
    await this.#octokit.graphql(SET_ITEM_TEXT_MUTATION, {
      projectId: opts.projectId,
      itemId: opts.itemId,
      fieldId: opts.fieldId,
      value: opts.value,
    });
  }

  async clearBotField(opts: { projectId: string; itemId: string; fieldId: string }): Promise<void> {
    await this.#octokit.graphql(CLEAR_ITEM_FIELD_MUTATION, {
      projectId: opts.projectId,
      itemId: opts.itemId,
      fieldId: opts.fieldId,
    });
  }

  async setProjectItemStatus(opts: {
    projectId: string;
    itemId: string;
    fieldId: string;
    optionId: string;
  }): Promise<void> {
    await this.#octokit.graphql(SET_ITEM_SELECT_MUTATION, {
      projectId: opts.projectId,
      itemId: opts.itemId,
      fieldId: opts.fieldId,
      optionId: opts.optionId,
    });
  }

  async #readStatusOptionId(opts: { itemId: string; fieldId: string }): Promise<string | undefined> {
    const data = await this.#octokit.graphql<{
      node: { fieldValues: { nodes: Array<{ optionId?: string; field?: { id: string } }> } } | null;
    }>(READ_ITEM_SELECT_QUERY, { itemId: opts.itemId });

    return data.node?.fieldValues.nodes.find((n) => n.field?.id === opts.fieldId)?.optionId;
  }

  /**
   * Set status and make it stick.
   *
   * Github's built-in "Pull request linked to issue" workflow writes `In Progress`
   * to the item moments after ramonda opens the PR — asynchronously, so it
   * can land *after* our own write and silently revert it. The mutation reports
   * success either way, which makes the loss invisible. Write, let the workflow
   * settle, then re-read and re-apply if something clobbered us.
   *
   * `setup-project` deletes that workflow outright, which is the real fix — a
   * race against a system reacting to ramonda's own pull request cannot be won
   * by waiting, only by removing the other writer. This stays for the boards
   * that command never touched: one set up before it did, one whose workflow is
   * named something else, or one carrying automation somebody added later.
   *
   * Returns whether the field ended up on the intended option.
   */
  async setProjectItemStatusConfirmed(opts: {
    projectId: string;
    itemId: string;
    fieldId: string;
    optionId: string;
  }): Promise<boolean> {
    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
      await this.setProjectItemStatus(opts);
      await sleep(SETTLE_MS);
      const actual = await this.#readStatusOptionId(opts);

      if (actual === opts.optionId) {
        return true;
      }
    }

    return false;
  }

  async postIssueComment(opts: { repoNameWithOwner: string; issueNumber: number; body: string }): Promise<void> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);
    await this.#octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: opts.issueNumber,
      body: opts.body,
    });
  }

  /** The open PR already sitting on `head`, or null. */
  async #findOpenPullRequest(opts: { owner: string; repo: string; head: string }): Promise<string | null> {
    const list = await this.#octokit.rest.pulls.list({
      owner: opts.owner,
      repo: opts.repo,
      state: 'open',
      head: `${opts.owner}:${opts.head}`,
    });

    return list.data[0]?.html_url ?? null;
  }

  /**
   * Opens the PR for a finished task, or hands back the one that is already
   * there. Returns its html_url and whether it was found rather than created.
   *
   * A second run on the same issue is ordinary: the branch is derived from the
   * issue number, so a task sent back to `Todo` after review lands on the branch
   * its own PR is already open on, and `pulls.create` answers that with a 422.
   * Treating it as a failure would mean the project could never be used to iterate
   * on a PR — the push has already updated it, so the existing PR *is* the
   * result. 422 also covers real refusals ("No commits between ..."), which is why
   * the original error is re-thrown when no such PR turns up.
   */
  async createPullRequest(opts: {
    repoNameWithOwner: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<{ url: string; reused: boolean }> {
    const { owner, repo } = splitRepo(opts.repoNameWithOwner);

    try {
      const response = await this.#octokit.rest.pulls.create({
        owner,
        repo,
        title: opts.title,
        head: opts.head,
        base: opts.base,
        body: opts.body,
      });

      return { url: response.data.html_url, reused: false };
    } catch (err) {
      if ((err as { status?: number }).status !== 422) {
        throw err;
      }

      const existing = await this.#findOpenPullRequest({ owner, repo, head: opts.head });

      if (!existing) {
        throw err;
      }

      return { url: existing, reused: true };
    }
  }

  async fetchProjectShape(opts: { ghOwner: string; ghProject: number }): Promise<ProjectShape> {
    const data = (await this.#octokit.graphql(PROJECT_SHAPE_QUERY, {
      login: opts.ghOwner,
      number: opts.ghProject,
    })) as {
      repositoryOwner?: { projectV2: RawProject | null } | null;
    };
    const project = requireProject(data, opts);
    // Before the plan is built, let alone applied: converging a public project
    // would leave a board `run` then refuses to poll.
    assertPrivateProject(project, opts.ghProject);
    const fields = project.fields.nodes.map(toProjectField).filter((field) => field !== null);
    // A workflow missing either half cannot be planned against — the name is how
    // it is recognised and the id is how it is deleted — so it is dropped rather
    // than carried as a half-record the caller has to re-check.
    const workflows = (project.workflows?.nodes ?? []).filter(
      (workflow): workflow is ProjectWorkflow => Boolean(workflow.id) && Boolean(workflow.name)
    );

    return {
      projectId: project.id,
      number: project.number,
      title: project.title,
      url: project.url,
      fields,
      workflows,
    };
  }

  async deleteProjectWorkflow(opts: { workflowId: string }): Promise<void> {
    await this.#octokit.graphql(DELETE_PROJECT_WORKFLOW_MUTATION, { workflowId: opts.workflowId });
  }

  async fetchOwnerId(ghOwner: string): Promise<string> {
    const data = (await this.#octokit.graphql(OWNER_ID_QUERY, { login: ghOwner })) as {
      repositoryOwner?: { id: string } | null;
    };

    const id = data.repositoryOwner?.id;

    if (!id) {
      throw new Error(ownerNotFound(ghOwner));
    }

    return id;
  }

  async fetchRepositoryId(repoNameWithOwner: string): Promise<string> {
    const { owner, repo } = splitRepo(repoNameWithOwner);
    const data = (await this.#octokit.graphql(REPOSITORY_ID_QUERY, { owner, name: repo })) as {
      repository?: { id: string } | null;
    };

    if (!data.repository?.id) {
      throw new Error(`Repository ${repoNameWithOwner} not found.`);
    }

    return data.repository.id;
  }

  /**
   * Creates the project, links it to the repo, and makes sure it is private.
   *
   * `run` refuses a public project, so a `setup-project` that left one behind
   * would build a board its own next command cannot use. Github creates projects
   * private already; this reads `public` back off the create rather than
   * assuming it, and spends a second mutation only if the answer is wrong —
   * costing nothing today while surviving a change to that default.
   */
  async createProject(opts: {
    ownerId: string;
    title: string;
    repositoryId: string;
  }): Promise<{ projectId: string; number: number; url: string }> {
    const data = (await this.#octokit.graphql(CREATE_PROJECT_MUTATION, {
      ownerId: opts.ownerId,
      title: opts.title,
      repositoryId: opts.repositoryId,
    })) as {
      createProjectV2?: {
        projectV2?: { id: string; number: number; url: string; public: boolean };
      };
    };

    const project = data.createProjectV2?.projectV2;

    if (!project) {
      throw new Error('createProjectV2 returned no project.');
    }

    if (project.public) {
      await this.#octokit.graphql(SET_PROJECT_PRIVATE_MUTATION, { projectId: project.id });
    }

    return { projectId: project.id, number: project.number, url: project.url };
  }

  async createTextField(opts: { projectId: string; name: string }): Promise<void> {
    await this.#octokit.graphql(CREATE_TEXT_FIELD_MUTATION, {
      projectId: opts.projectId,
      name: opts.name,
    });
  }

  async createSingleSelectField(opts: { projectId: string; name: string; options: NewOption[] }): Promise<void> {
    await this.#octokit.graphql(CREATE_SELECT_FIELD_MUTATION, {
      projectId: opts.projectId,
      name: opts.name,
      options: opts.options.map((o) => ({
        name: o.name,
        color: o.color,
        description: '',
      })),
    });
  }

  /**
   * `singleSelectOptions` replaces the whole option set rather than merging, so
   * every existing option has to be sent back — with its id *and* its
   * description, since an option left out is deleted and a field left off is
   * cleared. The id is what stops Github clearing the status of every item
   * already on the project; the description is simply not ramonda's to rewrite.
   */
  async appendSelectOptions(opts: { fieldId: string; existing: SelectOption[]; added: NewOption[] }): Promise<void> {
    await this.replaceSelectOptions({
      fieldId: opts.fieldId,
      options: [...opts.existing, ...opts.added],
    });
  }

  /**
   * Sets a single-select field's options to exactly `options`, in order.
   *
   * The caller decides what survives: see `WantedOption`. Descriptions default
   * to empty, so an option reused without one is stripped of whatever text it
   * carried — which is the point on a project ramonda has just created, where
   * the text is Github's boilerplate rather than anything the repo chose.
   */
  async replaceSelectOptions(opts: { fieldId: string; options: WantedOption[] }): Promise<void> {
    await this.#octokit.graphql(UPDATE_SELECT_FIELD_MUTATION, {
      fieldId: opts.fieldId,
      options: opts.options.map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name,
        color: o.color,
        description: o.description ?? '',
      })),
    });
  }
}
