/**
 * Type-only module for the collab RBAC policy. Roles and permissions are
 * closed unions; the permission maps that derive allowed sets from roles live
 * in the runtime module (`src/index.ts`) so consumers read one source of
 * truth.
 * @module @deepseek-ai/dsh-collab-rbac/types
 */

/** Instance-wide role carried by every authenticated user. */
export type GlobalRole = 'admin' | 'member'

/** Role inside one collab workspace, granted by its administrator. */
export type WorkspaceRole = 'admin' | 'developer'

/** Every role of the instance-wide plane, in canonical order. */
export const GLOBAL_ROLES = ['admin', 'member'] as const satisfies readonly GlobalRole[]

/** Every role of the workspace plane, in canonical order. */
export const WORKSPACE_ROLES = ['admin', 'developer'] as const satisfies readonly WorkspaceRole[]

/**
 * Distinct administrative statements on the instance-wide plane. Every
 * authenticated user holds `users.self`; `users.read` and `users.manage` are
 * admin-only; `workspace.create` and `workspace.join` are open to any member.
 */
export type GlobalPermission =
  | 'users.read'
  | 'users.manage'
  | 'users.self'
  | 'workspace.create'
  | 'workspace.join'

/**
 * Distinct administrative statements inside one workspace. `workspace.use`
 * and `workspace.members.read` are shared by every role; the remaining
 * management statements are admin-only.
 */
export type WorkspacePermission =
  | 'workspace.delete'
  | 'workspace.invite'
  | 'workspace.manage'
  | 'workspace.members.manage'
  | 'workspace.members.read'
  | 'workspace.use'

/** Every permission of both planes. */
export type Permission = GlobalPermission | WorkspacePermission
