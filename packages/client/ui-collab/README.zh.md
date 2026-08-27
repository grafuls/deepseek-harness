# @deepseek-ai/dsh-client-ui-collab

[English](README.md) | 中文

Web GUI 的 collab 工作区管理器。这个浏览器插件列出已登录用户所属的工作区、创建新工作区、接受发给当前用户的邀请，并对选中的工作区显示成员与邀请、发送邀请、修改成员角色、移除成员以及删除工作区。成员的「打开」会把 collab 工作区变成真实的主机工作区（collab API 将其挂载到保留的数据目录上），并经由运行时 Workspace 面把 GUI 切换进它，于是诞生于其中的会话会被共享并作用到该工作区的数据。登录门本身来自 [dsh-client-ui-auth](../ui-auth/README.zh.md)，本包在其后组合：ui-collab 只在浏览器持有 collab 会话 Cookie 时才渲染。

插件注册两个条目，都通过槽声明器组合出去，而非无条件挂载：侧边栏 Workspaces 浏览区下方的 collab 区块（`sidebar.workspaces.collab`），以及渲染列表与详情的 `shell.overlay` 管理器面板。与槽属主（ui-workspace、ui-layout）的 apply 顺序不受约束；每次注册都用 `slots.inject` 等待各自的声明。两个条目共享 `apply` 内创建的同一个 store 句柄，因此从区块行打开管理器、在面板里驱动它，读到的都是同一份状态。

## 挂载了什么

- Node 半面（`src/index.ts`）：惰性——本包完全位于浏览器侧。
- 浏览器半面（`src/client/`）：一个 `apply`，创建工作区 store 和基于 collab RPC 通道的控制器，然后注册两个槽条目。store hook 以 `useCollabWorkspaces` 注入 hook 的形式到达组件；动作（打开、关闭、打开管理器到某个工作区、把工作区打开进 GUI、刷新、选择、创建、邀请、撤销、接受、改角色、移除、删除）经由 inject 面透传。

## collab 面契约

管理器只经由共享的 `/api` 连接 RPC 信封通信（`collab/workspace.*`、`collab/auth.status`），与 GUI 其余部分同一条通道，因此它使用会话 Cookie，且不需要 localStorage。可用性探测把每一种失败——未挂载 collab 面、没有会话 Cookie、传输错误——折叠为 `hidden`，此时两个条目都渲染为空：单用户 `web` 安装与未登录的浏览器看到的都是不变的应用。工作区角色来自线上数据（`workspace.role`）；管理动作的 UI 门禁只是呈现，collab API 网关的 `requireWorkspaceAndRole` 才是执行点。

## Model Experience

None, as this is a presentation-only workspaces manager; the workspace scoping it reflects is enforced server-side by the collab API gateway, which owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **未授权时隐藏而非解释** —— 当浏览器没有 collab 会话（或未挂载 collab 面）时，区块与面板只是不渲染，没有说明原因的横幅。在 collab 实例上回答这个问题的是 ui-auth 门。
- **挂载后的 collab 工作区也会出现在标准 Workspaces 列表中** —— collab API 用真实主机工作区注册表挂载它，因此侧边栏的常规 Workspaces 列表会把同一个工作区当作普通工作区显示。在那里重命名或删除作用于真实工作区（重命名会使主机标题与 collab 记录分叉；下一次成员的「打开」会重新断言 collab 名称）。成员管理请在这块面板中进行。
- **共享同一个实例平面** —— 工作区共享同一条浏览器会话 Cookie；工作区不带自己的登录，也没有自己的一组会话。挂在 collab 工作区内的会话仍然落在该工作区共享的数据目录中。
