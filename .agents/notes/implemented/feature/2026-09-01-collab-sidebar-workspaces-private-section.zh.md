# Agent Note：侧边栏的工作区席位只保留「工作区」区块

Status: implemented

[English](2026-09-01-collab-sidebar-workspaces-private-section.md) | 中文

## Problem

在「一个区块」整合之后，侧边栏唯一的 Workspaces 区块仍然以本地 Workspaces 浏览区（标题「公共工作区」）开头，collab 工作区作为带标签的分组排在它下方。用户要求从侧边栏移除公共工作区浏览区，让 collab 工作区取而代之，成为唯一的工作区面——包括完全没有 collab 面的单用户安装。

## Decision

侧边栏只有一个 Workspaces 席位 `sidebar.workspaces`，仅由 collab 工作区区块占据。本地浏览区从侧边栏整体移除：

- **浏览子系统被删除。** `WorkspaceBrowser` 及其行、树派生与视图 store 均从 ui-workspace 移除；该包现在只注册对话 hero 的 `WorkspacePicker`。侧边栏目录流孔洞（`sidebar.workspaces.directoryFlow`）仍作为纯类型契约保留声明，让 picker 包的共享类型链继续编译，但运行时没有任何东西挂载它。
- **collab 区块成为独立的「工作区」区块。** `CollabSection` 直接注册到 `sidebar.workspaces`，以独立的区块形式保留源自浏览区的格式作为自己的：区块标题、可展开的搜索、视图选项、添加工作区，以及点击即可打开的会话行。其根节点重新声明浏览区的列表内缩距与滚动条 CSS 变量，使列表保持与被它取代的浏览区一致的对齐；收起成 rail 时只保留点击即可展开侧边栏的搜索控件。
- **本地工作区仍可从侧边栏之外触达。** hero 的「选择工作区」picker 与「新会话」流程让每个本地工作区只需一次点击；工作区与会话数据均不变。
- **collab 面缺失时渲染为空。** 未登录（或单用户安装）时 `CollabSection` 自我隐藏，侧边栏 Workspaces 席位为空——这是移除本地区域且不回退的既定后果。

## Alternatives considered

- **保留本地浏览区在 collab 工作区上方（「一个区块、两个分组」设计）。** 被用户否决：用户要求将公共工作区整体替换；此前的分组设计被取代并归档。
- **只为 collab 安装隐藏浏览区、单用户仍保留。** 被否决：用户确认移除是无条件的——单用户侧边栏同样没有本地工作区列表，本地工作区仍可通过 picker 与「新会话」触达。
- **只删除注册、把浏览器组件留在休眠状态。** 作为简化被否决：浏览器组件没有运行时面就是死重，因此在移除注册时连同其测试一起删除。

## Consequences

- 侧边栏工作区在 collab 面就绪时显示「工作区」区块，否则为空；「一个头部下两个分组」的框架及其笔记被归档。
- ui-workspace 收窄为 picker 注册；重新生成的 client slot catalog 把 `CollabSection` 列为 `sidebar.workspaces` 的占据者。
- Web e2e 的侧边栏工作流（工作区管理、冷启动空白会话、rail 搜索展开、侧边栏滚动条／子代理活动、子代理会话）需要针对「仅工作区」的新侧边栏改写。
- 该区块的会话行为（行展开、点击打开会话、自动挂载）不变；其笔记保持有效，本地浏览区过滤机制已删除。

## Related

- [collab 侧边栏区块浏览并打开每个工作区内的会话](2026-08-29-collab-sidebar-section-session-browse.zh.md) —— 区块的会话行为，不变。
- 已被取代的两分组设计是已归档的历史：[collab 侧边栏把公共与私有工作区并为一个区块](../../archived/feature/2026-09-01-collab-sidebar-one-section-two-groups.md)。
- 该区块保留的浏览区格式是已归档的历史：[collab 侧边栏区块镜像 Workspaces 浏览区的格式](../../archived/feature/2026-08-29-collab-sidebar-section-format.md)。
