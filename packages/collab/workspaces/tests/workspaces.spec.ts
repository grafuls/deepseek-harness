import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CollabUsers from '@deepseek-ai/dsh-collab-users'
import { CollabForbiddenError } from '@deepseek-ai/dsh-collab-rbac'
import CollabWorkspaces, {
  InvitationId,
  WORKSPACES_FILE_NAME,
  WorkspaceId,
  resolveSpec,
} from '../src/index.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { UserId, UserRecord } from '@deepseek-ai/dsh-collab-users'

let root: string | undefined
const contexts: Context[] = []

async function harness(withUsers = true) {
  root = await mkdtemp(join(tmpdir(), 'dsh-collab-workspaces-'))
  const ctx = new Context()
  if (withUsers) await ctx.plugin(CollabUsers, { dshHome: root, bootstrapFirstAdmin: false })
  await ctx.plugin(CollabWorkspaces, { dshHome: root })
  contexts.push(ctx)
  return { ctx }
}

async function user(ctx: Context, sub: string, email: string, name: string): Promise<UserRecord> {
  return ctx.collabUsers.findOrCreateByGoogle({ sub, email, name })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('create and reads', () => {
  it('resolves the registry root and exposes it', async () => {
    expect(resolveSpec({ root: '/explicit/collab' }).root).toBe('/explicit/collab')
    expect(resolveSpec({}).root).toBe(join(resolveDshHome(), 'collab'))
    const { ctx } = await harness()
    expect(ctx.collabWorkspaces.root).toBe(join(root as string, 'collab'))
  })

  it('mints a workspace owned by the creating user as its first admin', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, '  Platform  ')
    expect(ws.name).toBe('Platform')
    expect(ws.ownerId).toBe(alice.id)
    expect(ws.members).toHaveLength(1)
    expect(ws.members[0]!.role).toBe('admin')
    expect(ctx.collabWorkspaces.roleOf(ws.id, alice.id)).toBe('admin')
    expect(ctx.collabWorkspaces.memberOf(ws.id, alice.id)?.userId).toBe(alice.id)
  })

  it('refuses a blank workspace name and an unknown id', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    await expect(ctx.collabWorkspaces.create(alice.globalRole, alice.id, '   ')).rejects.toThrow(/must not be empty/)
    await expect(ctx.collabWorkspaces.get('admin', alice.id, WorkspaceId('nope'))).rejects.toThrow(/does not exist/)
  })

  it('lists only the workspaces the user is a member of', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const [summary] = ctx.collabWorkspaces.listFor(alice.id)
    expect(summary?.id).toBe(ws.id)
    expect(summary?.isOwner).toBe(true)
    expect(summary?.role).toBe('admin')
    expect(summary?.memberCount).toBe(1)
    expect(ctx.collabWorkspaces.listFor(bob.id)).toEqual([])
  })

  it('a non-member cannot read a workspace', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const carol = await user(ctx, 'sub-carol', 'carol@example.com', 'Carol')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    await expect(ctx.collabWorkspaces.get('developer', carol.id, ws.id)).rejects.toThrow(/not a member/)
  })

  it('a member can read their workspace', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const read = await ctx.collabWorkspaces.get('admin', alice.id, ws.id)
    expect(read.id).toBe(ws.id)
  })

  it('enforces workspace.use: a developer without permission cannot act as admin', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    await expect(ctx.collabWorkspaces.invite('developer', ws.id, bob.id, 'carol@example.com'))
      .rejects.toBeInstanceOf(CollabForbiddenError)
  })
})

