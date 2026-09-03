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
| `collab/workspace.rename` | rename a workspace (the shared name change applies for every member, and a live mount's Host title is re-asserted); workspace-admin only |
| `collab/workspace.setMemberRole` | change a member's role; workspace-admin only |
| `collab/workspace.removeMember` | remove a member; workspace-admin only |
| `collab/workspace.open` | mount a collab workspace as a real Host workspace over its reserved data directory (a member may open it); the Host registry resolves the same workspace for every member, and the Host plane serves it and its sessions only to members |
| `collab/users.list` | account roster; instance-admin only |
| `collab/users.setGlobalRole` | promote/demote an account (`admin`/`member`); instance-admin only |
| `collab/users.setDisabled` | disable/enable an account; instance-admin only |

Errors fold to a closed `RpcError` code set: `collab-forbidden` for authorization denials (service RBAC), `collab-not-found` for unknown workspaces, `collab-bad-request` for malformed wire fields or other service failures, `collab-internal` for a missing host service (the workspace registry is absent from the composition), `collab-name-conflict` when re-asserting a collab name that collides with another Host workspace title, and `collab-clone-pending` when opening or resolving a repository-backed workspace whose clone has not finished. Every endpoint is validated at the wire boundary, then delegated to the owning service, which owns persistence and RBAC.

## Repository-backed workspaces

`collab/workspace.create` accepts a `repoUrl` this is omitted or an empty string for a name-only workspace. A non-empty repository URL registers a provisioning workspace whose clone runs in the background, so the create answers immediately and a slow transfer never holds a browser request open across a proxy idle timeout. The clone target is `<cloneRoot>/<repoName>-<workspaceId>`, where `<workspaceId>` is the generated workspace id, `<repoName>` is the repository name sanitized to a filesystem-safe component (so an administrator can recognize which repository a clone roots at), and `<cloneRoot>` is the `cloneDir` setting of the `collab` settings namespace when set, otherwise the collab data root's `workspaces` directory. The clone root is created recursively at create time and must be writable by the server user; a configured directory that cannot be created or written answers `collab-bad-request` immediately, so a bad clone directory never silently removes a workspace after a doomed background clone. While the clone runs the listed row carries `cloneState: cloning`; `collab/workspace.open` and `collab/workspace.dir` refuse the provisioning record with `collab-clone-pending` and resolve the clone path for settled records (`cloneState: ready`), so members share the cloned working tree as the mounted workspace's data. A settled clone also fills `gitState` on the view — current branch, abbreviated HEAD, and whether uncommitted changes exist — read at view-build time from three short `git` invocations over the clone with a five-second bound; a clone whose directory is missing, is not a git checkout, or is stuck reports no `gitState` instead of failing the list. A session created inside a settled clone is switched onto its own work branch named `<workspace>-<session>` — created from the current HEAD when absent, plain-switched when it already exists, so a re-created or re-attached session rejoins its own line and each session's commits and pushes stay on their own branch while the workspace's mainline branch stays untouched; the fork is fire-and-forget with a warn log on failure and never blocks session creation. `collab/workspace.push` moves a branch to the clone's origin: it fails closed (`collab-approval-required`) without the member's explicit `confirm`, defaults to the checkout's current branch (or pushes an explicit `branch`), refuses a non-fast-forward update (`collab-push-rejected`) once the live remote tip is fetched, supports `dryRun` to preview what would go up without touching the remote (a dry run fetches and reports but cannot move a branch, so it skips the confirmation gate), and answers the new remote SHA plus compare and open-a-pull-request links for an HTTPS origin. A divergence on the remote between the read and the push is also rejected by git itself because the push never carries a force flag. The push rewrites the clone's local `user.name`/`user.email` to the pushing member's identity (when the member has one), so commits born in the shared tree from there carry that member's attribution, and it sends the server credential only when it is pinned to the origin's host — an HTTPS origin with no matching credential answers `collab-credential-unavailable`, and any other git failure answers `collab-push-failed` with the git diagnostic (the token travels as an authorization header, never in a URL, so diagnostics stay credential-free). The clone runs through the collab-local no-shell `git clone` (spawned with no stdin and `GIT_TERMINAL_PROMPT=0`, so a repository the user cannot access fails fast with git's stderr instead of hanging on a credential prompt) with a ten-minute timeout, and is cancelled when the collab gateway tears down so a running clone never blocks shutdown. A failed clone removes the partial target and auto-removes the provisioning record, so a failed repository bootstrap leaves nothing behind; a provisioning record left by a gateway restart mid-clone can be deleted by the creating user. The access gate applies to the clone directory through the collab `workspaceHolding` relationship exactly as it does for the data root, so a non-member's request for a path under a hidden clone is refused. A private repository clones only when the operator configures a server git credential (`gitToken` plus `gitHost`); the credential is a per-instance secret sent only to that host through a host-scoped git config that exists for the clone and is removed right after, so it never reaches the browser, the workspace record, or the clone's own config.

