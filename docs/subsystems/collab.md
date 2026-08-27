# Collab Collaboration

English | [中文](collab.zh.md)

The collab layer turns one Harness instance into a multi-user installation behind Google OAuth: [dsh-collab-api](../../packages/collab/api) mounts the gate, [dsh-collab-auth](../../packages/collab/auth) owns sessions, [dsh-collab-users](../../packages/collab/users) owns the Google-identity account registry, and [dsh-collab-workspaces](../../packages/collab/workspaces) owns invite-only workspaces with an admin/developer role model. Every part is mounted only through the `web-collab` profile overlay ([dsh-collab-bundle](../../packages/bundle/collab)); a default `web` install runs single-user exactly as before, with no authenticator and no collab surface.

Source: [`packages/collab/api/src/dispatch.ts`](../../packages/collab/api/src/dispatch.ts)

## Sessions and the auth fence

When the collab bundle is mounted, [dsh-collab-auth](../../packages/collab/auth) signs browsers in through Google OIDC (`/api/collab/auth/login`, `/api/collab/auth/callback`), mints a signed session cookie, and reports sign-in state on `/api/collab/auth/session`. The collab API registers the session authenticator on the shared connection: an unsigned browser is refused `401 unauthorized` on every `/api` RPC and on WebSocket upgrades, while the exact auth routes stay reachable so the browser can always sign in. With no authenticator registered, the connection stays open as in a single-user install.

## Workspaces and data scoping

[dsh-collab-workspaces](../../packages/collab/workspaces) keeps durable `users.json` and `workspaces.json` registries plus a `workspaces/<id>` data directory per workspace under the configured root, so per-workspace data is scoped by directory rather than shared in one session plane. Members join by invitation email; the creator becomes the owner and admin; the owner cannot leave or be demoted and the last admin cannot be demoted. The workspace role model is the policy in [dsh-collab-rbac](../../packages/collab/rbac) (a service view over the permission sets): developers read members and use the workspace, admins additionally invite, manage members, and delete.

## Wire surface

The collab API owns the `collab/*` JSON-RPC endpoints served under `/api` over the shared connection envelope — `workspace.list/get/create/members/dir/invite/invitations/myInvitations/revokeInvitation/join/leave/delete/setMemberRole/removeMember/open`, the `users.*` admin surface, and the `collab/auth.status` probe. The browser [ui-auth client gate](../../packages/client/ui-auth) blocks the app behind a sign-in page until a cookie authorizes it, and the [ui-collab workspaces manager](../../packages/client/ui-collab) lists, creates, accepts invitations addressed to the user, and administers workspaces over the same RPC from the collab section under the sidebar's Workspaces list (a row opens the manager overlay for member and role detail). A member's Open mounts the collab workspace through `collab/workspace.open` as a real Host workspace over its reserved `workspaces/<id>` directory and switches the GUI into it via the runtime Workspace face; the Host registry resolves the same workspace for every member, so sessions born inside it share that directory.

## Known limitations

The auth exact routes intentionally bypass the RPC trust fence and are reachable on any host, which is safe only for loopback-first localhost deployments. Sessions are the shared instance plane: one cookie per browser, a workspace does not host its own login. Callback success depends on the configured `redirectUri` matching the provider application.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcollabauth--collabauth"></a>

### `ctx.collabAuth` — `CollabAuth`

Collab auth service. Startup binds the Google OIDC strategy and the required collab user registry; session resolution is a pure function of the cookie and the registry, keeping authenticated requests off any store path.

