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
