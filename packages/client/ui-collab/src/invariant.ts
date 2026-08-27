/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-collab`.
 * @module @deepseek-ai/dsh-client-ui-collab/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-collab'

/** Cordis companion plugin name. */
export const name = 'ui-collab-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the plugin owns no mutable data relation to check.
// Its only state is the browser workspaces store, whose lifecycle is the
// effect that owns it; the collab wire contract it calls is the collab API
// package's invariant surface (the /api envelope and endpoint results are
// pinned by the collab-api real-composition suite).
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
