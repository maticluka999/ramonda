# Requirements Document

## Introduction

Ramonda is a CLI tool that runs a long-running process on the user's machine. It picks up issues from a Github Project, works each one in a git worktree of its own with a Claude Code session, verifies the result with the repository's own checks, and opens a pull request. It handles Claude Code limit hits, overloads and the other ways a session can be cut short, so that a Claude subscription is used to its full extent while the user is away.

Ramonda has four commands, used in this order: `setup-profile`, `init`, `setup-project`, `run`. It works on private repositories and private projects only, because it runs Claude Code with every tool call auto-approved on a prompt built from the issue title and body.

`run` is a loop. Each pass polls the project for the most urgent eligible issue, claims it, prepares a worktree for it and starts a Claude Code session on it. Whenever the model stops, a Stop hook runs the repository's `verify` commands and sends the model back to work, until they pass or have failed three times. A branch that passes is committed, pushed and opened as a pull request, and its item moves to `Ready for review`; any other ending moves the item to `Cancelled` with the reason commented on the issue. A rate limit or a backend error pauses the session and resumes it rather than ending it.

### Conventions

Every acceptance criterion is written in EARS (Easy Approach to Requirements Syntax) as Mavin defined it:

- Ubiquitous: `<system> shall <response>`
- Event-driven: `When <trigger>, <system> shall <response>`
- State-driven: `While <state>, <system> shall <response>`
- Unwanted behaviour: `If <trigger>, then <system> shall <response>`
- Optional feature: `Where <feature>, <system> shall <response>`
- Complex: a combination of the clauses above

The system name is `Ramonda` for behaviour shared by every command, the command's name (`setup-profile`, `init`, `setup-project`, `run`) for behaviour of one command, and `the Stop hook` or `the StopFailure hook` for the two hook processes that run inside a Claude Code session. A `Where` clause names a flag or an environment switch of the invocation; a `While` clause names a state that holds during a run.

This document specifies what a user can observe: the commands and their flags, the files Ramonda reads and writes, what it does in git and on Github, what it reports, and when it refuses. Behaviour it does not state — timings, internal file formats, the wording of messages and log lines it does not quote — is left to the implementation.

Text in backticks is verbatim: a flag, a file path, a command line, a key or a message. `<angle brackets>` inside it mark a placeholder. Terms used throughout:

- **base checkout**: the clone a command is run from, whose root is `<workspacePath>`.
- **task**: one issue being worked, from claim to pull request or cancel.
- **branch**: `<issue-#>-<slug>`, the name of a task's branch (Requirement 30).
- **worktree**: `<workspacePath>/.worktrees/<branch>`, the git worktree a task is worked in, whose path is `<worktreePath>`.
- **task state**: the file `<worktreePath>/.claude/ramonda-task.json`, through which `run` and the hooks of a task's session exchange its verdict.
- **claim**: the git ref `refs/ramonda/<branch>` in the Github repository, marking a task as taken.
- **best-effort**: a step whose failure is logged and does not stop the task.
- **failed pass**: a pass of the loop that ends in an error (Requirement 28).
- **the claim guard**: the unwinding in Requirement 19.
- **the Cancel path**: the sequence in Requirement 27.
- **the no-PR budget**: the limit in Requirement 28.

## Requirements

### Requirement 1: Platform and installation

**User Story:** As a user, I want Ramonda to state what it needs and refuse an environment that lacks it, so that a setup mistake surfaces before any work starts.

#### Acceptance Criteria

1. Ramonda shall run on macOS and Linux.
2. If the platform is neither macOS nor Linux, then every command shall refuse to start, `ramonda --version` included, pointing at WSL for Windows.
3. Ramonda shall require Node 20.17 or newer, git on `PATH`, and Claude Code.
4. If the Node running Ramonda is older than the `engines` floor in its own `package.json`, then every command shall refuse to start, naming the version it found and the floor.
5. If git is not on `PATH`, then a command that runs git shall fail, saying git has to be installed.
6. Ramonda shall be installable from a clone of its repository with `npm install`, `npm run build` and `npm link`.
7. When invoked as `ramonda --version`, Ramonda shall print its version.

### Requirement 2: Private repositories and projects only

**User Story:** As a user, I want Ramonda to work only on private repositories and private projects, so that a session with every tool call auto-approved is never driven by an issue a stranger could write.

#### Acceptance Criteria

1. Ramonda shall run every Claude Code session with every tool call auto-approved, on a prompt built from the issue title and body.
2. If the repository is public, then `setup-project` and `run` shall refuse to run.
3. If the project is public, then `setup-project` and `run` shall refuse to run.

### Requirement 3: Commands

**User Story:** As a user, I want four commands with a fixed order, each naming the next, so that setting Ramonda up is one sequence to follow.

#### Acceptance Criteria

