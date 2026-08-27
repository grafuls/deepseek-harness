# @deepseek-ai/dsh-collab-auth

[English](README.md) | 中文

面向 collab 部署的 Google OpenID Connect 登录（`ctx.collabAuth`）：一个无状态的签名会话 Cookie，让共享 harness 进程能够认证每一个多用户请求，把授权挑战兑换为经 HMAC 校验的主体。Google 策略是一个接缝；Google 之外的提供方可以实现同样的 `OidcGateway` 表面。

## 会话

登录是一次单一的兑换。`loginUrl()` 签发一个防 CSRF 的 `state` 挑战并返回提供方的授权 URL；浏览器完成流程；`completeLogin()` 校验回调（挑战一次性使用、由 `stateTtlMs` 限时），在 `ctx.collabUsers` 中更新写入 Google 身份，并返回一个会话令牌。令牌是无状态载荷 `base64url(JSON{userId,iat,exp}).base64url(hmac-sha256(secret, payload))`；`resolve()` 以常数时间校验签名、检查过期，并通过用户注册表再次核对账号。唯一的服务端状态是挑战表，且通过剪枝保持极小。

```ts
import type { LoginOutcome, CollabPrincipal } from '@deepseek-ai/dsh-collab-auth'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
declare const params: Record<string, string>
declare const sessionToken: string

await ctx.collabAuth.loginUrl('/workspaces')            // provider authorization URL
const outcome: LoginOutcome = await ctx.collabAuth.completeLogin(params) // { location, sessionToken, principal }
ctx.collabAuth.resolve(sessionToken)                    // CollabPrincipal | undefined (needs cookie)
ctx.collabAuth.cookieValue(sessionToken)                // the Set-Cookie value to emit
ctx.collabAuth.clearCookieValue()                       // the Set-Cookie value that logs out
```


## 配置

| Key | Default | Meaning |
| --- | --- | --- |
| `clientId` | `''` | Google OAuth 2.0 client id (required for sign-in) |
| `clientSecret` | `''` | Google OAuth 2.0 client secret (required for sign-in) |
| `redirectUri` | `<baseUrl>/api/collab/auth/callback` | registered redirect URI, must match the Google console |
| `baseUrl` | `http://localhost:3080` | public base URL used to derive the redirect URI |
| `secret` | dev-only derivation from `dshHome` | HMAC key signing session cookies; set explicitly in production |
| `sessionTtlSeconds` | `2592000` (30 days) | session cookie lifetime |
| `secureCookies` | `false` | mark cookies `Secure` (set behind TLS termination) |
| `scopes` | `['openid', 'profile', 'email']` | granted Google scopes |
| `stateTtlMs` | `600000` (10 minutes) | authorization challenge lifetime |

`secret` 默认值是从 harness 主目录派生的仅限开发的确定性值，使本地 checkout 无需任何配置即可运行。它相当于口令；真实 IdP 之后的部署必须显式设置 `secret`（以及 `secureCookies`）。

## 组合

服务要求 collab 用户注册表：在缺少 `ctx.collabUsers` 时挂载它会在启动时立即失败。

```yaml
- id: collab-auth
  name: '@deepseek-ai/dsh-collab-auth'
  config:
    dshHome: !!js dshHome
    clientId: <google-client-id>
    clientSecret: <google-client-secret>
    secret: <strong-random-value>
    secureCookies: true
```

## 模型体验

无，因为服务只认证请求、不产生任何模型面对面的内容；collab bundle 与 collab API 网关拥有任何模型可见效果。

#### KV Cache 影响

本包对模型请求无任何贡献，因此不会使缓存复用失效。

## 已知局限与延后工作

- **内存挑战在重启后重置**——待处理 `state` 表不持久，因此被进程重启打断的回调需要重新登录；攻击者重放已劫持的 state 无法得逞，因为在重启前任何已签发的 `state` 都是一次性使用的。
- **Google 是随附的适配器**——其他 OpenID 提供方只能通过自定义 `OidcGateway` 实现来工作；不随附通用的动态客户端注册。
- **轮换密钥会使现有会话失效**——Cookie 使用配置的 `secret` 签名；轮换它会让所有活跃用户同时登出。
