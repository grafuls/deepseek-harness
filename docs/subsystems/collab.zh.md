# 协作

[English](collab.md) | 中文

协作层把单个 Harness 实例变成支持多用户的安装：在 Google OAuth 之后，[dsh-collab-api](../../packages/collab/api) 挂载认证与 RPC 面，[dsh-collab-auth](../../packages/collab/auth) 持有会话，[dsh-collab-users](../../packages/collab/users) 持有 Google 身份账户注册表，[dsh-collab-workspaces](../../packages/collab/workspaces) 持有带 admin/developer 角色模型的邀请制工作区。各部分只经由 `web-collab` profile 叠加层（[dsh-collab-bundle](../../packages/bundle/collab)）挂载；默认 `web` 安装与之前完全一样单用户运行，没有认证器，也没有协作面。

来源：[`packages/collab/api/src/dispatch.ts`](../../packages/collab/api/src/dispatch.ts)

## 会话与认证围栏

挂载协作 bundle 后，[dsh-collab-auth](../../packages/collab/auth) 通过 Google OIDC 让浏览器登录（`/api/collab/auth/login`、`/api/collab/auth/callback`），铸造带签名的会话 cookie，并在 `/api/collab/auth/session` 上报告登录状态。collab API 在共享连接上注册会话认证器：未登录的浏览器对每个 `/api` RPC 以及对 WebSocket 升级都被拒绝 `401 unauthorized`，而精确认证路由保持可达，以便浏览器始终可以登录。没有注册认证器时，连接保持开放，与单用户安装一致。

## 工作区与数据隔离

[dsh-collab-workspaces](../../packages/collab/workspaces) 在配置的根目录下维护持久的 `users.json` 与 `workspaces.json` 注册表，以及每个工作区一个 `workspaces/<id>` 数据目录，因此按工作区隔离的数据按目录作用域划分，而不是共享在一个会话平面里。成员按邀请邮箱加入；创建者成为 owner 与 admin；owner 不能离开或被降级，最后一个 admin 也不能被降级。工作区角色模型是 [dsh-collab-rbac](../../packages/collab/rbac) 中的策略（对权限集合的服务视图）：开发者读取成员并使用工作区，admin 额外邀请、管理成员并删除。

## 线上 API

collab API 拥有在 `/api` 下通过共享连接封装的 `collab/*` JSON-RPC 端点——`workspace.list/get/create/members/dir/invite/invitations/revokeInvitation/join/leave/delete/setMemberRole/removeMember`、`users.*` 管理面与 `collab/auth.status` 探测。浏览器端 [ui-auth 登录门](../../packages/client/ui-auth) 在 cookie 授权之前用登录页挡住应用，而 [ui-collab 工作区管理器](../../packages/client/ui-collab) 从侧栏底部动作按钮经同一 RPC 列出、创建、邀请并管理工作区。

## 已知限制

认证精确路由有意绕过 RPC 信任围栏，且在任何主机上都可达，因此只对以 localhost 优先的本地部署安全。会话是共享实例平面：每个浏览器一个 cookie，工作区不带自己的登录。回调成功依赖配置的 `redirectUri` 与提供方应用一致。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [WorkspaceId](workspace.zh.md)

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