```ts cordis-catalog
/**
 * Begin a sign-in: stash an anti-CSRF challenge and return the provider's
 * authorization URL.
 * @param redirectTo - where the browser lands after the callback (default `/`).
 * @returns the provider authorization URL carrying `state` and `nonce`.
 */
async loginUrl(redirectTo: string = '/'): Promise<string>

/**
 * Finish a sign-in from the callback parameters: validate the exchange
 * against the pending challenge, upsert the Google identity, mint a session
 * token, and return the outcome for the host to apply.
 * @param params - raw callback query/form parameters (`code`, `state`, `nonce`).
 * @returns the post-login location and the session token to set.
 */
async completeLogin(params: Record<string, string>): Promise<LoginOutcome>

/**
 * Resolve the principal for a session cookie value, or undefined when the
 * token, its signature, its expiry, or the account is invalid. Never throws
 * on attacker-supplied tokens — it is the auth fence's hot path.
 * @param token - raw session token, or undefined for an unauthenticated call.
 * @param nowMs - clock instant used for the expiry check (for tests).
 * @returns the resolved principal, or undefined when unauthenticated.
 */
resolve(token: string | undefined, nowMs: number = Date.now()): CollabPrincipal | undefined

/**
 * Mint a session token for an account (primarily for tests and tooling).
 * @param userId - account the token authenticates.
 * @param nowMs - clock instant used for `iat`/`exp` (for tests).
 * @returns the freshly signed session token.
 */
createSessionToken(userId: UserId, nowMs: number = Date.now()): string

/**
 * The `Set-Cookie` value that mints this service's session.
 * @param token - session token to hand the browser.
 * @returns the `Set-Cookie` value.
 */
cookieValue(token: string): string

/**
 * The `Set-Cookie` value that clears this service's session.
 * @returns the `Set-Cookie` value.
 */
clearCookieValue(): string
```

Source: [`packages/collab/auth/src/index.ts`](../../packages/collab/auth/src/index.ts)

<a id="ctxcollabusers--collabusers"></a>

### `ctx.collabUsers` — `CollabUsers`

Durable collab user registry. Startup loads or mints the `users.json` document; every mutation is serialized behind one operation tail and committed with an atomic write before the change event is emitted.

```ts cordis-catalog
/**
 * Create or refresh a user account from Google identity facts. Matches an
 * existing account by `googleSub` or normalized email, updates the display
 * facts, and records the sign-in; otherwise mints the account with the
 * global-admin bootstrap policy.
 * @param profile - Google identity for the sign-in.
 * @returns the current durable account.
 */
findOrCreateByGoogle(profile: GoogleProfile): Promise<UserRecord>

/**
 * Synchronous account lookup (the auth fence hot path).
 * @param id - the account to find.
 * @returns the record, or undefined when unknown.
 */
findById(id: UserId): UserRecord | undefined

/**
 * Synchronous account lookup by normalized email.
 * @param email - email to search (normalized before matching).
 * @returns the record, or undefined when unknown.
 */
findByEmail(email: string): UserRecord | undefined

/**
 * Every account in registry order (admin surface; callers authorize).
 * @returns the frozen registry snapshot.
 */
list(): readonly UserRecord[]

/**
 * Client-safe projection of one account.
 * @param record - the stored account record.
 * @returns the projected profile for client surfaces.
 */
profileOf(record: UserRecord): UserProfile

/**
 * Change one account's global role. Requires the acting user to hold
 * `users.manage`; refuses to demote the last enabled admin.
 * @param actorRole - the acting user's global role.
 * @param id - the target account.
 * @param role - the role to assign.
 * @returns the updated account.
 */
async setGlobalRole(actorRole: GlobalRole, id: UserId, role: GlobalRole): Promise<UserRecord>

/**
 * Block or unblock an account. Requires the acting user to hold
 * `users.manage`; refuses to disable the last enabled admin.
 * @param actorRole - the acting user's global role.
 * @param id - the target account.
 * @param disabled - desired block state.
 * @returns the updated account.
 */
async setDisabled(actorRole: GlobalRole, id: UserId, disabled: boolean): Promise<UserRecord>

/**
 * Record a sign-in timestamp. Updates memory on every call but writes the
 * document only after {@link TOUCH_PERSIST_INTERVAL_MS} elapses, keeping
 * the auth fence off the disk write path.
 * @param id - the signed-in account.
 * @returns resolution once any triggered persist commits.
 */
async touch(id: UserId): Promise<void>
```

