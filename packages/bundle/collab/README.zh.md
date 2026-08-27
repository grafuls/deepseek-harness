# @deepseek-ai/dsh-collab-bundle

[English](README.md) | 中文

多用户 collab 覆盖层，作为一个 profile bundle：在 [`dsh-base`](../base/README.zh.md) 与 [`dsh-web-app`](../web-app/README.zh.md) 之上的第三层补丁，把 Google OAuth + RBAC 的 workspace 表面挂载到共享的 web 进程。用 `dsh --profile web-collab` 启动。除非加入本层，否则默认的单用户 `web` 配置保持不变。

## 本层挂载了什么

补丁插入四行：`@deepseek-ai/dsh-collab-users`、`@deepseek-ai/dsh-collab-workspaces`、`@deepseek-ai/dsh-collab-auth`、`@deepseek-ai/dsh-collab-api`。它们一起挂载后，`/api` 通道就变为经过认证的多用户表面：

- 每个 `/api` 请求都必须携带签名的 `dsh_collab_session` Cookie（collab API 网关负责注册连接认证器）；
- 浏览器 OIDC 流程走 `/api/collab/auth/*`（`login`、`callback`、`session`、`logout`）；
- `collab/*` RPC 端点暴露仅限邀请的 workspace，带 `admin`/`developer` 角色，外加实例管理员的账号管理；
- 持久化状态位于 `$DSH_HOME/collab`：`users.json`、`workspaces.json`，以及按 workspace 隔离的数据目录 `workspaces/<wsId>`。

## 运维配置

认证行**刻意不携带**任何 OAuth 凭据。在用户登录之前，请在 profile 的 `cordis.patch.yml` 中按行 id 设置它们（补丁会替换整个 auth 行配置）：

```yaml
- id: collab-users
  config:
    root: !!js dshHomePath('collab/users')
- id: collab-workspaces
  config:
    root: !!js dshHomePath('collab/workspaces')
- id: collab-auth
  config:
    clientId: <google-client-id>
    clientSecret: <google-client-secret>
    secret: <strong-random-value>
    baseUrl: http://localhost:3080
```

Google 控制台必须登记重定向 URI `http://localhost:3080/api/collab/auth/callback`（或公网主机上的等价地址；走 TLS 时设置 `secureCookies: true`）。第一个登录的账号将成为实例管理员（`bootstrapFirstAdmin` 默认为 true），并管理其余账号。

## Model Experience

None, as the collab bundle is a static patch-list carrier; each inserted row's own package owns any model-facing behavior, and the collab API gateway it mounts owns the auth-gated `/api` surface.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **补丁会替换整行配置** —— 对 collab 行的 profile 覆盖必须完整重申该行保留的每个字段。
- **无凭据启动会把登录失败推迟到请求时** —— `clientId`/`clientSecret` 为空时进程照常启动，第一次登录才会失败（重定向到 `/?collab=signin-failed`）；请在向用户公布实例之前配置好 auth 行。
- **认证路由优先 localhost** —— 在回环绑定上，collab 认证路由绕过 `/api` 信任围栏；非回环部署必须在前端架设 TLS（见 collab API 网关的 Known Limitations）。
- **在线会话平面是共享的，而非按 workspace 隔离** —— 进程的会话平面保持全局；按 workspace 的隔离边界是持久化的 `$DSH_HOME/collab/workspaces/<wsId>` 数据目录。
