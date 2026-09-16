<p align="center">
  <img src="assets/logo-animated.svg" alt="Ramonda" width="560">
</p>

# Ramonda

## What is Ramonda?

Ramonda is a CLI tool which allows you to run a long-running process which picks up issues from Github Projects and creates pull requests using Claude Code running on your local machine.

Ramonda deals with Claude Code limit hits, overload and other Claude Code task-cancellation issues, which helps you use the full potential of your Claude subscription.

While you sleep, workout or chill - Ramonda works for you!

<p align="center">
  <img src="assets/flow-animated.svg" alt="How ramonda works: an issue becomes a pull request" width="880">
</p>

**Private repositories and private projects only.** Ramonda runs Claude Code with every tool call auto-approved, on a prompt built from the issue title and body. Make sure issues handed over to Ramonda are safely described. Ramonda commands `setup-project` and `run` reject running on public repos and projects.

## Installation

**Requirements**

- macOS or Linux — every command refuses to start anywhere else (on Windows - run it under WSL)
- Node 20.17 or newer
- git
- private Github repository
- Claude Code

**Install**

```sh
git clone https://github.com/maticluka999/ramonda.git
cd ramonda
npm install
npm run build
npm link
```

`ramonda --version` should answer. Then go through the four commands below, in order.

## Usage

Four commands, in the order you use them:

