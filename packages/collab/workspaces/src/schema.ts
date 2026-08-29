/**
 * Durable-boundary zod schemas for the collab workspace registry: the on-disk
 * `workspaces.json` document. The schema is the validator at the storage
 * boundary — every load and every write round-trips through it, so corrupt or
 * foreign documents fail loud on read and never reach the runtime store.
 * @module @deepseek-ai/dsh-collab-workspaces/src/schema (internal)
 */

import { z } from 'zod'
import type { WorkspaceRole } from '@deepseek-ai/dsh-collab-rbac'
import type { UserId } from '@deepseek-ai/dsh-collab-users'
import type { InvitationId, WorkspaceId, WorkspaceInvitation, WorkspaceRecord } from './types.ts'

/** Branded identifier schemas; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)
const invitationId = z.string().transform(value => value as InvitationId)
const userId = z.string().transform(value => value as UserId)

/** Workspace-role schema constrained to the closed role union. */
export const workspaceRoleSchema: z.ZodType<WorkspaceRole> = z.enum(['admin', 'developer'])

/** One membership row within a workspace. */
const memberSchema = z.object({
  userId,
  role: workspaceRoleSchema,
  joinedAt: z.string(),
})

/**
 * One durable collab workspace. Like the sibling registry schemas, the schema
 * casts to the branded record interface (`exactOptionalPropertyTypes` makes
 * the required-`undefined` host interface incompatible with zod's optional
 * output); zod still validates shape and presence at the boundary.
 */
export const workspaceRecordSchema = z.object({
  id: workspaceId,
  name: z.string().min(1),
  ownerId: userId,
  members: z.array(memberSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  repoUrl: z.string().min(1).optional(),
  clonePath: z.string().min(1).optional(),
}) as unknown as z.ZodType<WorkspaceRecord>

/** One durable workspace invitation. */
export const workspaceInvitationSchema = z.object({
  id: invitationId,
  workspaceId,
  email: z.email(),
  role: workspaceRoleSchema,
  createdBy: userId,
  createdAt: z.string(),
  revoked: z.boolean(),
  usedAt: z.string().optional(),
}) as unknown as z.ZodType<WorkspaceInvitation>

/** The on-disk `workspaces.json` document. */
export const workspacesFileSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(workspaceRecordSchema),
  invitations: z.array(workspaceInvitationSchema),
}) as unknown as z.ZodType<{ version: 1; workspaces: WorkspaceRecord[]; invitations: WorkspaceInvitation[] }>

/** Durable document inferred from {@link workspacesFileSchema}. */
export type WorkspacesFile = z.infer<typeof workspacesFileSchema>
