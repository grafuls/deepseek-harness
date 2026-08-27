/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-collab-users`.
 * @module @deepseek-ai/dsh-collab-users/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { UserRecord } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-collab-users'

/** Cordis companion plugin name. */
export const name = 'collab-users-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Runtime invariant: every published accounts snapshot is internally unique by
 * account id, normalized email, and Google sub, and carries no duplicate brand.
 * The registry publishes a frozen snapshot after every committed mutation, and
 * a snapshot that violates any uniqueness constraint means the registry is
 * serving contradictory identity bindings — a state that must fail loud.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const seenIds = new Set<string>()
  const seenEmails = new Set<string>()
  const seenSubs = new Set<string>()
  ctx.on('collab/users/changed', (records: readonly UserRecord[]) => {
    seenIds.clear()
    seenEmails.clear()
    seenSubs.clear()
    for (const record of records) {
      if (seenIds.has(record.id)) fail(`duplicate collab user id '${record.id}'`)
      if (seenEmails.has(record.email)) fail(`duplicate collab user email '${record.email}'`)
      if (seenSubs.has(record.googleSub)) fail(`duplicate Google sub '${record.googleSub}'`)
      seenIds.add(record.id)
      seenEmails.add(record.email)
      seenSubs.add(record.googleSub)
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
