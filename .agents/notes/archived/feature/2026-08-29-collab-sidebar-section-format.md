# Agent Note: collab sidebar section mirrors the Workspaces browsing region

Status: implemented
Archived: 2026-09-01

English | [中文](2026-08-29-collab-sidebar-section-format.zh.md)

## Problem

The sidebar's Collaborative Workspaces section below the local Workspaces browsing region looked and behaved nothing like the region above it: a plain `h2` title, a list of workspace rows each carrying a separate "Open" button (mount + switch), and an inline create affordance at the bottom. Every element a user expects from a browsing section — search, view options, an add affordance in the header — was either missing or styled differently, so two adjacent surfaces with the same conceptual role had no visual or interaction parity.

## Decision

The collab block now mirrors the Workspaces browsing region's format as the section's second labeled group below the local list — see [the one-section two-groups note](2026-09-01-collab-sidebar-one-section-two-groups.md):

- **Compact group toolbar.** The "Private Workspaces" label and its controls sit in a recessed group toolbar under a hairline divider, not a second full section header: an expanding search capsule (collapsing the trailing actions), the same view-options menu, and the add-workspace icon button. The search filters the collab workspace list by name locally.
- **Same view-options menu, mirrored exactly.** The menu offers the browsing region's four items — Group by WorkSpace / In one list, Order by Manual / Last updated. Grouping toggles the leading folder chrome per row, and in the grouped mode a workspace row now expands to the sessions mounted in it; ordering `updated` sorts sessions by their own recency (creation recency was the only signal the wire exposed at section-format time, and session recency arrived with session browsing), while `manual` keeps the server/workspace order — see [the session-browsing note](2026-08-29-collab-sidebar-section-session-browse.md).
- **No per-row Open button.** Clicking a workspace row now expands its sessions; clicking a session opens it directly, so the session row is the open affordance, exactly as entering a default workspace is — the row's own mount-and-switch is superseded by [the session-browsing note](2026-08-29-collab-sidebar-section-session-browse.md).
- **Create moves to the toolbar.** The group's add-workspace button opens the same creation dialog the manager's dashed entry uses (`CreateWorkspace` gained an optional custom trigger; the dashed button remains the default for the manager).
- **Pending invitations keep their accept rows** above the scrolling workspace list, and the empty message appears only when there are neither workspaces nor invitations.

The view state (`groupBy`, `orderBy`) lives in the shared collab workspaces store (defaulting to grouped/recent like the browsing region) and is written through the same controller seam as every other action.

## Alternatives considered

- **Merging collab workspaces into the browsing region's tree.** Rejected: collab workspaces are not mounted Host workspaces until opened, so their sessions are not part of the local session projection; a distinct group inside the region (rather than interleaved tree rows) preserves that boundary while sharing the format.
- **Dropping view options entirely.** Rejected: the request called for the same header style including the view-options menu, and mirroring it exactly (rather than inventing collab-specific sort keys) keeps the two surfaces consistent.
- **Keeping the per-row Open button and adding header chrome around it.** Rejected: the button duplicated the row's primary purpose; the row itself is the open affordance in the browsing region, so the same holds here.

## Consequences

- The collab block is now visually and functionally parallel to the Workspaces browsing region: toolbar, search, view options, add, and open-on-click all match, with only the wire-specific content (member counts, invitations) differing.
- The Open action is reachable from the group without a glyph button, so the earlier per-row button (and its `open` locale key) is gone; the manager panel and its dashed create entry are unchanged.
- The group remains a bounded block under the scrolling session list: it caps at 40% of the column height and scrolls its own rows, so a long collab list never squeezes the local browsing region away.

## Related

- [collab sidebar section browses and opens the sessions inside each workspace](2026-08-29-collab-sidebar-section-session-browse.md) — the session-browsing follow-up that supersedes this note's row interaction and adds auto-mount plus local-browser filtering of collab-origin workspaces.
- [collab sidebar consolidates public and private workspaces into one section](2026-09-01-collab-sidebar-one-section-two-groups.md) — supersedes this note's distinct-block framing: the collab block renders as the section's second labeled group with a compact toolbar.
