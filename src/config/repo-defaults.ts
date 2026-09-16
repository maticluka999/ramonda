import type { RepoConfig } from '../types.js';
import { DEFAULT_COMMAND_TIMEOUT_MS } from './repo.js';

/**
 * The file `ramonda init` writes.
 *
 * Not fallbacks: a key a repo leaves out is refused at load, or defaulted there
 * — never read from here. These are the values a repo *starts* from, which is
 * the whole reason `init` exists.
 */
export const DEFAULT_REPO_CONFIG: RepoConfig = {
  baseBranch: 'main',
  project: {
    // Filled in by `setup-project`, which is the command that resolves them.
    // Empty here rather than absent: the file is the record of how this repo is
    // wired, and "no project yet" is worth being able to read in it.
    owner: '',
    number: 0,
  },
  // `npm install`, because a worktree is a bare checkout and the overwhelmingly
  // common thing that makes one usable is installing dependencies. npm is the
  // one package manager every Node install already has, so it is the guess most
  // likely to run at all — and a repo on yarn or bun edits one line, having been
  // told to by `init`'s own output. `filesToCopy` stays empty: which gitignored
  // files a repo reads is not guessable at all.
  worktree: {
    filesToCopy: [],
    prepare: [{ command: 'npm install', timeout: DEFAULT_COMMAND_TIMEOUT_MS }],
  },
  // `npm test`, for the same reason, and with the same caveat: a repo with no
  // `test` script fails every task on it, three verify retries at a time, until
  // the no-PR budget ends the run. That is the cost of a default that has to be
  // edited rather than one that has to be discovered, and it is loud — `init`
  // says to check both, and an unedited `npm test` fails visibly on the first
  // task rather than opening PRs nothing ever checked.
  verify: [{ command: 'npm test', timeout: DEFAULT_COMMAND_TIMEOUT_MS }],
};