- **`setup-profile`** — `ramonda setup-profile [--profile=<profile>]`

  Sets up a Ramonda profile (credentials and settings). See [`setup-profile`](#setup-profile).

- **`init`** — `ramonda init`

  Writes a `ramonda.json` with default values at the repo root and adds Ramonda's entries to `.gitignore`. See [`init`](#init).

- **`setup-project`** — `ramonda setup-project [--gh-owner=<owner>] [--title=<title>] [--gh-project=<number>] [--profile=<profile>] [--yes]`

  Creates a Github project or updates an existing one based on `ramonda.json`. See [`setup-project`](#setup-project).

- **`run`** — `ramonda run [--profile=<profile>] [--poll-pause=<seconds>] [--model=<model>] [--no-banner]`

  Picks up the highest priority `ramonda`-labelled `Todo` issues one by one, works on them end to end unattended in git worktrees, verifies changes and creates pull requests. See [`run`](#run).

## Commands

### `setup-profile`

Writes one **profile** (a named set of credentials and settings) into `$XDG_CONFIG_HOME/ramonda/credentials` and `$XDG_CONFIG_HOME/ramonda/settings`. Run it once per set of credentials. It takes:

| Parameter             | Required | Default | Description               |
| --------------------- | -------- | ------- | ------------------------- |
| `--profile=<profile>` | No       | asked   | The profile to configure. |

Everything else is a question, asked in this order:

- **the profile to write** — picked from the profiles already on disk, or named to create a new one. Skipped when `--profile` is passed.
- **`GH_TOKEN`** — the Github token other commands authenticate with against Github. Required, written to `credentials`. Mint it at https://github.com/settings/tokens/new with scopes `repo` and `project`. Fine-grained tokens can't be used for project management, so a classic one is required. The token is checked against Github before it is written, and one Github refuses is asked for again.
- **`CLAUDE_BIN`** — Claude binary path written to `settings`. A blank answer lets `$PATH` decide at run time. The path is checked, and a binary that will not start is asked for again.
- **`DEFAULT_MODEL`** — the model sessions run on written to `settings`. Picked from a list of the models the installed Claude Code version supports. If other commands pass `--model`, `--model` takes precedence over `DEFAULT_MODEL`.
- **`DEFAULT_POLL_PAUSE`** — the idle seconds [`run`](#run) waits between task lookups when no task is available, written to `settings`. If `run` passes `--poll-pause`, `--poll-pause` takes precedence over `DEFAULT_POLL_PAUSE`; with neither set, `60`.
- **whether this profile is the default** — the profile every command uses when `--profile` is omitted. Only asked if there is something to decide.

Profiles are stored as sections. Each section starts with a header `[<profile>]`, and the default profile's header also carries the word `default`. Comments and blank lines are allowed anywhere; above the first header they are the only thing allowed, and anything else there is an error.

Here's an example of both files, with a "work" and a "personal" profile, where "personal" is the default:

```ini
# ~/.config/ramonda/credentials
[work]
GH_TOKEN=ghp_0000000000000000000000000000000000

[default personal]
GH_TOKEN=github_pat_00000000000000000000000000
```

```ini
# ~/.config/ramonda/settings
# hand-written comments survive a rewrite
[work]
CLAUDE_BIN=/opt/homebrew/bin/claude
DEFAULT_MODEL=claude-opus-5
DEFAULT_POLL_PAUSE=300

[default personal]
DEFAULT_MODEL=claude-sonnet-5
```

### `init`

Writes the `ramonda.json` at the repo root, and adds the entries Ramonda needs to the repo's `.gitignore`. Run it once per repo, from inside of it. Both files want committing and pushing once [`setup-project`](#setup-project) has filled the project in — and pushing before `run` is what matters, because the worktrees are created based on origin base branch.

Default `ramonda.json` provided by `ramonda init`:

```json
{
  "baseBranch": "main",
  "project": {
    "owner": "",
    "number": 0
  },
  "worktree": {
    "filesToCopy": [],
    "prepare": [{ "command": "npm install", "timeout": 600000 }]
  },
  "verify": [{ "command": "npm test", "timeout": 600000 }]
}
```

- **`baseBranch`** — the branch task branches are cut from and PRs target. A non-empty string.
- **`project`** — an object containing:
  - **`project.owner`** — the user or organization owning the project this repo's tasks live on. Required.
  - **`project.number`** — the number of that project. Required.

  The priority levels Ramonda polls — `Critical`, `High`, `Medium`, `Low`, in that order, highest first — are not among these: they are fixed, `setup-project` puts them on the board, and `run` refuses to start against a project whose `Priority` field is missing one.

- **`worktree`** — what turns a bare worktree into a tree the session and its verification can work in. A bare worktree is a fresh checkout of tracked files and nothing else. An object holding:
  - **`worktree.filesToCopy`** — gitignored paths, relative to the repo root, copied from the base checkout into every worktree before its session starts. Required, but may be **empty**. Every path must be **gitignored** in the checkout, or `run` refuses to start. Directories are copied recursively and symlinks are carried across as symlinks. A path that does not exist is warned about and skipped, not refused.
  - **`worktree.prepare`** — commands run in order after the copies and before the session, on a fresh worktree and a reused one alike. The first to fail ends the pickup. Required, but may be **empty**. An ordered array of objects, each holding:
    - **`worktree.prepare.command`** — the shell command, a non-empty string, run through `sh -c` at the worktree root in Ramonda's own environment with every key `credentials` defines stripped out.
    - **`worktree.prepare.timeout`** — how long that command gets, in milliseconds. A positive integer. Optional, defaulting to `600000`, ten minutes. Running out of it kills the command's whole process group — `SIGTERM`, then `SIGKILL` five seconds later — and counts as a failure.

- **`verify`** — the checks that must pass before the changes are committed. Required. An ordered array of objects, each holding:
  - **`command`** — the shell command, a non-empty string, run through `sh -c` at the worktree root. The Stop hook runs it, so the environment is the session's own, with every key `credentials` defines stripped out of that too.
  - **`timeout`** — how long that command gets, in milliseconds. A positive integer. Optional. One that names none gets `600000`, ten minutes.

  They run in order, and the first to fail sends the model back to work with that command's output. Three failures cancel the task. The array may be **empty**, for a repo with nothing to run.

### `setup-project`

Creates a Github Project, or updates an existing one to match config, then records its owner and number in `ramonda.json`. Run it once per project, from inside the repo. A project it creates is private, which is what [`run`](#run) requires. It takes:

| Parameter               | Required | Default                                                                              | Description                                                                                               |
| ----------------------- | -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--gh-owner=<owner>`    | No       | `project.owner` from `ramonda.json`, else asked (defaulting to the repo's own owner) | The username of the user or organization that owns the project.                                           |
| `--title=<title>`       | No       | asked, defaulting to the repo's own name                                             | The title of the project this run creates. Rejected when updating, where the project keeps its own title. |
| `--gh-project=<number>` | No       | `project.number` from `ramonda.json`, else a new project is created                  | An existing project to update instead of creating one. A positive integer.                                |
| `--profile=<profile>`   | No       | the default profile                                                                  | Which profile to authenticate with.                                                                       |
| `--yes`                 | No       | off                                                                                  | Skips the confirmation asked before the first mutation.                                                   |

**Which project a bare `ramonda setup-project` is about is `ramonda.json`'s answer.** The file records `project.owner` and `project.number`, this command is what wrote them, and [`run`](#run) is what reads them — so a repo that already has a project recorded is a repo asking for _that_ project to be brought up to date. Creating is what happens where the file records nothing. Without this the everyday re-run — repairing a field somebody deleted, or picking up a version that wants a new one — builds a second board and then overwrites the number pointing at the first, and every question on the way there has a default that makes it look right.

A flag still wins over the file: `--gh-project` names a different project to converge, `--gh-owner` a different owner to look under, and both are re-recorded when the run finishes. To build a fresh project for a repo that already records one, clear `project.number` in `ramonda.json` first — which is the same thing said the other way round, since the file is the record of what this repo is wired to.

The project does not have to live under the same account as the repo — a personal board driving a work repo, an org board driving a fork — so where the owner is asked for at all, the repo's own owner is offered as a default rather than taken as the answer. Every question wants a terminal; without one, the flag it would have asked for is named instead, since the fix for a script is the flag rather than a TTY it is never going to have.

### `run`

A long-running process that works one task at a time, unattended, until `Ctrl-C`. Run it from inside the repo it works on. Every flag is optional, so the everyday invocation is a bare `ramonda run`:

| Parameter                | Required | Default                                                    | Description                                                                      |
| ------------------------ | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `--poll-pause=<seconds>` | No       | `DEFAULT_POLL_PAUSE` from settings, else `60`              | Idle seconds between task lookups when no task is available. A positive integer. |
| `--model=<model>`        | No       | `DEFAULT_MODEL` from settings, else `claude`'s own default | The model sessions run on.                                                       |
| `--profile=<profile>`    | No       | the default profile                                        | Which profile to authenticate with.                                              |
| `--no-banner`            | No       | off                                                        | Skips the startup logo.                                                          |

The project it polls comes from `ramonda.json` — `project.owner` and `project.number`, written by [`setup-project`](#setup-project); `run` refuses if either half is unset, naming the one that is missing.

Each pass:

- finds the highest-priority `Todo` issue in the project that carries the `ramonda` label, belongs to this repo and is unclaimed
- claims the issue
- works it end to end in a git worktree of its own: prep and seed the worktree → Claude Code session → verify → commit → push → open a PR → move the item to `Ready for review`.

The next pass starts right away; with nothing to work on, Ramonda sleeps `<poll-pause>` seconds and looks again. A failed task releases what it took, logs why, and polls again after the same pause; three tasks in a row that produce no pull request end the run.

Worktrees live under `.worktrees/` at the repo root, each cut from `origin/<baseBranch>`. Nothing Ramonda runs touches the branch, index or working tree of the checkout you started from, so you can keep working there while the loop runs, and several `ramonda` processes can share one clone.

Commits, the PR, the project moves and the issue comment all come from the account `GH_TOKEN` belongs to. The **push** is the one exception: over an HTTPS origin it still authenticates with `GH_TOKEN`, through a one-shot git credential helper, but over an SSH origin it authenticates with whatever key your SSH agent offers instead, so the pushing identity can differ from `GH_TOKEN`'s account. Sessions are headless, with permission prompts disabled and one prompt each. `Ctrl-C` ends the loop cleanly, cancelling, commenting on and releasing a task in flight; a `SIGTERM` from a supervisor does the same.

## Trivia

Ramonda is a group of flowers — small purple rosettes from a few shaded Balkan gorges, a relict of the flora that grew before the Ice Ages took the rest of it.

It is a resurrection plant: cut off from water it dries into a brown husk and waits out the dry season. When the rain comes back - it revives from exactly where it stopped. The tool is the same trick: a session limit hit is not lost work, only a dry spell, and the session comes back mid-sentence when it passes.

## License

[MIT](LICENSE) © Luka Matic
