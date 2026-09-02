# @deepseek-ai/dsh-client-ui-workspace

[English](README.md) | 中文

Workspace 选择器插件。`WorkspacePicker` 填充对话空态主视觉区的 `conversation.hero.workspace` slot。侧边栏的 `sidebar.workspaces` Workspaces 席位由 collab 工作区区块（ui-collab）占据——本地浏览区已从侧边栏移除，因此本包只注册选择器；本地工作区仍可通过它与「新会话」流程触达。

该选择器通过全局 `useWorkspaces` hook 列出真实的 Host Workspace 实体。选择 Workspace 会调用 slot owner 的 `onPick` 回调，重新定位前端 Session 对象。不同的规范化路径即使 basename 和显示标题相同，仍会作为由 id 区分的独立 Workspace。菜单只在确有多个目标可选时出现——没有 Workspace 可列时，锚点手势直接拉起添加流程，而不是弹出只有一行的浮层；在列表基线落地前，空列表不算最终结果。

该注册声明一个**目录流子 slot**（`single` kind：`conversation.hero.workspace.directoryFlow`），由组合的选择器包 client half 填入其选取交互——今天是 [`-native`](../../host/directory-picker-native/README.zh.md) 后端的无渲染 OS 选择器驱动，`-browse` 组合下则是应用内浏览对话框。`sidebar.workspaces.directoryFlow` 孔洞是被移除浏览区的纯类型残留：它保留在共享契约中让 picker 包的类型链继续编译，但运行时没有任何东西挂载它。平铺显示的 **添加工作区…** 操作仅在 hero 的孔洞被占用时渲染（每次菜单渲染读取占用状态；孔洞为空意味着该组合没有目录选择能力——seam 文档化的无流程默认行为，此时选择器直接不渲染添加按钮，而非留下一个点了没反应的按钮）。本包持有触发与接纳：占用方通过孔洞的属主交互约定（`open`/`busy`/`onPicked`/`onCancel`/`onError`）每次打开上报一个所选路径，owner 通过对象层接纳它，并等待 Workspace 列表投影刷新后才选中已提交的 Workspace；取消操作不会显示提示，错误落入可重试的文件夹对话框，其 **重新选择** 会重新打开流程（孔洞在对话中途变空后，重试会被禁用，以免打开一个无人应答的流程）。添加只有一条路径：占用者自带的新建文件夹能力已经覆盖了全新目录，因此不再单设按名称创建的对话框。运行时 Session 与 Workspace 服务负责物化。

目标 slot 由其他插件声明，因此 `apply` 使用 `slots.inject()` 在各自的声明生命周期内完成注册，并在目标 slot 的声明恢复后重新注册；其 inject 只声明它所读取的 `slots`、`workspaces` 与 `locale` 服务。

## 模型体验

无。选择器属于浏览器界面；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **本地工作区没有侧边栏导航**——侧边栏浏览区已被移除；其 Workspaces 席位在 collab 面就绪时显示「工作区」区块，否则为空，本地工作区通过本选择器与「新会话」流程触达。
- **没有会话管理界面**——选择器只列出并添加工作区，从不列出会话行，因此此处没有重命名、fork、归档与排序会话的 UI（它们属于 collab 区块或宿主）。
- **原生文件夹选择依赖本地 Host 载体**：在 `-native` 组合下，进程内部署或远程浏览器部署无法打开本地操作系统对话框；模态框会显示平台故障，并允许重试。可远程的选取是 `-browse` 组合的应用内流程。
