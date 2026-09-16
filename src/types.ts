export type Config = {
  /** The credentials section these values came from. */
  profile: string;
  ghToken: string;
  claudeBin: string;
  /** From DEFAULT_MODEL. Undefined leaves the model to Claude Code's own default. */
  model?: string;
  /** From DEFAULT_POLL_PAUSE, already filled in with the built-in default. */
  pollPauseSeconds: number;
};

/**
 * Who ramonda's commits are authored by: the account `GH_TOKEN` authenticates
 * as, resolved once at startup.
 */
export type CommitIdentity = {
  name: string;
  email: string;
};

/**
 * What asking Github about a `GH_TOKEN` established. Four answers rather than a
 * boolean, because what to do about a bad token depends entirely on how it is
 * bad: only `rejected` is a fact about the token that another attempt could fix.
 */
export type TokenProbe =
  /** Usable: the account it belongs to, and the scopes it carries. */
  | { kind: 'ok'; login: string; scopes: string[] }
  /** Github refused it, or it lacks a scope ramonda needs. Asking again is the fix. */
  | { kind: 'rejected'; message: string }
  /** A real token of a kind that cannot drive a project. Asking again may not be the fix. */
  | { kind: 'unsupported'; message: string }
  /** Nothing was established — no network, Github down. Says nothing about the token. */
  | { kind: 'unknown'; message: string };

export type StartSessionOpts = {
  claudeBin: string;
  /**
   * The task worktree: the child's working directory, what `$CLAUDE_PROJECT_DIR`
   * resolves to in its hooks, and where the task state they patch lives.
   */
  cwd: string;
  sessionId: string;
  initialPrompt: string;
  /** Carried into the child's environment, so commits it makes itself match. */
  commitIdentity: CommitIdentity;
  /** Passed through to `claude --model`. Undefined means "let claude decide". */
  model?: string;
  /**
   * Called with one summary line per session event. Nothing is inherited from
   * the terminal, so this is the only live window into a running session.
   */
  onSessionOutput?: (line: string) => void;
};

export type SessionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionError?: SessionError;
  verifyGaveUp?: boolean;
  emptyDiff?: boolean;
};

export type ProjectConfig = {
  /**
   * Which project this repo's tasks live on. `init` writes both empty and
   * `setup-project` fills them in, so `ramonda run` needs no flags. An empty
   * `owner` or a `number` of 0 means "not set up yet".
   */
  owner: string;
  number: number;
};

/**
 * One `sh -c` command the repo configures, with the budget resolved — an omitted
 * `timeout` is filled at parse.
 *
 * Shared by `verify` and `worktree.prepare`: both are ordered lists of shell
 * commands run at the worktree root with ramonda's credentials scrubbed out of
 * whichever environment the caller has — the session's for `verify`, which the
 * Stop hook inherits, and the loop's own for `worktree.prepare` — and both need
 * their own leash for the same reason. One type rather than two keeps them from
 * drifting into two spellings of the same key.
 */
export type ShellCommand = {
  command: string;
  /** Wall-clock budget for this command alone, in milliseconds. */
  timeout: number;
};

/**
 * How a task worktree is made usable before its session starts.
 *
 * A worktree is a fresh checkout of tracked files and nothing else — no
 * `node_modules`, no `.env`, no build output. Without these two keys a repo whose
 * `verify` is `yarn test` fails every task instantly on a command that cannot
 * resolve, three times over, and the no-PR budget ends the run three tasks later.
 *
 * The split is by what can be regenerated: `prepare` rebuilds what the lockfile
 * describes, and `filesToCopy` carries across what no command can produce because
 * it was never committed.
 */
export type WorktreeConfig = {
  /**
   * Paths copied from the base checkout into each worktree, relative to the repo
   * root. Every one must be gitignored — see `assertCopiedPathsIgnored`.
   */
  filesToCopy: string[];
  /** Run in order before every session, on a fresh worktree and a reused one alike. */
  prepare: ShellCommand[];
};

export type RepoConfig = {
  baseBranch: string;
  project: ProjectConfig;
  worktree: WorktreeConfig;
  verify: ShellCommand[];
};

export type CommandFailure = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * The budget this command overran, in milliseconds. Absent unless it did — its
   * presence is what marks a kill apart from an ordinary non-zero exit.
   */
  timedOutAfter?: number;
};

export type WorkspaceInfo = {
  workspacePath: string;
  repoNameWithOwner: string;
  host: string;
};

export type LimitHit = {
  errorType: string;
  transcriptPath?: string;
  /**
   * When a rejected rate limit resets, as the session's own output reported it.
   * Absent where it reported none — the StopFailure hook's payload never carries
   * one — which leaves the transcript to read it from.
   */
  resetsAt?: string;
  detectedAt: string;
};

export type SessionError = {
  errorType: string;
  fatal: boolean;
  transcriptPath?: string;
  detectedAt: string;
  /**
   * Free-form detail for the errors ramonda raises itself, where the type alone
   * says nothing useful — `hook_failed` names a stage, not a cause. Claude Code's
   * own error types are self-describing and carry none.
   */
  message?: string;
};

/**
 * One task's state, at `<worktree>/.claude/ramonda-task.json`.
 *
 * The loop writes it, the hooks patch it, and the loop polls it back — they are
 * separate processes, so this file is the only channel between them. Everything
 * down to `taskLogPath` is settled at the write and never changes, bar
 * `verifyFailures` — the Stop hook counts that one up. Below it are the verdict
 * the hooks report back, and the two timestamps with which the loop records how
 * the task ended.
 *
 * Nothing here is a credential. The hooks make no network call and run no git
 * command that writes, which is what lets a session be spawned with every secret
 * stripped from its environment and leave nothing downstream unable to work.
 */
