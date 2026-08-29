# Agent Note: Collab OAuth redirect origin derives from the request when unpinned

Status: implemented

[English](2026-08-29-collab-oauth-request-derived-redirect-origin.md) | 中文

## 问题

从远程主机提供的 collab 部署在 Google 登录时失败，redirect 被硬编码为 `http://localhost:3080`。Google 收到的 `redirect_uri` 由 `collabAuth.baseUrl` 推导而来，而该配置项的默认值正是那个回环来源；如果操作者在非回环主机上提供服务却没有固定 `baseUrl` 或 `redirectUri`，就会把这个默认值留在原处，于是提供方把访问者的浏览器重定向到访问者自己的 localhost，兑换在应用内没有任何信号的情况下静默失败——这恰恰是该仓库约定要最响亮地暴露的配置错误类型。

## 决策

当 `baseUrl` 与 `redirectUri` 都未固定时，每次登录都从该次登录的请求推导 redirect 的来源（`Host` authority 加上第一条 `x-forwarded-proto`，否则为 `http`）。推导出的 URI 不是计算两次，而是贯穿整个兑换过程：它保存在授权挑战上，作为 `redirect_uri` 传入提供方的授权 URL，并在回调校验时再次呈现，因此授权码落入的 URI 与登录开始时使用的 URI 一致。显式的 `redirectUri`（或据此推导的 `baseUrl`）始终优先且永不查询请求；`redirectUri` 固定完整的 URI，`baseUrl` 固定 `${baseUrl}/api/collab/auth/callback` 的来源。

设计之所以有界，是因为执行点是提供方而非应用。登录路由是 `/api` 下的精确路由，按设计在任何主机上均可到达（四个认证路由刻意绕开 RPC 信任围栏，记录在[多用户覆盖层说明](2026-08-27-collab-multi-user-overlay.zh.md)中）；浏览器信任的 Host 围栏并不对它设卡。取而代之的是：Google 只把授权码投递给 OAuth 客户端上已注册的 `redirect_uri`，因此伪造的 `Host` 无法把兑换指向操作者未注册的任何地方——最坏只会产生提供方侧的响亮 `redirect_uri_mismatch`，绝不至于泄露授权码——且防 CSRF 的 `state` 挑战无论如何都绑定该兑换。harness webserver 自身不终止 TLS，因此 `https` 只经代理的 `x-forwarded-proto` 进入，这也是该协议唯一识别的机制；socket 分支被否决，因为 harness 只绑定纯 HTTP，那将是死代码。

## 备选方案

### 除非固定了 `baseUrl`，否则响亮地拒绝远程来源登录

否决：它虽然符合「响亮报错」的约定，却迫使操作者为每一个非回环来源配置部署项，重新引入了这次改动要去掉的配置负担，并且破坏了直接提供某可达 IP 字面量或域名的常见场景。

### 从绑定的 webserver 地址推导来源

否决：绑定的 host 与端口是传输事实（回环绑定或操作系统分配的端口），并不等于公共来源，尤其在反向代理之后；请求的 `Host` 才是公共 authority 唯一可见之处。反向代理的 TLS 还需要代理可见的协议，这只有 `x-forwarded-proto` 能携带。

## 后果

无回环的远程部署现在无需任何来源配置即可登录，前提是公共来源的 `/api/collab/auth/callback` 已在 Google 控制台注册，并且当服务器按名称访问时，该来源已由 `/api` 围栏信任（`--trusted-host`；按 IP 字面量访问会自动推导）。回调路由的路径不变，因为路径段与来源无关。这是配置默认值的行为变更：`baseUrl` 现在默认为 `''`（由请求推导）而非回环来源，原先静默生成的 localhost redirect 被替换为正确的推导 URI，或者在公共来源从未注册时提供方侧响亮的 `redirect_uri_mismatch`。对于请求来源并非控制台允许 URI 的 TLS 终止或特殊拓扑，显式配置仍是权威。
