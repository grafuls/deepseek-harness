import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CollabForbiddenError } from '@deepseek-ai/dsh-collab-rbac'
import CollabUsers, {
  resolveSpec,
  TOUCH_PERSIST_INTERVAL_MS,
  USERS_FILE_NAME,
  UserId,
} from '../src/index.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { GoogleProfile } from '../src/index.ts'

let root: string | undefined
let contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts = []
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.useRealTimers()
})

async function harness(config: Record<string, unknown> = {}) {
  root = await mkdtemp(join(tmpdir(), 'dsh-collab-users-'))
  const ctx = new Context()
  await ctx.plugin(CollabUsers, { dshHome: root, ...config })
  contexts.push(ctx)
  return { ctx }
}

const alice = (): GoogleProfile => ({
  sub: 'sub-alice',
  email: 'alice@example.com',
  name: 'Alice',
  avatarUrl: 'https://example.com/alice.png',
})

async function createUser(ctx: Context, profile: GoogleProfile) {
  return ctx.collabUsers.findOrCreateByGoogle(profile)
}

describe('global admin bootstrap', () => {
  it('promotes the first account when bootstrapFirstAdmin is on', async () => {
    const { ctx } = await harness()
    const aliceUser = await createUser(ctx, alice())
    expect(aliceUser.globalRole).toBe('admin')
  })

  it('leaves the first account a member when bootstrapFirstAdmin is off', async () => {
    const { ctx } = await harness({ bootstrapFirstAdmin: false })
    const aliceUser = await createUser(ctx, alice())
    expect(aliceUser.globalRole).toBe('member')
  })

  it('promotes allowlisted emails regardless of bootstrap', async () => {
    const { ctx } = await harness({ adminEmails: ['ops@example.com'] })
    const ops = await createUser(ctx, { sub: 'sub-ops', email: 'ops@example.com', name: 'Ops' })
    expect(ops.globalRole).toBe('admin')
  })

  it('treats the allowlist case-insensitively', async () => {
    const { ctx } = await harness({ adminEmails: ['OPS@example.com'] })
    const ops = await createUser(ctx, { sub: 'sub-ops', email: 'ops@example.com', name: 'Ops' })
    expect(ops.globalRole).toBe('admin')
  })
})

describe('findOrCreateByGoogle', () => {
  it('exposes the resolved data root', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    expect(ctx.collabUsers.root).toBe(join(root as string, 'collab'))
  })

  it('resolves an explicit root verbatim and defers to the harness home otherwise', () => {
    expect(resolveSpec({ root: '/explicit/collab' }).root).toBe('/explicit/collab')
    expect(resolveSpec({}).root).toBe(join(resolveDshHome(), 'collab'))
    expect(resolveSpec({}).bootstrapFirstAdmin).toBe(true)
    expect(resolveSpec({}).adminEmails).toEqual([])
  })

  it('returns undefined for unknown ids and emails', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    expect(ctx.collabUsers.findById(UserId('nope'))).toBeUndefined()
    expect(ctx.collabUsers.findByEmail('nobody@example.com')).toBeUndefined()
  })

  it('mints one account per identity and dedupes by sub and normalized email', async () => {
    const { ctx } = await harness()
    const first = await createUser(ctx, alice())
    const second = await createUser(ctx, { ...alice(), email: ' ALICE@Example.com ' })
    expect(second.id).toBe(first.id)
    expect(second.email).toBe('alice@example.com')
    expect(ctx.collabUsers.list()).toHaveLength(1)
  })

  it('refreshes display facts on an existing account without minting another', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    const renamed = await createUser(ctx, { ...alice(), name: 'Alice B.' })
    expect(renamed.name).toBe('Alice B.')
    expect(ctx.collabUsers.list()).toHaveLength(1)
  })

  it('makes the second distinct account a member', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    const bob = await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    expect(bob.globalRole).toBe('member')
  })

  it('emits a change event with the post-commit snapshot', async () => {
    const { ctx } = await harness()
    const snapshots: unknown[] = []
    ctx.on('collab/users/changed', (records) => { snapshots.push(records) })
    await createUser(ctx, alice())
    await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    expect(snapshots).toHaveLength(2)
    expect((snapshots[0] as unknown[])).toHaveLength(1)
    expect((snapshots[1] as unknown[])).toHaveLength(2)
  })

  it('warns and adopts a new sub when an email moves identities', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const moved = await createUser(ctx, { ...alice(), sub: 'sub-alice-2' })
    expect(moved.id).toBe(ctx.collabUsers.findByEmail('alice@example.com')?.id)
    expect(moved.googleSub).toBe('sub-alice-2')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed Google sub'))
  })

  it('rejects when the document on disk is a directory (non-ENOENT read failure)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-users-'))
    await mkdir(join(root, 'collab', USERS_FILE_NAME), { recursive: true })
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(CollabUsers, { dshHome: root }).await()).rejects.toThrow()
  })

  it('rejects when the document on disk is corrupt', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-users-'))
    const file = join(root, 'collab', USERS_FILE_NAME)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(CollabUsers, { dshHome: root }).await()).rejects.toThrow(/invalid/)
  })
})

