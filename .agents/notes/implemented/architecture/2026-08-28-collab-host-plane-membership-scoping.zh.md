# Agent Note: Collab Host 平面按成员资格划定作用域

Status: implemented

[English](2026-08-28-collab-host-plane-membership-scoping.md) | 中文

## Problem

[多用户 collab 覆盖层](2026-08-27-collab-multi-user-overlay.zh.md)为 `/api` 通道加了门槛（每个请求与 WebSocket 升级都需要已签名的会话），但把 Host 工作区平面留在了进程全局。已挂载的 collab 工作区存在于这个共享平面上，因此任何已认证的用户——无论是否成员——都能在标准 Workspaces 列表里看到每个已挂载的 collab 工作区，并可通过 Host RPC（`workspace.list`/`create`、按 `workspaceId` 或 cwd 的 `sessions.create`、`history`、`fork`）以及实时的 `host()`/`mux()` 流来触及它们的数据目录与会话。一位只被邀请进两个工作区之一的用户报告称两个都能看见、都能到达。这个边界必须按主体（principal）划分，因为成员的 GUI 切换依赖 collab 工作区出现在他们自己的 Host 列表里。

## Decision

collab 覆盖层挂载了一个可选的成员资格门，Host API 代理在每次决策时都带着连接主体来咨询它。这个门（`CollabWorkspaceAccess`，仅由 collab 装配体以 `collabWorkspaceAccess` 服务提供）回答 `allow(principal, path)`：collab 数据根目录之外的路径总是放行（属于 Host 所有），而在 `<collabRoot>/workspaces/<workspaceId>[…]` 以内的路径，仅当主体是该 collab 工作区的成员时才放行。单用户装配不提供门，因此其 Host 平面逐字节不变。

- 代理在每次决策时从实时服务存储中读取门与连接主体，因此 collab 行可以挂在 api-gateway 行之前或之后；api-proxy 套件按生产顺序驱动（门在代理组合之后才提供），依然正确划定作用域。
- 工作区：`workspace.list` 只返回调用者可见的集合；`create`、`rename`、`delete`、`insertBefore`、`insertSessionBefore` 拒绝调用者不是成员的 collab 根目标；`host()` 流只提交并推送查看者可见的工作区与顺序。
- 会话：`sessions.create` 拒绝指向隐藏 collab 目录的 `workspaceId` 或 cwd；共享的 `listVisibleSessionSummaries` 同时过滤 `sessions.list` 与 `search`；`history` 与 `fork` 将隐藏目标报告为不存在；`mux()` 流只为可见会话订阅基线与会话实时帧。
- 拒绝被折叠为携带工作区 id 的 host 自有错误 `workspace-forbidden`；collab 客户端无需改动，因为隐藏工作区永远不会到达非成员的 UI。

## Alternatives considered

### 从 Host 平面隐藏所有已挂载的 collab 工作区

已否决：成员通过标准 Workspaces 界面切入 collab 工作区（`openWorkspace` → `mount` → 帧回显 → `startSession(hostId)`），因此把 collab 挂载从 Host 列表移除会破坏成员的使用，而且无法阻止非成员直接指向隐藏目录。

### 只在 collab 挂载路径上强制成员资格

已否决：泄漏报告显示访问经由未划定作用域的 Host RPC，因此执行点必须在每一条 Host 调用落点之处，而不只是 collab 覆盖层挂载工作区之处。

## Consequences

Host 平面只为成员提供每个已挂载的 collab 工作区及其内部绑定的会话，而普通 Host 工作区对每个已认证调用者依旧可见。成员资格按请求取样、在流打开时取样，因此授予与撤销作用于新的请求与新的流，而不是已在进行中的帧。两条实时回显按设计仍是进程全局的，并作为 Known Limitation 记录而非悄悄加门：`host()` 的归档会话回显与 `mux()` 的任务/队列/问题基线仍可能携带调用者看不见的会话的工作区 id、会话 id 或任务状态，但不会携带任何会话内容，而枚举表面（`workspace.list`、`sessions.list`/`search`、`history`、`fork`）已被完全划定作用域。