1. Ramonda shall provide `setup-profile`, invoked as `ramonda setup-profile [--profile=<profile>]`, which writes one profile of credentials and settings.
2. Ramonda shall provide `init`, invoked as `ramonda init`, which writes a default `ramonda.json` at the repository root and adds Ramonda's entries to `.gitignore`.
3. Ramonda shall provide `setup-project`, invoked as `ramonda setup-project [--gh-owner=<owner>] [--title=<title>] [--gh-project=<number>] [--profile=<profile>] [--yes]`, which creates a Github project or brings an existing one up to date.
4. Ramonda shall provide `run`, invoked as `ramonda run [--profile=<profile>] [--poll-pause=<seconds>] [--model=<model>] [--no-banner]`, which picks up `ramonda`-labelled `Todo` issues one by one, works them unattended in git worktrees, verifies the changes and opens pull requests.
5. When `setup-profile`, `init` or `setup-project` completes its work, it shall end by printing `Next:` followed by the next command in full and the notes that command needs.
6. When `setup-profile` finishes, it shall name `ramonda init`, to be run from inside the repository Ramonda is to work on.
7. When `init` finishes, it shall name `ramonda setup-project`, and say to commit and push `.gitignore` and `ramonda.json` once that command has recorded the project.
8. When `setup-project` finishes with a usable project behind it, it shall name `ramonda run`, repeat the reminder to commit and push `.gitignore` and `ramonda.json`, and say how to queue a task: label an issue `ramonda` and put it in the project's `Todo` column.
9. When `setup-project` ends on a declined confirmation, it shall name no next command.
10. When `run` ends, it shall name no next command.

### Requirement 4: Errors, aborts and terminals

**User Story:** As a user, I want every command to end the same way on an error or an abort, and never to wait for input it cannot get, so that a person and a script can both tell what happened.

#### Acceptance Criteria

1. If an error ends a command, then the command shall print `ramonda: <message>` on stderr and exit with status 1.
2. When `Ctrl-C` is pressed at a question of `setup-profile` or `setup-project`, the command shall print `aborted` on stderr and exit with status 130, having written nothing.
3. If stdin is not a terminal, then `setup-profile` shall exit non-zero before asking anything.
4. If `setup-project` has to ask for the owner or the title and stdin is not a terminal, then it shall exit non-zero, naming `--gh-owner` or `--title`, whichever would have answered the question.
5. If `setup-project` has to ask for confirmation and stdin is not a terminal, then it shall exit non-zero, saying it needs a terminal.
6. While a stream is not a terminal, or `NO_COLOR` is set, or `TERM` is `dumb`, Ramonda shall write that stream without colour.

### Requirement 5: Board vocabulary

**User Story:** As a user, I want the board's label, fields and options fixed, so that what `setup-project` puts on the board and what `run` polls for and writes can never disagree.

#### Acceptance Criteria

1. Ramonda shall use a `Status` single-select field carrying ten options in this order: `Backlog`, `Cancelled`, `Todo`, `In progress`, `Ready for review`, `Ready for test`, `Testing`, `Tested`, `Delivered`, `Done`.
2. Ramonda shall use a `Priority` single-select field carrying four options in this order: `Critical`, `High`, `Medium`, `Low`.
3. Ramonda shall use a `Ramonda-run-ID` text field showing the run that is working an item.
4. Ramonda shall use the repository label `ramonda` to mark an issue as eligible for pickup.
5. Ramonda shall fix the label, the field names, the status options and the priority levels, with no key in `ramonda.json` to change them.
6. `run` shall write only four `Status` options to an item: `In progress` when it claims the item, `Ready for review` once its pull request is open, `Cancelled` when it is cancelled, and `Todo` again when its pickup ends before its task state is written.

### Requirement 6: Profiles

**User Story:** As a user, I want credentials and settings kept as named profiles in my config directory, so that every command can authenticate as whichever of my Github accounts I choose.

#### Acceptance Criteria

1. Ramonda shall keep profiles in `$XDG_CONFIG_HOME/ramonda/credentials` and `$XDG_CONFIG_HOME/ramonda/settings`, `$XDG_CONFIG_HOME` defaulting to `~/.config`.
2. Ramonda shall keep `GH_TOKEN` in `credentials`, and `CLAUDE_BIN`, `DEFAULT_MODEL` and `DEFAULT_POLL_PAUSE` in `settings`, each as a `KEY=value` line in the section of the profile it belongs to.
3. Ramonda shall read a section header `[<profile>]` as a profile and `[default <profile>]` as the default profile, so that `[default]` is a profile named `default` without the marker.
4. If a line other than a comment or a blank line comes before the first section header of either file, then Ramonda shall error, naming the file and the line number without echoing the line.
5. Where `--profile=<profile>` is passed, Ramonda shall use that profile, a blank value reading as the flag omitted.
6. If `--profile` names a profile the `credentials` file does not hold, then Ramonda shall error, naming the profiles it does hold.
7. Where `--profile` is omitted, Ramonda shall use the profile marked default, or the only profile where the `credentials` file holds exactly one.
8. If `--profile` is omitted and the `credentials` file holds several profiles of which not exactly one is marked default, then Ramonda shall error, naming them.
9. Where `--profile` is omitted, while the `credentials` file holds no profile and `GH_TOKEN` is exported non-empty, Ramonda shall run under a profile named `environment` whose values all come from the environment.
10. If `--profile` is omitted, the `credentials` file holds no profile and `GH_TOKEN` is not exported non-empty, then Ramonda shall error, pointing at `ramonda setup-profile`.
11. Ramonda shall resolve each key from the shell environment first, then from the chosen profile's section of the file that owns the key.
12. If `GH_TOKEN` resolves empty or not at all, then Ramonda shall error, naming the profile.
13. If `DEFAULT_POLL_PAUSE` is set to a non-blank value that is not a positive whole number of seconds, then Ramonda shall error, naming where the value came from.
14. Ramonda shall remove `GH_TOKEN`, and every key the `credentials` file defines in any profile, from the environment of every Claude Code session, `verify` command and `worktree.prepare` command it runs.