describe('role and disabled mutations', () => {
  it('rejects a member acting on global role or disable', async () => {
    const { ctx } = await harness()
    const admin = await createUser(ctx, alice())
    const member = await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    await expect(ctx.collabUsers.setGlobalRole(member.globalRole, admin.id, 'member'))
      .rejects.toBeInstanceOf(CollabForbiddenError)
    await expect(ctx.collabUsers.setGlobalRole(member.globalRole, member.id, 'admin'))
      .rejects.toBeInstanceOf(CollabForbiddenError)
    await expect(ctx.collabUsers.setDisabled(member.globalRole, admin.id, true))
      .rejects.toBeInstanceOf(CollabForbiddenError)
  })

  it('allows an admin to promote a member', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    const bob = await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    const promoted = await ctx.collabUsers.setGlobalRole('admin', bob.id, 'admin')
    expect(promoted.globalRole).toBe('admin')
  })

  it('is a no-op when the role or disabled state is unchanged', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    const bob = await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    const same = await ctx.collabUsers.setGlobalRole('admin', bob.id, 'member')
    expect(same.globalRole).toBe('member')
    const sameEnabled = await ctx.collabUsers.setDisabled('admin', bob.id, false)
    expect(sameEnabled.disabled).toBe(false)
  })

  it('throws on an unknown target account', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    await expect(ctx.collabUsers.setDisabled('admin', UserId('nope'), true))
      .rejects.toThrow(/does not exist/)
  })

  it('touch is a no-op for an unknown account', async () => {
    const { ctx } = await harness()
    await ctx.collabUsers.touch(UserId('nope'))
  })

  it('keeps existing display facts when a re-sign-in omits them', async () => {
    const { ctx } = await harness()
    await createUser(ctx, alice())
    const bob = await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    const refreshed = await createUser(ctx, { sub: 'sub-alice', email: 'alice@example.com', name: '' })
    expect(refreshed.name).toBe('Alice')
    expect(refreshed.avatarUrl).toBe('https://example.com/alice.png')
    const reverted = await createUser(ctx, { ...alice(), avatarUrl: 'https://example.com/new.png' })
    expect(reverted.avatarUrl).toBe('https://example.com/new.png')
    expect(ctx.collabUsers.list()).toHaveLength(2)
    expect(ctx.collabUsers.findById(bob.id)?.name).toBe('Bob')
  })

  it('projects profiles without an avatar when the account has none', async () => {
    const { ctx } = await harness()
    const bob = await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    const profile = ctx.collabUsers.profileOf(bob)
    expect('avatarUrl' in profile).toBe(false)
  })

  it('refuses to demote or disable the last enabled admin', async () => {
    const { ctx } = await harness()
    const admin = await createUser(ctx, alice())
    await expect(ctx.collabUsers.setGlobalRole('admin', admin.id, 'member')).rejects.toThrow(/last enabled global admin/)
    await expect(ctx.collabUsers.setDisabled('admin', admin.id, true)).rejects.toThrow(/last enabled global admin/)
  })

  it('allows disabling once another admin exists', async () => {
    const { ctx } = await harness()
    const admin = await createUser(ctx, alice())
    const bob = await createUser(ctx, { sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' })
    await ctx.collabUsers.setGlobalRole('admin', bob.id, 'admin')
    const disabled = await ctx.collabUsers.setDisabled('admin', admin.id, true)
    expect(disabled.disabled).toBe(true)
    expect(ctx.collabUsers.findById(admin.id)?.disabled).toBe(true)
  })
})

describe('touch and persistence', () => {
  it('reads back accounts after a fresh boot on the same root', async () => {
    const { ctx } = await harness()
    const aliceUser = await createUser(ctx, alice())
    await ctx.fiber.dispose()
    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(CollabUsers, { dshHome: root! })
    expect(ctx2.collabUsers.findById(aliceUser.id)?.email).toBe('alice@example.com')
  })

  it('persists the first sign-in immediately and defers in-interval touches', async () => {
    const { ctx } = await harness()
    const user = await createUser(ctx, alice())
    const file = join(root as string, 'collab', USERS_FILE_NAME)

    await ctx.collabUsers.touch(user.id)
    const afterFirst = JSON.parse(await readFile(file, 'utf8')) as { users: Array<{ lastSeenAt?: string }> }
    expect(afterFirst.users[0]?.lastSeenAt).toBeDefined()
    expect(ctx.collabUsers.findById(user.id)?.lastSeenAt).toBeDefined()

    const mtimeAfterFirst = (await stat(file)).mtimeMs
    const contentAfterFirst = await readFile(file, 'utf8')
    await ctx.collabUsers.touch(user.id)
    const mtimeAfterSecond = (await stat(file)).mtimeMs
    const contentAfterSecond = await readFile(file, 'utf8')
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst)
    expect(contentAfterSecond).toBe(contentAfterFirst)
  })

  it('persists lastSeenAt once the touch interval elapses', async () => {
    const { ctx } = await harness()
    const user = await createUser(ctx, alice())
    const file = join(root as string, 'collab', USERS_FILE_NAME)
    const stale = {
      ...JSON.parse(await readFile(file, 'utf8')) as { version: 1; users: unknown[] },
    }
    const staleRecord = (stale.users[0] as { lastSeenAt?: string })
    staleRecord.lastSeenAt = new Date(Date.now() - 2 * TOUCH_PERSIST_INTERVAL_MS).toISOString()
    await writeFile(file, `${JSON.stringify(stale, null, 2)}\n`, 'utf8')
    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(CollabUsers, { dshHome: root! })
    await ctx2.collabUsers.touch(user.id)
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { users: Array<{ lastSeenAt?: string }> }
    expect(persisted.users[0]?.lastSeenAt).toBeDefined()
  })
})

describe('profiles', () => {
  it('projects client-safe facts without identity internals', async () => {
    const { ctx } = await harness()
    const user = await createUser(ctx, alice())
    const profile = ctx.collabUsers.profileOf(user)
    expect(profile).toEqual({
      id: user.id,
      email: 'alice@example.com',
      name: 'Alice',
      avatarUrl: 'https://example.com/alice.png',
      globalRole: 'admin',
    })
    expect(UserId('x')).toBe('x')
  })
})
