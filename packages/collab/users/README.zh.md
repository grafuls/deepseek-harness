# @deepseek-ai/dsh-collab-users

[English](README.md) | 中文

持久的 collab 用户注册表（`ctx.collabUsers`）：携带实例级角色的 Google 身份用户账号，落盘为 harness 主目录下的一份原子 `users.json` 文档。注册表负责账号 CRUD 与全局管理员引导；变更方法显式接收执行者的全局角色，并在做出决策的操作点将裁决委托给 `dsh-collab-rbac`。

## 存储

一份 JSON 文档 `<root>/users.json`（默认 `<harness home>/collab/users.json`），在存储边界由 zod schema 校验，以 `0o600` 权限与 `0o700` 父目录（用户私有数据）原子写入。每一次变更都串行在同一个操作队列之后，并在 `collab/users/changed` 变更事件发出冻结快照之前完成提交。

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

## 全局管理员引导

满足以下任一条件的新账号会成为全局 `admin`：

- 其规范化邮箱出现在 `adminEmails` 配置白名单中；或
- 开启 `bootstrapFirstAdmin`，且尚不存在任何启用的管理员（即首个登录者）。

这里的守卫会拒绝罢免或禁用最后一个启用的全局管理员，从而保证实例永远保有一位管理员。

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


`setGlobalRole` 与 `setDisabled` 要求执行者持有 `users.manage` 权限（通过 `dsh-collab-rbac` 强制）；member 执行时将抛出 `CollabForbiddenError`。

## 事件

`collab/users/changed` —— 每次提交变更后触发，携带按注册表顺序排列的 `readonly UserRecord[]` 冻结快照。配套的 invariant 伴生模块订阅该事件，并在任一重复的 id、邮箱或 Google sub 出现时立即失败。

## 组合

```yaml
- id: collab-users
  name: '@deepseek-ai/dsh-collab-users'
  config:
    dshHome: !!js dshHome
    adminEmails: [ops@example.com]
```

## 模型体验

无，因为注册表只存储 Google 身份账号、不注册任何模型面对面的内容；collab surface 的消费者拥有任何模型可见效果。

#### KV Cache 影响

本包对模型请求无任何贡献，因此不会使缓存复用失效。

## 已知局限与延后工作

- **用户作用域在存储层，而非会话层**——注册表隔离账号；共享进程中的内存会话仍由 collab API 网关的授权管辖，而非本包。
- **默认无密码**——目前唯一的适配器是 Google 登录；公司 IdP 部署需要新的适配器（服务只消费 `GoogleProfile` 事实）。
- **不复查邮箱验证**——登录时按 Google 已验证信任其邮箱；手工编辑的 `users.json` 不会对照 Google 重新校验。
