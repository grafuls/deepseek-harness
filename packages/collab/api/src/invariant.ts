/**
 * Invariant companion for the collab API assembly.
 * @module @deepseek-ai/dsh-collab-api/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-collab-api'

/** Cordis companion plugin name. */
export const name = 'collab-api-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant:
 * the collab API assembly holds no mutable state of its own — it forwards the
 * connection gate's identity to the collab services and owns the fix-pointed
 * OIDC routes, while each collab service owns and asserts its own on-disk
 * document identity. There is no owned data/event relationship to check
 * here, so an empty installer is correct, not an omission.
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
