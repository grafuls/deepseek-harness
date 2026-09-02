# Agent Note: collab 侧边栏把公共与私有工作区并为一个区块

Status: implemented
Archived: 2026-09-01

[English](2026-09-01-collab-sidebar-one-section-two-groups.md) | 中文

## Problem

侧边栏上下堆叠了两个工作区区域：本地 Workspaces 浏览区（标题「公共工作区」）与它下方的独立「协作工作区」区块（标题「私有工作区」）。两者各自带完整的区块头部——标题、可展开的搜索、视图选项、添加工作区——以及各自的边框块，于是一个概念上的同一面被读成两个区块，为同一件事重复了两份头部装饰。

## Decision

侧边栏现在显示一个 Workspaces 区块与两个带标签分组。浏览区的头部仍是该区块唯一的头部；collab 块渲染在本地列表下方，作为该区块的第二个带标签分组，由一个缩进的「私有工作区」分组标签和细分隔线下方的紧凑工具栏（可展开的搜索、视图选项、添加工作区）标识——不再呈现第二个区块头部。

- **collab 块变成 ARIA group，而不是 region。** `CollabSection` 渲染一个以标题为标签的 `role="group"`，而不是 `<section>`，于是无障碍树暴露的是一个工作区 region 内含一个带标签的分组，而非两个 region。
- **两条数据流保持分离。** 本地浏览区与 collab 控制器／store 均不变；分组保留自己的搜索、视图选项与添加入口，其列表仍是同一内缩距内滚动的一小块（最高占列高的 40%），因此与上方会话行的行对齐保持不变。
- **collab 面缺失时仍渲染为空。** 单用户安装的浏览区逐字节不变；席位与大列（wide）出口仍留在原地。

## Alternatives considered

- **完全合并成一个统一列表** —— 本地与 collab 工作区同列、单一搜索与单一视图选项菜单、collab 行混排并打标。被用户拒绝，改用更轻的分组设计：那会把两条数据流焊在一起、强制共享一套控制面，并模糊哪些行操作属于哪一侧来源。
- **把 collab 的搜索与视图选项折进单个区块头部。** 随着统一列表一起被拒：这些控件属于 collab 数据流，因此分组保留自己独立的紧凑工具栏。

## Consequences

- 顶部只有一个头部；其下是本地分组与 Private Workspaces 分组，以细分隔线分开、靠标签区分。
- collab 块的格式（工具栏、行、邀请）其余保持不变，因此会话浏览行为及其记录仍然成立；早先格式记录的「独立区块」与「区域带框头部」框架在此被取代，而其「复刻浏览区」的决策仍约束工具栏。
- `sidebar.workspaces.collab` 席位、其属主约定与包边界均未触碰——这仅是呈现与语义变化。

## Related

- [collab sidebar section mirrors the Workspaces browsing region](2026-08-29-collab-sidebar-section-format.zh.md) —— 本记录所重构的格式决策；其「独立区块」框架在此被取代，「复刻格式」的决策仍然成立。
- [collab sidebar section browses and opens the sessions inside each workspace](2026-08-29-collab-sidebar-section-session-browse.zh.md) —— 分组内部、不变的会话浏览行为。
