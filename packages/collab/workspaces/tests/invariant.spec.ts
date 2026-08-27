import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import CollabWorkspaces from '@deepseek-ai/dsh-collab-workspaces'
import * as WorkspacesInvariant from '@deepseek-ai/dsh-collab-workspaces/invariant'
import type { WorkspaceInvitation, WorkspaceRecord, WorkspaceId, InvitationId } from '../src/types.ts'
import type { UserId } from '@deepseek-ai/dsh-collab-users'

let root: string | undefined

const workspace = (id: string, ownerId: string): WorkspaceRecord => ({
  id: id as WorkspaceId,
  name: 'Platform',
  ownerId: ownerId as UserId,
  members: [{ userId: ownerId as UserId, role: 'admin', joinedAt: '2020-01-01T00:00:00.000Z' }],
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
})

const invitation = (id: string, workspaceId: string, email: string): WorkspaceInvitation => ({
  id: id as InvitationId,
  workspaceId: workspaceId as WorkspaceId,
  email,
  role: 'developer',
  createdBy: 'u-owner' as UserId,
  createdAt: '2020-01-01T00:00:00.000Z',
  revoked: false,
})

describe('invariant companion', () => {
  it('registers package ownership and tolerates a well-formed snapshot', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-workspaces-inv-'))
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(WorkspacesInvariant).await()
    await ctx.plugin(CollabWorkspaces, { dshHome: root })
    await ctx.collabWorkspaces.create('member', 'u-owner' as UserId, 'Platform')
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('fails loud on a structurally inconsistent published snapshot', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-workspaces-inv-'))
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(WorkspacesInvariant).await()

    const ws = workspace('w1', 'u-owner')
    expect(() => {
      ctx.emit('collab/workspaces/changed', {
        workspaces: [ws, { ...ws, id: 'w1' as WorkspaceId }],
        invitations: [],
      })
    }).toThrow(/duplicate collab workspace id/)

    const ownerless: WorkspaceRecord = { ...ws, members: [] }
    expect(() => { ctx.emit('collab/workspaces/changed', { workspaces: [ownerless], invitations: [] }) })
      .toThrow(/owner is not a member/)

    const developerOwner: WorkspaceRecord = { ...ws, members: [{ ...ws.members[0]!, role: 'developer' }] }
    expect(() => { ctx.emit('collab/workspaces/changed', { workspaces: [developerOwner], invitations: [] }) })
      .toThrow(/owner is not an admin/)

    const duplicatedMember: WorkspaceRecord = { ...ws, members: [...ws.members, { ...ws.members[0]! }] }
    expect(() => { ctx.emit('collab/workspaces/changed', { workspaces: [duplicatedMember], invitations: [] }) })
      .toThrow(/duplicate membership/)

    const dangling = invitation('i1', 'w1', 'bob@example.com')
    expect(() => { ctx.emit('collab/workspaces/changed', { workspaces: [], invitations: [dangling] }) })
      .toThrow(/references unknown workspace/)

    expect(() => {
      ctx.emit('collab/workspaces/changed', {
        workspaces: [ws],
        invitations: [invitation('i1', 'w1', 'bob@example.com'), invitation('i1', 'w1', 'carol@example.com')],
      })
    }).toThrow(/duplicate collab invitation id/)

    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
})