Source: [`packages/collab/users/src/index.ts`](../../packages/collab/users/src/index.ts)

<a id="ctxcollabworkspaces--collabworkspaces"></a>

### `ctx.collabWorkspaces` — `CollabWorkspaces`

Durable collab workspace registry. Startup loads or mints the `workspaces.json` document; every mutation is serialized behind one operation tail and committed with an atomic write before the change event is emitted.

```ts cordis-catalog
/**
 * Synchronous workspace lookup by id.
 * @param id - the workspace to find.
 * @returns the record, or undefined when unknown.
 */
findById(id: WorkspaceId): WorkspaceRecord | undefined

/**
 * Synchronous invitation lookup by id.
 * @param id - the invitation to find.
 * @returns the record, or undefined when unknown.
 */
findInvitationById(id: InvitationId): WorkspaceInvitation | undefined

/**
 * Synchronous per-member role lookup (the collab API hot path).
 * @param workspaceId - the workspace to inspect.
 * @param userId - the member to find.
 * @returns the member's workspace role, or undefined when not a member.
 */
roleOf(workspaceId: WorkspaceId, userId: UserId): WorkspaceRole | undefined

/**
 * Synchronous per-member lookup.
 * @param workspaceId - the workspace to inspect.
 * @param userId - the member to find.
 * @returns the membership, or undefined when not a member.
 */
memberOf(workspaceId: WorkspaceId, userId: UserId): WorkspaceMember | undefined

/**
 * Every workspace the user is a member of, as client-safe summaries.
 * @param userId - the member whose workspace list is requested.
 * @returns the client-safe summary per membership.
 */
listFor(userId: UserId): WorkspaceSummary[]

/**
 * Create a workspace. Any authenticated user may create one; the creator
 * becomes the owner and its first `admin` member.
 * @param actorGlobalRole - the acting user's global role (needs `workspace.create`).
 * @param actorId - the creating user.
 * @param name - display name (trimmed; must not be empty).
 * @returns the new workspace.
 */
async create(actorGlobalRole: GlobalRole, actorId: UserId, name: string): Promise<WorkspaceRecord>

/**
 * Read one workspace the actor is a member of.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.use`).
 * @param actorId - the acting user.
 * @param id - the workspace.
 * @returns the workspace record.
 */
async get(actorWorkspaceRole: WorkspaceRole, actorId: UserId, id: WorkspaceId): Promise<WorkspaceRecord>

/**
 * Invite a user into a workspace by normalized email.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.invite`).
 * @param workspaceId - the target workspace.
 * @param actorId - the inviting user (recorded as `createdBy`).
 * @param email - the invitee's email.
 * @param role - the role the invitee receives on joining (defaults to `developer`).
 * @returns the new invitation.
 */
async invite( actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId, actorId: UserId, email: string, role: WorkspaceRole = 'developer', ): Promise<WorkspaceInvitation>

/**
 * List every invitation of a workspace, pending or otherwise.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.invite`).
 * @param workspaceId - the target workspace.
 * @returns every invitation for the workspace, pending or otherwise.
 */
async listInvitations(actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId): Promise<WorkspaceInvitation[]>

/**
 * Every pending invitation addressed to an email (the acting user's own),
 * each with the target workspace's name for the accept surface. A self
 * query, so it takes no role: `delete` already removes a workspace's
 * invitations, so a pending invitation always resolves a live workspace.
 * @param email - the acting user's verified email.
 * @returns the pending-invitation accept facts for the addressed user.
 */
listPendingForEmail(email: string): WorkspaceInvitationForEmail[]

/**
 * Revoke a pending invitation (idempotent).
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.invite`).
 * @param workspaceId - the target workspace.
 * @param invitationId - the invitation to revoke.
 * @returns the revoked invitation.
 */