## Repository push, sync, and audit

`collab/workspace.push` moves one branch to the clone's origin; the repository row of the Collaborative Workspaces panel offers it (preview via a server dry run, then the member's own confirmation) as described above. `collab/workspace.fetch` syncs a settled clone with the origin without touching the checkout: it fetches remote-tracking refs and prunes stale ones, never the working tree or the session's current branch, so a member pulls the latest upstream into the shared clone without disturbing any session's line. It refuses a name-only or still-cloning record (`collab-not-a-repository`) and folds git failures back as `collab-bad-request`. Pushing and fetching share the pinned server credential through a temporary `GIT_CONFIG_GLOBAL` whose authorization header carries the token only to the matching origin host; the token never reaches the browser, a wire URL, or the repository's own config.

Every push — dry run or real — appends one line to `<collabWorkspacesRoot>/audit/push.jsonl`: workspace and actor ids, the actor display name, the branch, whether it was a dry run, whether it pushed or was already up to date, and, for a successful push, the new remote SHA and the compare link. The audit write is best-effort (a failure only warns, never fails the push), and the trail outlives a workspace deletion, so an administrator can see who pushed what and when even after the record and its clone are gone.

`collab/workspace.delete` now also removes the clone directory backing a repository-backed workspace (recursive and forced), so deleting a workspace closes its working tree instead of leaving roots behind; a clone that resists removal still completes the record deletion and only warns.

## Host plane membership scoping

The collab assembly also stages the membership decision for the Host workspace plane. On every request and at the open of a `host()`/`mux()` stream, the Host proxy resolves the connection principal and consults the collab membership gate: a collab-rooted Host workspace (and the sessions bound inside it) is listed, streamed, and reachable only to that workspace's members, and a non-member's Host call that targets a hidden collab directory is refused with the host-owned `workspace-forbidden` error carrying the workspace id. Plain Host workspaces stay visible to every authenticated caller. The gate is read live from the service store, so a single-user composition that omits this overlay keeps the Host plane byte-identical, and a membership change takes effect from the next request or new stream.

## Configuration

The plugin composes the collab services and owns three configuration concerns: the default directory for repository clones (`cloneDir`, which seeds the runtime `collab` settings namespace value owned by the user through the Collaborative Workspaces settings page), an optional shallow-clone depth (`cloneDepth`, a positive integer that keeps only that many recent commits in new clones — `git clone --depth` — to speed the first transfer at the cost of a truncated history; absent or cleared means full history), and the optional server git credential for cloning private repositories (`gitToken` with `gitHost`, `gitUsername`). The credential is operator-only by design: it is read from the plugin config, routed to the clone through a temporary host-scoped git config that is deleted immediately after the clone, and never exposed through the settings namespace the GUI reads back. Every other tuning lives in the collab services it mounts (`dsh-collab-*` roots, OAuth client, cookie policy).

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
  config:
    # Optional: default directory for cloning repository-backed workspaces
    # before the user overrides it through the settings page. Empty (the
    # default) clones under the collab data root's `workspaces` directory.
    cloneDir: !!js dshHomePath('collab/clones')
    # Optional: shallow-clone depth for new repository clones (positive
    # integer). Keeps only that many recent commits to speed the first
    # transfer at the cost of a truncated history; unset or empty clones
    # full history.
    # cloneDepth: 10
    # Optional: server git credential so private repositories clone. The
    # token is sent only to `gitHost` (github.com by default) through a
    # temporary host-scoped git config removed right after the clone.
    # gitHost: github.com
    # gitUsername: x-access-token
    # gitToken: <personal-access-token>
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
- **Delete removes the record and the settled clone** — `collab/workspace.delete` unregisters a workspace and removes the clone directory backing a repository-backed workspace (best-effort; a clone that resists removal still completes the deletion with a warn). The push audit trail under the collab root is retained. A name-only workspace's materialized data directory is left for the host process to manage; re-creating a workspace from the same URL clones fresh into a fresh id-named directory.
