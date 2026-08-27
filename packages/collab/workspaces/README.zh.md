# @deepseek-ai/dsh-collab-workspaces

[English](README.md) | 中文

仅邀请制的 collab 工作区（`ctx.collabWorkspaces`）：持久的协作单元，成员分 `admin`/`developer` 两种角色，待处理邀请以规范化邮箱为地址，落盘为 harness 主目录下的一份原子 `workspaces.json` 文档。任何持有 `workspace.create` 权限的用户都可新建工作区并成为其所有者；其他人只能通过消费一封发到自己邮箱的邀请来加入。

## 存储

一份 JSON 文档 `<root>/workspaces.json`（默认 `<harness home>/collab/workspaces.json`），在存储边界由 zod schema 校验，以 `0o600` 权限与 `0o700` 父目录原子写入。与用户注册表共用同一 root，两份 collab 文档得以并列存放。

```ts
import type { WorkspaceId } from '@deepseek-ai/dsh-collab-workspaces'
import type { UserId } from '@deepseek-ai/dsh-collab-users'

interface WorkspaceRecord {
  id: WorkspaceId          // random UUID
  name: string
  ownerId: UserId          // creator; always an admin member
  members: { userId: UserId; role: 'admin' | 'developer'; joinedAt: string }[]
  createdAt: string        // ISO-8601
  updatedAt: string
}
```

## 所有权与成员规则

- **所有者**创建工作区、持有 `admin` 角色，且不能被降级、移除或自行离开——只能删除整个工作区。
- **邀请**以规范化邮箱为地址（可跨用户身份变更存活）。邀请分为待处理、已撤销或已消费；工作区拒绝重复的待处理邀请，也拒绝邀请当前成员（后者经由可选的 `collabUsers` 注册表）。
- **加入**即消费发给当前邮箱的邀请，并获得被授予的角色。这里不会出现“最后一个管理员”问题：所有者始终是 `admin`，因此工作区永远不会失去全部管理员。

## API

```ts
import type { WorkspaceId, InvitationId, WorkspaceMember } from '@deepseek-ai/dsh-collab-workspaces'
import type { GlobalRole, WorkspaceRole } from '@deepseek-ai/dsh-collab-rbac'
import type { UserId } from '@deepseek-ai/dsh-collab-users'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
declare const memberGlobal: GlobalRole
declare const memberId: UserId
declare const actorWorkspaceRole: WorkspaceRole
declare const adminWorkspaceRole: WorkspaceRole
declare const email: string

const created = await ctx.collabWorkspaces.create(memberGlobal, memberId, 'docs') // needs workspace.create
const wsId: WorkspaceId = created.id
await ctx.collabWorkspaces.get(actorWorkspaceRole, memberId, wsId) // needs workspace.use
ctx.collabWorkspaces.listFor(memberId) // own membership summaries
ctx.collabWorkspaces.roleOf(wsId, memberId) // sync hot path
const invite: InvitationId = (await ctx.collabWorkspaces.invite(adminWorkspaceRole, wsId, memberId, email)).id // needs workspace.invite
ctx.collabWorkspaces.listPendingForEmail(email) // the pending invitations addressed to one email (the accept surface)
await ctx.collabWorkspaces.join(memberGlobal, memberId, email, invite) // needs workspace.join
await ctx.collabWorkspaces.revokeInvitation(adminWorkspaceRole, wsId, invite) // needs workspace.invite
await ctx.collabWorkspaces.leave(actorWorkspaceRole, memberId, wsId) // needs workspace.use
const members: WorkspaceMember[] = await ctx.collabWorkspaces.listMembers(adminWorkspaceRole, wsId) // needs workspace.members.read
await ctx.collabWorkspaces.setMemberRole(adminWorkspaceRole, wsId, memberId, 'developer') // needs workspace.members.manage
await ctx.collabWorkspaces.removeMember(adminWorkspaceRole, wsId, memberId) // needs workspace.members.manage
await ctx.collabWorkspaces.delete(adminWorkspaceRole, wsId) // needs workspace.delete
```
每个变更方法都显式接收执行者的角色，并在做出决策的操作点将裁决委托给 `dsh-collab-rbac`，因此持有 `developer` 角色的成员不能邀请或管理。

## 可选的用户注册表耦合

工作区注册表通过 `ctx.get` 从可选的兄弟服务 `collabUsers` 读取身份事实（`id` ↔ `email`）。挂载后，邀请当前成员会被拒绝；独立运行（无用户注册表）时，注册表仍从结构上强制邀请门槛、邮箱匹配与成员唯一性。

## 事件

`collab/workspaces/changed` —— 每次提交变更后触发，携带冻结的 `{ workspaces, invitations }` 快照。配套的 invariant 伴生模块订阅该事件，并在出现重复的工作区 id、邀请 id、重复成员，或所有者不是 `admin` 成员时立即失败。

## 组合

```yaml
- id: collab-workspaces
  name: '@deepseek-ai/dsh-collab-workspaces'
  config:
    dshHome: !!js dshHome
```

## 模型体验

无，因为工作区注册表只存储成员关系与邀请、不注册任何模型面对面的内容；collab surface 的消费者拥有任何模型可见效果。

#### KV Cache 影响

本包对模型请求无任何贡献，因此不会使缓存复用失效。

## 已知局限与延后工作

- **工作区目前是元数据单元，还不是文件边界。** 注册表只建模成员关系；把每个工作区映射到独立的 `$DSH_HOME/collab/workspaces/<wsId>/` 目录以实现会话日志与文件的隔离，属于 collab 组装层的职责，延后到 collab-api host 插件处理。
- **邀请当前成员需要用户注册表。** 未挂载 `collabUsers` 时，邀请阶段无法按邮箱过滤成员（加入时仍从结构上强制）；collab bundle 总是同时挂载两者。
- **不支持所有权转移。** 工作区只有一个永久所有者；交接需要删除整个工作区。
