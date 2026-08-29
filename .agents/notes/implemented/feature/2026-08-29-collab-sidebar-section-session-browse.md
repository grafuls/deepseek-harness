# Agent Note: collab sidebar section browses and opens the sessions inside each workspace

Status: implemented

English | [中文](2026-08-29-collab-sidebar-section-session-browse.zh.md)

## Problem

The collab section's workspace rows opened (mount + switch) the workspace when clicked, yet collab sessions stayed invisible from the sidebar: a mounted collab workspace's sessions were interleaved into the default Workspaces browser's list, and reaching one forced a full switch into the workspace. Members asked for the collab section to replicate the default browsing region's model — see the sessions inside each workspace in place, without leaving the sidebar — with the two sections stacked as siblings (local browsing region above, collab section below) and the global settings entry left separate.

## Decision

The collab section now browses the sessions inside each member workspace exactly as the browsing region above does, as a sibling block under it:

- **Workspace rows expand to their sessions.** Clicking a workspace row toggles an expanded session list under it (chevron + folder chrome, `aria-expanded`); it no longer mounts-and-switches. A session opens directly when its row is clicked, through the runtime `sessions.open` face, matching how entering a default workspace session works.
- **Auto-mount on render.** When the section first becomes ready, it mounts every member workspace in the background via `collab/workspace.open` and folds per-workspace failures into the store's error banner. Mounting is path-idempotent in the Host registry, so sessions other members created (or previously mounted ones) materialize on their own; a workspace with no sessions yet shows a localized empty note.
- **Collab-origin workspaces stay out of the local browsing region.** A collab mount creates a Host workspace whose record carries a `collab: { workspaceId }` marker (the `create(path, title?, collabWorkspaceId)` third parameter re-stamps it idempotently). The default Workspaces browser filters workspaces carrying that marker, and the sessions accounted to them, out of every grouping surface — grouped list, flat list, and content search — so collab sessions appear only in the collab section.
- **View options now act on sessions.** Grouped mode nests each workspace's sessions under its row; flat mode lists every collab session once (deduped) across workspaces; order-by `updated` sorts sessions by their own recency while `manual` keeps the workspace/server order.
- **Empty states.** No workspaces at all (and no invitations) shows the region's empty message; workspaces exist but none mounted yet shows the no-sessions-yet note; a search with no match shows the no-match message in both view modes.

## Alternatives considered

- **Switching into the workspace on row click (the prior behavior).** Rejected: the user asked for the section to replicate the default browser, where a row click opens a specific session; switching the whole GUI on every click also forced a navigation for what is often a glance. Auto-mounting with direct session open covers both the glance and the entry without tying them to one gesture.
- **An opt-in toggle for automatic mounting.** Rejected by the user: with a collab surface present, members expect other members' sessions to be there with no extra step; mounting is idempotent and cheap, so the section auto-mounts unconditionally on render.
- **Letting collab-origin workspaces remain in the default list, filtered by the marker.** Rejected: without a filter every collab install would double-list each workspace and its sessions; the colocated marker plus a client-side hidden-session set keeps the default list local-only while the Host registry still owns the one true record.
- **A dedicated collab sessions RPC.** Rejected: sessions already materialize in the mounted Host workspace's list projection, so the section reads them through the shared runtime `useWorkspaces`/`useSessions` seats with no new wire surface or availability state.

## Consequences

- A collab member sees, side by side in the sidebar, the default Workspaces browsing region (local workspaces only) and the Collab section (its own workspaces with their sessions), with the global settings entry remaining separate below.
- The marker is durable in the Host workspace record, so every member resolves the same collab-owned workspace and its session account; previous records without the marker keep working, and re-mounting stamps the marker onto unmarked or recreated records.
- The default browser's local-only behavior is preserved by threading a hidden-session set (derived from collab mounts) through the existing tree derivations; there is no server-side query change and no collab sessions endpoint.
- `collab/workspace.open` is now issued automatically whenever the section renders (a ready-availability effect), not only from an explicit click; per-workspace failures stay scoped to the banner so one failing workspace never blocks the rest.
- The row-level interaction from the earlier section-format note is superseded: rows expand instead of switching, and sessions are the open affordance.

## Related

- [collab sidebar section mirrors the Workspaces browsing region](2026-08-29-collab-sidebar-section-format.md) — the format-and-registration decision this note builds on; its row-open interaction is superseded here.
- [collab repo-backed workspaces](2026-08-29-collab-repo-backed-workspaces.md) — the collab API mount and clone behavior whose workspaces this section browses.
