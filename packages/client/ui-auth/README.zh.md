# @deepseek-ai/dsh-client-ui-auth

[English](README.md) | 中文

Web GUI 的 collab 登录门。这个浏览器插件探测 collab 会话端点（`/api/collab/auth/session`），在浏览器尚未持有有效会话 Cookie 时，用全屏的「使用 Google 登录」页面覆盖整个应用。它只向 layout 的 `shell.overlay` 槽注册一个条目，因此可以干净地组合出去：没有 collab 覆盖层时它甚至不会被挂载；挂载在非 collab 实例上时渲染为空（探测会把任何「不存在」折叠为 no-op 判定）。服务器自身的 `/api` 门在任何情况下都仍是执行点——本 UI 只会 fail-open。

登录按钮把浏览器导航到 `/api/collab/auth/login`，门启动浏览器 OIDC 往返，网关带着 `dsh_collab_session` Cookie 跳转回来，之后门在刷新后消失。服务器端拒绝（网关跳转到 `/?collab=<reason>`）会显示在卡片上。

## 挂载了什么

- Node 半面（`src/index.ts`）：惰性——本包完全位于浏览器侧。
- 浏览器半面（`src/client/`）：一个 `shell.overlay` 条目，其 inject 面暴露 `collabGate` 存储 hook，外加一个导航到 OIDC 起始 URL 的 `signIn` 回调。探测在挂载时以及窗口重新获得焦点时运行（在另一个标签页登录会让这里的门消失）。

## 线上契约

会话/登录路径字面量位于 `src/client/contract.ts`，并由线路两侧的测试固定：

| 字面量 | 值 |
| --- | --- |
| `COLLAB_SESSION_PATH` | `/api/collab/auth/session` |
| `COLLAB_SIGN_IN_PATH` | `/api/collab/auth/login` |

探测把所有失败模式（网络错误、非 OK 状态、非 JSON 主体、缺少 `authenticated` 字段）折叠为 `absent`，它渲染为空——为拒绝围栏的非回环主机配置的 collab 绝不会把应用卡在虚构的门后面。

## Model Experience

None, as this is a pure presentation gate; the auth fence it reflects is enforced server-side by the collab API gateway, which owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **登录后不做连接级恢复** —— OIDC 往返是一次整页导航，因此门后的应用带着新 Cookie 重新加载，而非热重连 `/api` 传输。对已 401 连接的实时恢复留待后续。
- **UI 只 fail-open，不做强制** —— 本插件只呈现会话判定；它绝不宣称授权或拒绝请求。collab 实例必须保持 collab API 网关（它自己的 401 围栏）挂载。
- **文案跟随当前应用语言** —— 门将其 `collab.auth` 词典（中文 + 英文）注册到标准 locale seat 上，卡片语言跟随 GUI 的语言设置，而非写死的字符串。
