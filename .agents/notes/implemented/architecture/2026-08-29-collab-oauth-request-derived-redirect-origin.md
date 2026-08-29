# Agent Note: Collab OAuth redirect origin derives from the request when unpinned

Status: implemented

English | [中文](2026-08-29-collab-oauth-request-derived-redirect-origin.zh.md)

## Problem

A collab deployment served from a remote host failed Google sign-in with a redirect hardcoded to `http://localhost:3080`. The `redirect_uri` Google received is derived from `collabAuth.baseUrl`, whose config default was that loopback origin; an operator who served from a non-loopback host without pinning `baseUrl` or `redirectUri` left the default in place, so the provider redirected the visitor's browser to the visitor's own localhost and the exchange died with no signal in the app that a deployment knob was wrong. The failure was silent exactly where the repo convention demands the loudest misconfiguration error.

## Decision

When neither `baseUrl` nor `redirectUri` is pinned, each sign-in derives its redirect origin from the sign-in request (`Host` authority plus the first `x-forwarded-proto` entry, else `http`). The derived URI is threaded through the whole exchange rather than computed twice: it is stored on the authorization challenge, passed into the provider's authorization URL as `redirect_uri`, and presented again when the exchange validates at the callback, so the URI the authorization code lands on matches the URI the login started with. An explicit `redirectUri` (or a `baseUrl` from which it derives) always wins and never consults the request; `redirectUri` pins the URI, and `baseUrl` pins the origin for `${baseUrl}/api/collab/auth/callback`.

The design stays bounded because the provider is the enforcement point, not the app. The login route is an exact `/api` route and is reachable on any host by design (the four auth routes deliberately bypass the RPC trust fence, recorded in the [multi-user overlay note](2026-08-27-collab-multi-user-overlay.md)); the browser-trust Host fence does not gate it. Instead, Google delivers the authorization code only to `redirect_uri` values registered on the OAuth client, so a forged `Host` cannot point the exchange anywhere the operator did not register — the worst it produces is a loud provider-side `redirect_uri_mismatch`, never a code leak — and the anti-CSRF `state` challenge binds the exchange regardless. The harness webserver does not terminate TLS, so `https` enters only through a proxy's `x-forwarded-proto`, which is the sole mechanism the scheme honors; the socket branch was rejected because the harness binds plain HTTP only and would have been dead.

## Alternatives considered

### Reject remote-origin sign-ins unless `baseUrl` is pinned, loudly

Rejected: it met the fail-loud convention but forced an operator to set a deployment knob for every non-loopback origin, reintroducing the configuration burden the change removes and breaking the common case of serving a reachable IP literal or a name directly.

### Derive the origin from the bound webserver address

Rejected: the bind host and port are transport facts (a loopback bind or an OS-assigned port) that do not equal the public origin, especially behind a reverse proxy; the request `Host` is the only place the public authority is visible. A reverse proxy's TLS also requires the proxy-seen scheme, which only `x-forwarded-proto` carries.

## Consequences

A loopback-free remote deployment now signs in with no origin configuration, provided the public `/api/collab/auth/callback` is registered in the Google console and — when the server is reached by name — the origin is trusted by the `/api` fence (`--trusted-host`; an IP-literal reach derives automatically). The callback route path is unchanged because the path segment is stable regardless of origin. This is a config-default behavior change: `baseUrl` now defaults to `''` (request-derived) instead of the loopback origin, and the earlier silent generation of a localhost redirect is replaced by either a correct derived URI or a loud provider-side `redirect_uri_mismatch` when the public origin was never registered. Explicit config remains authoritative for TLS-terminated or exotic topologies where the request origin is not the URI the console allows.
