import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RbacService, {
  authorizeGlobal,
  authorizeWorkspace,
  CollabForbiddenError,
  hasGlobalPermission,
  hasWorkspacePermission,
  WORKSPACE_ROLE_PERMISSIONS,
  GLOBAL_ROLE_PERMISSIONS,
} from '../src/index.ts'

describe('global role permissions', () => {
  it('grants every member self and workspace bootstrap statements', () => {
    expect(GLOBAL_ROLE_PERMISSIONS.member).toEqual([
      'users.self',
      'workspace.create',
      'workspace.join',
    ])
  })

  it('grants an admin every member statement plus instance-wide user management', () => {
    expect(GLOBAL_ROLE_PERMISSIONS.admin).toEqual([
      'users.manage',
      'users.read',
      'users.self',
      'workspace.create',
      'workspace.join',
    ])
  })

  it('denies member instance-wide user management', () => {
    expect(hasGlobalPermission('member', 'users.manage')).toBe(false)
    expect(hasGlobalPermission('member', 'users.read')).toBe(false)
  })

  it('allows any global role to read its own profile', () => {
    expect(hasGlobalPermission('member', 'users.self')).toBe(true)
    expect(hasGlobalPermission('admin', 'users.self')).toBe(true)
  })
})

describe('workspace role permissions', () => {
  it('grants a developer use and membership read', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.developer).toEqual([
      'workspace.members.read',
      'workspace.use',
    ])
  })

  it('grants an admin every developer statement plus workspace management', () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.admin).toEqual([
      'workspace.delete',
      'workspace.invite',
      'workspace.manage',
      'workspace.members.manage',
      'workspace.members.read',
      'workspace.rename',
      'workspace.use',
    ])
  })

  it('denies developer workspace management statements', () => {
    expect(hasWorkspacePermission('developer', 'workspace.manage')).toBe(false)
    expect(hasWorkspacePermission('developer', 'workspace.invite')).toBe(false)
    expect(hasWorkspacePermission('developer', 'workspace.members.manage')).toBe(false)
    expect(hasWorkspacePermission('developer', 'workspace.delete')).toBe(false)
    expect(hasWorkspacePermission('developer', 'workspace.rename')).toBe(false)
  })
})

describe('authorize', () => {
  it('passes when the permission is held', () => {
    expect(() => { authorizeGlobal('admin', 'users.read') }).not.toThrow()
    expect(() => { authorizeWorkspace('admin', 'workspace.delete') }).not.toThrow()
    expect(() => { authorizeWorkspace('developer', 'workspace.use') }).not.toThrow()
  })

  it('throws CollabForbiddenError with the denied action and role', () => {
    expect(() => { authorizeGlobal('member', 'users.manage') }).toThrow(CollabForbiddenError)
    expect(() => { authorizeWorkspace('developer', 'workspace.invite') }).toThrow(CollabForbiddenError)
    try {
      authorizeWorkspace('developer', 'workspace.invite')
      expect.unreachable('authorize should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CollabForbiddenError)
      const forbidden = error as CollabForbiddenError
      expect(forbidden.action).toBe('workspace.invite')
      expect(forbidden.role).toBe('developer')
    }
  })
})

describe('RbacService', () => {
  it('exposes the pure decisions under the rbac key', () => {
    const ctx = new Context()
    const service = new RbacService(ctx)
    expect(service.globalCan('admin', 'users.manage')).toBe(true)
    expect(service.globalCan('member', 'users.manage')).toBe(false)
    expect(service.workspaceCan('developer', 'workspace.use')).toBe(true)
    expect(service.workspaceCan('developer', 'workspace.manage')).toBe(false)
    expect(() => { service.globalAuthorize('member', 'users.manage') }).toThrow(CollabForbiddenError)
    expect(() => { service.workspaceAuthorize('developer', 'workspace.delete') }).toThrow(CollabForbiddenError)
  })
})
