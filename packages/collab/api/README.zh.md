# @deepseek-ai/dsh-collab-api

[English](README.md) | 中文

Collab API 网关：一个函数插件，把共享的 harness 进程转变为 Google OAuth 背后的多用户实例。它把 collab 服务（`collabAuth`、`collabUsers`、`collabWorkspaces`）挂载到既有的 `/api` 通道之上，并补充五条面向浏览器的认证路由。该插件是选装件——未挂载本行时，默认的单用户 `dsh web` 配置保持不变；一旦挂载，每个 `/api` 请求都必须携带签名会话 Cookie，`collab/*` 就变为多用户的 workspace 表面。

## 认证表面

五条精确路由在绕过 JSON-RPC 围栏的情况下完成浏览器 OIDC 流程。在绑定回环地址的 localhost 部署中，这些路由按设计绕过 `/api` 信任围栏与信封检查（见 Known Limitations）。

| 路由 | 方法 | 行为 |
| --- | --- | --- |
| `/api/collab/auth/login` | GET | 携带一次性 `state` 挑战 302 跳转到 OIDC 提供方；其后通过 `?redirectTo=` 恢复浏览器跳转 |
| `/api/collab/auth/callback` | GET / POST | 完成兑换，设置 `dsh_collab_session` Cookie，302 跳转到结果位置 |
| `/api/collab/auth/session` | GET | JSON `{ "authenticated": false }` 或 `{ "authenticated": true, "principal": ... }` |
| `/api/collab/auth/logout` | POST | 204 并清除会话 Cookie |

三个路径常量均已导出（`COLLAB_AUTH_LOGIN_PATH`、`COLLAB_AUTH_SESSION_PATH`、`COLLAB_AUTH_LOGOUT_PATH`）。回调路径由 `collabAuth.redirectUri` 推导而来，因此覆盖 `redirectUri` 的部署会自动获得匹配的路由。

## Collab RPC

`collab/*` 端点复用共享 `/api` 通道与标准 JSON-RPC 信封。认证围栏先行：缺少有效会话 Cookie 的请求在任何端点逻辑之前即被回复 `401 unauthorized`。会话有效但解析出的主体不存在或被禁用的请求以 `collab-forbidden` 拒绝。

| 端点 | 用途 |
| --- | --- |
| `collab/auth.status` | 当前主体（`CollabPrincipalView`） |
| `collab/workspace.list` | 调用者所属的 workspace 列表 |
| `collab/workspace.create` | 创建 workspace（所有者即 workspace 管理员） |
| `collab/workspace.get` | 调用者所属的单个 workspace |
| `collab/workspace.members` | 调用者所属 workspace 的成员名册 |
| `collab/workspace.dir` | collab 根目录下按 workspace 隔离的数据目录，按需实体化 |
| `collab/workspace.invite` | 按邮箱邀请到某个角色（`admin`/`developer`）；仅 workspace 管理员 |
| `collab/workspace.invitations` | 未完成的邀请；仅 workspace 管理员 |
| `collab/workspace.myInvitations` | 发给调用者邮箱的待处理邀请，附带目标 workspace 名称 |
| `collab/workspace.revokeInvitation` | 撤销邀请；仅 workspace 管理员 |
| `collab/workspace.join` | 接受发给调用者的邀请 |
| `collab/workspace.leave` | 离开 workspace（所有者必须改为删除） |
| `collab/workspace.delete` | 删除 workspace；仅 workspace 所有者 |
| `collab/workspace.setMemberRole` | 修改成员角色；仅 workspace 管理员 |
| `collab/workspace.removeMember` | 移除成员；仅 workspace 管理员 |
| `collab/workspace.open` | 把 collab 工作区挂载为保留数据目录之上的真实主机工作区（成员即可打开）；主机注册表为每个成员解析到同一个工作区，且 Host 平面只为成员提供它及其会话 |
| `collab/users.list` | 账号名册；仅实例管理员 |
| `collab/users.setGlobalRole` | 提升/降级账号（`admin`/`member`）；仅实例管理员 |
| `collab/users.setDisabled` | 禁用/启用账号；仅实例管理员 |

