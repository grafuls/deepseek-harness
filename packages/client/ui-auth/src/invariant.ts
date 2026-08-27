/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-auth`.
 * @module @deepseek-ai/dsh-client-ui-auth/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-auth'

/** Cordis companion plugin name. */
export const name = 'ui-auth-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the plugin owns no mutable data relation to check.
// Its only state is the browser gate store, whose lifecycle is the effect
// that owns it; the session endpoint it probes is the collab API package's
// invariant surface (an exact route whose response shape the collab-api
// test suite pins).
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