### Requirement 7: `setup-profile` questions

**User Story:** As a user, I want `setup-profile` to ask for one profile's credentials and settings in a fixed order, so that I never edit the profile files by hand.

#### Acceptance Criteria

1. `setup-profile` shall ask, in this order, for the profile to write, `GH_TOKEN`, `CLAUDE_BIN`, `DEFAULT_MODEL`, `DEFAULT_POLL_PAUSE`, and whether the profile is the default.
2. If either profile file cannot be parsed, then `setup-profile` shall refuse before the first question rather than rewrite it.
3. Where `--profile` is passed, `setup-profile` shall skip the profile question, refusing a name that holds a space or a bracket.
4. Where `--profile` is omitted, while the `credentials` file holds profiles, `setup-profile` shall offer them as a list, the default one marked, with a last entry that creates a new profile.
5. Where `--profile` is omitted, while the `credentials` file holds no profile, `setup-profile` shall ask for the name of a new one.
6. If a typed profile name holds a space or a bracket, then `setup-profile` shall ask again.
7. When the flag or the list names a profile the files already hold, `setup-profile` shall offer that profile's current values as the defaults of the remaining questions.

### Requirement 8: `setup-profile` answers

**User Story:** As a user, I want each answer checked before it is saved, so that a token, a binary or a pause that cannot work is caught at setup rather than at the first run.

#### Acceptance Criteria

1. While the profile holds a `GH_TOKEN`, `setup-profile` shall open the token question filled in with it, so that submitting it unchanged keeps it.
2. `setup-profile` shall ask for the token as an editable answer showing each character as `*`, saying it has to be a classic token carrying the `repo` and `project` scopes.
3. When a token is settled, `setup-profile` shall check it with Github's `GET /user`, and accept it where it carries the `repo` and `project` scopes.
4. If Github rejects the token, or it lacks either scope, then `setup-profile` shall say why and ask for another.
5. If Github reports no scopes for the token, as it does for a fine-grained or Github App token, then `setup-profile` shall say why and ask `Save it anyway?`, defaulting to no.
6. If the check cannot be made, then `setup-profile` shall say so and ask `Save it anyway?`, defaulting to yes.
7. When `Save it anyway?` is answered no, `setup-profile` shall ask for another token.
8. `setup-profile` shall default the `CLAUDE_BIN` question to the profile's value, or else to the `claude` executable found on `PATH`.
9. When a `CLAUDE_BIN` answer is given, `setup-profile` shall run it with `--version`, saying why and asking again until an answer runs.
10. When the `CLAUDE_BIN` answer is the plain name `claude` or the executable `PATH` already finds, `setup-profile` shall store no `CLAUDE_BIN`.
11. `setup-profile` shall offer as `DEFAULT_MODEL` the full model IDs the installed Claude Code reports for its `/model` aliases, without duplicates, alongside a choice to store no `DEFAULT_MODEL` and a choice to type a value.
12. While the profile holds a `DEFAULT_MODEL` the list does not carry, `setup-profile` shall add it to the list.
13. If the models cannot be listed, then `setup-profile` shall warn and ask for a typed value instead.
14. `setup-profile` shall accept as `DEFAULT_POLL_PAUSE` a blank answer, meaning `60`, or a positive whole number of seconds, and ask again on anything else.
15. While the profile is the only one in the `credentials` file, or is already the default, `setup-profile` shall make it the default without asking.
16. While other profiles exist and this one is not the default, `setup-profile` shall ask whether to make it the default, defaulting to yes where no other profile is.

### Requirement 9: Writing the profile files

**User Story:** As a user, I want `setup-profile` to edit the files in place and tell me what it wrote, so that my comments and other profiles survive and I can see the result.

#### Acceptance Criteria

1. When every question is answered, `setup-profile` shall write `GH_TOKEN` to the profile's section of `credentials` and the other three keys to its section of `settings`, adding a section where a file has none.
2. `setup-profile` shall edit each file in place, keeping its comments, the sections of other profiles and the keys Ramonda does not own.
3. When an answer falls back to the built-in default, `setup-profile` shall remove the key rather than write it.
4. When the profile is made the default, `setup-profile` shall remove the default marker from every other profile in both files.
5. If a value cannot be written so that it reads back intact, then `setup-profile` shall refuse before writing either file.
6. `setup-profile` shall leave the config directory at mode 0700 and both files at mode 0600.
7. When the files are written, `setup-profile` shall print each file's path and each of its keys for the profile, `GH_TOKEN` as one `*` per character and a removed key shown as using the default.

### Requirement 10: `init`

**User Story:** As a user, I want `init` to write a default `ramonda.json` and the `.gitignore` entries Ramonda needs, so that the repository is ready for `setup-project`.

#### Acceptance Criteria

1. `init` shall write at the repository root, found with `git rev-parse --show-toplevel`, whichever subdirectory it is run from.
2. If `init` is run outside a git repository, then it shall fail, saying to run it from inside one.
3. `init` shall append to the root `.gitignore`, under a `# ramonda` comment, whichever of `.claude/AGENT_TASK.md`, `.claude/ramonda-task.json`, `.claude/ramonda-task.json.*`, `.claude/settings.local.json` and `.worktrees/` git does not already ignore, creating the file where there is none.
4. `init` shall update `.gitignore` before writing `ramonda.json`.
5. `init` shall not `git add`, commit or push.
6. If `ramonda.json` already exists, then `init` shall refuse to overwrite it.
7. `init` shall write this `ramonda.json`:

   ```json
   {
     "baseBranch": "main",
     "project": {
       "owner": "",
       "number": 0
     },
     "worktree": {
       "filesToCopy": [],
       "prepare": [
         {
           "command": "npm install",
           "timeout": 600000
         }
       ]
     },
     "verify": [
       {
         "command": "npm test",
         "timeout": 600000
       }
     ]
   }
   ```

