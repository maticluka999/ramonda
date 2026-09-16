/**
 * The one Github deployment ramonda works against.
 *
 * These two are a pair: `api.github.com` is the API fronting repos hosted on
 * `github.com`. A repo whose origin names any other host — a Github Enterprise
 * instance, a mirror, another forge entirely — is refused at startup rather than
 * worked against an API that does not hold it.
 */
export const GITHUB_HOST = 'github.com';

export const GITHUB_API_URL = 'https://api.github.com';

/**
 * The issue label an issue needs before ramonda will pick it up.
 *
 * Fixed rather than configurable. It is one name on one repo, carrying no
 * meaning beyond "ramonda works this", and the only thing a per-repo setting
 * ever bought was a way for the label the poll filters on and the label
 * `setup-project` creates to drift apart — a repo that then polls forever
 * against a label no issue carries. `setup-project` creates it, so it is a name
 * nobody has to type.
 */
export const TASK_LABEL = 'ramonda';

/**
 * The project fields ramonda reads by name, fixed for the same reason the label
 * is: `setup-project` creates all three, so none is a name anyone has to supply,
 * and a configurable one only ever let the field the poll filters on drift from
 * the field that was created. `Status` is also what Github puts on a new project
 * of its own accord, so the default was never really a choice.
 *
 * Both go into the item filter as bare keys — `status:"Todo"` — which is why
 * neither may hold a space or a quote: one would end the key and start a second
 * filter term rather than extend the name.
 */
export const STATUS_FIELD = 'Status';

export const PRIORITY_FIELD = 'Priority';

/**
 * The `Status` column names, in board order, fixed for the same reason the field
 * itself is.
 *
 * Only four are ramonda's to drive: it polls `todo` and writes `inProgress`,
 * `readyForReview` and `cancelled`. The rest are the human half of the lifecycle
 * — `backlog` ahead of the queue, `readyForTest` through `done` behind it.
 * `setup-project` creates all ten so a board is complete in one command, and
 * `run` never reads or asserts the other six.
 *
 * The order is the board's, and `cancelled` sits out of the working lane rather
 * than at the end of it: `todo` through `done` is the path a task takes, and
 * a column for work that left that path early reads better beside `backlog` than
 * past the finish line.
 *
 * Not configurable, for the same reason the field names and the label are not.
 * These only ever had to agree with each other: the column `setup-project`
 * creates and the column the poll filters on are the same column, and a per-repo
 * spelling of them bought nothing but a way for the two to drift — a repo
 * polling forever on a name no option carries. `setup-project` puts them on the
 * board, so they are names nobody has to type.
 */
export const STATUS_VALUES = {
  backlog: 'Backlog',
  cancelled: 'Cancelled',
  todo: 'Todo',
  inProgress: 'In progress',
  readyForReview: 'Ready for review',
  readyForTest: 'Ready for test',
  testing: 'Testing',
  tested: 'Tested',
  delivered: 'Delivered',
  done: 'Done',
} as const;

/** A column's role on the board — the key half of `STATUS_VALUES`. */
export type StatusRole = keyof typeof STATUS_VALUES;

/**
 * The `Priority` options, highest first — which is also the order the poll walks
 * them in, one query per level, taking the first that yields an issue.
 *
 * Fixed, like the status columns and for the same reason: `setup-project` puts
 * these on the board and the poll filters on them, so the only thing they have
 * to do is agree with each other. A per-repo list would buy nothing but a way
 * for the two to disagree — a value spelled one way in config and another on the
 * project polls forever against an option no issue carries — in exchange for a
 * choice almost nobody wants to make. Four levels is the vocabulary every
 * tracker converges on anyway.
 */
export const PRIORITY_VALUES = ['Critical', 'High', 'Medium', 'Low'] as const;

/**
 * What a task found by the untriaged pass is reported as, where every other one
 * is reported by the level whose query turned it up.
 *
 * Deliberately not a level name, and deliberately not blank: the board carries
 * no such option and nothing ever writes it, so a `[priority=(none)]` on a
 * pickup line says "this issue was queued without a priority" rather than
 * naming a fifth column somebody would go looking for. Kept out of
 * `PRIORITY_VALUES` for the same reason — that list is the vocabulary
 * `setup-project` puts on the board and `run` asserts against it.
 */
export const NO_PRIORITY = '(none)';

/**
 * Which run is working the item, for the board to show. **Not** the claim — the
 * claim is a git ref, see `CLAIM_REF_PREFIX`.
 *
 * Written once after a claim is won and cleared once the task ends, both
 * best-effort, and never read back. That is the whole of its contract, and it is
 * what keeps a value left behind by a crashed run cosmetic: nothing filters on
 * this field, so a stale one is a wrong name on a card until the next run to take
 * the issue overwrites it, rather than an item nothing can ever see again.
 */
export const BOT_FIELD = 'Ramonda-run-ID';

/**
 * Where the claim lives: `refs/ramonda/<branch>`, one ref per task.
 *
 * Creating a ref is the only atomic compare-and-swap Github offers. ProjectV2
 * field mutations take no precondition — `updateProjectV2ItemFieldValue` accepts
 * a value and nothing else — so a claim built on a field can only ever be
 * read-then-write, which is a race however much settling time is put between the
 * two halves. `POST /git/refs` answers 201 exactly once and `422 Reference
 * already exists` to everyone after, in one call, with no read and nothing to
 * confirm.
 *
 * Outside `refs/heads/` so it is not a branch: it does not appear in the branch
 * list, in a PR's base picker, or in anything else that enumerates branches. It
 * is visible to `git ls-remote`, which is what makes a claim left behind by a
 * killed process something an operator can find and delete.
 */
export const CLAIM_REF_PREFIX = 'refs/ramonda/';