export type TaskState = {
  runId: string;
  claudeSessionId: string;
  ghOwner: string;
  ghProject: number;
  issue: number;
  issueTitle: string;
  branch: string;
  baseBranch: string;
  repoNameWithOwner: string;
  workspacePath: string;
  worktreePath: string;
  projectItemId: string;
  projectId: string;
  botFieldId: string;
  statusFieldId?: string;
  statusOptionInReviewId?: string;
  statusOptionCancelledId?: string;
  pid: number;
  startedAt: string;
  verifyFailures: number;
  taskLogPath: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  limitHit?: LimitHit | null;
  sessionError?: SessionError | null;
  verifyGaveUp?: boolean;
  emptyDiff?: boolean;
  lastVerifyStderr?: string;
  /**
   * When the Stop hook found the branch verified and worth publishing. The hook
   * stops there; this is what tells the loop to commit, push and open the PR.
   */
  verifyPassedAt?: string;
};

export type RateLimitHeaders = {
  limit?: number;
  remaining?: number;
  used?: number;
  reset?: number;
};

/** One Github call's rate-limit footprint, as reported by its response headers. */
export type RateLimitObservation = {
  /** `METHOD /path`, e.g. `POST /graphql`. */
  route: string;
  /** Which budget the call was billed to — `graphql`, `core`, `search`, ... */
  resource: string;
  rateLimit: RateLimitHeaders;
  /** Points this call spent; undefined for the first call against a resource. */
  cost?: number;
};

export type ProjectMeta = {
  projectId: string;
  botFieldId: string;
  statusFieldId?: string;
  /** Set only when a field of that name exists *and* is a single-select. */
  priorityFieldId?: string;
  priorityOptions?: string[];
  /**
   * How a field carrying the priority field's name but the wrong type reads
   * mid-sentence — see `describedAs` on `ProjectField`. Set alongside an
   * undefined `priorityFieldId` so the refusal can say "wrong type" rather than
   * "missing".
   */
  priorityFieldWrongType?: string;
  /** Where a pickup that failed before its session puts the item back. */
  statusOptionTodoId?: string;
  statusOptionInProgressId?: string;
  statusOptionInReviewId?: string;
  statusOptionCancelledId?: string;
};

/** A single-select option as the project reports it, round-trippable into an update. */
export type SelectOption = {
  id: string;
  name: string;
  color: string;
  description: string;
};

/** A single-select option ramonda wants to exist; it has no id until Github mints one. */
export type NewOption = {
  name: string;
  color: string;
};

/**
 * An option in an update about to be sent. Github's update mutation takes the
 * field's whole option list, so what is in this array *is* the field afterwards:
 * an `id` claims an option the project already has and edits it in place, its
 * absence mints a new one, and an existing option left out of the array is
 * dropped. Editing in place is what keeps the option ID stable, which matters
 * because a project's built-in workflows target options by ID — the `Item added
 * to project` one among them, which is what makes a column the default.
 */
export type WantedOption = NewOption & { id?: string; description?: string };

export type ProjectField =
  | { kind: 'text'; id: string; name: string }
  | { kind: 'singleSelect'; id: string; name: string; options: SelectOption[] }
  /**
   * A field carrying a name ramonda wants under a type it cannot use.
   * `describedAs` names that type mid-sentence, article and all: the `dataType`
   * of a generic `ProjectV2Field` — which is what `TEXT`, `NUMBER`, `DATE` and
   * every built-in column all arrive as — or the `__typename` of a type that has
   * one of its own.
   */
  | { kind: 'other'; id: string; name: string; describedAs: string };

/**
 * One of a project's automation workflows — the built-in ones Github seeds, and
 * any the owner wrote. Only the name identifies what a workflow does: the type
 * carries no kind, no trigger and no target, so a workflow is recognised by what
 * it is called or not at all.
 */
export type ProjectWorkflow = {
  id: string;
  name: string;
};

/** Everything `setup-project` needs to decide what is missing from a project. */
export type ProjectShape = {
  projectId: string;
  number: number;
  title: string;
  url: string;
  fields: ProjectField[];
  workflows: ProjectWorkflow[];
};

export type FoundTask = {
  itemId: string;
  issue: { number: number; title: string; body: string };
  /**
   * The level whose pass turned this up, or `NO_PRIORITY` where the pass that
   * did was the one for issues carrying no level at all.
   */
  priorityHit: string;
};

export type RateLimitCall = {
  priority: string;
  rateLimit: RateLimitHeaders;
};

/**
 * One `ProjectV2Item` as the project reports it. The issue fields are optional
 * because a project item may hold a pull request or a draft issue instead — only
 * `__typename` says which, and only an `Issue` carries the rest.
 */
export type TaskNode = {
  id: string;
  content: {
    __typename: string;
    number?: number;
    title?: string;
    body?: string;
  };
};

export type HookEntry = {
  name?: string;
  hooks?: Array<{ type: string; command: string }>;
};

export type SettingsJson = {
  hooks?: {
    Stop?: HookEntry[];
    StopFailure?: HookEntry[];
    [key: string]: HookEntry[] | undefined;
  };
  [key: string]: unknown;
};
