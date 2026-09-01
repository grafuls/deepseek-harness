# @deepseek-ai/dsh-client-ui-collab

[English](README.md) | 中文

Web GUI 的 collab 工作区管理器。这个浏览器插件列出已登录用户所属的工作区、创建新工作区（可选用 GitHub 仓库地址，由 collab API 克隆到配置的本地目录作为工作区数据）、接受发给当前用户的邀请，并对选中的工作区显示成员与邀请、发送邀请、修改成员角色、移除成员以及删除工作区。collab API 把每个工作区实现为挂载在保留数据目录之上的真实主机工作区，因此诞生于其中的会话会被共享并作用到该工作区的数据。侧边栏区块在渲染时会自动挂载每个成员工作区（挂载是幂等的，所以其他成员创建的会话会自动出现），会话则直接从其行打开。登录门本身来自 [dsh-client-ui-auth](../ui-auth/README.zh.md)，本包在其后组合：ui-collab 只在浏览器持有 collab 会话 Cookie 时才渲染。

插件注册两个条目，都通过槽声明器组合出去，而非无条件挂载：侧边栏 Workspaces 浏览区正下方的 collab 区块（`sidebar.workspaces.collab`），以及渲染列表与详情的 `shell.overlay` 管理器面板。该区块紧贴本地 Workspaces 浏览区之下并复刻其格式：带区域边框的头部（标题、可展开的搜索、与本地浏览区相同的分组/排序视图选项菜单，以及打开创建对话框的添加工作区按钮），下面是可滚动的成员工作区列表；点击工作区行会展开挂载在该工作区中的会话，每个会话点击即打开，因此不再有单独的行内「打开」按钮。与槽属主（ui-workspace、ui-layout）的 apply 顺序不受约束；每次注册都用 `slots.inject` 等待各自的声明。两个条目共享 `apply` 内创建的同一个 store 句柄，因此从区块行打开管理器、在面板里驱动它，读到的都是同一份状态。第三处贡献——「协作工作区」设置页——只在设置面存在（由 ui-settings-general 声明）时注册进 `settings.section`，暴露承载默认克隆目录的 `collab` 设置命名空间。

## 挂载了什么

- Node 半面（`src/index.ts`）：惰性——本包完全位于浏览器侧。
- 浏览器半面（`src/client/`）：一个 `apply`，创建工作区 store 和基于 collab RPC 通道的控制器，然后注册两个槽条目与可选的设置页。store hook 以 `useCollabWorkspaces` 注入 hook 的形式到达组件；动作（打开、关闭、打开管理器到某个工作区、在后台挂载每个工作区、打开会话、刷新、选择、创建、邀请、撤销、接受、改角色、移除、删除）经由 inject 面透传。所有产品文案——界面文案、错误横幅与校验提示——都位于标准 locale 座上的 `collab.ui` 词典，因此随 GUI 的「语言」设置切换。

## 仓库后端的工作区

创建入口（管理器的虚线按钮与区块头部的添加工作区按钮）会弹出一个承载协作工作区创建详情的模态对话框：一个工作区名称输入框和一个可选的「GitHub 仓库地址」输入框。填写地址会请求 collab API 把该仓库克隆到本地目录并把克隆结果作为工作区数据打开，而不是创建仅命名的（空）工作区。克隆目标在 `collab` 设置命名空间的 `cloneDir` 偏好被设置时取该值，否则取 collab 数据根下的 `workspaces` 目录；目标目录名为「仓库名-生成的工作区 id」，方便管理员一眼看出克隆源自哪个仓库。克隆在服务器端后台进行，因此创建请求立即应答、成功即关闭对话框；克隆尚未完成期间，工作区行显示「克隆中…」徽标，侧边栏条目同样显示该徽标并禁用「新建会话」，打开该工作区会被以「仍在克隆中」横幅拒绝。后台克隆失败会静默移除该工作区，因此失败的仓库初始化不会留下任何注册记录。仓库地址只是 UI 便利入口——强制的克隆契约与访问门禁在 collab API 中。

## collab 面契约

管理器只经由共享的 `/api` 连接 RPC 信封通信（`collab/workspace.*`、`collab/auth.status`），与 GUI 其余部分同一条通道，因此它使用会话 Cookie，且不需要 localStorage。可用性探测把每一种失败——未挂载 collab 面、没有会话 Cookie、传输错误——折叠为 `hidden`，此时两个条目都渲染为空：单用户 `web` 安装与未登录的浏览器看到的都是不变的应用。collab 来源的工作区与本地浏览区保持分离：默认的 Workspaces 浏览区会把它和它的会话从分组列表、平铺列表与搜索中过滤掉，因此 collab 会话只出现在 collab 区块。工作区角色来自线上数据（`workspace.role`）；管理动作的 UI 门禁只是呈现，collab API 网关的 `requireWorkspaceAndRole` 才是执行点。邀请接收面无需刷新页面也保持新鲜：打开管理器面板即刷新工作区列表与发给当前用户的待处理邀请，并且在 collab 面挂载期间，控制器以三十秒为间隔重新读取两者（在变更或可用性探测进行中时跳过）——页面加载之后发出的邀请会自动出现。

## Model Experience

None, as this is a presentation-only workspaces manager; the workspace scoping it reflects is enforced server-side by the collab API gateway, which owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **未授权时隐藏而非解释** —— 当浏览器没有 collab 会话（或未挂载 collab 面）时，区块与面板只是不渲染，没有说明原因的横幅。在 collab 实例上回答这个问题的是 ui-auth 门。
- **collab 工作区不会进入标准 Workspaces 列表** —— 本地浏览区会把 collab 来源的工作区及其会话从分组列表、平铺列表与搜索中过滤掉，因此它们只出现在 collab 区块（该区块没有重命名或删除入口，只有打开）。成员管理请在这块面板中进行。
- **会话只在挂载后才存在** —— 从未在 GUI 中打开过的 collab 工作区确实没有任何会话，因为挂载出的主机工作区才是它们的载体。区块渲染时自动挂载每个工作区即可覆盖那些已挂载的，其余情况由空态提示说明。
- **共享同一个实例平面** —— 工作区共享同一条浏览器会话 Cookie；工作区不带自己的登录，也没有自己的一组会话。挂在 collab 工作区内的会话仍然落在该工作区共享的数据目录中。
- **删除工作区只移除注册记录** —— 工作区创建时使用的克隆目录（或保留的数据目录）有意保留不动，与服务端删除语义一致；文件仍留在磁盘上。
