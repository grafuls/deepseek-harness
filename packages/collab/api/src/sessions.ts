/**
 * Session-attach work branches: when a session is created inside a settled
 * repository-backed collab workspace, the shared clone is switched onto a
 * branch named after that session, so each session's commits (and later
 * pushes) live on their own line while the workspace's mainline branch stays
 * untouched. All guards are silent no-ops — a session is never slowed or
 * failed by the fork, and a workspace that cannot fork keeps its branch.
 */

import { cloneStateOf, type WorkspaceId, type WorkspaceRecord } from '@deepseek-ai/dsh-collab-workspaces'
import { gitCloneRunner, type GitCommandRunner } from './clone.ts'
import { GIT_STATE_TIMEOUT_MS } from './repo-state.ts'

/** The collab-workspaces seat a session fork reads (holding + id lookups). */
export interface CollabWorkspacesForksLike {
  /** Resolve the workspace whose recorded clone contains a host-plane path. */
  workspaceHolding(path: string): WorkspaceId | undefined
  /** Read one workspace record by id. */
  findById(id: WorkspaceId): WorkspaceRecord | undefined
}

/** The session facts a fork needs; structural, so no dsh-session import here. */
export interface CollabSessionLike {
  /** The session's unique id (the branch's distinguishing component). */
  readonly id: string
  /** The session header; its canonical working directory locates the clone. */
  readonly header?: { readonly cwd?: string }
}

/**
 * The per-session work-branch name: the sanitized workspace name and the
 * session id joined with `-`, so rows read `<workspace>-<session>` and every
 * session gets a stable, distinct line (re-creating or re-attaching the same
 * session rejoins the same branch).
 * @param workspaceName - the collab workspace display name.
 * @param sessionId - the session's opaque id.
 * @returns a git-check-refname-safe branch name.
 */
export function sessionBranchName(workspaceName: string, sessionId: string): string {
  return `${component(workspaceName, 'workspace')}-${component(sessionId, 'session')}`
}

/** Sanitize one branch component to `[A-Za-z0-9._-]`, falling back to a fixed word. */
function component(raw: string, fallback: 'workspace' | 'session'): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned === '' ? fallback : cleaned
}

/**
 * Switch a settled clone onto a per-session work branch: create it from the
 * current HEAD when absent, plain-switch when it already exists, so an emit
 * replay or a re-created session rejoins its own line instead of forking a
 * second one. Runs through the shared no-shell git runner under the state-read
 * timeout (the same bound the view-build git reads use).
 * @param clonePath - the settled clone's directory.
 * @param branch - the branch name to check out.
 * @param runner - the no-shell git runner (defaults to the clone runner).
 * @returns the branch the checkout moved to, or undefined when the clone is
 *   missing, not a checkout, or stuck (the fork to an unusable clone is a
 *   silent no-op).
 */
export async function forkSessionBranch(
  clonePath: string,
  branch: string,
  runner: GitCommandRunner = gitCloneRunner,
): Promise<string | undefined> {
  const signal = AbortSignal.timeout(GIT_STATE_TIMEOUT_MS)
  try {
    await runner('git', ['-C', clonePath, 'switch', '-c', branch], signal)
    return branch
  } catch {
    try {
      await runner('git', ['-C', clonePath, 'switch', branch], signal)
      return branch
    } catch {
      return undefined
    }
  }
}

/**
 * Give a just-created session its own work branch: resolve the repo-backed
 * collab workspace whose clone contains the session's working directory, and
 * switch that clone onto the session's branch. Every guard is a silent no-op —
 * a session outside a repo-backed workspace, a still-cloning workspace, or an
 * unusable clone keeps the checkout untouched.
 * @param workspaces - the collab workspace service (holding and id lookups).
 * @param session - the created session (its id and canonical working directory
 *   are all that is read).
 * @param runner - the no-shell git runner (defaults to the clone runner).
 * @returns the branch the clone was switched onto, or undefined when no fork
 *   applied.
 */
export async function forkCollabSessionBranch(
  workspaces: CollabWorkspacesForksLike,
  session: CollabSessionLike,
  runner: GitCommandRunner = gitCloneRunner,
): Promise<string | undefined> {
  const cwd = session.header?.cwd
  if (cwd === undefined || cwd.trim() === '') return undefined
  const holding = workspaces.workspaceHolding(cwd)
  if (holding === undefined) return undefined
  const record = workspaces.findById(holding)
  if (!readyRecord(record)) return undefined
  return forkSessionBranch(record.clonePath, sessionBranchName(record.name, session.id), runner)
}

/** A record is ready to fork when its clone is settled and has a recorded path. */
function readyRecord(record: WorkspaceRecord | undefined): record is WorkspaceRecord & { clonePath: string } {
  return record !== undefined && cloneStateOf(record) === 'ready'
}
