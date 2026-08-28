# @deepseek-ai/dsh-collab-api

English | [中文](README.zh.md)

The collab API gateway: one function plugin that turns a shared harness process into a multi-user instance behind Google OAuth. It mounts the collab services (`collabAuth`, `collabUsers`, `collabWorkspaces`) over the existing `/api` channel and adds the five browser-facing auth routes. The plugin is opt-in — a default single-user `dsh web` profile is unchanged until this row is mounted, at which point every `/api` request requires a signed session cookie and `collab/*` becomes the multi-user workspace surface.

## Auth surface

Five exact routes complete the browser OIDC flow without touching the JSON-RPC fence. On a loopback-bound localhost deployment these routes bypass the `/api` trust fence and envelope by design (see Known Limitations).

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/collab/auth/login` | GET | 302 to the OIDC provider with a single-use `state` challenge; `?redirectTo=` resumes the browser afterward |
| `/api/collab/auth/callback` | GET / POST | completes the exchange, sets the `dsh_collab_session` cookie, 302 to the outcome location |
| `/api/collab/auth/session` | GET | JSON `{ "authenticated": false }` or `{ "authenticated": true, "principal": ... }` |
| `/api/collab/auth/logout` | POST | 204 and clears the session cookie |

All three path constants are exported (`COLLAB_AUTH_LOGIN_PATH`, `COLLAB_AUTH_SESSION_PATH`, `COLLAB_AUTH_LOGOUT_PATH`). The callback path is derived from `collabAuth.redirectUri`, so a deployment that overrides `redirectUri` gets a matching route automatically.

## Collab RPC

The `collab/*` endpoints ride the shared `/api` channel with the standard JSON-RPC envelope. The auth fence runs first: a request without a valid session cookie answers `401 unauthorized` before any endpoint logic. A valid session whose resolved principal does not exist or is disabled is refused with `collab-forbidden`.

| Endpoint | Purpose |
| --- | --- |
| `collab/auth.status` | current principal (`CollabPrincipalView`) |
| `collab/workspace.list` | workspaces the caller belongs to |
| `collab/workspace.create` | create a workspace (owner becomes workspace admin) |
| `collab/workspace.get` | one workspace the caller belongs to |
| `collab/workspace.members` | member roster of a workspace the caller belongs to |
| `collab/workspace.dir` | the per-workspace data directory under the collab root, materialized on demand |
| `collab/workspace.invite` | invite by email to a role (`admin`/`developer`); workspace-admin only |
| `collab/workspace.invitations` | outstanding invitations; workspace-admin only |
| `collab/workspace.myInvitations` | pending invitations addressed to the caller's email, with the target workspace names |
| `collab/workspace.revokeInvitation` | revoke an invitation; workspace-admin only |
| `collab/workspace.join` | accept an invitation addressed to the caller |
| `collab/workspace.leave` | leave a workspace (the owner must delete instead) |
| `collab/workspace.delete` | delete a workspace; workspace-owner only |
| `collab/workspace.setMemberRole` | change a member's role; workspace-admin only |
| `collab/workspace.removeMember` | remove a member; workspace-admin only |
| `collab/workspace.open` | mount a collab workspace as a real Host workspace over its reserved data directory (a member may open it); the Host registry resolves the same workspace for every member, and the Host plane serves it and its sessions only to members |
| `collab/users.list` | account roster; instance-admin only |
| `collab/users.setGlobalRole` | promote/demote an account (`admin`/`member`); instance-admin only |
| `collab/users.setDisabled` | disable/enable an account; instance-admin only |

Errors fold to a closed `RpcError` code set: `collab-forbidden` for authorization denials (service RBAC), `collab-not-found` for unknown workspaces, `collab-bad-request` for malformed wire fields or other service failures, `collab-internal` for a missing host service (the workspace registry is absent from the composition), and `collab-name-conflict` when re-asserting a collab name that collides with another Host workspace title. Every endpoint is validated at the wire boundary, then delegated to the owning service, which owns persistence and RBAC.

## Host plane membership scoping

The collab assembly also stages the membership decision for the Host workspace plane. On every request and at the open of a `host()`/`mux()` stream, the Host proxy resolves the connection principal and consults the collab membership gate: a collab-rooted Host workspace (and the sessions bound inside it) is listed, streamed, and reachable only to that workspace's members, and a non-member's Host call that targets a hidden collab directory is refused with the host-owned `workspace-forbidden` error carrying the workspace id. Plain Host workspaces stay visible to every authenticated caller. The gate is read live from the service store, so a single-user composition that omits this overlay keeps the Host plane byte-identical, and a membership change takes effect from the next request or new stream.

## Configuration

The plugin takes no configuration; every tuning lives in the collab services it mounts (`dsh-collab-*` roots, OAuth client, cookie policy).

```yaml
- id: collab-users
  name: '@deepseek-ai/dsh-collab-users'
  config:
    root: !!js dshHomePath('collab/users')
- id: collab-workspaces
  name: '@deepseek-ai/dsh-collab-workspaces'
  config:
    root: !!js dshHomePath('collab/workspaces')
- id: collab-auth
  name: '@deepseek-ai/dsh-collab-auth'
  config:
    clientId: <google-client-id>
    clientSecret: <google-client-secret>
    secret: <strong-random-value>
    baseUrl: http://localhost:3080
- id: collab-api
  name: '@deepseek-ai/dsh-collab-api'
```

## Model Experience

None, as the gateway authenticates requests and forwards collab service responses over RPC, registering nothing model-facing; the harness session surface it authorizes owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **Auth routes bypass the JSON-RPC fence on localhost** — the login, callback, session, and logout exact routes answer before the `/api` prefix route, so they do not carry the trust-fence or envelope checks. This is acceptable for an OIDC flow over a loopback development bind; a non-loopback deployment must front the process with TLS and keep `baseUrl`/`redirectUri` on the public host the IdP redirects to.
- **Callback path must match `collabAuth.redirectUri`** — the callback route is derived from the redirect URI's pathname, so an inconsistent `redirectUri` breaks sign-in rather than silently mis-directing it.
- **One process session plane, per-workspace session binding** — authentication and active sessions live in the process plane (the browser holds one session cookie), so a collab workspace hosts no login of its own; opening a workspace mounts it as a real Host workspace, and the sessions a member starts inside it are bound to the shared `$DSH_HOME/.../collab/workspaces/<wsId>` data directory.
- **Two live echoes carry hidden session ids without conversation** — the `host()` archived-sessions echo and the `mux()` task/queue/question baselines are process-global, so they still carry workspace ids, session ids, or task state for collab sessions a caller cannot see; they carry no conversation content, and the enumerated surfaces (`workspace.list`, `sessions.list`/`search`, `history`, `fork`) are fully scoped.
- **Membership is sampled at request time and at stream open** — the principal a `host()`/`mux()` stream captured when it opened stays fixed for that stream's life, so a membership grant or revocation applies to new requests and new streams, not to frames already in flight.
- **`loader.await()` does not imply the collab surface is ready** — dependent activation settles a tick after the tree reports loaded, so a readiness consumer should probe `/api/collab/auth/session` before issuing requests (the real-composition test does exactly this).
