/**
 * Working-tree git state of a settled repository-backed workspace, read by
 * the collab API gateway so the GUI can show where a session runs. Reads are
 * three short read-only `git` invocations over the settled clone path; they
 * use the production no-shell runner and never touch the server credential,
 * so a broken or missing clone triangulates to "state absent" instead of
 * failing the workspace list.
 * @module @deepseek-ai/dsh-collab-api/src/repo-state (internal)
 */

import { gitCloneRunner, type GitCommandRunner } from './clone.ts'

/** Upper bound for one git-state read; exceeded reads report the state as absent. */
export const GIT_STATE_TIMEOUT_MS = 5000

/** The working-tree surface of a settled clone that reached the GUI. */
export interface GitWorkspaceState {
  /** Current branch name (e.g. `main`); empty when the checkout is detached. */
  readonly branch: string
  /** Abbreviated (short) HEAD commit. */
  readonly sha: string
  /** Whether the working tree has uncommitted changes (including untracked files). */
  readonly dirty: boolean
}

/**
 * Read a clone's branch, abbreviated HEAD, and dirty flag. All three reads run
 * concurrently under one short timeout; any failure (missing directory, not a
 * git checkout, a hung git) reports `undefined` so callers treat the state as
 * absent rather than breaking the workspace view.
 * @param clonePath - the settled clone directory to inspect.
 * @param runner - the git command runner; defaults to the production runner.
 * @returns the workspace git state, or undefined when it cannot be read.
 */
export async function gitStateOf(clonePath: string, runner: GitCommandRunner = gitCloneRunner): Promise<GitWorkspaceState | undefined> {
  const signal = AbortSignal.timeout(GIT_STATE_TIMEOUT_MS)
  try {
    const [branch, sha, status] = await Promise.all([
      runner('git', ['-C', clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'], signal),
      runner('git', ['-C', clonePath, 'rev-parse', '--short', 'HEAD'], signal),
      runner('git', ['-C', clonePath, 'status', '--porcelain'], signal),
    ])
    const branchName = branch.stdout.trim()
    const head = sha.stdout.trim()
    if (branchName === '' || head === '') return undefined
    return { branch: branchName, sha: head, dirty: status.stdout.trim() !== '' }
  } catch {
    // A detach or a missing/broken clone is common mid-lifecycle; absence is
    // the contract (the clone-and-remove flow already owns failures).
    return undefined
  }
}
