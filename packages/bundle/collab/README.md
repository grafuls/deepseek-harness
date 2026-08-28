# @deepseek-ai/dsh-collab-bundle

English | [中文](README.zh.md)

The multi-user collab overlay as a profile bundle: a third patch layer over [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md) that mounts the Google OAuth + RBAC workspace surface on the shared web process. Boot it with `dsh --profile web-collab`. The default single-user `web` profile is unchanged unless this layer is added.

## What the layer mounts

The patch inserts four rows: `@deepseek-ai/dsh-collab-users`, `@deepseek-ai/dsh-collab-workspaces`, `@deepseek-ai/dsh-collab-auth`, and `@deepseek-ai/dsh-collab-api`. Mounted together they turn the `/api` channel into an authenticated multi-user surface:

- every `/api` request requires a signed `dsh_collab_session` cookie (the collab API gateway registers the connection authenticator);
- the browser OIDC flow runs over `/api/collab/auth/*` (`login`, `callback`, `session`, `logout`);
- `collab/*` RPC endpoints expose invite-only workspaces with `admin`/`developer` roles, plus instance-admin account management;
- durable state lives under `$DSH_HOME/collab`: `users.json`, `workspaces.json`, and the per-workspace data directories `workspaces/<wsId>`;
- on the Host plane, a mounted collab workspace and the sessions bound inside it are served only to its members (the membership gate is read with the live connection principal on every request and at stream open), while plain Host workspaces stay visible to every authenticated caller.

## Operator setup

The auth row ships with **no OAuth credentials** on purpose. Before users can sign in, set them in the profile's `cordis.patch.yml` by row id (the patch replaces the whole auth-row config):

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

The Google console must register the redirect URI `http://localhost:3080/api/collab/auth/callback` (or the equivalent on your public host; behind TLS set `secureCookies: true`). The first account to sign in becomes the instance admin (`bootstrapFirstAdmin` defaults to true) and can admin the rest.

## Model Experience

None, as the collab bundle is a static patch-list carrier; each inserted row's own package owns any model-facing behavior, and the collab API gateway it mounts owns the auth-gated `/api` surface.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — profile overrides of the collab rows must restate every field a row keeps.
- **Credential-less boot defers sign-in failure** — with empty `clientId`/`clientSecret` the process boots and the first sign-in fails (redirect to `/?collab=signin-failed`); configure the auth row before announcing the instance.
- **Localhost-first auth routes** — the collab auth routes bypass the `/api` trust fence on a loopback bind; a non-loopback deployment must front the process with TLS (see the collab API gateway's Known Limitations).
- **One process session plane, per-workspace session binding** — the browser keeps one session cookie and the process hosts one global session plane, so a collab workspace hosts no login or session list of its own; opening a workspace mounts it as a real Host workspace, and the sessions a member starts inside it are bound to that workspace's shared `$DSH_HOME/collab/workspaces/<wsId>` data directory. Member-only serving is enforced on the Host plane itself, so a non-member sees no collab workspace in the standard Workspaces/Sessions listings and a Host call into a hidden collab directory is refused.
- **Two live echoes carry hidden session ids without conversation** — the `host()` archived-sessions echo and the `mux()` task/queue/question baselines still carry session ids or task state for collab sessions a caller cannot see (no conversation content; the enumerated surfaces are fully scoped).