8. When `ramonda.json` is written, `init` shall print it, and say that `worktree.prepare` and `verify` are to be changed to this repository's own install command and checks, and that `worktree.filesToCopy` is for the gitignored files the repository reads.

### Requirement 11: `ramonda.json`

**User Story:** As a user, I want `ramonda.json` to declare the base branch, the project, what makes a worktree workable and the checks a change must pass, so that `run` needs no flags and every task is verified the way this repository verifies.

#### Acceptance Criteria

1. Ramonda shall read `ramonda.json` from the repository root.
2. If `ramonda.json` is missing, then the command shall refuse, pointing at `ramonda init`.
3. If `ramonda.json` is not a valid JSON object, then the command shall refuse, naming the file.
4. If a required key is missing or holds the wrong shape, then the command shall refuse, naming the file and the key.
5. Ramonda shall require every key, except `timeout` on a `worktree.prepare` or `verify` entry.
6. Ramonda shall require `baseBranch` to be a non-empty string, cut every task branch from `origin/<baseBranch>`, and target every pull request at `<baseBranch>`.
7. Ramonda shall require `project.owner` to be a string and `project.number` a non-negative integer, naming the project the repository's tasks live on, and holding `""` and `0` until `setup-project` records it.
8. Ramonda shall require `worktree.filesToCopy` to be an array, possibly empty, of paths relative to the repository root, naming the gitignored files a task's worktree needs copied from the base checkout.
9. Ramonda shall require `worktree.prepare` to be an array, possibly empty, of `{ "command", "timeout" }` entries, run in order in a task's worktree before its session starts.
10. Ramonda shall require `verify` to be an array, possibly empty, of `{ "command", "timeout" }` entries, the checks a task must pass before its pull request is opened.
11. Ramonda shall require a `timeout` to be a positive integer of milliseconds, defaulting to `600000`.
12. Ramonda shall run every `worktree.prepare` and `verify` command through `sh -c` at the worktree root.
13. If a `worktree.prepare` or `verify` command runs past its timeout, then Ramonda shall kill its process group and count the command as failed.

### Requirement 12: `setup-project`: which project

**User Story:** As a user, I want a bare `ramonda setup-project` to bring up to date the project `ramonda.json` records, and to create one only where the file records none, so that a re-run repairs the board I have instead of building a second one.

#### Acceptance Criteria

1. `setup-project` shall accept `--gh-owner=<owner>`, `--title=<title>`, `--gh-project=<number>`, `--profile=<profile>` and `--yes`, all optional, a blank `--gh-owner`, `--title` or `--profile` reading as the flag omitted.
2. If `--gh-project` is not a positive integer, then `setup-project` shall refuse with the usage line.
3. `setup-project` shall work on the project `--gh-project` names, or else on the one `project.number` records where it is above zero, and shall create a new project where neither names one.
4. `setup-project` shall take the owner from `--gh-owner`, or else from `project.owner`, or else by asking, defaulting to the repository's own owner and accepting only a bare Github login as the answer.
5. While a project is to be created, `setup-project` shall take its title from `--title`, or else by asking, defaulting to the repository's name.
6. If `--title` is passed while an existing project is settled, then `setup-project` shall refuse with the usage line.
7. While `ramonda.json` records both the owner and the project, a bare `ramonda setup-project` shall ask nothing but the confirmation of Requirement 13.

### Requirement 13: `setup-project`: checks, plan and confirmation

**User Story:** As a user, I want `setup-project` to know the whole plan before it changes anything, to ask me first, and to remove the board automation that fights Ramonda, so that nothing on the board changes without my seeing what will, and a finished task is neither dragged back to `In progress` nor pushed past testing and delivery to `Done`.

#### Acceptance Criteria

1. If `setup-project` is run outside a git repository, or in one whose `origin` is missing or is not an SSH or HTTPS URL on `github.com`, then it shall refuse.
2. `setup-project` shall read `ramonda.json` before settling the project.
3. `setup-project` shall check that the repository is private before planning anything.
4. If the owner is not a user or organization the token can see, or holds no project of the settled number, then `setup-project` shall refuse.
5. If an existing project is public, then `setup-project` shall refuse before planning.
6. `setup-project` shall plan these actions in this order, each only where it is needed: create the `ramonda` label, delete the project's `Pull request linked to issue`, `Auto-close issue`, `Item closed` and `Pull request merged` workflows, create the `Ramonda-run-ID` text field, create or complete `Status`, create or complete `Priority`.
7. If `Status` or `Priority` is missing, then the plan shall create it as a single-select field holding all of its options in order.
8. While an existing project carries `Status` or `Priority`, the plan shall add the options the field lacks, matched by exact name, and leave its existing options unchanged.
9. If a field Ramonda needs exists under the wrong type, then `setup-project` shall refuse, saying to delete or rename it.
10. `setup-project` shall recognise the workflows to delete by their names alone, and leave every other workflow alone.
11. While a project is to be created, the plan shall list its creation and the label, and state the field and workflow work as a summary to be settled once the project exists.
12. When the plan holds a change, `setup-project` shall print the plan before making the first one, under `--yes` too.
13. Where `--yes` is omitted, `setup-project` shall ask `Apply?`, defaulting to yes, before the first change.
14. If confirmation is answered no, then `setup-project` shall print `aborted` and exit with status 0, having changed nothing.
15. When the plan holds nothing, `setup-project` shall say the project already matches, then check and record it as Requirement 14 specifies.

