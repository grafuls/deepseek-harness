/**
 * Collab workspace registry (`ctx.collabWorkspaces`): durable invite-only
 * collaboration units with admin/developer members and pending invitations
 * addressed to normalized emails, over one atomic `workspaces.json` document
 * under the harness home. The registry owns workspace CRUD, membership, and
 * invitations; role enforcement takes the acting roles explicitly and defers
 * the decision to `dsh-collab-rbac` at the operation that makes it.
 *
 * Identity facts (user id ↔ email) are read from the optional sibling
 * `collabUsers` registry through `ctx.get`, so the workspace registry stays
 * independently deployable and testable while the collab assembly enforces
 * the cross-registry membership invariants.
 * @module @deepseek-ai/dsh-collab-workspaces
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { authorizeGlobal, authorizeWorkspace } from '@deepseek-ai/dsh-collab-rbac'
import type { GlobalRole, WorkspaceRole } from '@deepseek-ai/dsh-collab-rbac'
import type { UserId } from '@deepseek-ai/dsh-collab-users'
import { workspaceInvitationSchema, workspaceRecordSchema, workspacesFileSchema, type WorkspacesFile } from './schema.ts'
import type {
  InvitationId as InvitationIdBrand,
  WorkspaceId as WorkspaceIdBrand,
  WorkspaceInvitation,
  WorkspaceInvitationForEmail,
  WorkspaceMember,
  WorkspaceRecord,
  WorkspaceSummary,
} from './types.ts'

/** Identifies one collab workspace. */
export type WorkspaceId = WorkspaceIdBrand
export type {
  WorkspaceInvitation,
  WorkspaceInvitationForEmail,
  WorkspaceMember,
  WorkspaceRecord,
  WorkspaceSummary,
} from './types.ts'
/** Identifies one invitation into a workspace. */
export type InvitationId = InvitationIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - opaque workspace identifier.
 * @returns the branded id.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * Brand a string as an {@link InvitationId}.
 * @param id - opaque invitation identifier.
 * @returns the branded id.
 */
export function InvitationId(id: string): InvitationId {
  return id as InvitationId
}

/** The on-disk filename the registry owns inside its root. */
export const WORKSPACES_FILE_NAME = 'workspaces.json'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Collab workspace registry. */
    collabWorkspaces: CollabWorkspaces
  }
  interface Events {
    /**
     * A collab workspace or invitation was created, mutated, or removed;
     * carries the frozen post-commit snapshot.
     * @param snapshot - frozen workspaces and invitations after the commit.
     * @mode emit
     */
    'collab/workspaces/changed'(snapshot: WorkspaceRegistrySnapshot): void
  }
}

/** Plugin config: the collab data root. */
export interface Config {
  /** Collab data directory; defaults to `<harness home>/collab`. */
  root?: string
  /** Harness home used when `root` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Plugin config schema. */
export const Config: z<Config> = z.object({
  root: z.string().default(''),
  dshHome: z.string().default(''),
})

/** Resolved runtime spec derived from raw config; defaulting happens here, never inline. */
interface ResolvedSpec {
  root: string
}

/**
 * Resolve the runtime spec: explicit non-empty `root` wins, else `<harness home>/collab`.
 * @param config - unresolved plugin config.
 * @returns the resolved runtime spec with defaults applied.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const explicit = config.root ?? ''
  const root = explicit === ''
    ? join(resolveDshHome(config.dshHome), 'collab')
    : resolve(explicit)
  return { root }
}

/**
 * Normalize an email for invitation and membership matching.
 * @param email - raw email from a caller or the Google profile.
 * @returns the trimmed, lowercased form used for matching.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** The subset of the user registry this service relies on for identity facts. */
interface UserRegistryFacts {
  findByEmail(email: string): { id: UserId } | undefined
}

/** One committed change to the workspace registry. */
export interface WorkspaceRegistrySnapshot {
  /** Every workspace in registry order. */
  workspaces: readonly WorkspaceRecord[]
  /** Every invitation in registry order. */
  invitations: readonly WorkspaceInvitation[]
}

/**
 * Durable collab workspace registry. Startup loads or mints the
 * `workspaces.json` document; every mutation is serialized behind one
 * operation tail and committed with an atomic write before the change event
 * is emitted.
 */
export class CollabWorkspaces extends Service {
  private readonly workspaces = new Map<WorkspaceId, WorkspaceRecord>()
  private readonly invitations = new Map<InvitationId, WorkspaceInvitation>()
  private readonly membership = new Map<WorkspaceId, Map<UserId, WorkspaceMember>>()
  private spec!: ResolvedSpec
  private file!: string
  private users: UserRegistryFacts | undefined
  private operationTail: Promise<void> = Promise.resolve()

