/**
 * Wire and client-safe types for the collab API surface.
 * @module @deepseek-ai/dsh-collab-api/types
 */

import type {
  GlobalRole,
  WorkspaceRole,
} from '@deepseek-ai/dsh-collab-rbac'
import type { CollabCloneState } from '@deepseek-ai/dsh-collab-workspaces'

/** Client-safe identity of the sign-in caller. */
export interface CollabPrincipalView {
  /** Collab user id. */
  userId: string
  /** Normalized account email. */
  email: string
  /** Display name. */
  name: string
  /** Instance-wide role. */
  globalRole: GlobalRole
}

/** Status the collab client bootstraps against. */
export interface CollabStatusView {
  /** Whether the request carried a valid session. */
  authenticated: boolean
  /** The authenticated caller, when signed in. */
  principal?: CollabPrincipalView
}

/** Client-safe workspace row. */
export interface CollabWorkspaceView {
  id: string
  name: string
  memberCount: number
  isOwner: boolean
  role: WorkspaceRole
  createdAt: string
  /**
   * Lifecycle of the repository bootstrap: `cloning` while the server clones
   * in the background (the row opens once the clone settles), `ready` once
   * settled, `none` for a name-only workspace.
   */
  cloneState: CollabCloneState
  /**
   * Working-tree git state of a settled repository-backed workspace, read at
   * view-build time for the shared clone. Present only while the clone is
   * readably `ready`; absent for name-only or cloning workspaces and when the
   * clone directory cannot be read.
   */
  gitState?: CollabGitWorkspaceState
}

/** The working-tree surface of a settled clone shown on a workspace row. */
export interface CollabGitWorkspaceState {
  /** Current branch name; empty when the checkout is detached. */
  branch: string
  /** Abbreviated HEAD commit. */
  sha: string
  /** Whether uncommitted changes (including untracked files) are present. */
  dirty: boolean
}

/**
 * The server-side outcome of a `collab/workspace.push`: what the branch's
 * push reached, and the human-facing links to act on the pushed line.
 */
export interface CollabPushView {
  /** Whether the push moved the remote branch (false for dry-run or up-to-date). */
  pushed: boolean
  /** Whether the remote branch already pointed at the same commit. */
  upToDate: boolean
  /** The pushed branch name (the session's work branch or the workspace mainline). */
  branch: string
  /** The mainline branch the compare link roots at; empty when unknown. */
  base: string
  /** The pushed commit on the local side. */
  localSha: string
  /** The remote tip after the push; the pre-push tip on a dry-run; absent when the branch was never pushed. */
  remoteSha: string | undefined
  /** Local commits not on the remote branch, when the remote tip is known. */
  ahead: number | undefined
  /** Remote commits not on the local branch, when the remote tip is known. */
  behind: number | undefined
  /** The origin URL the branch lives on (credentials never appear in it). */
  remote: string
  /** Open-a-diff (base...branch) link for an HTTPS origin with a known base. */
  compareUrl?: string
  /** Open-a-pull-request link for an HTTPS origin with a known base. */
  prUrl?: string
}

/** Client-safe membership row, enriched from the user registry when present. */
export interface CollabMemberView {
  userId: string
  email: string
  name: string
  role: WorkspaceRole
  joinedAt: string
}

/** Client-safe invitation row. */
export interface CollabInvitationView {
  id: string
  workspaceId: string
  email: string
  role: WorkspaceRole
  createdBy: string
  createdAt: string
  revoked: boolean
  usedAt?: string
}

/** Client-safe pending invitation addressed to the caller (the accept surface). */
export interface CollabInvitationForMeView {
  id: string
  workspaceId: string
  workspaceName: string
  role: WorkspaceRole
  createdAt: string
}

/** Client-safe account row for the admin surface. */
export interface CollabUserView {
  id: string
  email: string
  name: string
  globalRole: GlobalRole
  disabled: boolean
  lastSeenAt?: string
}

/** Per-workspace data directory resolution. */
export interface CollabWorkspaceDirView {
  /** Absolute data directory reserved for the workspace. */
  dir: string
}

/** A collab workspace mounted as a real Host workspace over its data directory. */
export interface CollabMountedWorkspaceView {
  /** The Host workspace the collab workspace resolves to (path-stable: every member mounts the same one). */
  workspace: {
    /** Host workspace id (branded string on the wire). */
    workspaceId: string
    /** Canonical data directory of the collab workspace. */
    path: string
    /** Display title (the collab workspace name). */
    title: string
    /** Sessions accounted under this workspace, in manually owned order. */
    sessionIds: string[]
    /** Creation instant of the Host workspace record (ISO 8601). */
    createdAt: string
    /** Last-mutation instant of the Host workspace record (ISO 8601). */
    updatedAt: string
  }
  /** The collab workspace's reserved data directory (equals `workspace.path`). */
  dir: string
}