### Requirement 14: `setup-project`: create, apply, check and record

**User Story:** As a user, I want the project created private with Ramonda's exact vocabulary, checked the way `run` checks it, and recorded in `ramonda.json`, so that `ramonda run` starts against it with no flags.

#### Acceptance Criteria

1. While no project is settled, `setup-project` shall create a private project under the owner, linked to the repository.
2. When it has created a project, `setup-project` shall set `Status`, and `Priority` where Github created one, to exactly Ramonda's options in order, replacing the options Github seeded.
3. While setting the options of a project it created, `setup-project` shall keep an existing option whose name matches a wanted one case-insensitively, renaming it in place rather than replacing it.
4. `setup-project` shall apply the planned actions in order, reporting each as it is done.
5. When the actions are applied, or the project already matched, `setup-project` shall check the project's visibility and its `Ramonda-run-ID` and `Status` fields as Requirement 16 specifies.
6. When the project passes that check, `setup-project` shall write its owner and number to `project.owner` and `project.number` in `ramonda.json`, keeping every other key as it was, and leaving the file untouched where it already holds them.
7. If confirmation was declined, then `setup-project` shall neither check nor record the project.

### Requirement 15: `run` flags

**User Story:** As a user, I want `ramonda run` to take everything from the profile and `ramonda.json`, so that the everyday invocation is bare.

#### Acceptance Criteria

1. `run` shall accept `--profile=<profile>`, `--poll-pause=<seconds>`, `--model=<model>` and `--no-banner`, all optional.
2. Where `--poll-pause` is passed, `run` shall wait that many seconds before polling again after a pass that found no task or failed.
3. Where `--poll-pause` is omitted, `run` shall use `DEFAULT_POLL_PAUSE`, or `60` where that is unset.
4. If `--poll-pause` is not a positive whole number, then `run` shall exit non-zero with the usage line.
5. Where `--model` is passed, `run` shall start every session with that model.
6. Where `--model` is omitted, `run` shall use `DEFAULT_MODEL`, or leave the model to Claude Code where that is unset.
7. If `--model` is empty or whitespace, then `run` shall refuse.
8. Where `--no-banner` is passed, `run` shall print no banner.
9. `run` shall poll the project that `project.owner` and `project.number` record in `ramonda.json`.
10. If `project.owner` or `project.number` is unset, then `run` shall refuse, pointing at `ramonda setup-project`.

### Requirement 16: `run` startup

**User Story:** As a user, I want every setup mistake refused before the run claims anything, and the ones Ramonda can find on its own reported before the banner, so that a run that cannot work fails at once and plainly.

#### Acceptance Criteria

1. `run` shall make every check of this requirement that needs neither Github nor Claude Code before it prints the banner.
2. If Ramonda's hook entry files are missing from its build, then `run` shall refuse, saying to rebuild with `npm run build`.
3. If `run` is started outside a git repository, or in one whose `origin` is missing or is not an SSH or HTTPS URL on `github.com`, then it shall refuse.
4. `run` shall read `ramonda.json` as Requirement 11 specifies, whatever branch and uncommitted changes the base checkout holds.
5. If git does not ignore every `.gitignore` entry of Requirement 10 in the base checkout, then `run` shall refuse, naming the missing entries and pointing at `ramonda init`.
6. If a `worktree.filesToCopy` path is not ignored in the base checkout, then `run` shall refuse, naming it.
7. When those checks pass, `run` shall print a banner, unless `--no-banner` is passed or stdout is not a terminal.
8. When the banner step is done, `run` shall open its main log and check that the Claude Code binary runs with `--version` and that its `--help` lists `--session-id` and `--permission-mode`, refusing otherwise.
9. When the binary passes its checks, `run` shall read the account `GH_TOKEN` belongs to, refusing where it cannot.
10. If the repository is public or lacks the `ramonda` label, then `run` shall refuse.
11. If the project cannot be found, is public, lacks a `Ramonda-run-ID` text field, or lacks a `Status` single-select field carrying `Todo`, `In progress`, `Ready for review` and `Cancelled`, then `run` shall refuse.
12. If the project lacks a `Priority` single-select field carrying all four priority levels, then `run` shall refuse, pointing at `ramonda setup-project`.
13. If `Priority` carries options beyond the four, then `run` shall warn that issues on them are never picked up, and carry on.
14. If `<baseBranch>` does not resolve in the Github repository, then `run` shall refuse.
15. When startup is complete, `run` shall enter the loop.

### Requirement 17: Logging

**User Story:** As a user, I want every run and every task to write its own log, and the terminal to show what a session is doing, so that I can follow a run live and reconstruct it afterwards.

#### Acceptance Criteria

