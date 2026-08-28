# Agent Note: Collab Host plane is membership-scoped

Status: implemented

English | [中文](2026-08-28-collab-host-plane-membership-scoping.zh.md)

## Problem

The [multi-user collab overlay](2026-08-27-collab-multi-user-overlay.md) gates the `/api` channel (every request and WebSocket upgrade requires a signed session) but left the Host workspace plane process-global. Mounted collab workspaces live on that shared plane, so any authenticated user — member or not — could see every mounted collab workspace in the standard Workspaces list and target their data directories and sessions through the Host RPCs (`workspace.list`/`create`, `sessions.create` by `workspaceId` or cwd, `history`, `fork`) and the live `host()`/`mux()` streams. A user invited to one of two workspaces reported seeing and reaching both. The boundary had to be per principal, because a member's GUI switch-in depends on the collab workspace appearing in their own Host list.

## Decision

The collab overlay stages an optional membership gate that the Host API proxy consults with the connection principal on every decision. The gate (`CollabWorkspaceAccess`, provided by the collab assembly only, as the `collabWorkspaceAccess` service) answers `allow(principal, path)`: a path outside the collab data root is always allowed (Host-owned), and a path inside `<collabRoot>/workspaces/<workspaceId>[…]` is allowed only while the principal is a member of that collab workspace. A single-user composition provides no gate, so its Host plane is byte-identical.

- The proxy reads the gate and the connection principal from the live service store per decision, so the collab rows may mount before or after the api-gateway row; the api-proxy suite drives the production order (gate provided after the proxy is composed) and still scopes.
- Workspaces: `workspace.list` returns only the caller's visible set; `create`, `rename`, `delete`, `insertBefore`, and `insertSessionBefore` refuse a collab-rooted target the caller is not a member of; and the `host()` stream commits and frames only the viewer's visible workspaces and order.
- Sessions: `sessions.create` refuses a `workspaceId` or cwd into a hidden collab directory, the shared `listVisibleSessionSummaries` filters both `sessions.list` and `search`, `history` and `fork` report a hidden target as missing, and the `mux()` stream subscribes baseline and live conversation frames only for visible sessions.
- A refusal folds to the host-owned error `workspace-forbidden` carrying the workspace id; the collab client needs no change because hidden workspaces never reach a non-member UI.

## Alternatives considered

### Hiding all mounted collab workspaces from the Host plane

Rejected: members switch into a collab workspace through the standard Workspaces face (`openWorkspace` → `mount` → frame echo → `startSession(hostId)`), so removing collab mounts from the Host list would break members, and it would not stop a non-member from targeting a hidden directory directly.

### Enforcing membership only in the collab mount path

Rejected: the leak report showed access through un-scoped Host RPCs, so enforcement had to live where every Host call lands, not only where the collab overlay mounts a workspace.

## Consequences

The Host plane serves each mounted collab workspace and the sessions bound inside it only to its members, while plain Host workspaces stay visible to every authenticated caller. Membership is sampled per request and at stream open, so grants and revocations apply to new requests and new streams rather than to frames already in flight. Two live echoes remain process-global by design and are recorded as a Known Limitation rather than silently gated: the `host()` archived-sessions echo and the `mux()` task/queue/question baselines still carry workspace ids, session ids, or task state for sessions a caller cannot see, but they carry no conversation content, and the enumerated surfaces (`workspace.list`, `sessions.list`/`search`, `history`, `fork`) are fully scoped.
