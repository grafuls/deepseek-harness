/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-collab-workspaces`.
 * @module @deepseek-ai/dsh-collab-workspaces/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceRecord } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-collab-workspaces'

/** Cordis companion plugin name. */
export const name = 'collab-workspaces-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Runtime invariant: every published workspace snapshot is internally unique
 * by workspace id and invitation id, owns a unique membership per workspace,
 * keeps its owner as an `admin` member, and references only existing
 * workspaces from its invitations. The registry publishes a frozen snapshot
 * after every committed mutation, and a snapshot that violates any of these
 * means the registry is serving contradictory membership — a state that must
 * fail loud.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const seenWorkspaceIds = new Set<string>()
  const seenInvitationIds = new Set<string>()
  ctx.on('collab/workspaces/changed', (snapshot: { workspaces: readonly WorkspaceRecord[]; invitations: readonly WorkspaceInvitation[] }) => {
    seenWorkspaceIds.clear()
    seenInvitationIds.clear()
    for (const record of snapshot.workspaces) {
      if (seenWorkspaceIds.has(record.id)) fail(`duplicate collab workspace id '${record.id}'`)
      seenWorkspaceIds.add(record.id)
      const memberKeys = new Set<string>()
      for (const member of record.members as readonly WorkspaceMember[]) {
        const key = `${record.id}/${member.userId}`
        if (memberKeys.has(key)) fail(`duplicate membership '${key}'`)
        memberKeys.add(key)
      }
      const ownerMember = record.members.find(member => member.userId === record.ownerId)
      if (ownerMember === undefined) {
        fail(`collab workspace '${record.id}' owner is not a member`)
      } else if (ownerMember.role !== 'admin') {
        fail(`collab workspace '${record.id}' owner is not an admin`)
      }
    }
    const workspaceSet = new Set(snapshot.workspaces.map(record => record.id))
    for (const invitation of snapshot.invitations) {
      if (seenInvitationIds.has(invitation.id)) fail(`duplicate collab invitation id '${invitation.id}'`)
      seenInvitationIds.add(invitation.id)
      if (!workspaceSet.has(invitation.workspaceId)) {
        fail(`collab invitation '${invitation.id}' references unknown workspace '${invitation.workspaceId}'`)
      }
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
