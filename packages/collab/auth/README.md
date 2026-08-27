# @deepseek-ai/dsh-collab-auth

English | [中文](README.zh.md)

Google OpenID Connect sign-in for collab deployments (`ctx.collabAuth`): a stateless signed session cookie so the shared harness process can authenticate every multi-user request, trading an authorization challenge for a HMAC-verified principal. The Google strategy is a seam; providers other than Google can implement the same `OidcGateway` surface.

## Sessions

A sign-in is a single exchange. `loginUrl()` issues an anti-CSRF `state` challenge and returns the provider's authorization URL; the browser completes the flow; `completeLogin()` validates the callback (challenge single-use, time-boxed by `stateTtlMs`), upserts the Google identity in `ctx.collabUsers`, and returns a session token. The token is a stateless payload `base64url(JSON{userId,iat,exp}).base64url(hmac-sha256(secret, payload))`; `resolve()` verifies the signature in constant time, checks expiry, and re-checks the account through the user registry. The challenge map is the only server-side state and stays tiny by pruning.

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


## Configuration

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

The `secret` default is a deterministic dev-only derivation from the harness home so a localhost checkout works with no configuration. It is a password; deployments behind a real IdP must set `secret` (and `secureCookies`) explicitly.

## Composition

The service requires the collab user registry: mounting it without `ctx.collabUsers` fails loud at startup.

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

## Model Experience

None, as the service authenticates requests and produces no model-facing content; the collab bundle and collab API gateway own any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **In-memory challenges reset on restart** — the pending `state` map is not durable, so a callback interrupted by a process restart needs a fresh sign-in; an attacker replaying a harvested state cannot, because any issued `state` is single-use before restart.
- **Google is the shipped adapter** — other OpenID providers work only through a custom `OidcGateway` implementation; no generic dynamic-client registration ships.
- **Secret rotation invalidates live sessions** — cookies are signed with the configured `secret`; rotating it signs out every active user at once.