describe('invitations and join', () => {
  it('invites by email as pending, revocable, and joinable once', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, '  Bob@Example.com ', 'developer')
    expect(invitation.email).toBe('bob@example.com')
    expect(invitation.role).toBe('developer')
    expect(invitation.revoked).toBe(false)
    expect(invitation.usedAt).toBeUndefined()

    const listed = await ctx.collabWorkspaces.listInvitations('admin', ws.id)
    expect(listed.map(entry => entry.id)).toEqual([invitation.id])

    const joined = await ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id)
    const bobMember = joined.members.find(member => member.userId === bob.id)
    expect(bobMember?.role).toBe('developer')
    expect(ctx.collabWorkspaces.findInvitationById(invitation.id)?.usedAt).toBeDefined()
    // A second join is refused.
    await expect(ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id))
      .rejects.toThrow(/no longer usable/)
  })

  it('refuses duplicate pending invitations, blank emails, and invites to current members', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    await expect(ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com'))
      .rejects.toThrow(/already pending/)
    await expect(ctx.collabWorkspaces.invite('admin', ws.id, alice.id, '   '))
      .rejects.toThrow(/must not be empty/)
    // An existing member (Alice herself) cannot be invited.
    await expect(ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'alice@example.com'))
      .rejects.toThrow(/already a member/)
  })

  it('refuses to join an invitation addressed to another email', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const carol = await user(ctx, 'sub-carol', 'carol@example.com', 'Carol')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    await expect(ctx.collabWorkspaces.join(carol.globalRole, carol.id, 'carol@example.com', invitation.id))
      .rejects.toThrow(/not addressed/)
  })

  it('refuses to join a revoked invitation, and revocation is idempotent', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    const carol = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'carol@example.com')
    const revoked = await ctx.collabWorkspaces.revokeInvitation('admin', ws.id, invitation.id)
    expect(revoked.revoked).toBe(true)
    const again = await ctx.collabWorkspaces.revokeInvitation('admin', ws.id, invitation.id)
    expect(again.revoked).toBe(true)
    expect(ctx.collabWorkspaces.findInvitationById(carol.id)?.revoked).toBe(false)
    await expect(ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id))
      .rejects.toThrow(/no longer usable/)
  })

  it('joins against multiple workspaces and invitations, keeping the rest intact', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const second = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Second')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    const carolInvite = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'carol@example.com')
    await ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id)
    expect(ctx.collabWorkspaces.findById(second.id)).toBeDefined()
    expect(ctx.collabWorkspaces.findInvitationById(carolInvite.id)?.usedAt).toBeUndefined()
  })

  it('works standalone without the user registry (membership checks degrade gracefully)', async () => {
    const { ctx } = await harness(false)
    const ws = await ctx.collabWorkspaces.create('member', 'alice' as UserId, 'Platform')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, 'alice' as UserId, 'bob@example.com')
    const joined = await ctx.collabWorkspaces.join('member', 'bob' as UserId, 'bob@example.com', invitation.id)
    expect(ctx.collabWorkspaces.memberOf(joined.id, 'bob' as UserId)?.role).toBe('developer')
    // Without the user registry a second invitation is not filtered against
    // membership, so joining it hits the already-member guard structurally.
    const secondInvite = await ctx.collabWorkspaces.invite('admin', ws.id, 'alice' as UserId, 'bob@example.com')
    await expect(ctx.collabWorkspaces.join('member', 'bob' as UserId, 'bob@example.com', secondInvite.id))
      .rejects.toThrow(/already a member/)
  })
})

describe('membership administration', () => {
  async function adminOnlyWorkspace(ctx: Context) {
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    return { alice, ws }
  }

  it('lists members for a developer', async () => {
    const { ctx } = await harness()
    const { alice, ws } = await adminOnlyWorkspace(ctx)
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    await ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id)
    const members = await ctx.collabWorkspaces.listMembers('developer', ws.id)
    expect(members.map(member => member.userId)).toEqual([alice.id, bob.id])
  })

  it('promotes and demotes a member, and refuses to demote the owner', async () => {
    const { ctx } = await harness()
    const { alice, ws } = await adminOnlyWorkspace(ctx)
    await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Second')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    await ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id)
    const same = await ctx.collabWorkspaces.setMemberRole('admin', ws.id, bob.id, 'developer')
    expect(same.role).toBe('developer')
    const promoted = await ctx.collabWorkspaces.setMemberRole('admin', ws.id, bob.id, 'admin')
    expect(promoted.role).toBe('admin')
    const demoted = await ctx.collabWorkspaces.setMemberRole('admin', ws.id, bob.id, 'developer')
    expect(demoted.role).toBe('developer')
    await expect(ctx.collabWorkspaces.setMemberRole('admin', ws.id, alice.id, 'developer'))
      .rejects.toThrow(/owner.*cannot be demoted/)
    await expect(ctx.collabWorkspaces.setMemberRole('admin', ws.id, 'nobody' as UserId, 'admin'))
      .rejects.toThrow(/not a member/)
  })

  it('removes a member and revokes their access, but never the owner', async () => {
    const { ctx } = await harness()
    const { alice, ws } = await adminOnlyWorkspace(ctx)
    await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Second')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    await ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id)
    await ctx.collabWorkspaces.removeMember('admin', ws.id, bob.id)
    expect(ctx.collabWorkspaces.memberOf(ws.id, bob.id)).toBeUndefined()
    await expect(ctx.collabWorkspaces.removeMember('admin', ws.id, alice.id)).rejects.toThrow(/owner.*cannot be removed/)
    await expect(ctx.collabWorkspaces.removeMember('admin', ws.id, 'nobody' as UserId)).rejects.toThrow(/not a member/)
  })

  it('lets a member leave, but the owner must delete instead, and a non-member cannot leave', async () => {
    const { ctx } = await harness()
    const { alice, ws } = await adminOnlyWorkspace(ctx)
    await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Second')
    const bob = await user(ctx, 'sub-bob', 'bob@example.com', 'Bob')
    const carol = await user(ctx, 'sub-carol', 'carol@example.com', 'Carol')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    await ctx.collabWorkspaces.join(bob.globalRole, bob.id, 'bob@example.com', invitation.id)
    await ctx.collabWorkspaces.leave('developer', bob.id, ws.id)
    expect(ctx.collabWorkspaces.memberOf(ws.id, bob.id)).toBeUndefined()
    await expect(ctx.collabWorkspaces.leave('admin', alice.id, ws.id)).rejects.toThrow(/must delete/)
    await expect(ctx.collabWorkspaces.leave('developer', carol.id, ws.id)).rejects.toThrow(/not a member/)
  })

  it('deleting a workspace removes it and its invitations, leaving others untouched', async () => {
    const { ctx } = await harness()
    const { alice, ws } = await adminOnlyWorkspace(ctx)
    const second = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Second')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    const keeper = await ctx.collabWorkspaces.invite('admin', second.id, alice.id, 'carol@example.com')
    await ctx.collabWorkspaces.delete('admin', ws.id)
    expect(ctx.collabWorkspaces.findById(ws.id)).toBeUndefined()
    expect(ctx.collabWorkspaces.findInvitationById(invitation.id)).toBeUndefined()
    expect(ctx.collabWorkspaces.findById(second.id)).toBeDefined()
    expect(ctx.collabWorkspaces.findInvitationById(keeper.id)).toBeDefined()
    expect(ctx.collabWorkspaces.listFor(alice.id).map(entry => entry.id)).toEqual([second.id])
  })

  it('refuses to invite with a blank email or delete an unknown workspace', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    await expect(ctx.collabWorkspaces.invite('admin', ws.id, alice.id, '')).rejects.toThrow(/must not be empty/)
    await expect(ctx.collabWorkspaces.delete('admin', WorkspaceId('nope'))).rejects.toThrow(/does not exist/)
  })
})

