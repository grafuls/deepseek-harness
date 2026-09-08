/**
 * Read-only branch diff for a repository-backed collab workspace: return the
 * unified diff of one work branch against the workspace's mainline base as a
 * patch a member can apply locally with `git apply`. The diff roots at the
 * branch's mainline merge-base. When the branch is the clone's current
 * checkout, the session that holds it may carry uncommitted edits, so those
 * are included (the working tree diffed against the merge-base), and the
 * result nevertheless only covers that session's work. For a branch that is
 * not the checkout the diff is the deterministic three-dot ref diff
 * (`git diff <base>...<branch>`), computed entirely from commit objects.
 * @module @deepseek-ai/dsh-collab-api/src/patch (internal)
 */

import { gitCloneRunner, type GitCommandRunner } from './clone.ts'
import { GIT_STATE_TIMEOUT_MS } from './repo-state.ts'

/** The branch-diff surface handed back to the caller. */
export interface CollabPatchView {
  /** The branch whose diff was produced. */
  readonly branch: string
  /** The mainline base branch the diff roots at; empty when unknown. */
  readonly base: string
  /** The unified diff text, `git apply`-compatible. */
  readonly patch: string
  /** Suggested download filename (`<branch>.patch`). */
  readonly filename: string
}

/**
 * The clone has no usable mainline to root the diff at. Raised when
 * `refs/remotes/origin/HEAD` does not resolve, which is a genuine
 * misconfiguration of the settled clone rather than an expected failure.
 */
export class CollabPatchBaseError extends Error {
  constructor() {
    super('collab: the workspace clone has no mainline branch to diff against')
    this.name = 'CollabPatchBaseError'
  }
}

/**
 * Resolve the mainline base branch name from `refs/remotes/origin/HEAD`, the
 * same source the push state reads, so the diff roots at the workspace's
 * default branch. A clone that cannot resolve its default branch reports an
 * empty base (never throws), so the caller can distinguish "no base" from a
 * git failure.
 * @param clonePath - the settled clone directory.
 * @param runner - the no-shell git runner (defaults to the clone runner).
 * @param signal - the read's cancellation signal.
 * @returns the bare mainline branch name (e.g. `main`), or '' when unknown.
 */
async function mainlineBranchOf(
  clonePath: string,
  runner: GitCommandRunner,
  signal: AbortSignal,
): Promise<string> {
  const head = (await runner(
    'git', ['-C', clonePath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], signal,
  ).then(result => result.stdout, () => '')).trim()
  return head.split('/').slice(1).join('/')
}

/**
 * Compute one branch's diff text. When the branch is the clone's current
 * checkout, the session that holds it may have uncommitted working-tree edits
 * that are part of that session's work, so diff the working tree against the
 * branch's mainline merge-base (`git diff <merge-base>`), which yields the
 * session's full current delta applied onto the base. For any other branch —
 * a session that does not hold the checkout — the deterministic three-dot ref
 * diff (`git diff <base>...<branch>`) is kept, so requesting one session's
 * patch never leaks another session's uncommitted edits.
 * @param clonePath - the settled clone directory.
 * @param base - the mainline base branch name.
 * @param branch - the branch to diff (its `refs/heads/<branch>` must exist).
 * @param runner - the no-shell git runner.
 * @param signal - the read's cancellation signal.
 * @returns the unified diff text.
 */
async function branchDiff(
  clonePath: string,
  base: string,
  branch: string,
  runner: GitCommandRunner,
  signal: AbortSignal,
): Promise<string> {
  const current = (await runner('git', ['-C', clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'], signal).then(result => result.stdout, () => '')).trim()
  if (current === branch) {
    const mergeBase = (await runner('git', ['-C', clonePath, 'merge-base', `refs/remotes/origin/${base}`, branch], signal).then(result => result.stdout, () => '')).split('\n')[0]?.trim() ?? ''
    if (mergeBase !== '') {
      const out = await runner('git', ['-C', clonePath, 'diff', '--no-ext-diff', '--no-color', '--binary', mergeBase], signal)
      return out.stdout
    }
  }
  const out = await runner('git', ['-C', clonePath, 'diff', '--no-ext-diff', '--no-color', '--binary', `refs/remotes/origin/${base}...${branch}`], signal)
  return out.stdout
}

/**
 * Produce the unified diff of one branch against the clone's mainline base as
 * a local patch (no network, no credential — the diff reads only commit
 * objects already present in the clone). The three-dot form
 * (`git diff <base>...<branch>`) shows exactly the changes the branch
 * introduced relative to where it diverged from the base, applying cleanly to
 * a checkout of that base. When the branch is the clone's current checkout,
 * the session's uncommitted working-tree edits are included (see
 * {@link branchDiff}).
 * @param clonePath - the settled clone directory.
 * @param branch - the branch to diff (its `refs/heads/<branch>` must exist).
 * @param runner - the no-shell git runner (defaults to the clone runner).
 * @returns the branch's patch against the mainline base.
 * @throws {@link CollabPatchBaseError} when the clone has no mainline base
 *   and {@link Error} when git rejects the read (missing branch, bad repo).
 */
export async function diffWorkspaceBranch(
  clonePath: string,
  branch: string,
  runner: GitCommandRunner = gitCloneRunner,
): Promise<CollabPatchView> {
  const signal = AbortSignal.timeout(GIT_STATE_TIMEOUT_MS)
  const base = await mainlineBranchOf(clonePath, runner, signal)
  if (base === '') throw new CollabPatchBaseError()
  const patch = await branchDiff(clonePath, base, branch, runner, signal)
  return {
    branch,
    base,
    patch,
    filename: `${branch.replaceAll('/', '-')}.patch`,
  }
}
