# @deepseek-ai/dsh-collab-rbac

[English](README.md) | 中文

多用户 collab 层的基于角色的访问控制策略：两个相互独立的角色平面，以及「该角色能否执行此动作」这一纯粹决策。本包只拥有策略本身；所有执行边界都位于调用者的调用点。

## 角色

两个平面对应于产品内的两种信任作用域：

- 实例平面（`GlobalRole`：`admin` | `member`）——`admin` 在 `member` 持有的一切之外，追加实例级用户管理（`users.read`、`users.manage`）；`member` 持有 `users.self`、`workspace.create` 与 `workspace.join`。
- 工作区平面（`WorkspaceRole`：`admin` | `developer`）——`admin` 在 `developer` 持有的一切之外，追加工作区管理（`workspace.delete`、`workspace.invite`、`workspace.manage`、`workspace.members.manage`）；`developer` 持有 `workspace.use` 与 `workspace.members.read`。

权限映射表被导出（`GLOBAL_ROLE_PERMISSIONS`、`WORKSPACE_ROLE_PERMISSIONS`），因此角色变更只需更新一张表，所有消费者都能观察到。

## API

```ts
import RbacService, { hasGlobalPermission, authorizeWorkspace } from '@deepseek-ai/dsh-collab-rbac'

hasGlobalPermission('member', 'users.manage') // false
authorizeWorkspace('developer', 'workspace.invite') // throws CollabForbiddenError
```

- `hasGlobalPermission(role, permission)` / `hasWorkspacePermission(role, permission)` —— 纯布尔判断。
- `authorizeGlobal(role, permission)` / `authorizeWorkspace(role, permission)` —— 拒绝时抛出 [`CollabForbiddenError`](#collabforbiddenerror)。
- `RbacService`（挂载为 `ctx.rbac`）——以 Cordis 服务形式提供的同一套决策，collab 消费者只注入一个名字，即可替换实现。

## 组合

```yaml
- id: collab-rbac
  name: '@deepseek-ai/dsh-collab-rbac'
```

不注入任何服务；实例化 `RbacService` 并将其行命名为 `collab-rbac` 即可暴露 `ctx.rbac`。

## CollabForbiddenError

携带被拒绝的 `action` 与尝试该动作的 `role`；消息中不嵌入二者，因此该错误可安全对外呈现。

## 模型体验

无，因为该策略不注册任何提示词、工具 schema 或模型可见状态；执行调用点拥有任何模型可见效果。

#### KV Cache 影响

本包对模型请求无任何贡献，因此不会使缓存复用失效。

## 已知局限与延后工作

- **边界执行是调用者的职责**——本包只做决策、不做中介；导入这些辅助函数却忘记授权的服务仍会保持开放，因此 collab API 网关是唯一不可绕过的关口。
- **角色是静态联合**——自定义角色或按资源授权不在范围内；需要它们的部署应扩展联合类型与权限映射表。