1. `run` shall identify each run as `<runId>`, `<hostname>-<pid>-<timestamp>`, the timestamp in UTC to the second.
2. `run` shall log the run to `~/.local/state/ramonda/logs/<runId>_main.log`, and each task to `~/.local/state/ramonda/logs/<runId>/<branch>.log`.
3. Ramonda shall timestamp every line of a log file, and create the log files readable by the user alone.
4. `run` shall report its progress on the terminal: its start, each claim and pickup, each wait, each task's outcome, each idle sleep and its end.
5. While a session runs, `run` shall log to the terminal and the task log a one-line summary of each event the session reports — its start and model, the model's text and tool calls, and its result — and each line the session writes to stderr.
6. `run` shall record in the main log the Github rate-limit usage of each call it makes.
7. Where `RAMONDA_LOG_STDOUT=1` is set, `run` shall mirror every line of its logs to the terminal.
8. If a log write fails, then Ramonda shall report it on stderr and carry on.
9. Ramonda shall leave the full session transcript where Claude Code keeps it, under `~/.claude/projects/`.
10. The Stop hook shall log to the task's log file alone.

### Requirement 18: Polling

**User Story:** As a user, I want each pass to fetch the eligible issues highest priority first, so that Ramonda works the most urgent unclaimed task and idles cheaply when there is none.

#### Acceptance Criteria

1. When a pass starts, `run` shall query the project for the open issues of this repository that carry the `ramonda` label and the `Status` `Todo`.
2. `run` shall query one `Priority` level at a time, `Critical` first and `Low` last, and take the first level that yields an issue, in the project's own order.
3. When no level yields an issue, `run` shall query the issues carrying no `Priority`, and take them oldest first.
4. `run` shall ignore project items that are not issues.
5. `run` shall skip an issue this process finished with in the last 10 seconds.
6. When a pass finds no issue to work, `run` shall wait the poll pause and poll again.
7. When a task ends, `run` shall start the next pass right away.
8. If a Github call answers a server error or a secondary rate limit, then Ramonda shall retry it up to three times before failing, `setup-profile`'s token check aside.

### Requirement 19: Claiming

**User Story:** As a user, I want a claim to be one atomic ref creation on Github, and every claim released however the task ends, so that two Ramonda processes can never take the same task and no task is left claimed by nobody.

#### Acceptance Criteria

1. `run` shall claim a task by creating `refs/ramonda/<branch>` in the Github repository, trying the pass's issues in order.
2. When the ref already exists, `run` shall try the next issue.
3. When every issue is already claimed, `run` shall wait the poll pause and poll again.
4. When a claim is won, `run` shall write `<runId>` to `Ramonda-run-ID` and move the item to `In progress`, both best-effort.
5. `run` shall never read `Ramonda-run-ID`.
6. `run` shall release a claim by deleting its ref, a ref already gone counting as released, then clearing `Ramonda-run-ID`, both best-effort.
7. If a claim cannot be released, then `run` shall say how to delete the ref by hand.
8. If an error ends a task before its task state is written, then `run` shall move the item back to `Todo`, release the claim, and fail the pass.
9. If an error ends a task whose task state carries neither `completedAt` nor `cancelledAt`, then `run` shall run the Cancel path with the reason `ramonda error: <message>`, and fail the pass.
10. If an error ends a task whose task state carries `completedAt` or `cancelledAt`, then `run` shall release the claim, leave the item's status as it is, and fail the pass.
11. If a stop is requested between winning a claim and writing the task state, then `run` shall move the item back to `Todo`, release the claim, and end the run without a Cancel.

### Requirement 20: Worktree preparation

**User Story:** As a user, I want every task to run in its own worktree cut from the base branch, seeded with the untracked state my checks need, so that the checkout I work in is never touched and a fresh tree can run my `verify` commands.

#### Acceptance Criteria

1. When a claim is won, `run` shall run `git fetch origin` in the base checkout.
2. `run` shall not check out a branch, touch the index, or change a file of the base checkout outside `.worktrees/`.
3. While the worktree does not exist, `run` shall add it on `<branch>`, creating the branch from `origin/<baseBranch>` where it does not exist locally.
4. While the worktree exists, `run` shall reuse it on `<branch>`, keeping its commits and ignored files and discarding every other uncommitted change.
5. When a reused worktree held uncommitted changes, `run` shall log what it discarded.
6. If the worktree path exists but is not a git worktree, then `run` shall fail the pass.
7. When the worktree is ready, `run` shall check that git ignores every `.gitignore` entry of Requirement 10 inside it.
8. If it does not, then `run` shall move the item back to `Todo`, release the claim and end the run, saying that `.gitignore` has to be committed and pushed to `origin/<baseBranch>`.
9. When the worktree passes the check, `run` shall copy every `worktree.filesToCopy` path from the base checkout into it, directories whole and symlinks as symlinks.
10. If a `worktree.filesToCopy` path does not exist in the base checkout, then `run` shall warn and skip it.
11. When the copies are made, `run` shall run the `worktree.prepare` commands in order, in its own environment with the credentials removed as Requirement 6 specifies.
12. If a `worktree.prepare` command fails, then `run` shall log its output to the task log, run none of the rest, and fail the pass.

### Requirement 21: Session start

**User Story:** As a user, I want each session handed a brief, its hooks and a task state inside its worktree, so that the session and its hooks know the task without any credential reaching them.

#### Acceptance Criteria

