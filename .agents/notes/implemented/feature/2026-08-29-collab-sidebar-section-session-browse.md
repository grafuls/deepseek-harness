# Agent Note: collab sidebar section browses and opens the sessions inside each workspace

Status: implemented

English | [中文](2026-08-29-collab-sidebar-section-session-browse.zh.md)

## Problem

The collab section's workspace rows opened (mount + switch) the workspace when clicked, yet collab sessions stayed invisible from the sidebar: a mounted collab workspace's sessions were interleaved into the default Workspaces browser's list, and reaching one forced a full switch into the workspace. Members asked for the collab section to replicate the default browsing region's model — see the sessions inside each workspace in place, without leaving the sidebar — with the two sections stacked as siblings (local browsing region above, collab section below) and the global settings entry left separate.

## Decision

The collab section browses the sessions inside each member workspace as the sidebar's sole Workspaces seat (the local browsing region it was formatted to mirror is removed):

- **Workspace rows expand to their sessions.** Clicking a workspace row toggles an expanded session list under it (chevron + folder chrome, `aria-expanded`); it no longer mounts-and-switches. A session opens directly when its row is clicked, through the runtime `sessions.open` face, matching how entering a default workspace session works.
- **Auto-mount on render.** When the section first becomes ready, it mounts every member workspace in the background via `collab/workspace.open` and folds per-workspace failures into the store's error banner. Mounting is path-idempotent in the Host registry, so sessions other members created (or previously mounted ones) materialize on their own; a workspace with no sessions yet shows a localized empty note.
- **Collab-origin workspaces carry a durable marker.** A collab mount creates a Host workspace whose record carries a `collab: { workspaceId }` marker (the `create(path, title?, collabWorkspaceId)` third parameter re-stamps it idempotently). There is no local browsing region left to filter: collab sessions appear in the Workspaces section, and the hero picker lists Host workspaces (collab mounts included) as before. The browsing region's local-only filtering and its hidden-session set were deleted with the region.
- **View options now act on sessions.** Grouped mode nests each workspace's sessions under its row; flat mode lists every collab session once (deduped) across workspaces; order-by `updated` sorts sessions by their own recency while `manual` keeps the workspace/server order.
- **Empty states.** No workspaces at all (and no invitations) shows the section's empty message; workspaces exist but none mounted yet shows the no-sessions-yet note; a search with no match shows the no-match message in both view modes.

## Alternatives considered

- **Switching into the workspace on row click (the prior behavior).** Rejected: the user asked for the section to replicate the default browser, where a row click opens a specific session; switching the whole GUI on every click also forced a navigation for what is often a glance. Auto-mounting with direct session open covers both the glance and the entry without tying them to one gesture.
- **An opt-in toggle for automatic mounting.** Rejected by the user: with a collab surface present, members expect other members' sessions to be there with no extra step; mounting is idempotent and cheap, so the section auto-mounts unconditionally on render.
- **Letting collab-origin workspaces remain in the default list, filtered by the marker.** Rejected: without a filter every collab install would double-list each workspace and its sessions; the colocated marker plus a client-side hidden-session set keeps the default list local-only while the Host registry still owns the one true record.
- **A dedicated collab sessions RPC.** Rejected: sessions already materialize in the mounted Host workspace's list projection, so the section reads them through the shared runtime `useWorkspaces`/`useSessions` seats with no new wire surface or availability state.

## Consequences

- A collab member sees the Workspaces section as the sidebar's Workspaces seat, its workspace rows expanding to their sessions; local workspaces are reached through the hero picker and the New Session flow, with the global settings entry separate below.
- The marker is durable in the Host workspace record, so every member resolves the same collab-owned workspace and its session account; previous records without the marker keep working, and re-mounting stamps the marker onto unmarked or recreated records.
- The default browser's local-only filtering is gone with the browsing region: no hidden-session set threads through tree derivations, because the sidebar no longer renders a local list; collab sessions appear in the Workspaces section.
- `collab/workspace.open` is now issued automatically whenever the group renders (a ready-availability effect), not only from an explicit click; per-workspace failures stay scoped to the banner so one failing workspace never blocks the rest.
- The row-level interaction from the earlier section-format note is superseded: rows expand instead of switching, and sessions are the open affordance.

## Related

- [the sidebar's Workspaces seat holds only the Workspaces section](2026-09-01-collab-sidebar-workspaces-private-section.md) — the collab section owns the sidebar's sole Workspaces seat; the browsing region it mirrored is removed.
- [collab repo-backed workspaces](2026-08-29-collab-repo-backed-workspaces.md) — the collab API mount and clone behavior whose workspaces this section browses.
- [collab sidebar section mirrors the Workspaces browsing region](../../archived/feature/2026-08-29-collab-sidebar-section-format.md) — the format the section keeps (archived history; the region it mirrored no longer exists).
- [collab sidebar consolidates public and private workspaces into one section](../../archived/feature/2026-09-01-collab-sidebar-one-section-two-groups.md) — the superseded two-groups framing (archived history).
