/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-collab-auth`.
 * @module @deepseek-ai/dsh-collab-auth/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-collab-auth'

/** Cordis companion plugin name. */
export const name = 'collab-auth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: sessions are stateless signed cookies the service
 * verifies on every request, and the only mutable relationship this package
 * owns is the short-lived authorization challenge, which is single-use and
 * time-boxed by construction. Identity correctness is enforced by the collab
 * user registry's own invariant companion. An empty installer is correct,
 * not an omission.
 */
const install: InvariantInstaller = () => {
  // Intentionally empty: see the module doc comment.
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
