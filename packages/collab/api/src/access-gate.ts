/**
 * Collab membership gate for the Host workspace plane: the multi-user overlay
 * scopes every collab-rooted Host workspace and session to its members, while
 * the Host plane itself stays principle-agnostic.
 * @module @deepseek-ai/dsh-collab-api
 */

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CollabPrincipal } from '@deepseek-ai/dsh-collab-auth'
import { WorkspaceId as makeWorkspaceId } from '@deepseek-ai/dsh-collab-workspaces'

/**
 * The per-principal visibility decision the Host plane consults for a
 * workspace directory or a session working directory. Provided by the collab
 * overlay only; a composition without it keeps the Host plane un-scoped.
 */
export interface CollabWorkspaceAccess {
  /** Canonical collab workspaces data root (the `<root>/workspaces` parent). */
  readonly collabRoot: string
  /**
   * Whether this principal may see and use the path. A path outside the collab
   * data root is always allowed (it is a Host-owned workspace); a path inside
   * `<root>/workspaces/<workspaceId>[/…]` is allowed only when the principal is
   * a member of that collab workspace.
   * @param principal - the gate-resolved principal (a collab principal when the overlay is active).
   * @param path - the workspace directory or session cwd to decide on.
   * @returns whether the principal may see and use that path.
   */
  allow(principal: unknown, path: string): boolean
}

/**
 * Build the collab membership gate over the mounted collab workspaces service.
 * @param ctx - the collab API plugin context with `collabWorkspaces` mounted.
 * @returns the gate decision.
 */
export function createCollabWorkspaceAccess(ctx: Context): CollabWorkspaceAccess {
  const root = ctx.collabWorkspaces.root
  // The Host plane stores canonical (realpath-resolved) paths, so the collab
  // boundary must be canonical too. The root appears after the first write, so
  // resolve lazily and every call re-checks the boundary against the latest
  // canonical form.
  let canonical: string | undefined
  const boundary = (): string => {
    if (canonical !== undefined) return canonical
    try {
      canonical = realpathSync.native(root)
    } catch {
      return root
    }
    return canonical
  }
  return {
    get collabRoot() {
      return boundary()
    },
    allow(principal, path) {
      const prefix = `${boundary()}${sep}workspaces${sep}`
      if (!path.startsWith(prefix)) return true
      const rest = path.slice(prefix.length)
      const separator = rest.indexOf(sep)
      const idText = separator === -1 ? rest : rest.slice(0, separator)
      const principalOf = (principal as CollabPrincipal | undefined)?.userId
      if (principalOf === undefined) return false
      return ctx.collabWorkspaces.memberOf(makeWorkspaceId(idText), principalOf) !== undefined
    },
  }
}