错误折叠到封闭的 `RpcError` 代码集：授权拒绝（服务 RBAC）为 `collab-forbidden`，未知 workspace 为 `collab-not-found`，畸形的线上字段或其他服务失败为 `collab-bad-request`，缺少主机服务（组合中没有工作区注册表）为 `collab-internal`，重新断言与另一个主机工作区标题冲突的 collab 名称为 `collab-name-conflict`。每个端点在线上边界完成校验，然后委托给所属服务，由服务负责持久化与 RBAC。

## Host 平面按成员资格划定作用域

collab 装配体还为 Host 工作区平面挂载了成员资格决策。在每次请求以及每条 `host()`/`mux()` 流打开时，Host 代理解析连接主体并咨询 collab 成员资格门：collab 根目录下的 Host 工作区（以及绑定在其中的会话）只对该工作区的成员列出、推送与可达，非成员指向隐藏 collab 目录的 Host 调用会被携带工作区 id 的 host 自有错误 `workspace-forbidden` 拒绝。普通 Host 工作区对每个已认证调用者依旧可见。门从服务存储实时读取，因此省略该覆盖层的单用户组合会让 Host 平面逐字节不变，而成员资格变更自下一次请求或新流起生效。

## 配置

本插件不接收任何配置；所有调优都位于其挂载的 collab 服务中（`dsh-collab-*` 根目录、OAuth 客户端、Cookie 策略）。

```yaml
- id: collab-users
  name: '@deepseek-ai/dsh-collab-users'
  config:
    root: !!js dshHomePath('collab/users')
- id: collab-workspaces
  name: '@deepseek-ai/dsh-collab-workspaces'
  config:
    root: !!js dshHomePath('collab/workspaces')
- id: collab-auth
  name: '@deepseek-ai/dsh-collab-auth'
  config:
    clientId: <google-client-id>
    clientSecret: <google-client-secret>
    secret: <strong-random-value>
    baseUrl: http://localhost:3080
- id: collab-api
  name: '@deepseek-ai/dsh-collab-api'
```

## Model Experience

None, as the gateway authenticates requests and forwards collab service responses over RPC, registering nothing model-facing; the harness session surface it authorizes owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **认证路由在 localhost 上绕过 JSON-RPC 围栏** —— login、callback、session、logout 四条精确路由在 `/api` 前缀路由之前应答，因此不携带信任围栏或信封检查。这对回环开发绑定上的 OIDC 流程可以接受；非回环部署必须在前端架设 TLS，并让 `baseUrl`/`redirectUri` 指向 IdP 实际重定向返回的公开主机。
- **回调路径必须与 `collabAuth.redirectUri` 一致** —— 回调路由由重定向 URI 的 pathname 推导而来，因此不一致的 `redirectUri` 会使登录直接失败，而非静默错指。
- **单一进程会话平面，按 workspace 绑定会话** —— 认证与活动会话位于进程平面（浏览器持有一个会话 Cookie），因此 collab workspace 没有自己的登录；打开一个 workspace 会将其挂载为真实 Host workspace，成员在其中启动的会话被绑定到共享的 `$DSH_HOME/.../collab/workspaces/<wsId>` 数据目录。
- **两条实时回显携带隐藏会话 id 但不携带会话内容** —— `host()` 的归档会话回显与 `mux()` 的任务/队列/问题基线是进程全局的，因此仍会携带调用者看不见的 collab 会话的工作区 id、会话 id 或任务状态；它们不携带任何会话内容，而枚举表面（`workspace.list`、`sessions.list`/`search`、`history`、`fork`）已被完全划定作用域。
- **成员资格在请求时与流打开时取样** —— `host()`/`mux()` 流在打开时捕获的主体在该流生命周期内保持不变，因此成员资格的授予或撤销作用于新的请求与新的流，而不是已经推送的帧。
- **`loader.await()` 不代表 collab 表面已就绪** —— 依赖方的激活在树报告加载完成之后还有一个 tick 才落定，因此就绪消费者应先探测 `/api/collab/auth/session` 再发起请求（真实组合测试正是这么做的）。
