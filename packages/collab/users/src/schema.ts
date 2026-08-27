/**
 * Durable-boundary zod schemas for the collab user registry: the on-disk
 * `users.json` document. The schema is the validator at the storage boundary —
 * every load and every write round-trips through it, so corrupt or foreign
 * documents fail loud on read and never reach the runtime store.
 * @module @deepseek-ai/dsh-collab-users/src/schema (internal)
 */

import { z } from 'zod'
import type { GlobalRole } from '@deepseek-ai/dsh-collab-rbac'
import type { UserId, UserRecord } from './types.ts'

/** Branded user-id schema; branding has no runtime representation. */
const userId = z.string().transform(value => value as UserId)

/** Global-role schema constrained to the closed role union. */
export const globalRoleSchema: z.ZodType<GlobalRole> = z.enum(['admin', 'member'])

/**
 * One durable collab user account. With optional fields typed as required
 * `string | undefined` on {@link UserRecord} (optional-only would conflict
 * with the repository's `exactOptionalPropertyTypes`), the schema casts to
 * the branded interface exactly as the storage-domain records do; zod still
 * validates shape and presence at the boundary.
 */
export const userRecordSchema = z.object({
  id: userId,
  googleSub: z.string().min(1),
  email: z.email(),
  name: z.string(),
  avatarUrl: z.string().optional(),
  globalRole: globalRoleSchema,
  disabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeenAt: z.string().optional(),
}) as unknown as z.ZodType<UserRecord>

/** The on-disk `users.json` document. */
export const usersFileSchema = z.object({
  version: z.literal(1),
  users: z.array(userRecordSchema),
}) as unknown as z.ZodType<{ version: 1; users: UserRecord[] }>

/** Durable document inferred from {@link usersFileSchema}. */
export type UsersFile = z.infer<typeof usersFileSchema>
