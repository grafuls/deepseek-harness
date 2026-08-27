# Agent Note: Multi-user collab overlay (Google OAuth + RBAC workspaces)

Status: implemented

English | [中文](2026-08-27-collab-multi-user-overlay.zh.md)

## Problem

DeepSeek Harness runs as one shared harness process in which every browser that can reach it shares one session plane. There was no way to run an instance serving several named people: no authentication, no per-person identity, no workspace scoping of data or role. Making the product multi-user touches every layer — the wire, the session model, the data layout, and the browser GUI — so the change needed a decision about where enforcement lives and how a single-user install stays unchanged.

## Decision

Multi-user is an opt-in overlay on the one-server model. A single deepseek-harness process serves every signed-in user; nothing forks or spawns per-user servers. The whole feature ships under the `web-collab` profile patch bundle ([`packages/bundle/collab`](../../../../packages/bundle/collab/README.md)): a plain `web` install registers no authenticator and mounts no collab UI, and its behavior is unchanged.

- **Identity and sessions** — [dsh-collab-auth](../../../../packages/collab/auth/README.md) runs the browser OIDC round-trip against Google through the `openid-client` discovery API, issues a signed `dsh_collab_session` cookie, and exposes `resolve`/`createSessionToken`/`loginUrl` plus the gateway seam (`OidcGateway`) the tests replace with a fake. The sign-in flow rides four exact HTTP routes under `/api` (`/api/collab/auth/login`, `/callback`, `/logout`, `/session`).
- **The auth fence** — [dsh-collab-api](../../../../packages/collab/api/README.md) registers a connection authenticator on the shared connection: every `/api` RPC and every WebSocket upgrade is refused with 401 unless the browser's cookie resolves to a principal. With no authenticator registered (single-user), the connection stays open as today. The fence is a runtime invariant of the connection owner, and the collab RPC interceptor dispatches the `collab/*` endpoints under that principal.
- **Identities and RBAC** — [dsh-collab-users](../../../../packages/collab/users/README.md) keeps the Google-identity account registry with a global `admin`/`member` role per account; [dsh-collab-rbac](../../../../packages/collab/rbac/README.md) owns the permission matrix (global member = create/join workspaces, admin adds user management; workspace developer = use and read members, admin adds invite/manage/delete). A member can create workspaces; a fresh sign-in creates no workspace automatically.
- **Workspaces and data scoping** — [dsh-collab-workspaces](../../../../packages/collab/workspaces/README.md) keeps durable `users.json`/`workspaces.json` plus one `workspaces/<id>` data directory per workspace under a configured root (default `$DSH_HOME/collab`), so per-workspace data ships as a directory, not one shared session plane. Membership is invite-only by email; the creator becomes owner+admin, the owner cannot leave or be demoted, and the last admin cannot be demoted.
- **The browser face** — [dsh-client-ui-auth](../../../../packages/client/ui-auth/README.md) covers the app with a sign-in card while the browser holds no session cookie; [dsh-client-ui-collab](../../../../packages/client/ui-collab/README.md) lists, creates, accepts invitations addressed to the user, and administers workspaces from the collab section under the sidebar's Workspaces list (a row opens the overlay manager for member and role detail) and the `shell.overlay` manager panel, over the same shared `/api` RPC envelope the rest of the GUI uses (the accept row reads `collab/workspace.myInvitations` and joins via `collab/workspace.join`). A row's Open calls `collab/workspace.open`, which mounts the collab workspace as a real Host workspace over its reserved `workspaces/<id>` data directory (idempotent by path, title re-asserted to the collab name against the Host registry's uniqueness invariant) and switches the GUI into it through the runtime Workspace face, so the mounted workspace appears in the standard Workspaces list too and every member opens the same Host workspace. Both compose out via `slots.inject`, so without the collab overlay rows nothing mounts and a non-collab install renders unchanged. Their product copy is not hardcoded: each registers a dictionary namespace (`collab.auth`, `collab.ui`) on the standard locale seat, so the gate and workspaces manager follow the GUI's Language setting (a browser naming no shipped language falls back to English).

## Alternatives considered

### Per-user server processes

Each authenticated user gets their own harness process, isolated by construction. Gives up the shared-process model entirely and is heavy: N servers, N session stores, no shared workspace data without a sync layer. The agreed scoped spec fixed one process serving all users, so the fence + workspace-directory model was chosen instead.

### A collab package per capability

A separate top-level product that wraps or proxies the real harness. Rejected: it adds a second telemetry/logging/session system instead of an overlay that composes the existing single-user install, and it cannot keep the default `web` behavior byte-for-byte.

### Auto-provisioning workspace on first sign-in

Every fresh Google account gets a personal workspace on first login. Rejected: it violates invite-only semantics, mints data nobody asked for, and the agreed spec explicitly forbids auto-creating workspaces for fresh users.

### Forwarding the connection's own 401 recovery

The OIDC round-trip is a full-page navigation, so ui-auth re-enters through a page reload that lands with the fresh cookie rather than hot-reconnecting a 401'd transport. A connection-level recovery state machine was deferred; the reload path keeps the fence the single authority and stays simpler.

## Consequences

One process serves many users but keeps a single shared instance plane for the browser: one session cookie per browser, and a workspace is scoped to its data directory, not to its own login or sessions. The gate covers every `/api` RPC and WebSocket upgrade, which is where the real authority lives; the GUI layers (ui-auth then ui-collab) only ever fail open and add wait-for-ready probes on top. The four exact auth routes deliberately bypass the RPC trust fence and are reachable on any host, which is safe only for loopback-first localhost deployments — recorded as a known tradeoff rather than silently "protected". RBAC lives in its own package with a typed permission matrix, so the per-workspace policy is testable without the full GUI. The whole feature's durability is pinned by a REAL-composition test that boots the `web-collab` profile through the Loader against a fake OIDC gateway; that composition also mounts the real Host workspace registry (memory domain store), and one case asserts that two members opening the same collab workspace resolve to the same real Workspace whose canonical path is the collab data directory.
