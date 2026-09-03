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
| `collab/workspace.rename` | 重命名 workspace（共享名称变更对每个成员生效，并会同步活动挂载的 Host 标题）；仅 workspace 管理员 |
| `collab/workspace.setMemberRole` | 修改成员角色；仅 workspace 管理员 |
| `collab/workspace.removeMember` | 移除成员；仅 workspace 管理员 |
| `collab/workspace.open` | 把 collab 工作区挂载为保留数据目录之上的真实主机工作区（成员即可打开）；主机注册表为每个成员解析到同一个工作区，且 Host 平面只为成员提供它及其会话 |
| `collab/users.list` | 账号名册；仅实例管理员 |
| `collab/users.setGlobalRole` | 提升/降级账号（`admin`/`member`）；仅实例管理员 |
| `collab/users.setDisabled` | 禁用/启用账号；仅实例管理员 |

错误折叠到封闭的 `RpcError` 代码集：授权拒绝（服务 RBAC）为 `collab-forbidden`，未知 workspace 为 `collab-not-found`，畸形的线上字段或其他服务失败为 `collab-bad-request`，缺少主机服务（组合中没有工作区注册表）为 `collab-internal`，重新断言与另一个主机工作区标题冲突的 collab 名称为 `collab-name-conflict`，打开或解析克隆尚未完成的仓库后端工作区为 `collab-clone-pending`。每个端点在线上边界完成校验，然后委托给所属服务，由服务负责持久化与 RBAC。

## 仓库后端的工作区

`collab/workspace.create` 接受 `repoUrl`；省略或传空字符串即创建仅命名的工作区。非空仓库地址会注册一个置备中的工作区，克隆在后台进行，因此创建请求立即应答——慢速传输永远不会让浏览器请求停在一个跨代理空闲超时上。克隆目标是 `<cloneRoot>/<repoName>-<workspaceId>`，其中 `<workspaceId>` 是生成的工作区 id，`<repoName>` 是净化成文件系统安全组件后的仓库名（方便管理员一眼认出克隆源自哪个仓库），`<cloneRoot>` 在 `collab` 设置命名空间的 `cloneDir` 被设置时取其值，否则取 collab 数据根下的 `workspaces` 目录。克隆根目录在创建时递归创建且必须对服务器用户可写；配置的目录若无法创建或写入，会立即以 `collab-bad-request` 应答——坏掉的克隆目录永远不会在一次注定失败的克隆之后静默移除工作区。克隆进行期间，列表行的 `cloneState` 为 `cloning`；`collab/workspace.open` 与 `collab/workspace.dir` 以 `collab-clone-pending` 拒绝置备中的记录，对已落定的记录（`cloneState` 为 `ready`）则解析克隆路径，因此成员共享克隆出的工作树作为所挂载工作区的数据。已落定的克隆还会在视图上填充 `gitState`——当前分支、缩写 HEAD 与是否存在未提交更改——在构建视图时通过对克隆的三条短 `git` 调用读取，上限五秒；克隆目录缺失、不是 git 检出或卡住时不报告 `gitState`，而不是让列表失败。在已落定克隆内创建的会话会被切换到自己的工作分支，名为 `<workspace>-<session>`——不存在时从当前 HEAD 创建，已存在时直接切换，因此重新创建或重新挂接的会话会回到自己那条线上，每个会话的提交与推送都留在各自的分支上，而工作区的主线分支保持不动；这个分叉是即发即忘的，失败只记 warn 日志，绝不影响会话创建。克隆经由 collab 本地的无 shell `git clone` 运行（spawn 时不给子进程 stdin 并设置 `GIT_TERMINAL_PROMPT=0`，因此用户无权访问的仓库会以 git 的 stderr 快速失败，而不是停在凭据提示上等待），超时为十分钟，并在 collab 网关拆除时被取消，运行中的克隆绝不被阻塞停机。克隆失败会删除不完整的目标并自动移除置备中的记录，因此失败的仓库初始化不会留下任何东西；因网关在克隆中途重启而残留的置备记录可由创建者删除。访问门通过 collab `workspaceHolding` 关系把克隆目录与数据根目录一视同仁，因此非成员对隐藏克隆下路径的请求会被拒绝。私有仓库只有在操作员配置了服务端 git 凭据（`gitToken` 加 `gitHost`）后才会克隆；该凭据是每实例的秘密，只通过一个宿主作用域、克隆结束后随即删除的 git 配置发送给那个宿主，因此永远不会到达浏览器、工作区记录或克隆自身的配置。

## Host 平面按成员资格划定作用域

collab 装配体还为 Host 工作区平面挂载了成员资格决策。在每次请求以及每条 `host()`/`mux()` 流打开时，Host 代理解析连接主体并咨询 collab 成员资格门：collab 根目录下的 Host 工作区（以及绑定在其中的会话）只对该工作区的成员列出、推送与可达，非成员指向隐藏 collab 目录的 Host 调用会被携带工作区 id 的 host 自有错误 `workspace-forbidden` 拒绝。普通 Host 工作区对每个已认证调用者依旧可见。门从服务存储实时读取，因此省略该覆盖层的单用户组合会让 Host 平面逐字节不变，而成员资格变更自下一次请求或新流起生效。

## 配置

本插件组合 collab 服务并负责两项配置：仓库克隆的默认目录（`cloneDir`，为运行时 `collab` 设置命名空间的值播种初始值，启动后该值由用户通过「协作工作区」设置页拥有），以及克隆私有仓库的可选服务端 git 凭据（`gitToken` 加 `gitHost`、`gitUsername`）。该凭据刻意只归操作员所有：它从插件配置读取，经一个临时、宿主作用域、克隆结束后立即删除的 git 配置路由到克隆，绝不通过 GUI 读回的设置命名空间暴露。其余所有调优都位于其挂载的 collab 服务中（`dsh-collab-*` 根目录、OAuth 客户端、Cookie 策略）。

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
  config:
    # Optional: default directory for cloning repository-backed workspaces
    # before the user overrides it through the settings page. Empty (the
    # default) clones under the collab data root's `workspaces` directory.
    cloneDir: !!js dshHomePath('collab/clones')
    # Optional: server git credential so private repositories clone. The
    # token is sent only to `gitHost` (github.com by default) through a
    # temporary host-scoped git config removed right after the clone.
    # gitHost: github.com
    # gitUsername: x-access-token
    # gitToken: <personal-access-token>
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
- **删除移除记录但不移除数据** —— `collab/workspace.delete` 会注销工作区，但把它的克隆（或数据）目录留在磁盘上，因此已删除仓库后端工作区的工作树对主机进程仍然可达。用同一个地址重新创建工作区会在新的以 id 命名的目录里实体化一个全新克隆。
