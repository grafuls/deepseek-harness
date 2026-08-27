/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-collab-rbac`.
 * @module @deepseek-ai/dsh-collab-rbac/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-collab-rbac'

/** Cordis companion plugin name. */
export const name = 'collab-rbac-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns a pure role-to-permission decision
 * whose allowed sets are closed unions pinned at compile time (the role and
 * permission types are `type` unions and the permission maps are
 * `Record<Role, readonly Permission[]>`), and every enforcement boundary
 * (`CollabForbiddenError`) is a caller-owned call-site decision checked by
 * workspace and instance state the collab stores own and invalidate, not a
 * durable relation this package publishes.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
