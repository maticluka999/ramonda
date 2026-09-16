import { CLAIM_REF_PREFIX } from '../constants/github.js';
import type { Github } from '../wrappers/github.js';

/** The ref that *is* the claim on a task, derived from its branch name. */
export function claimRefFor(branch: string): string {
  return `${CLAIM_REF_PREFIX}${branch}`;
}

/**
 * Takes the claim on a task. `true` means this process holds it.
 *
 * There is nothing else to the protocol. Creating a ref succeeds exactly once,
 * so the answer is decided by the same call that acts on it — no pre-check to
 * race past, no settling window, no read-back to disagree with the write, and no
 * "may or may not have landed" state for a caller to unwind. A failure here means
 * the claim was not taken, which is the one thing a caller needs to know.
 *
 * The ref is keyed on the branch rather than the issue number, so the claim, the
 * worktree and the branch a task works on all carry the same name. Two processes
 * that cannot both hold the ref therefore cannot both reach the same worktree
 * path either, which is what the claim is ultimately protecting.
 */
export async function claimTask(opts: {
  github: Github;
  repoNameWithOwner: string;
  branch: string;
  sha: string;
}): Promise<boolean> {
  return opts.github.createClaimRef({
    repoNameWithOwner: opts.repoNameWithOwner,
    branch: opts.branch,
    sha: opts.sha,
  });
}

/**
 * Gives the claim back. Best-effort at every call site: the task is over either
 * way, and a ref left behind is one line of `git push --delete` rather than a
 * task nothing can see.
 */
export async function releaseTask(opts: { github: Github; repoNameWithOwner: string; branch: string }): Promise<void> {
  await opts.github.deleteClaimRef({
    repoNameWithOwner: opts.repoNameWithOwner,
    branch: opts.branch,
  });
}
