# Agent Note: Collab 克隆目录按其工作区 id 进行作用域限定

Status: implemented

[English](2026-09-07-collab-clone-layout-membership-scoping.md) | 中文

## 问题

[Host 平面成员资格门](2026-08-28-collab-host-plane-membership-scoping.zh.md)在检查成员资格之前，先把 Host 平面路径解析为某个 collab 工作区 id，然后按该工作区的成员来限定该路径。该解析器先解析 `<collabRoot>/workspaces/` 布局，只有当克隆目录位于该布局之外时才查询工作区记录。当未配置克隆目录时，仓库备份的工作区克隆到 `<collabRoot>/workspaces/<repo>-<workspaceId>`，于是解析器把目录名 `<repo>-<workspaceId>` 当作 id 返回——这与任何成员资格都不匹配。结果每一位成员（包括所有者）在此类工作区上执行 `session.create` 都被拒绝，错误为 `workspace-forbidden`。

## 决策

先通过工作区记录解析路径，再执行布局解析。工作区记录会命名其克隆目录，因此无论克隆位于 workspaces 布局之内，还是位于所配置的克隆根之下，路径都属于真实的、以工作区 id 标识的工作区，并由针对该 id 的成员资格来限定作用域。对于没有记录的布局路径（即仅具名工作区的 `<collabRoot>/workspaces/<workspaceId>` 目录），则仍从目录名解析其 id，保持不变。

## 备选方案

### 把 `<repo>-<workspaceId>` 目录名识别为 id

否决：目录名并不是工作区 id，因此先按布局解析会得到与任何成员资格键都不匹配的值；把该名称映射回 id 会引入一条记录本已拥有的解析规则。

### 把每条克隆路径记录为显式成员资格别名

否决：这会与工作区记录已拥有的 `clonePath` 重复，并增加一个需要保持同步的第二个真相来源；直接查询记录才是唯一来源，也无需新增持久化状态。

## 结果

成员——包括工作区 `developer` 角色的用户以及所有者——可以在仓库备份的 collab 工作区中创建会话，这与该门对仅具名工作区早已应用的“仅限成员”作用域规则一致。仅具名布局路径以及布局之外的克隆路径行为完全不变。唯一发生变化的是位于 workspaces 布局之内的克隆（当未设置克隆目录时的默认情况）：从“全员拒绝”变为“按成员限定”。该门仍然拒绝非成员，而位于每个 collab 工作区之外（由 Host 所有）的路径依旧对任何已认证主体开放。
