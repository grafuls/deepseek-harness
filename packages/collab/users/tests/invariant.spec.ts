import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import CollabUsers from '@deepseek-ai/dsh-collab-users'
import * as UsersInvariant from '@deepseek-ai/dsh-collab-users/invariant'
import type { UserId, UserRecord } from '../src/types.ts'

let root: string | undefined

const record = (id: string, email: string, googleSub: string): UserRecord => ({
  id: id as UserId,
  googleSub,
  email,
  name: 't',
  avatarUrl: undefined,
  globalRole: 'member',
  disabled: false,
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
  lastSeenAt: undefined,
})

describe('invariant companion', () => {
  it('registers the package ownership and tolerates a well-formed snapshot', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-users-inv-'))
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(UsersInvariant).await()
    await ctx.plugin(CollabUsers, { dshHome: root, bootstrapFirstAdmin: false })
    await ctx.collabUsers.findOrCreateByGoogle({
      sub: 'sub-a',
      email: 'a@example.com',
      name: 'A',
    })
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('fails loud on a duplicate identity in a published snapshot', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-users-inv-'))
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(UsersInvariant).await()
    const dup = record('u1', 'a@example.com', 'sub-a')
    expect(() => { ctx.emit('collab/users/changed', [dup, { ...dup, email: 'b@example.com' }]) })
      .toThrow(/duplicate/)
    expect(() => { ctx.emit('collab/users/changed', [dup, { ...dup, id: 'u2' as UserId }]) })
      .toThrow(/duplicate/)
    expect(() => { ctx.emit('collab/users/changed', [dup, { ...dup, id: 'u2' as UserId, email: 'other@example.com' }]) })
      .toThrow(/duplicate Google sub/)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
})