1. When the worktree is seeded, `run` shall write `<worktreePath>/.claude/AGENT_TASK.md` holding the issue title and number, the branch, the issue body or `(no description provided)`, instructions to implement the task on the branch and to stop when done so that the Stop hook can verify it, and `Closes #<issue-#>`.
2. `run` shall give the session the text of `AGENT_TASK.md` as its prompt.
3. `run` shall install its Stop and StopFailure hooks in `<worktreePath>/.claude/settings.local.json`, replacing the entries an earlier task installed and keeping every other setting.
4. `run` shall write the task state with a fresh session ID, the task's issue, branch and repository, the project IDs the Cancel path and publishing need, and a verify failure count of zero, and with no credential.
5. `run` shall start the session in the worktree with stdin detached, `<bin>` being `CLAUDE_BIN`, or `claude` where it is unset:

   ```
   <bin> --session-id <claudeSessionId> \
         [--model <model>] \
         --permission-mode bypassPermissions \
         --output-format stream-json --verbose \
         --print "<task-brief-text>"
   ```

6. `run` shall start the session with the credentials removed from its environment as Requirement 6 specifies, and with `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` set to the account of Requirement 26.

### Requirement 22: Session verdicts

**User Story:** As a user, I want the loop to act on whatever the session's hooks report, and on a session that ends without a report, so that every session ends in a pull request, a wait or a cancel.

#### Acceptance Criteria

1. While a session runs, `run` shall watch the task state for a signal from the session's hooks: `limitHit`, `sessionError`, `verifyGaveUp` or `emptyDiff`.
2. When a session whose hooks recorded no signal ends on an API error its output reports, `run` shall take the signal the StopFailure hook records for that error type as its signal.
3. When a signal appears, `run` shall stop the session with `SIGTERM`, and with `SIGKILL` where it is still running five seconds later.
4. When the session ends with `verifyPassedAt` set and no signal, `run` shall publish the branch as Requirement 26 specifies.
5. When the session ends on `limitHit`, `run` shall wait and resume it as Requirement 23 specifies.
6. When the session ends on `sessionError`, `verifyGaveUp` or `emptyDiff`, `run` shall run the Cancel path.
7. When the session ends with no signal and neither `verifyPassedAt` nor `cancelledAt` set, `run` shall run the Cancel path as a session with no verdict.
8. While a stop is requested, when the session ends with no signal and no `verifyPassedAt`, `run` shall cancel it as a stop instead.

### Requirement 23: Rate limits and backend errors

**User Story:** As a user, I want a session to survive rate limits and backend errors by waiting and resuming, so that a limit hit is a pause rather than lost work.

#### Acceptance Criteria

1. When a session ends on a `rate_limit` hit, `run` shall wait until the reset time the session's output reports, or else the one its transcript records, waiting no more than 8 hours and no less than 60 seconds.
2. If neither the output nor the transcript yields a reset time, then `run` shall wait 5 hours and warn that it fell back to that wait.
3. When a session ends on an `overloaded` or `server_error` hit, `run` shall wait 30 seconds, then 1, 2, 5 and 15 minutes on consecutive hits, staying at 15 minutes.
4. When a `rate_limit` hit occurs, or a backend hit ends a session in which the model had responded, `run` shall start that backoff over.
5. When a wait begins, `run` shall log the error type and the length of the wait.
6. When a wait ends, `run` shall resume the session with `--resume <claudeSessionId>` in place of `--session-id`, on the prompt `Rate limit / backend error cleared. Continue where you left off on this task.`
7. If a stop is requested during a wait, then `run` shall end the wait and cancel the task as a stop.

### Requirement 24: The Stop hook

**User Story:** As a user, I want the repository's own checks run every time the model stops, and the model sent back to work on a failure, so that a pull request is opened only for work that passes them.

#### Acceptance Criteria

1. When the model stops, the Stop hook shall run the `verify` commands of the base checkout's `ramonda.json` in order in the worktree, stopping at the first that fails.
2. The Stop hook shall hold no credential, make no network call and run no git command that writes.
3. While the task state is missing, or carries `completedAt`, `cancelledAt` or `verifyPassedAt`, the Stop hook shall do nothing.
4. If a `verify` command fails or times out for the first or second time on the task, then the Stop hook shall block the stop, handing the model the command, how it failed, its output and the failure count.
5. If a `verify` command fails or times out for the third time on the task, then the Stop hook shall record `verifyGaveUp` with the command's output and let the session end.
6. When every `verify` command passes, the Stop hook shall record `emptyDiff` where the worktree holds no uncommitted change and no commit beyond the base branch, and `verifyPassedAt` otherwise.
7. While `verify` is empty, the Stop hook shall pass.
8. If the Stop hook fails for any other reason, then it shall record a non-fatal `sessionError` of type `hook_failed` and exit with status 1.
9. The Stop hook shall write nothing to stdout but its block decision.

### Requirement 25: The StopFailure hook

**User Story:** As a user, I want an API error inside the session classified and recorded, so that the loop can wait and resume, abandon the task, or stop the run, by the kind of error.

#### Acceptance Criteria

1. When a session stops on an API error, the StopFailure hook shall read the error type from its payload, reading an unreadable payload as `unknown`.
2. When the error type is `rate_limit`, `overloaded` or `server_error`, the StopFailure hook shall record `limitHit`.
3. When the error type is `authentication_failed`, `oauth_org_not_allowed`, `billing_error` or `model_not_found`, the StopFailure hook shall record a fatal `sessionError`.
4. When the error type is any other, the StopFailure hook shall record a non-fatal `sessionError`.
5. While the task state is missing, or carries `completedAt` or `cancelledAt`, the StopFailure hook shall do nothing.

### Requirement 26: Publishing

**User Story:** As a user, I want verified work committed under my token's account, pushed, and opened as a pull request against the base branch, with `.gitignore` alone deciding what it carries, so that every task ends in a review I can act on and my secrets are governed by the file I already maintain.