  /**
   * @param ctx - owning context.
   * @param config - resolved plugin config (schema defaults applied by the Loader).
   */
  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'collabWorkspaces')
  }

  /** Open the store: load or mint the document, bind the optional user registry, publish. */
  protected async [Service.init](): Promise<void> {
    this.spec = resolveSpec(this.config)
    this.file = join(this.spec.root, WORKSPACES_FILE_NAME)
    await this.load()
    this.users = this.ctx.get('collabUsers', false)
    this.publish()
  }

  /** The current registry owner is considered the collab data root. */
  get root(): string {
    return this.spec.root
  }

  /**
   * Synchronous workspace lookup by id.
   * @param id - the workspace to find.
   * @returns the record, or undefined when unknown.
   */
  findById(id: WorkspaceId): WorkspaceRecord | undefined {
    return this.workspaces.get(id)
  }

  /**
   * Synchronous invitation lookup by id.
   * @param id - the invitation to find.
   * @returns the record, or undefined when unknown.
   */
  findInvitationById(id: InvitationId): WorkspaceInvitation | undefined {
    return this.invitations.get(id)
  }

  /**
   * Synchronous per-member role lookup (the collab API hot path).
   * @param workspaceId - the workspace to inspect.
   * @param userId - the member to find.
   * @returns the member's workspace role, or undefined when not a member.
   */
  roleOf(workspaceId: WorkspaceId, userId: UserId): WorkspaceRole | undefined {
    return this.membership.get(workspaceId)?.get(userId)?.role
  }

  /**
   * Synchronous per-member lookup.
   * @param workspaceId - the workspace to inspect.
   * @param userId - the member to find.
   * @returns the membership, or undefined when not a member.
   */
  memberOf(workspaceId: WorkspaceId, userId: UserId): WorkspaceMember | undefined {
    return this.membership.get(workspaceId)?.get(userId)
  }

  /**
   * Every workspace the user is a member of, as client-safe summaries.
   * @param userId - the member whose workspace list is requested.
   * @returns the client-safe summary per membership.
   */
  listFor(userId: UserId): WorkspaceSummary[] {
    return [...this.workspaces.values()]
      .filter(record => this.memberOf(record.id, userId) !== undefined)
      .map((record) => {
        const member = this.memberOf(record.id, userId)
        // The filter above proves membership; listFor must not guess a role.
        /* v8 ignore start -- unreachable through the API (filtered above). */
        if (member === undefined) throw new Error(`collab workspace '${record.id}' has no membership for '${userId}'`)
        /* v8 ignore stop */
        return {
          id: record.id,
          name: record.name,
          memberCount: record.members.length,
          isOwner: record.ownerId === userId,
          role: member.role,
          createdAt: record.createdAt,
        }
      })
  }

  /**
   * Create a workspace. Any authenticated user may create one; the creator
   * becomes the owner and its first `admin` member.
   * @param actorGlobalRole - the acting user's global role (needs `workspace.create`).
   * @param actorId - the creating user.
   * @param name - display name (trimmed; must not be empty).
   * @returns the new workspace.
   */
  async create(actorGlobalRole: GlobalRole, actorId: UserId, name: string): Promise<WorkspaceRecord> {
    authorizeGlobal(actorGlobalRole, 'workspace.create')
    return this.enqueue(async () => {
      const trimmed = name.trim()
      if (trimmed === '') throw new Error('collab workspace name must not be empty')
      const record: WorkspaceRecord = {
        id: WorkspaceId(randomUUID()),
        name: trimmed,
        ownerId: actorId,
        members: [{ userId: actorId, role: 'admin', joinedAt: now() }],
        createdAt: now(),
        updatedAt: now(),
      }
      await this.persist([...this.workspaces.values(), record], [...this.invitations.values()])
      this.workspaces.set(record.id, record)
      this.indexMembership(record)
      this.publish()
      return record
    })
  }

  /**
   * Read one workspace the actor is a member of.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.use`).
   * @param actorId - the acting user.
   * @param id - the workspace.
   * @returns the workspace record.
   */
  async get(actorWorkspaceRole: WorkspaceRole, actorId: UserId, id: WorkspaceId): Promise<WorkspaceRecord> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.use')
    return this.enqueue(() => {
      const record = this.requireWorkspace(id)
      if (this.memberOf(id, actorId) === undefined) {
        throw new Error(`collab authorization denied: not a member of workspace '${id}'`)
      }
      return record
    })
  }

  /**
   * Invite a user into a workspace by normalized email.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.invite`).
   * @param workspaceId - the target workspace.
   * @param actorId - the inviting user (recorded as `createdBy`).
   * @param email - the invitee's email.
   * @param role - the role the invitee receives on joining (defaults to `developer`).
   * @returns the new invitation.
   */
  async invite(
    actorWorkspaceRole: WorkspaceRole,
    workspaceId: WorkspaceId,
    actorId: UserId,
    email: string,
    role: WorkspaceRole = 'developer',
  ): Promise<WorkspaceInvitation> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.invite')
    return this.enqueue(async () => {
      const record = this.requireWorkspace(workspaceId)
      const normalized = normalizeEmail(email)
      if (normalized === '') throw new Error('collab invitation email must not be empty')
      const memberId = this.memberEmail(record, normalized)
      if (memberId !== undefined) {
        throw new Error(`collab: '${normalized}' is already a member of workspace '${workspaceId}'`)
      }
      if ([...this.invitations.values()].some(invitation => invitation.workspaceId === workspaceId
        && invitation.email === normalized
        && !invitation.revoked
        && invitation.usedAt === undefined)) {
        throw new Error(`collab: an invitation for '${normalized}' to workspace '${workspaceId}' is already pending`)
      }
      const invitation: WorkspaceInvitation = {
        id: InvitationId(randomUUID()),
        workspaceId,
        email: normalized,
        role,
        createdBy: actorId,
        createdAt: now(),
        revoked: false,
      }
      await this.persist([...this.workspaces.values()], [...this.invitations.values(), invitation])
      this.invitations.set(invitation.id, invitation)
      this.publish()
      return invitation
    })
  }

  /**
   * List every invitation of a workspace, pending or otherwise.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.invite`).
   * @param workspaceId - the target workspace.
   * @returns every invitation for the workspace, pending or otherwise.
   */
  async listInvitations(actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId): Promise<WorkspaceInvitation[]> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.invite')
    return this.enqueue(() => {
      this.requireWorkspace(workspaceId)
      return [...this.invitations.values()].filter(invitation => invitation.workspaceId === workspaceId)
    })
  }

  /**
   * Every pending invitation addressed to an email (the acting user's own),
   * each with the target workspace's name for the accept surface. A self
   * query, so it takes no role: `delete` already removes a workspace's
   * invitations, so a pending invitation always resolves a live workspace.
   * @param email - the acting user's verified email.
   * @returns the pending-invitation accept facts for the addressed user.
   */
  listPendingForEmail(email: string): WorkspaceInvitationForEmail[] {
    const normalized = normalizeEmail(email)
    return [...this.invitations.values()]
      .filter(invitation => invitation.email === normalized && !invitation.revoked && invitation.usedAt === undefined)
      .map((invitation) => {
        const record = this.requireWorkspace(invitation.workspaceId)
        return { invitation, workspaceName: record.name }
      })
  }

  /**
   * Revoke a pending invitation (idempotent).
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.invite`).
   * @param workspaceId - the target workspace.
   * @param invitationId - the invitation to revoke.
   * @returns the revoked invitation.
   */
  async revokeInvitation(
    actorWorkspaceRole: WorkspaceRole,
    workspaceId: WorkspaceId,
    invitationId: InvitationId,
  ): Promise<WorkspaceInvitation> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.invite')
    return this.enqueue(async () => {
      const invitation = this.invitations.get(invitationId)
      if (invitation === undefined || invitation.workspaceId !== workspaceId) {
        throw new Error(`collab invitation '${invitationId}' does not exist in workspace '${workspaceId}'`)
      }
      if (invitation.revoked) return invitation
      const next: WorkspaceInvitation = { ...invitation, revoked: true }
      await this.persist(
        [...this.workspaces.values()],
        [...this.invitations.values()].map(entry => entry.id === invitationId ? next : entry),
      )
      this.invitations.set(invitationId, next)
      this.publish()
      return next
    })
  }

  /**
   * Join a workspace by consuming a pending invitation addressed to the
   * acting user's email.
   * @param actorGlobalRole - the acting user's global role (needs `workspace.join`).
   * @param actorId - the joining user.
   * @param email - the acting user's verified email (must match the invitation).
   * @param invitationId - the invitation to consume.
   * @returns the joined workspace.
   */
  async join(
    actorGlobalRole: GlobalRole,
    actorId: UserId,
    email: string,
    invitationId: InvitationId,
  ): Promise<WorkspaceRecord> {
    authorizeGlobal(actorGlobalRole, 'workspace.join')
    return this.enqueue(async () => {
      const invitation = this.invitations.get(invitationId)
      if (invitation === undefined) throw new Error(`collab invitation '${invitationId}' does not exist`)
      if (invitation.revoked || invitation.usedAt !== undefined) {
        throw new Error(`collab invitation '${invitationId}' is no longer usable`)
      }
      if (invitation.email !== normalizeEmail(email)) {
        throw new Error(`collab authorization denied: invitation '${invitationId}' is not addressed to this user`)
      }
      const record = this.requireWorkspace(invitation.workspaceId)
      if (this.memberOf(record.id, actorId) !== undefined) {
        throw new Error(`collab: user is already a member of workspace '${record.id}'`)
      }
      const member: WorkspaceMember = { userId: actorId, role: invitation.role, joinedAt: now() }
      const next: WorkspaceRecord = { ...record, members: [...record.members, member], updatedAt: now() }
      const used: WorkspaceInvitation = { ...invitation, usedAt: now() }
      await this.persist(
        [...this.workspaces.values()].map(entry => entry.id === record.id ? next : entry),
        [...this.invitations.values()].map(entry => entry.id === invitationId ? used : entry),
      )
      this.workspaces.set(record.id, next)
      this.indexMembership(next)
      this.invitations.set(invitationId, used)
      this.publish()
      return next
    })
  }

  /**
   * Leave a workspace voluntarily. The owner cannot leave — delete the
   * workspace instead.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.use`).
   * @param actorId - the leaving member.
   * @param workspaceId - the workspace.
   */
  async leave(actorWorkspaceRole: WorkspaceRole, actorId: UserId, workspaceId: WorkspaceId): Promise<void> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.use')
    return this.enqueue(async () => {
      const record = this.requireWorkspace(workspaceId)
      if (this.memberOf(workspaceId, actorId) === undefined) {
        throw new Error(`collab authorization denied: not a member of workspace '${workspaceId}'`)
      }
      if (record.ownerId === actorId) {
        throw new Error(`collab: owner of workspace '${workspaceId}' must delete it, not leave`)
      }
      const next: WorkspaceRecord = {
        ...record,
        members: record.members.filter(entry => entry.userId !== actorId),
        updatedAt: now(),
      }
      await this.persist(
        [...this.workspaces.values()].map(entry => entry.id === workspaceId ? next : entry),
        [...this.invitations.values()],
      )
      this.workspaces.set(workspaceId, next)
      this.indexMembership(next)
      this.publish()
    })
  }

  /**
   * List the members of a workspace.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.members.read`).
   * @param workspaceId - the workspace.
   * @returns the member list.
   */
  async listMembers(actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId): Promise<WorkspaceMember[]> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.members.read')
    return this.enqueue(() => {
      const record = this.requireWorkspace(workspaceId)
      return record.members.map(member => ({ ...member }))
    })
  }

  /**
   * Change a member's role. The owner stays `admin`; the last `admin` member
   * cannot be demoted.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.members.manage`).
   * @param workspaceId - the workspace.
   * @param userId - the target member.
   * @param role - the role to assign.
   * @returns the updated membership.
   */
  async setMemberRole(
    actorWorkspaceRole: WorkspaceRole,
    workspaceId: WorkspaceId,
    userId: UserId,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.members.manage')
    return this.enqueue(async () => {
      const record = this.requireWorkspace(workspaceId)
      const member = this.memberOf(workspaceId, userId)
      if (member === undefined) throw new Error(`collab: user '${userId}' is not a member of workspace '${workspaceId}'`)
      if (record.ownerId === userId) {
        throw new Error(`collab: owner of workspace '${workspaceId}' cannot be demoted`)
      }
      if (member.role === role) return member
      const nextMember: WorkspaceMember = { ...member, role }
      const next: WorkspaceRecord = {
        ...record,
        members: record.members.map(entry => entry.userId === userId ? nextMember : entry),
        updatedAt: now(),
      }
      await this.persist(
        [...this.workspaces.values()].map(entry => entry.id === workspaceId ? next : entry),
        [...this.invitations.values()],
      )
      this.workspaces.set(workspaceId, next)
      this.indexMembership(next)
      this.publish()
      return nextMember
    })
  }

  /**
   * Remove a member from a workspace. The owner cannot be removed; the last
   * `admin` member cannot be removed.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.members.manage`).
   * @param workspaceId - the workspace.
   * @param userId - the member to remove.
   * @returns the updated workspace.
   */
  async removeMember(
    actorWorkspaceRole: WorkspaceRole,
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<WorkspaceRecord> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.members.manage')
    return this.enqueue(async () => {
      const record = this.requireWorkspace(workspaceId)
      if (record.ownerId === userId) {
        throw new Error(`collab: owner of workspace '${workspaceId}' cannot be removed`)
      }
      const member = this.memberOf(workspaceId, userId)
      if (member === undefined) throw new Error(`collab: user '${userId}' is not a member of workspace '${workspaceId}'`)
      const next: WorkspaceRecord = {
        ...record,
        members: record.members.filter(entry => entry.userId !== userId),
        updatedAt: now(),
      }
      await this.persist(
        [...this.workspaces.values()].map(entry => entry.id === workspaceId ? next : entry),
        [...this.invitations.values()],
      )
      this.workspaces.set(workspaceId, next)
      this.indexMembership(next)
      this.publish()
      return next
    })
  }

  /**
   * Delete a workspace and every invitation into it.
   * @param actorWorkspaceRole - the acting workspace role (needs `workspace.delete`).
   * @param workspaceId - the workspace.
   */
  async delete(actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId): Promise<void> {
    authorizeWorkspace(actorWorkspaceRole, 'workspace.delete')
    return this.enqueue(async () => {
      this.requireWorkspace(workspaceId)
      const remaining = [...this.invitations.values()].filter(invitation => invitation.workspaceId !== workspaceId)
      await this.persist([...this.workspaces.values()].filter(record => record.id !== workspaceId), remaining)
      this.workspaces.delete(workspaceId)
      this.membership.delete(workspaceId)
      this.invitations.clear()
      for (const invitation of remaining) this.invitations.set(invitation.id, invitation)
      this.publish()
    })
  }

  private memberEmail(record: WorkspaceRecord, email: string): UserId | undefined {
    return record.members.find((member) => {
      const known = this.users?.findByEmail(email)
      return known !== undefined && known.id === member.userId
    })?.userId
  }

  private requireWorkspace(id: WorkspaceId): WorkspaceRecord {
    const record = this.workspaces.get(id)
    if (record === undefined) throw new Error(`collab workspace '${id}' does not exist`)
    return record
  }

  private indexMembership(record: WorkspaceRecord): void {
    const byUser = new Map<UserId, WorkspaceMember>()
    for (const member of record.members) byUser.set(member.userId, member)
    this.membership.set(record.id, byUser)
  }

  private async persist(records: readonly WorkspaceRecord[], invitations: readonly WorkspaceInvitation[]): Promise<void> {
    const document: WorkspacesFile = {
      version: 1,
      workspaces: records.map(record => workspaceRecordSchema.parse(record)),
      invitations: invitations.map(invitation => workspaceInvitationSchema.parse(invitation)),
    }
    await writeFileAtomic(this.file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private publish(): void {
    const snapshot: WorkspaceRegistrySnapshot = {
      workspaces: Object.freeze([...this.workspaces.values()]),
      invitations: Object.freeze([...this.invitations.values()]),
    }
    Object.freeze(snapshot)
    this.ctx.emit('collab/workspaces/changed', snapshot)
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      await this.persist([], [])
      return
    }
    let document: WorkspacesFile
    try {
      document = workspacesFileSchema.parse(JSON.parse(text) as unknown)
    } catch (cause) {
      throw new Error(`collab workspaces document at '${this.file}' is invalid`, { cause })
    }
    this.workspaces.clear()
    this.invitations.clear()
    this.membership.clear()
    for (const record of document.workspaces) {
      this.workspaces.set(record.id, record)
      this.indexMembership(record)
    }
    for (const invitation of document.invitations) this.invitations.set(invitation.id, invitation)
  }
}

function now(): string {
  return new Date().toISOString()
}

export default CollabWorkspaces
