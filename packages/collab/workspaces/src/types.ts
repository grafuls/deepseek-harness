/**
 * Type-only module for the collab workspace registry. Workspaces are
 * invite-only collaboration units: the creator becomes the owner (always
 * `admin`), everyone else joins by consuming a pending invitation addressed
 * to their normalized email. Cross-boundary identifiers are branded so a
 * workspace id can never be passed where a user id is required.
 * @module @deepseek-ai/dsh-collab-workspaces/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceRole } from '@deepseek-ai/dsh-collab-rbac'
import type { UserId } from '@deepseek-ai/dsh-collab-users'

/** Identifies one collab workspace. */
export type WorkspaceId = Branded<'WorkspaceId'>

/** Identifies one pending invitation into a workspace. */
export type InvitationId = Branded<'InvitationId'>

/** One membership inside a workspace: a user granted a role. */
export interface WorkspaceMember {
  userId: UserId
  role: WorkspaceRole
  joinedAt: string
}

/**
 * One workspace record. The owner is the creating user and is always an
 * `admin` member; membership is otherwise invitation-gated.
 */
export interface WorkspaceRecord {
  id: WorkspaceId
  name: string
  ownerId: UserId
  members: WorkspaceMember[]
  createdAt: string
  updatedAt: string
  /**
   * Git repository URL the workspace was bootstrapped from, when the creator
   * supplied one at create time.
   */
  repoUrl?: string
  /**
   * Absolute path of the cloned repository backing this workspace, when it was
   * bootstrapped from a repository. The clone directory is the workspace's
   * working directory: mounting the collab workspace opens it, and the collab
   * membership gate scopes paths beneath it to members.
   */
  clonePath?: string
}

/**
 * One invitation into a workspace. It is addressed to a normalized email
 * (never a user id, so the invite survives a user identity change), carries
 * the role the joining user will receive, and is either pending, revoked, or
 * consumed (`usedAt` set).
 */
export interface WorkspaceInvitation {
  id: InvitationId
  workspaceId: WorkspaceId
  email: string
  role: WorkspaceRole
  createdBy: UserId
  createdAt: string
  revoked: boolean
  usedAt?: string
}

/** Client-safe projection of one workspace for a given member. */
export interface WorkspaceSummary {
  id: WorkspaceId
  name: string
  memberCount: number
  isOwner: boolean
  role: WorkspaceRole
  createdAt: string
}

/**
 * One pending invitation's accept-surface facts for the addressed user: the
 * invitation plus the target workspace's display name.
 */
export interface WorkspaceInvitationForEmail {
  /** The pending invitation. */
  invitation: WorkspaceInvitation
  /** The target workspace's display name. */
  workspaceName: string
}
