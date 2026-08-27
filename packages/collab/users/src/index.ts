/**
 * Collab user registry (`ctx.collabUsers`): durable Google-identity user
 * accounts with instance-wide roles over one atomic `users.json` document
 * under the harness home. The registry owns account CRUD and the global-admin
 * bootstrap; role enforcement for mutation methods takes the acting global
 * role explicitly and defers the decision to `dsh-collab-rbac` at the
 * operation that makes it.
 * @module @deepseek-ai/dsh-collab-users
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { authorizeGlobal } from '@deepseek-ai/dsh-collab-rbac'
import type { GlobalRole } from '@deepseek-ai/dsh-collab-rbac'
import { userRecordSchema, usersFileSchema, type UsersFile } from './schema.ts'
import type { GoogleProfile, UserId as UserIdBrand, UserProfile, UserRecord } from './types.ts'

/** Identifies one collab user account. */
export type UserId = UserIdBrand
export type { GoogleProfile, UserProfile, UserRecord } from './types.ts'
export type { UsersFile } from './schema.ts'

/**
 * Brand a string as a {@link UserId}.
 * @param id - opaque account identifier.
 * @returns the branded id.
 */
export function UserId(id: string): UserId {
  return id as UserId
}

/** The on-disk filename the registry owns inside its root. */
export const USERS_FILE_NAME = 'users.json'

/** How long a `touch` defers an in-memory-only `lastSeenAt` write. */
export const TOUCH_PERSIST_INTERVAL_MS = 60 * 60 * 1000

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Collab user registry. */
    collabUsers: CollabUsers
  }
  interface Events {
    /**
     * A collab user account was created or mutated; carries the frozen
     * post-commit snapshot in registry order.
     * @param records - every user record after the committed mutation.
     * @mode emit
     */
    'collab/users/changed'(records: readonly UserRecord[]): void
  }
}

/** Plugin config: the collab data root and the global-admin policy. */
export interface Config {
  /** Collab data directory; defaults to `<harness home>/collab`. */
  root?: string
  /** Harness home used when `root` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Email allowlist additionally promoted to global admin (case-insensitive). */
  adminEmails?: string[]
  /** The first account becomes global admin when no admin exists; defaults to true. */
  bootstrapFirstAdmin?: boolean
}

/**
 * Plugin config schema. Admin allowlist entries are validated at the config
 * boundary (they are opaque lookups, so only the shape is pinned here).
 */
export const Config: z<Config> = z.object({
  root: z.string().default(''),
  dshHome: z.string().default(''),
  adminEmails: z.array(z.string()).default([]),
  bootstrapFirstAdmin: z.boolean().default(true),
})

/** Resolved runtime spec derived from raw config; defaulting happens here, never inline. */
interface ResolvedSpec {
  root: string
  adminEmails: readonly string[]
  bootstrapFirstAdmin: boolean
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
  return {
    root,
    adminEmails: config.adminEmails ?? [],
    bootstrapFirstAdmin: config.bootstrapFirstAdmin ?? true,
  }
}

/**
 * Durable collab user registry. Startup loads or mints the `users.json`
 * document; every mutation is serialized behind one operation tail and
 * committed with an atomic write before the change event is emitted.
 */
export class CollabUsers extends Service {
  private readonly users = new Map<UserId, UserRecord>()
  private readonly byEmail = new Map<string, UserId>()
  private spec!: ResolvedSpec
  private file!: string
  private operationTail: Promise<void> = Promise.resolve()

