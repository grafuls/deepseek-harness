# Agent Note: 多用户 collab 覆盖层（Google OAuth + RBAC 工作区）

Status: implemented

[English](2026-08-27-collab-multi-user-overlay.md) | 中文

## Problem

DeepSeek Harness 作为一个共享的 harness 进程运行，任何能访问它的浏览器共享同一个会话平面。当时没有任何方式让一个实例服务多个具名的人：没有认证、没有按人身份、没有工作区数据与角色的作用域。让产品多用户化触及每一层——线上协议、会话模型、数据布局与浏览器 GUI——因此这项工作需要先决定执行点放在哪里，以及如何让单用户安装保持不变。

## Decision

多用户是建立在一个服务器模型之上的可选覆盖层。单个 deepseek-harness 进程服务所有已登录用户；不会为每个用户 fork 或派生服务器。整个功能在 `web-collab` profile 补丁包（[`packages/bundle/collab`](../../../../packages/bundle/collab/README.zh.md)）之下交付：普通 `web` 安装不注册认证器、不挂载任何 collab UI，行为与之前完全相同。

- **身份与会话** —— [dsh-collab-auth](../../../../packages/collab/auth/README.zh.md) 通过 `openid-client` 的 discovery API 对 Google 运行浏览器 OIDC 往返，签发带签名的 `dsh_collab_session` Cookie，并暴露 `resolve`/`createSessionToken`/`loginUrl` 以及测试用来替换的网关 seam（`OidcGateway`）。登录流经由 `/api` 下的四个精确认证路由（`/api/collab/auth/login`、`/callback`、`/logout`、`/session`）。
- **认证围栏** —— [dsh-collab-api](../../../../packages/collab/api/README.zh.md) 在共享连接上注册连接认证器：除非浏览器的 Cookie 解析为某个 principal，否则每个 `/api` RPC 与每个 WebSocket 升级都被拒绝 401。没有注册认证器时（单用户），连接保持开放，与今天一致。围栏是连接属主的一个运行时不变式，collab RPC 拦截器在该 principal 之下分发 `collab/*` 端点。
- **身份与 RBAC** —— [dsh-collab-users](../../../../packages/collab/users/README.zh.md) 持有 Google 身份账户注册表，为每个账户带有全局 `admin`/`member` 角色；[dsh-collab-rbac](../../../../packages/collab/rbac/README.zh.md) 持有权限矩阵（全局 member = 创建/加入工作区，admin 增加用户管理；工作区 developer = 使用并读取成员，admin 增加邀请/管理/删除）。成员可以创建工作区；新登录不会自动创建工作区。
- **工作区与数据作用域** —— [dsh-collab-workspaces](../../../../packages/collab/workspaces/README.zh.md) 在配置的根目录（默认 `$DSH_HOME/collab`）下维护持久的 `users.json`/`workspaces.json` 以及每个工作区一个 `workspaces/<id>` 数据目录，因此按工作区隔离的数据以目录形式交付，而不是一个共享会话平面。成员资格按邀请邮箱加入；创建者成为 owner+admin，owner 不能离开或被降级，最后一个 admin 也不能被降级。
- **浏览器面** —— [dsh-client-ui-auth](../../../../packages/client/ui-auth/README.zh.md) 在浏览器未持有会话 Cookie 时用登录卡片覆盖整个应用；[dsh-client-ui-collab](../../../../packages/client/ui-collab/README.zh.md) 从侧边栏单个 Workspaces 区块内部的 collab 分组（点一行会打开管理器遮罩查看成员与角色详情）与 `shell.overlay` 管理器面板，经 GUI 其余部分使用的同一条共享 `/api` RPC 信封，列出、创建、接受发给当前用户的邀请并管理工作区（接受行读取 `collab/workspace.myInvitations`，并经 `collab/workspace.join` 加入）。某一行的「打开」调用 `collab/workspace.open`，把 collab 工作区挂载为保留的 `workspaces/<id>` 数据目录之上的真实主机工作区（按路径幂等，标题按主机注册表的唯一性不变量重新断言为 collab 名称），并经由运行时 Workspace 面把 GUI 切换进它，于是被挂载的工作区也会出现在标准 Workspaces 列表中，每个成员打开的都是同一个主机工作区。两者都经 `slots.inject` 组合出去，因此没有 collab 覆盖层时什么都不会挂载，非 collab 安装渲染结果不变。它们的产品文案不是写死的：各自在标准 locale seat 上注册一个词典命名空间（`collab.auth`、`collab.ui`），因此门与工作区管理器跟随 GUI 的语言设置（未声明支持语言的浏览器回退到英文）。

## Alternatives considered

### 每个用户一个服务器进程

每个认证用户得到各自隔离的 harness 进程。抛弃了共享进程模型且代价高昂：N 个服务器、N 个会话存储，没有同步层就无法共享工作区数据。约定的 scoped spec 固定为单进程服务所有用户，因此选择围栏 + 工作区目录模型。

### 每个能力一个 collab 包

作为包装或代理真实 harness 的独立顶级产品。被否：它增加第二套遥测/日志/会话系统，而不是与现有单用户安装组合的覆盖层，也无法让默认 `web` 行为保持逐字不变。

### 首次登录自动创建工作区

每个新 Google 账户首次登录都会得到一个个人工作区。被否：它违反邀请制语义，铸造了没人要求的数据，且约定的 spec 明确禁止为新用户自动创建工作区。

### 转发连接自身的 401 恢复

OIDC 往返是一次整页导航，因此 ui-auth 通过页面重新加载带新 Cookie 重新进入，而不是热重连一个已 401 的传输。连接级的恢复状态机留待后续；重新加载路径让围栏继续作为唯一权威并保持更简单。

## Consequences

一个进程服务许多用户，但对浏览器保持单一共享实例平面：每个浏览器一个会话 Cookie，工作区按数据目录作用域，而不是自己的登录或会话。Host 平面只为成员提供每个已挂载的 collab 工作区及其内部绑定的会话：collab 装配体挂载一个按主体的成员资格门，Host 代理在每次请求与流中都咨询它，因此非成员在标准列表中看不到任何 collab 工作区，指向隐藏 collab 目录的 Host 调用会被 host 自有错误 `workspace-forbidden` 拒绝（[按成员资格划定作用域的 Host 平面](2026-08-28-collab-host-plane-membership-scoping.zh.md)）。围栏覆盖每个 `/api` RPC 与 WebSocket 升级，这正是真正权威所在；GUI 层（先 ui-auth 后 ui-collab）只 fail-open，并在此基础上添加 wait-for-ready 探测。四个精确认证路由有意绕过 RPC 信任围栏，且在任何主机上都可达，只对优先 localhost 的部署安全——作为已知权衡记录，而非静默地「受保护」。现在当未固定任何来源时，OAuth redirect 来源会在每次登录时从请求推导，因此无回环的远程部署无需任何来源配置（[由请求推导的 redirect 来源](2026-08-29-collab-oauth-request-derived-redirect-origin.zh.md)）。RBAC 在独立包中带着类型化权限矩阵，因此按工作区策略无需完整 GUI 即可测试。整个功能的持久性由一个 REAL-composition 测试固定：它通过 Loader 以 fake OIDC 网关启动 `web-collab` profile；该组合还挂载真实主机工作区注册表（内存域存储），其中一条用例断言两个成员打开同一个 collab 工作区解析到同一个真实 Workspace，其规范路径即 collab 数据目录。
