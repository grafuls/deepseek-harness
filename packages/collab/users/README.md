# @deepseek-ai/dsh-collab-users

English | [中文](README.zh.md)

Durable collab user registry (`ctx.collabUsers`): Google-identity user accounts with instance-wide roles over one atomic `users.json` document under the harness home. The registry owns account CRUD and the global-admin bootstrap; mutation methods take the acting global role explicitly and defer the decision to `dsh-collab-rbac` at the operation that makes it.

## Storage

One JSON document `<root>/users.json` (default `<harness home>/collab/users.json`), validated by a zod schema at the storage boundary, written atomically with `0o600` permissions and a `0o700` parent (user-private data). Every mutation is serialized behind one operation tail and committed before the `collab/users/changed` change event emits a frozen snapshot.

```ts
import type { UserId } from '@deepseek-ai/dsh-collab-users'

interface UserRecord {
  id: UserId            // random UUID
  googleSub: string     // Google OpenID Connect sub claim
  email: string         // normalized (trimmed, lowercased) — primary lookup
  name: string
  avatarUrl?: string
  globalRole: 'admin' | 'member'
  disabled: boolean
  createdAt: string     // ISO-8601
  updatedAt: string
  lastSeenAt?: string
}
```

## Global-admin bootstrap

A new account becomes global `admin` when either of these holds:

- its normalized email appears in the `adminEmails` config allowlist; or
- `bootstrapFirstAdmin` is on and no enabled admin exists yet (the first sign-in).

The guards refuse to demote or disable the last enabled global admin, so the instance can never be left without an administrator.

## API

```ts
import type { GoogleProfile, UserId, UserRecord } from '@deepseek-ai/dsh-collab-users'
import type { GlobalRole } from '@deepseek-ai/dsh-collab-rbac'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
declare const profile: GoogleProfile
declare const id: UserId
declare const email: string
declare const actorRole: GlobalRole
declare const role: GlobalRole
declare const disabled: boolean
declare const record: UserRecord

await ctx.collabUsers.findOrCreateByGoogle(profile) // mint or refresh; bootstraps role
ctx.collabUsers.findById(id)                        // sync hot path for the auth fence
ctx.collabUsers.findByEmail(email)                  // sync lookup by normalized email
ctx.collabUsers.list()                              // admin surface; callers authorize
await ctx.collabUsers.setGlobalRole(actorRole, id, role)   // requires users.manage
await ctx.collabUsers.setDisabled(actorRole, id, disabled) // requires users.manage
await ctx.collabUsers.touch(id)                     // sign-in timestamp (debounced persist)
ctx.collabUsers.profileOf(record)                   // client-safe projection
```


`setGlobalRole` and `setDisabled` require the acting user to hold the `users.manage` permission (enforced through `dsh-collab-rbac`); a member acting on them rejects with `CollabForbiddenError`.

## Events

`collab/users/changed` — emitted after every committed mutation with the frozen `readonly UserRecord[]` snapshot in registry order. The invariant companion subscribes to it and fails loud on any duplicate id, email, or Google sub.

## Composition

```yaml
- id: collab-users
  name: '@deepseek-ai/dsh-collab-users'
  config:
    dshHome: !!js dshHome
    adminEmails: [ops@example.com]
```

## Model Experience

None, as the registry stores Google-identity accounts and registers nothing model-facing; collab surface consumers own any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **User scoping is at the store, not the session plane** — the registry isolates accounts; live in-memory sessions in a shared process stay governed by the collab API gateway's authorization, not by this package.
- **Password-free by design** — the only adapter is Google sign-in; a deployment on a corporate IdP needs a new adapter (the service only needs `GoogleProfile` facts).
- **No email verification re-checks** — the Google email is trusted as verified by Google at sign-in; a hand-edited `users.json` is not re-validated against Google.