  /**
   * @param ctx - owning context.
   * @param config - resolved plugin config (schema defaults applied by the Loader).
   */
  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'collabUsers')
  }

  /** Open the store: load or mint the document and publish the snapshot. */
  protected async [Service.init](): Promise<void> {
    this.spec = resolveSpec(this.config)
    this.file = join(this.spec.root, USERS_FILE_NAME)
    await this.load()
    this.publish()
  }

  /** The current registry owner is considered the collab data root. */
  get root(): string {
    return this.spec.root
  }

  /**
   * Create or refresh a user account from Google identity facts. Matches an
   * existing account by `googleSub` or normalized email, updates the display
   * facts, and records the sign-in; otherwise mints the account with the
   * global-admin bootstrap policy.
   * @param profile - Google identity for the sign-in.
   * @returns the current durable account.
   */
  findOrCreateByGoogle(profile: GoogleProfile): Promise<UserRecord> {
    return this.enqueue(async () => this.upsertGoogle(profile))
  }

  /**
   * Synchronous account lookup (the auth fence hot path).
   * @param id - the account to find.
   * @returns the record, or undefined when unknown.
   */
  findById(id: UserId): UserRecord | undefined {
    return this.users.get(id)
  }

  /**
   * Synchronous account lookup by normalized email.
   * @param email - email to search (normalized before matching).
   * @returns the record, or undefined when unknown.
   */
  findByEmail(email: string): UserRecord | undefined {
    const id = this.byEmail.get(normalizeEmail(email))
    return id === undefined ? undefined : this.users.get(id)
  }

  /**
   * Every account in registry order (admin surface; callers authorize).
   * @returns the frozen registry snapshot.
   */
  list(): readonly UserRecord[] {
    return [...this.users.values()]
  }

  /**
   * Client-safe projection of one account.
   * @param record - the stored account record.
   * @returns the projected profile for client surfaces.
   */
  profileOf(record: UserRecord): UserProfile {
    return {
      id: record.id,
      email: record.email,
      name: record.name,
      globalRole: record.globalRole,
      ...(record.avatarUrl !== undefined ? { avatarUrl: record.avatarUrl } : {}),
    }
  }

  /**
   * Change one account's global role. Requires the acting user to hold
   * `users.manage`; refuses to demote the last enabled admin.
   * @param actorRole - the acting user's global role.
   * @param id - the target account.
   * @param role - the role to assign.
   * @returns the updated account.
   */
  async setGlobalRole(actorRole: GlobalRole, id: UserId, role: GlobalRole): Promise<UserRecord> {
    authorizeGlobal(actorRole, 'users.manage')
    return this.enqueue(async () => {
      const record = this.requireRecord(id)
      if (record.globalRole === role) return record
      if (record.globalRole === 'admin' && !this.hasAdminBeyond(record)) {
        throw new Error(`cannot demote '${id}': it is the last enabled global admin`)
      }
      const next = { ...record, globalRole: role, updatedAt: now() }
      await this.persist([...this.users.values()].map(entry => entry.id === id ? next : entry))
      this.users.set(id, next)
      this.publish()
      return next
    })
  }

  /**
   * Block or unblock an account. Requires the acting user to hold
   * `users.manage`; refuses to disable the last enabled admin.
   * @param actorRole - the acting user's global role.
   * @param id - the target account.
   * @param disabled - desired block state.
   * @returns the updated account.
   */
  async setDisabled(actorRole: GlobalRole, id: UserId, disabled: boolean): Promise<UserRecord> {
    authorizeGlobal(actorRole, 'users.manage')
    return this.enqueue(async () => {
      const record = this.requireRecord(id)
      if (record.disabled === disabled) return record
      if (disabled && record.globalRole === 'admin' && !this.hasAdminBeyond(record)) {
        throw new Error(`cannot disable '${id}': it is the last enabled global admin`)
      }
      const next = { ...record, disabled, updatedAt: now() }
      await this.persist([...this.users.values()].map(entry => entry.id === id ? next : entry))
      this.users.set(id, next)
      this.publish()
      return next
    })
  }

  /**
   * Record a sign-in timestamp. Updates memory on every call but writes the
   * document only after {@link TOUCH_PERSIST_INTERVAL_MS} elapses, keeping
   * the auth fence off the disk write path.
   * @param id - the signed-in account.
   * @returns resolution once any triggered persist commits.
   */
  async touch(id: UserId): Promise<void> {
    const record = this.users.get(id)
    if (record === undefined) return
    const stamped = { ...record, lastSeenAt: now() }
    this.users.set(id, stamped)
    const age = record.lastSeenAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(stamped.lastSeenAt) - Date.parse(record.lastSeenAt)
    if (age < TOUCH_PERSIST_INTERVAL_MS) {
      return
    }
    await this.enqueue(async () => {
      await this.persist([...this.users.values()])
      this.publish()
    })
  }

  private async upsertGoogle(profile: GoogleProfile): Promise<UserRecord> {
    const email = normalizeEmail(profile.email)
    const byEmailId = this.byEmail.get(email)
    const existing = byEmailId !== undefined
      ? this.users.get(byEmailId)
      : [...this.users.values()].find(record => record.googleSub === profile.sub)
    if (existing !== undefined) {
      let touched = false
      if (existing.googleSub !== profile.sub) {
        // A reused email moved to a new Google identity: adopt the sub but keep
        // the account identity stable. The mismatch is surfaced to the store
        // so operators can audit the change.
        this.ctx.logger.warn(`collab: user '${existing.id}' changed Google sub from '${existing.googleSub}' to '${profile.sub}'`)
      }
      const next: UserRecord = {
        ...existing,
        googleSub: profile.sub,
        email,
        name: profile.name || existing.name,
        avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
        updatedAt: now(),
      }
      if (!sameAccount(existing, next)) {
        await this.persist([...this.users.values()].map(entry => entry.id === existing.id ? next : entry))
        touched = true
      }
      this.users.set(existing.id, next)
      this.byEmail.set(email, existing.id)
      if (touched) this.publish()
      return next
    }
    const record: UserRecord = {
      id: UserId(randomUUID()),
      googleSub: profile.sub,
      email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      globalRole: this.initialRole(email),
      disabled: false,
      createdAt: now(),
      updatedAt: now(),
      lastSeenAt: undefined,
    }
    await this.persist([...this.users.values(), record])
    this.users.set(record.id, record)
    this.byEmail.set(email, record.id)
    this.publish()
    return record
  }

  private initialRole(email: string): GlobalRole {
    if (this.spec.adminEmails.some(candidate => normalizeEmail(candidate) === email)) return 'admin'
    if (this.spec.bootstrapFirstAdmin && !this.hasAnyAdmin()) return 'admin'
    return 'member'
  }

  private hasAnyAdmin(): boolean {
    return [...this.users.values()].some(record => record.globalRole === 'admin' && !record.disabled)
  }

  private hasAdminBeyond(except: UserRecord): boolean {
    return [...this.users.values()]
      .some(record => record !== except && record.globalRole === 'admin' && !record.disabled)
  }

  private requireRecord(id: UserId): UserRecord {
    const record = this.users.get(id)
    if (record === undefined) throw new Error(`collab user '${id}' does not exist`)
    return record
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      await this.persist([])
      return
    }
    let document: UsersFile
    try {
      document = usersFileSchema.parse(JSON.parse(text) as unknown)
    } catch (cause) {
      throw new Error(`collab users document at '${this.file}' is invalid`, { cause })
    }
    this.users.clear()
    this.byEmail.clear()
    for (const record of document.users) this.index(record)
  }

  private index(record: UserRecord): void {
    this.users.set(record.id, record)
    this.byEmail.set(record.email, record.id)
  }

  private async persist(records: readonly UserRecord[]): Promise<void> {
    const document: UsersFile = { version: 1, users: records.map(record => userRecordSchema.parse(record)) }
    await writeFileAtomic(this.file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private publish(): void {
    this.ctx.emit('collab/users/changed', Object.freeze([...this.users.values()]))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function now(): string {
  return new Date().toISOString()
}

function sameAccount(left: UserRecord, right: UserRecord): boolean {
  return left.googleSub === right.googleSub
    && left.email === right.email
    && left.name === right.name
    && left.avatarUrl === right.avatarUrl
}

export default CollabUsers
