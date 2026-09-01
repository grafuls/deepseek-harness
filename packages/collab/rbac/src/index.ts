/**
 * Role-based access control policy for the multi-user collab layer.
 *
 * Two independent role planes mirror the product's two trust scopes:
 * - the instance-wide plane (`GlobalRole`: `admin` | `member`) governs
 *   platform statements such as reading or managing any user account;
 * - the workspace plane (`WorkspaceRole`: `admin` | `developer`) governs
 *   statements inside one collab workspace, granted by that workspace's
 *   administrator.
 *
 * The policy is a pure decision: it answers "does a role permit this action?"
 * and never performs the mechanism. Enforcement lives at the call boundary
 * consumers own (the collab API gateway, the collab services, the UI), so a
 * role map can change without touching this package.
 *
 * @module @deepseek-ai/dsh-collab-rbac
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { GlobalPermission, GlobalRole, Permission, WorkspacePermission, WorkspaceRole } from './types.ts'

export type {
  GlobalPermission,
  GlobalRole,
  WorkspacePermission,
  WorkspaceRole,
  Permission,
} from './types.ts'
export { GLOBAL_ROLES, WORKSPACE_ROLES } from './types.ts'

/** Which instance-wide permissions each global role holds, in canonical order. */
export const GLOBAL_ROLE_PERMISSIONS: Readonly<Record<GlobalRole, readonly GlobalPermission[]>> = {
  admin: ['users.manage', 'users.read', 'users.self', 'workspace.create', 'workspace.join'],
  member: ['users.self', 'workspace.create', 'workspace.join'],
}

/** Which workspace permissions each workspace role holds, in canonical order. */
export const WORKSPACE_ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly WorkspacePermission[]>> = {
  admin: [
    'workspace.delete',
    'workspace.invite',
    'workspace.manage',
    'workspace.members.manage',
    'workspace.members.read',
    'workspace.rename',
    'workspace.use',
  ],
  developer: ['workspace.members.read', 'workspace.use'],
}

/** A role did not hold the required permission for an action. */
export class CollabForbiddenError extends Error {
  /**
   * @param action - the denied permission name.
   * @param role - the role that attempted the action.
   */
  constructor(readonly action: Permission, readonly role: GlobalRole | WorkspaceRole) {
    super(`collab authorization denied: role '${role}' cannot perform '${action}'`)
    this.name = 'CollabForbiddenError'
  }
}

/**
 * Whether a global role holds an instance-wide permission.
 * @param role - the acting user's global role.
 * @param permission - the permission to test.
 * @returns whether the role's permission set contains it.
 */
export function hasGlobalPermission(role: GlobalRole, permission: GlobalPermission): boolean {
  return GLOBAL_ROLE_PERMISSIONS[role].includes(permission)
}

/**
 * Whether a workspace role holds a permission inside its workspace.
 * @param role - the acting member's workspace role.
 * @param permission - the permission to test.
 * @returns whether the role's permission set contains it.
 */
export function hasWorkspacePermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return WORKSPACE_ROLE_PERMISSIONS[role].includes(permission)
}

/**
 * Enforce an instance-wide permission for a role.
 * @param role - the acting user's global role.
 * @param permission - the required permission.
 * @throws {@link CollabForbiddenError} when the role does not hold it.
 */
export function authorizeGlobal(role: GlobalRole, permission: GlobalPermission): void {
  if (!hasGlobalPermission(role, permission)) throw new CollabForbiddenError(permission, role)
}

/**
 * Enforce a workspace permission for a role.
 * @param role - the acting member's workspace role.
 * @param permission - the required permission.
 * @throws {@link CollabForbiddenError} when the role does not hold it.
 */
export function authorizeWorkspace(role: WorkspaceRole, permission: WorkspacePermission): void {
  if (!hasWorkspacePermission(role, permission)) throw new CollabForbiddenError(permission, role)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Collab role-based access control policy. */
    rbac: RbacService
  }
}

/**
 * The policy as a Cordis service, so collab consumers can inject one name and
 * swap implementations without importing this package's functions. The
 * methods are the pure functions; the class adds no semantics.
 */
export class RbacService extends Service {
  /**
   * Instantiate the policy service.
   * @param ctx - owning context.
   */
  constructor(ctx: Context) {
    super(ctx, 'rbac')
  }

  /** Whether a global role holds an instance-wide permission. */
  globalCan: (role: GlobalRole, permission: GlobalPermission) => boolean = hasGlobalPermission

  /** Whether a workspace role holds a permission inside its workspace. */
  workspaceCan: (role: WorkspaceRole, permission: WorkspacePermission) => boolean = hasWorkspacePermission

  /** Enforce an instance-wide permission, throwing `CollabForbiddenError` on denial. */
  globalAuthorize: (role: GlobalRole, permission: GlobalPermission) => void = authorizeGlobal

  /** Enforce a workspace permission, throwing `CollabForbiddenError` on denial. */
  workspaceAuthorize: (role: WorkspaceRole, permission: WorkspacePermission) => void = authorizeWorkspace
}

export default RbacService