#### Acceptance Criteria

1. When a session ends with `verifyPassedAt` set, `run` shall publish the branch, even while a stop is requested.
2. If the base checkout's `origin` no longer points at the task's repository on `github.com`, then `run` shall refuse to push, run the Cancel path, and stop the run.
3. `run` shall stage everything in the worktree with `git add -A`, filtering nothing it stages.
4. While the worktree holds uncommitted changes, `run` shall commit them with the issue title as the subject, cut to 72 characters, and `Closes #<issue-#>` in the body.
5. While the worktree holds no uncommitted change, `run` shall publish the commits the session made.
6. `run` shall push `<branch>` to `origin`, authenticating an HTTPS push with `GH_TOKEN` without putting the token on the command line.
7. `run` shall open a pull request from `<branch>` into `<baseBranch>`, titled with the issue title, its body `Closes #<issue-#>` followed by the `verify` commands that passed.
8. If a pull request from `<branch>` is already open, then `run` shall use it.
9. When the pull request is open, `run` shall move the item to `Ready for review`, best-effort, re-applying the move where a project workflow overwrites it, up to three attempts.
10. If the move does not stay, then `run` shall warn.
11. When the status is handled, `run` shall release the claim, record `completedAt` in the task state, and report the pull request's URL.
12. If the push or the pull request fails, then `run` shall hand the error to the claim guard.
13. Ramonda shall commit, push, open pull requests, move project items and comment on issues as the account `GH_TOKEN` belongs to, taking the commit name and email from that account, or its login and its `<id>+<login>@users.noreply.github.com` address where it has none.

### Requirement 27: The Cancel path

**User Story:** As a user, I want a task that cannot end in a pull request marked `Cancelled` on the board with the reason on the issue, so that nothing is silently dropped and the worktree is left for a retry.

#### Acceptance Criteria

1. `run` shall run the Cancel path on a `sessionError`, on `verifyGaveUp` or `emptyDiff`, on a refused publish, on a session that ended with no verdict, on a stop while a task is in its session, and on an error the claim guard catches after the task state is written.
2. `run` shall run the Cancel path only once the session has ended.
3. `run` shall move the item to `Cancelled`, release the claim, and comment `Cancelled by ramonda (<timestamp>): <reason>` on the issue, each best-effort, then record `cancelledAt` in the task state.
4. `run` shall word `<reason>` by its cause:
   - a `sessionError`: `<errorType>`, or `<errorType>: <message>` where it carries a message
   - `verifyGaveUp`: `3 verify failures — last stderr: <output>`
   - `emptyDiff`: `model produced no diff`
   - a refused publish: `origin_mismatch: refusing to push — <detail>`
   - a session with no verdict: `session ended without a verdict — the Stop hook did not complete`
   - a stop: `SIGINT at terminal`, or `stopped by <signal>` for any other signal
   - an error the claim guard caught: `ramonda error: <message>`
5. `run` shall leave the worktree in place with its commits.
6. When the Cancel path ends after a non-fatal `sessionError`, `verifyGaveUp`, `emptyDiff` or a session with no verdict, `run` shall count the task against the no-PR budget and continue the loop.
7. When the Cancel path ends after a fatal `sessionError` or a refused publish, `run` shall stop and exit non-zero.
8. When the Cancel path ends after a stop, `run` shall exit cleanly.
9. When the Cancel path ends after an error the claim guard caught, `run` shall handle the error as a failed pass.

### Requirement 28: Failure handling and the no-PR budget

**User Story:** As a user, I want a failed pass retried after the poll pause, and the run stopped after three tasks in a row produce no pull request, so that a broken setup does not burn sessions all night.

#### Acceptance Criteria

1. When a pass fails, `run` shall log the error, wait the poll pause and poll again.
2. If three tasks in a row open no pull request, cancelled tasks and failed passes alike, then `run` shall exit non-zero, naming each of the three and why it produced none.
3. When a task opens a pull request, `run` shall reset that count.
4. If the worktree's `.gitignore` check of Requirement 20 fails, then `run` shall end the run on the first failure without counting it.
5. While a stop is requested, when a task ends without an error, `run` shall not count it.

### Requirement 29: Stopping

**User Story:** As a user, I want `Ctrl-C` or a supervisor's `SIGTERM` to end the run cleanly, so that a task in flight is cancelled, commented and released rather than abandoned mid-write.

#### Acceptance Criteria

1. `run` shall treat `SIGINT` and `SIGTERM` alike, as a request to stop rather than a failure.
2. When a stop is requested while a session runs, `run` shall stop the session with `SIGTERM`, and with `SIGKILL` where it is still running five seconds later, and cancel the task unless it has already passed `verify`.
3. When a stop is requested during a poll pause, `run` shall exit without sitting out the pause.
4. If a stop signal arrives before the loop starts, then Ramonda shall end at once.

### Requirement 30: Branch names

**User Story:** As a user, I want one slug of the issue title naming the branch, the worktree, the task log and the claim, so that the four are always found together.

#### Acceptance Criteria

1. Ramonda shall slug an issue title by lowercasing it, replacing every run of characters outside `a-z` and `0-9` with `-`, trimming `-` from both ends, and cutting it to 50 characters with no trailing `-`.
2. If a title yields an empty slug, then Ramonda shall use `task`.
3. Ramonda shall name a task's branch, its worktree directory, its task log and its claim ref after `<issue-#>-<slug>`.
