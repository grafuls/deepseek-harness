/**
 * Wire and client-safe types for the collab API surface.
 * @module @deepseek-ai/dsh-collab-api/types
 */

import type {
  GlobalRole,
  WorkspaceRole,
} from '@deepseek-ai/dsh-collab-rbac'

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
