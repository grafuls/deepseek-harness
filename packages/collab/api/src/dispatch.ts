/**
 * Collab RPC endpoint dispatch: maps `collab/*` endpoints to the mounted
 * collab services under the gate-resolved caller identity.
 * @module @deepseek-ai/dsh-collab-api
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { CollabPrincipal } from '@deepseek-ai/dsh-collab-auth'
import type { GlobalRole, WorkspaceRole } from '@deepseek-ai/dsh-collab-rbac'
import { UserId as makeUserId } from '@deepseek-ai/dsh-collab-users'
import type {
  WorkspaceId,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceRecord,
  WorkspaceSummary,
} from '@deepseek-ai/dsh-collab-workspaces'
import { InvitationId as makeInvitationId, WorkspaceId as makeWorkspaceId } from '@deepseek-ai/dsh-collab-workspaces'
import type {
  CollabInvitationView,
  CollabMemberView,
  CollabPrincipalView,
  CollabStatusView,
  CollabUserView,
  CollabWorkspaceDirView,
  CollabWorkspaceView,
} from './types.ts'
import { collabError, type CollabErrorCode } from './errors.ts'

/** Wire validation failure carrying its success-branch-free error code. */
class CollabWireError extends Error {
  /**
   * @param code - the collab error category for this failure.
   * @param message - caller-facing diagnostic without sensitive values.
   */
  constructor(readonly code: CollabErrorCode, message: string) {
    super(message)
    this.name = 'CollabWireError'
  }
}

type CollabHandler = (
  ctx: Context,
  principal: CollabPrincipal,
  args: Record<string, unknown>,
) => RpcResult<unknown> | Promise<RpcResult<unknown>>

const ENDPOINTS = new Map<string, CollabHandler>()

/**
 * Ok branch of the shared RPC envelope.
 * @param value - the endpoint result payload.
 * @returns the success envelope carrying `value`.
 */
