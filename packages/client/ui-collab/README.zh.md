# @deepseek-ai/dsh-client-ui-collab

[English](README.md) | 中文

Web GUI 的 collab 工作区管理器。这个浏览器插件列出已登录用户所属的工作区、创建新工作区，并对选中的工作区显示成员与邀请、发送邀请、修改成员角色、移除成员以及删除工作区。登录门本身来自 [dsh-client-ui-auth](../ui-auth/README.zh.md)，本包在其后组合：ui-collab 只在浏览器持有 collab 会话 Cookie 时才渲染。

插件注册两个条目，都通过槽声明器组合出去，而非无条件挂载：一个打开管理器的 `sidebar.footer.action` 触发器，以及一个渲染列表与详情的 `shell.overlay` 面板。与槽属主（ui-sidebar、ui-layout）的 apply 顺序不受约束；每次注册都用 `slots.inject` 等待各自的声明。两个条目共享 `apply` 内创建的同一个 store 句柄，因此从触发器打开管理器、在面板里驱动它，读到的都是同一份状态。

## 挂载了什么

- Node 半面（`src/index.ts`）：惰性——本包完全位于浏览器侧。
- 浏览器半面（`src/client/`）：一个 `apply`，创建工作区 store 和基于 collab RPC 通道的控制器，然后注册两个槽条目。store hook 以 `useCollabWorkspaces` 注入 hook 的形式到达组件；动作（打开、关闭、刷新、选择、创建、邀请、撤销、改角色、移除、删除）经由 inject 面透传。

## collab 面契约

管理器只经由共享的 `/api` 连接 RPC 信封通信（`collab/workspace.*`、`collab/auth.status`），与 GUI 其余部分同一条通道，因此它使用会话 Cookie，且不需要 localStorage。可用性探测把每一种失败——未挂载 collab 面、没有会话 Cookie、传输错误——折叠为 `hidden`，此时两个条目都渲染为空：单用户 `web` 安装与未登录的浏览器看到的都是不变的应用。工作区角色来自线上数据（`workspace.role`）；管理动作的 UI 门禁只是呈现，collab API 网关的 `requireWorkspaceAndRole` 才是执行点。

## Model Experience

None, as this is a presentation-only workspaces manager; the workspace scoping it reflects is enforced server-side by the collab API gateway, which owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **未授权时隐藏而非解释** —— 当浏览器没有 collab 会话（或未挂载 collab 面）时，触发器与面板只是不渲染，没有说明原因的横幅。在 collab 实例上回答这个问题的是 ui-auth 门。
- **不支持切换活动工作区** —— collab 模型把按工作区隔离的数据作用到目录，但本管理器不会把 GUI 切换到某个工作区；目前还没有这样的 RPC，这里的工作区详情也仅限于成员与邀请。
- **共享同一个实例平面** —— 工作区共享同一条浏览器会话 Cookie；工作区不带自己的登录，也没有自己的一组会话。
