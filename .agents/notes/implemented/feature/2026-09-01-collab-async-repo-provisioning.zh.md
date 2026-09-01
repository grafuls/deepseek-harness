# Agent Note：collab 异步仓库置备

状态：implemented

[English](2026-09-01-collab-async-repo-provisioning.md) | 中文

## 问题

仓库后端的 collab 工作区把 `git clone` 同步跑在浏览器创建请求对应的 HTTP 请求内。在远程部署上请求存活时间足够长，以至于反向代理或 NAT 空闲超时切断连接：浏览器看到的是传输失败并呈现 `errorUnreachable`（「连接服务失败，请重试」），尽管服务器健康、（公开）仓库单独克隆完全正常。仅命名的工作区创建没问题因为很快；带仓库地址的创建则会「等待后失败」。失败的是传输而不是克隆：仓库是公开的，且服务器上 `git ls-remote` 成功，排除了凭据因素。

## 决策

`collab/workspace.create`（带仓库地址）现在注册一个置备中的工作区后立即应答；克隆作为 collab 网关上的 fire-and-forget 后台任务运行。注册表与 API 明确呈现生命周期：

- `WorkspaceSummary`/`CollabWorkspaceView` 带有必填的 `cloneState: 'none' | 'cloning' | 'ready'`。仓库引导的记录以 `cloning` 开始（`repoUrl` 已设、`clonePath` 未定义），后台任务记录克隆路径后翻转为 `ready`。
- 工作区服务新增 `settleClone(workspaceId, outcome)`：`{ kind: 'cloned', clonePath }` 持久化路径并返回 `'added'`（幂等），`{ kind: 'failed' }` 删除置备记录并返回 `'removed'`，而对已经落定或不存在的记录返回 `'absent'`，调用方可据此 `rm` 清理孤儿目标。克隆任务把克隆失败折叠进 `failed` 结果而不是抛出，因此失败的引导会自动移除记录——没有失败态记录、没有线上的 `collab-clone-failed`、没有失败态 UI。
- `collab/workspace.open` 与 `collab/workspace.dir` 以 `collab-clone-pending` 拒绝未落定的记录，客户端把该码折叠为本地化的「工作区仍在克隆中」横幅；列表行与侧边栏在 `cloning` 期间显示「克隆中…」徽标，侧边栏并禁用「新建会话」。
- 克隆任务拥有一个 `AbortController`：fire-and-forget 链不 await 任何 fiber 上的东西，因此慢速传输绝不会阻塞请求或插件拆除；一个普通 disposer 在网关拆除时中止进行中的克隆（`cloneRepository` 通过 `AbortSignal.any` 把任务信号与其内部十分钟超时合并，被中止的克隆会很快落定）。
- 事故教训保持一致：`collab-clone-failed` 已从 `RpcError` 代码集移除；create 端点根本不再应答克隆失败。

置备记录只能在网关于克隆中途重启时存活（disposer 无法跨进程中止已死进程）；创建者可以删除它。这记录在 Known Limitations 中。

## 备选方案

- **加长/可配置超时。** 拒绝：切断的是代理的空闲超时，harness 无法调高，因此把克隆移出请求才是唯一持久的修法。
- **在 UI 呈现失败态（记录 + `collab-clone-failed` 横幅）。** 与用户讨论后选择了静默自动移除：过期的失败行比没有更糟，而且此症状替代的传输故障本就给不出可操作的成因。
- **保留凭据管道。** 保留：真正私有的仓库仍需要服务端 git 凭据，与凭据功能一致；它与异步流程正交、不受影响。

## 后果

所有工作区的 create 都变成 O(请求时延)；慢克隆只影响工作区自身就绪。`cloneState` 是所有视图字面量上的必填线上与客户端字段。自动移除契约意味着 API 刻意没有克隆失败的诊断，测试必须等待后台落定（轮询 fake cloner 与列表状态）而不是断言同步失败。

本笔记取代了[原始仓库后端提案](2026-08-29-collab-repo-backed-workspaces.zh.md)中的同步克隆与 `collab-clone-failed` 行为。
