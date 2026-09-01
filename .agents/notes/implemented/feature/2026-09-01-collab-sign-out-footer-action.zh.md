# Agent Note: collab sign-in gate gains a sign-out footer action

Status: implemented

[English](2026-09-01-collab-sign-out-footer-action.md) | 中文

## Problem

collab 实例通过 Google OAuth 为浏览器授权，但 GUI 中无法主动退出登录：`dsh_collab_session` Cookie 会一直有效到过期，因此在共享机器上结束已认证的浏览器会话只能离开实例或等 Cookie 过期。即使 collab API 网关已经提供了用于清除 Cookie 的 `POST /api/collab/auth/logout` 路由，此前也没有任何退出入口。

## Decision

ui-auth 浏览器插件现在在全屏登录门之外新增第二个表面：侧边栏 `sidebar.footer.action` seat（Settings 旁的附加操作列表）中的一个退出登录页脚操作，仅在 collab 会话探测报告已认证时渲染。展开的侧栏显示带图标的标签行（图标 + 退出登录 / Sign out）；折叠轨道栏显示为带提示的纯图标圆圈。点击后向 `/api/collab/auth/logout` 发起 POST，并且只在网关接受（2xx）后把共享的 collab 门存储翻转为 `unauthenticated`——此时应用会被登录门覆盖层重新盖住。被拒绝的退出保持已认证的门不变。

退出路径与既有会话/登录字面量并列，作为 `src/client/contract.ts` 中的 `COLLAB_LOGOUT_PATH`，由网关的路由测试和浏览器契约测试共同固定。覆盖层与页脚操作通过同一个注入 hook 共享同一个 `collabGate` 存储，两个表面永远一致；挂载时的初始探测与重新聚焦时的再探测继续服务两者。

## Alternatives considered

- **把退出入口放进设置面板。** 否决：设置属于偏好；身份操作应放在侧边栏底部 Settings 旁,那里正是 shell 声明的 `sidebar.footer.action` seat，并且无需打开面板即可始终可见。
- **整页跳转到退出页。** 否决：网关注销路由以 204 返回，而门判定归客户端所有，因此翻转共享存储即可在原处重新盖上登录门，无需导航或刷新。
- **新建包（例如 `ui-sign-out`）。** 否决：退出逻辑归属于登录门自己的存储与探测；它是既有 ui-auth 插件的另一个表面，而非新领域，新建包会重复门的管道与模块表行。

## Consequences

- 已认证用户可以在共享机器上从侧边栏底部主动结束浏览器会话；服务器确认退出后应用立即回到登录门。
- 页脚操作只会在 collab 表面已挂载且已认证时存在，因此单用户安装（以及未登录的浏览器）在视觉上保持不变。
- 退出只会在服务器接受后提交，因此 UI 永远不会宣称一个围栏仍持有的会话——登录门的 fail-open 姿态得以保留。
- 网关的退出路由此前没有 GUI 消费者；页脚操作现在是它唯一的消费者。

## Testing

浏览器契约测试固定 `signOut()`（接受 204、非 OK 状态、网络失败）；插件接线测试在退出被接受时把共享门存储从 `authenticated` 走到 `unauthenticated`，在退出被拒绝时保持原状；组件规格固定了页脚操作的可见性契约及其宽行/轨道两种形态。`pnpm run test:gui` 对涉及的包通过。

## Related

- [Multi-user collab overlay](2026-08-27-collab-multi-user-overlay.md) — 本功能所扩展的 Google-OAuth 门与 RBAC 决策，其浏览器半面由此获得退出登录入口。