export function collabOk<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function requireString(args: Record<string, unknown>, field: string, endpoint: string): string {
  const value = args[field]
  if (typeof value !== 'string') {
    throw new CollabWireError('collab-bad-request', `${endpoint}: '${field}' must be a string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new CollabWireError('collab-bad-request', `'${field}' must be a string`)
  return value
}

function requireBoolean(args: Record<string, unknown>, field: string, endpoint: string): boolean {
  const value = args[field]
  if (typeof value !== 'boolean') {
    throw new CollabWireError('collab-bad-request', `${endpoint}: '${field}' must be a boolean`)
  }
  return value
}

function requireRole(args: Record<string, unknown>, field: string, endpoint: string): WorkspaceRole {
  const value = args[field]
  if (value !== 'admin' && value !== 'developer') {
    throw new CollabWireError('collab-bad-request', `${endpoint}: '${field}' must be a workspace role`)
  }
  return value
}

function requireGlobalRole(args: Record<string, unknown>, field: string, endpoint: string): GlobalRole {
  const value = args[field]
  if (value !== 'admin' && value !== 'member') {
    throw new CollabWireError('collab-bad-request', `${endpoint}: '${field}' must be a global role`)
  }
  return value
}

/**
 * Resolve the acting workspace role for the caller, failing with a wire-safe
 * error when the workspace or the membership is missing.
 * @param ctx - the plugin context with the collab services mounted.
 * @param principal - the gate-resolved caller identity.
 * @param workspaceId - raw workspace id from the wire.
 * @returns the branded workspace id and the caller's role.
 */
function requireWorkspaceAndRole(
  ctx: Context,
  principal: CollabPrincipal,
  workspaceId: string,
): { wsId: WorkspaceId; role: WorkspaceRole } {
  const wsId = makeWorkspaceId(workspaceId)
  if (ctx.collabWorkspaces.findById(wsId) === undefined) {
    throw new CollabWireError('collab-not-found', `collab: workspace '${wsId}' does not exist`)
  }
  const role = ctx.collabWorkspaces.roleOf(wsId, principal.userId)
  if (role === undefined) {
    throw new CollabWireError('collab-forbidden', `collab: not a member of workspace '${wsId}'`)
  }
  return { wsId, role }
}

/** Ensure the caller is an instance admin (the users surface has no inner gate). */
function requireAdmin(principal: CollabPrincipal): void {
  if (principal.globalRole !== 'admin') {
    throw new CollabWireError('collab-forbidden', 'collab: global \'admin\' role is required')
  }
}

function principalView(principal: CollabPrincipal): CollabPrincipalView {
  return {
    userId: principal.userId,
    email: principal.email,
    name: principal.name,
    globalRole: principal.globalRole,
  }
}

function workspaceView(summary: WorkspaceSummary): CollabWorkspaceView {
  return summary
}

function recordView(record: WorkspaceRecord, viewer: string): CollabWorkspaceView {
  const membership = record.members.find(member => member.userId === viewer)
  // The read/leave guard has already proven the viewer is on this record;
  // create/join add the actor before this view runs, so a miss is an
  // internal inconsistency — fail loud rather than guess a role.
  /* v8 ignore start -- unreachable through the API (see above). */
  if (membership === undefined) throw new CollabWireError('collab-forbidden', `collab: no membership for '${viewer}' on '${record.id}'`)
  /* v8 ignore stop */
  return {
    id: record.id,
    name: record.name,
    memberCount: record.members.length,
    isOwner: record.ownerId === viewer,
    role: membership.role,
    createdAt: record.createdAt,
  }
}

function memberView(ctx: Context, member: WorkspaceMember): CollabMemberView {
  const users = ctx.get(
    'collabUsers',
    false,
  ) as { findById(id: WorkspaceMember['userId']): { email: string; name: string } | undefined } | undefined
  const user = users?.findById(member.userId)
  return {
    userId: member.userId,
    email: user?.email ?? '',
    name: user?.name ?? '',
    role: member.role,
    joinedAt: member.joinedAt,
  }
}

function invitationView(invitation: WorkspaceInvitation): CollabInvitationView {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    role: invitation.role,
    createdBy: invitation.createdBy,
    createdAt: invitation.createdAt,
    revoked: invitation.revoked,
    ...(invitation.usedAt === undefined ? {} : { usedAt: invitation.usedAt }),
  }
}

function userView(user: {
  id: string
  email: string
  name: string
  globalRole: GlobalRole
  disabled: boolean
  lastSeenAt: string | undefined
}): CollabUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    globalRole: user.globalRole,
    disabled: user.disabled,
    ...(user.lastSeenAt === undefined ? {} : { lastSeenAt: user.lastSeenAt }),
  }
}

ENDPOINTS.set('collab/auth.status', (_ctx, principal) => {
  return collabOk<CollabStatusView>({ authenticated: true, principal: principalView(principal) })
})

ENDPOINTS.set('collab/workspace.list', (ctx, principal) => {
  return collabOk(ctx.collabWorkspaces.listFor(principal.userId).map(workspaceView))
})

ENDPOINTS.set('collab/workspace.create', async (ctx, principal, args) => {
  const name = requireString(args, 'name', 'collab/workspace.create')
  const record = await ctx.collabWorkspaces.create(principal.globalRole, principal.userId, name)
  return collabOk(recordView(record, principal.userId))
})

ENDPOINTS.set('collab/workspace.get', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.get'))
  const record = await ctx.collabWorkspaces.get(role, principal.userId, wsId)
  return collabOk(recordView(record, principal.userId))
})

ENDPOINTS.set('collab/workspace.members', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.members'))
  const members = await ctx.collabWorkspaces.listMembers(role, wsId)
  return collabOk(members.map(member => memberView(ctx, member)))
})

ENDPOINTS.set('collab/workspace.dir', async (ctx, principal, args) => {
  const raw = requireString(args, 'workspaceId', 'collab/workspace.dir')
  const { wsId } = requireWorkspaceAndRole(ctx, principal, raw)
  const dir = workspaceDataDir(ctx.collabWorkspaces.root, wsId)
  await mkdir(dir, { recursive: true })
  return collabOk<CollabWorkspaceDirView>({ dir })
})

ENDPOINTS.set('collab/workspace.invite', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.invite'))
  const email = requireString(args, 'email', 'collab/workspace.invite')
  const wanted = optionalString(args, 'role')
  const inviteRole: WorkspaceRole = wanted === undefined ? 'developer' : (wanted as WorkspaceRole)
  const invitation = await ctx.collabWorkspaces.invite(role, wsId, principal.userId, email, inviteRole)
  return collabOk(invitationView(invitation))
})

ENDPOINTS.set('collab/workspace.invitations', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.invitations'))
  const invitations = await ctx.collabWorkspaces.listInvitations(role, wsId)
  return collabOk(invitations.map(invitationView))
})

ENDPOINTS.set('collab/workspace.revokeInvitation', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.revokeInvitation'))
  const invitationId = makeInvitationId(requireString(args, 'invitationId', 'collab/workspace.revokeInvitation'))
  const invitation = await ctx.collabWorkspaces.revokeInvitation(role, wsId, invitationId)
  return collabOk(invitationView(invitation))
})

ENDPOINTS.set('collab/workspace.join', async (ctx, principal, args) => {
  const invitationId = makeInvitationId(requireString(args, 'invitationId', 'collab/workspace.join'))
  const record = await ctx.collabWorkspaces.join(principal.globalRole, principal.userId, principal.email, invitationId)
  return collabOk(recordView(record, principal.userId))
})

ENDPOINTS.set('collab/workspace.leave', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.leave'))
  await ctx.collabWorkspaces.leave(role, principal.userId, wsId)
  return collabOk({ left: true })
})

ENDPOINTS.set('collab/workspace.delete', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.delete'))
  await ctx.collabWorkspaces.delete(role, wsId)
  return collabOk({ deleted: true })
})

ENDPOINTS.set('collab/workspace.setMemberRole', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.setMemberRole'))
  const userId = makeUserId(requireString(args, 'userId', 'collab/workspace.setMemberRole'))
  const next = requireRole(args, 'role', 'collab/workspace.setMemberRole')
  const member = await ctx.collabWorkspaces.setMemberRole(role, wsId, userId, next)
  return collabOk(memberView(ctx, member))
})

ENDPOINTS.set('collab/workspace.removeMember', async (ctx, principal, args) => {
  const { wsId, role } = requireWorkspaceAndRole(ctx, principal, requireString(args, 'workspaceId', 'collab/workspace.removeMember'))
  const userId = makeUserId(requireString(args, 'userId', 'collab/workspace.removeMember'))
  await ctx.collabWorkspaces.removeMember(role, wsId, userId)
  return collabOk({ removed: userId })
})

ENDPOINTS.set('collab/users.list', (ctx, principal) => {
  requireAdmin(principal)
  return collabOk(ctx.collabUsers.list().map(userView))
})

ENDPOINTS.set('collab/users.setGlobalRole', async (ctx, principal, args) => {
  requireAdmin(principal)
  const userId = makeUserId(requireString(args, 'userId', 'collab/users.setGlobalRole'))
  const role = requireGlobalRole(args, 'role', 'collab/users.setGlobalRole')
  const user = await ctx.collabUsers.setGlobalRole(principal.globalRole, userId, role)
  return collabOk(userView(user))
})

ENDPOINTS.set('collab/users.setDisabled', async (ctx, principal, args) => {
  requireAdmin(principal)
  const userId = makeUserId(requireString(args, 'userId', 'collab/users.setDisabled'))
  const disabled = requireBoolean(args, 'disabled', 'collab/users.setDisabled')
  const user = await ctx.collabUsers.setDisabled(principal.globalRole, userId, disabled)
  return collabOk(userView(user))
})

/**
 * One collab endpoint invocation: validate the wire payload, dispatch to the
 * owning service under the resolved caller identity, and fold service
 * failures into the shared RPC error envelope.
 * @param ctx - the plugin context with the collab services mounted.
 * @param principal - the gate-resolved caller identity.
 * @param endpoint - canonical `collab/<domain>.<action>` endpoint.
 * @param payload - raw wire payload (validated to an object).
 * @returns the shared RPC result envelope.
 */
export async function dispatchCollabEndpoint(
  ctx: Context,
  principal: CollabPrincipal,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  const handler = ENDPOINTS.get(endpoint)
  if (handler === undefined) {
    return { ok: false, error: collabError('collab-not-found', `collab: unknown endpoint '${endpoint}'`) }
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: collabError('collab-bad-request', `${endpoint}: payload must be a JSON object`) }
  }
  try {
    return await handler(ctx, principal, payload as Record<string, unknown>)
  } catch (error) {
    return foldedError(error)
  }
}

/**
 * The per-workspace data directory: `<collab root>/workspaces/<workspaceId>`.
 * @param root - the collab workspaces data root.
 * @param workspaceId - the workspace identity; a foreign id is coerced for display.
 * @returns the scoped data directory path inside the workspaces root.
 */
export function workspaceDataDir(root: string, workspaceId: string | WorkspaceId): string {
  return join(root, 'workspaces', String(workspaceId))
}

function foldedError(error: unknown): RpcResult<unknown> {
  if (error instanceof CollabWireError) {
    return { ok: false, error: collabError(error.code, error.message) }
  }
  if (error instanceof Error && error.name === 'CollabForbiddenError') {
    return { ok: false, error: collabError('collab-forbidden', error.message) }
  }
  if (error instanceof Error) {
    return { ok: false, error: collabError('collab-bad-request', error.message) }
  }
  return { ok: false, error: collabError('collab-bad-request', `collab: ${String(error)}`) }
}
