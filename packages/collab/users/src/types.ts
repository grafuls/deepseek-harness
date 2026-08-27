/**
 * Type-only module for the collab user registry. Runtime record schema and
 * the service live in `src/index.ts` / `src/schema.ts`; this module keeps the
 * cross-package surface (branded id, record shapes, Google profile input)
 * importable without pulling the runtime.
 * @module @deepseek-ai/dsh-collab-users/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GlobalRole } from '@deepseek-ai/dsh-collab-rbac'

/** Identifies one collab user account. */
export type UserId = Branded<'UserId'>

/** Google OpenID Connect identity facts the registration is derived from. */
export interface GoogleProfile {
  /** Google `sub` claim: the stable account id. */
  sub: string
  /** Verified Google account email. */
  email: string
  /** Display name from the Google profile. */
  name: string
  /** Profile picture URL, when present. */
  avatarUrl?: string
}

/**
 * Durable collab user account. `googleSub` is the Google identity's stable
 * claim; `email` is the primary lookup key and display handle; `globalRole`
 * is the instance-wide role; `disabled` blocks authentication and every
 * collab operation; timestamps are ISO-8601.
 */
export interface UserRecord {
  id: UserId
  googleSub: string
  email: string
  name: string
  avatarUrl: string | undefined
  globalRole: GlobalRole
  disabled: boolean
  createdAt: string
  updatedAt: string
  lastSeenAt: string | undefined
}

/** Client-safe projection of one user account (never carries identity internals). */
export interface UserProfile {
  id: UserId
  email: string
  name: string
  avatarUrl?: string
  globalRole: GlobalRole
}