describe('persistence and events', () => {
  it('persists the document and reloads it on a fresh context', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const invitation = await ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')
    const file = join(root as string, 'collab', WORKSPACES_FILE_NAME)
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { workspaces: Array<{ id: string; name: string }> }
    expect(onDisk.workspaces[0]?.id).toBe(ws.id)
    await ctx.fiber.dispose()

    const second = new Context()
    await second.plugin(CollabUsers, { dshHome: root!, bootstrapFirstAdmin: false })
    await second.plugin(CollabWorkspaces, { dshHome: root! })
    contexts.push(second)
    expect(second.collabWorkspaces.findById(ws.id)?.name).toBe('Platform')
    expect(second.collabWorkspaces.findInvitationById(invitation.id)?.email).toBe('bob@example.com')
  })

  it('emits a frozen post-commit snapshot on changes', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    let seen: Array<{ id: string }> = []
    ctx.on('collab/workspaces/changed', (snapshot) => { seen = [...snapshot.workspaces] })
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    expect(seen.map(entry => entry.id)).toEqual([ws.id])
  })

  it('rejects a corrupt document', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-workspaces-'))
    const file = join(root, 'collab', WORKSPACES_FILE_NAME)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(CollabWorkspaces, { dshHome: root }).await()).rejects.toThrow(/invalid/)
  })

  it('rejects a non-ENOENT read failure (document path is a directory)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-workspaces-'))
    await mkdir(join(root, 'collab', WORKSPACES_FILE_NAME), { recursive: true })
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(CollabWorkspaces, { dshHome: root }).await()).rejects.toThrow()
  })

  it('throws on an unknown invitation or workspace target', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    await expect(ctx.collabWorkspaces.invite('admin', ws.id, alice.id, 'bob@example.com')).resolves.toBeDefined()
    await expect(ctx.collabWorkspaces.revokeInvitation('admin', ws.id, InvitationId('nope')))
      .rejects.toThrow(/does not exist/)
    await expect(ctx.collabWorkspaces.listInvitations('admin', WorkspaceId('nope')))
      .rejects.toThrow(/does not exist/)
    await expect(ctx.collabWorkspaces.join(alice.globalRole, alice.id, 'alice@example.com', InvitationId('nope')))
      .rejects.toThrow(/does not exist/)
  })

  it('does not rewrite the file when a mutation is rejected', async () => {
    const { ctx } = await harness()
    const alice = await user(ctx, 'sub-alice', 'alice@example.com', 'Alice')
    const ws = await ctx.collabWorkspaces.create(alice.globalRole, alice.id, 'Platform')
    const file = join(root as string, 'collab', WORKSPACES_FILE_NAME)
    const before = (await stat(file)).mtimeMs
    await expect(ctx.collabWorkspaces.leave('admin', alice.id, ws.id)).rejects.toThrow(/must delete/)
    const after = (await stat(file)).mtimeMs
    expect(after).toBe(before)
  })
})