async revokeInvitation( actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId, invitationId: InvitationId, ): Promise<WorkspaceInvitation>

/**
 * Join a workspace by consuming a pending invitation addressed to the
 * acting user's email.
 * @param actorGlobalRole - the acting user's global role (needs `workspace.join`).
 * @param actorId - the joining user.
 * @param email - the acting user's verified email (must match the invitation).
 * @param invitationId - the invitation to consume.
 * @returns the joined workspace.
 */
async join( actorGlobalRole: GlobalRole, actorId: UserId, email: string, invitationId: InvitationId, ): Promise<WorkspaceRecord>

/**
 * Leave a workspace voluntarily. The owner cannot leave — delete the
 * workspace instead.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.use`).
 * @param actorId - the leaving member.
 * @param workspaceId - the workspace.
 */
async leave(actorWorkspaceRole: WorkspaceRole, actorId: UserId, workspaceId: WorkspaceId): Promise<void>

/**
 * List the members of a workspace.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.members.read`).
 * @param workspaceId - the workspace.
 * @returns the member list.
 */
async listMembers(actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId): Promise<WorkspaceMember[]>

/**
 * Change a member's role. The owner stays `admin`; the last `admin` member
 * cannot be demoted.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.members.manage`).
 * @param workspaceId - the workspace.
 * @param userId - the target member.
 * @param role - the role to assign.
 * @returns the updated membership.
 */
async setMemberRole( actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId, userId: UserId, role: WorkspaceRole, ): Promise<WorkspaceMember>

/**
 * Remove a member from a workspace. The owner cannot be removed; the last
 * `admin` member cannot be removed.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.members.manage`).
 * @param workspaceId - the workspace.
 * @param userId - the member to remove.
 * @returns the updated workspace.
 */
async removeMember( actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId, userId: UserId, ): Promise<WorkspaceRecord>

/**
 * Delete a workspace and every invitation into it.
 * @param actorWorkspaceRole - the acting workspace role (needs `workspace.delete`).
 * @param workspaceId - the workspace.
 */
async delete(actorWorkspaceRole: WorkspaceRole, workspaceId: WorkspaceId): Promise<void>
```

Types: [WorkspaceId](workspace.md)

Source: [`packages/collab/workspaces/src/index.ts`](../../packages/collab/workspaces/src/index.ts)

<a id="ctxrbac--rbacservice"></a>

### `ctx.rbac` — `RbacService`

The policy as a Cordis service, so collab consumers can inject one name and swap implementations without importing this package's functions. The methods are the pure functions; the class adds no semantics.

Source: [`packages/collab/rbac/src/index.ts`](../../packages/collab/rbac/src/index.ts)

<a id="collab-events"></a>

### `collab/*` events

<a id="collabuserschanged--emit"></a>

#### `collab/users/changed` — emit

A collab user account was created or mutated; carries the frozen post-commit snapshot in registry order.

```ts cordis-catalog
/**
 * A collab user account was created or mutated; carries the frozen
 * post-commit snapshot in registry order.
 * @param records - every user record after the committed mutation.
 * @mode emit
 */
'collab/users/changed'(records: readonly UserRecord[]): void
```

Source: [`packages/collab/users/src/index.ts`](../../packages/collab/users/src/index.ts)

<a id="collabworkspaceschanged--emit"></a>

#### `collab/workspaces/changed` — emit

A collab workspace or invitation was created, mutated, or removed; carries the frozen post-commit snapshot.

```ts cordis-catalog
/**
 * A collab workspace or invitation was created, mutated, or removed;
 * carries the frozen post-commit snapshot.
 * @param snapshot - frozen workspaces and invitations after the commit.
 * @mode emit
 */
'collab/workspaces/changed'(snapshot: WorkspaceRegistrySnapshot): void
```

Source: [`packages/collab/workspaces/src/index.ts`](../../packages/collab/workspaces/src/index.ts)
<!-- END GENERATED cordis-surface -->
