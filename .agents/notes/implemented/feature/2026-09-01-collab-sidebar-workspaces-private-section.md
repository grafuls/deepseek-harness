# Agent Note: the sidebar's Workspaces seat holds only the Workspaces section

Status: implemented

English | [中文](2026-09-01-collab-sidebar-workspaces-private-section.zh.md)

## Problem

After the one-section consolidation, the sidebar's single Workspaces section still opened with the local Workspaces browsing region (titled Public Workspaces) and placed the collab workspaces below it as a labeled group. The user asked to remove the public workspace browsing area from the sidebar and let the collab workspaces replace it as the only workspace surface — including a single-user install that has no collab surface at all.

## Decision

The sidebar has one Workspaces seat, `sidebar.workspaces`, occupied only by the collab Workspaces section. The local browsing region is removed from the sidebar entirely:

- **The browsing subsystem is deleted.** `WorkspaceBrowser` and its rows, tree derivations, and viewing store are gone from ui-workspace; the package now registers only the conversation-hero `WorkspacePicker`. The sidebar directory-flow hole (`sidebar.workspaces.directoryFlow`) stays declared as a type-only contract so the picker packages' shared type chain keeps compiling, but nothing mounts it at runtime.
- **The collab section becomes the standalone Workspaces section.** `CollabSection` registers on `sidebar.workspaces` itself as a standalone section, keeping the browser-derived format as its own: section title, expanding search, view options, add workspace, and session rows that open on click. Its root re-declares the browsing region's list-inset and scrollbar CSS variables so the list aligns as the region it replaced did, and the collapsed rail keeps just the search control that expands the sidebar.
- **Local workspaces stay reachable outside the sidebar.** The hero's Choose-workspace picker and the New Session flow keep every local workspace one click away; no workspace or session data changes.
- **An absent collab surface renders nothing.** Signed out (or a single-user install), `CollabSection` hides itself and the sidebar Workspaces seat is empty — the accepted consequence of removing the local region without a fallback.

## Alternatives considered

- **Keeping the local browsing region above the collab workspaces (the one-section two-groups design).** Rejected by the user, who asked for the public workspace area to be replaced outright; the earlier grouping is superseded and archived.
- **Hiding the browsing region only for collab installs and keeping it for single-user.** Rejected: the user confirmed the removal is universal — a single-user sidebar has no local workspace list either, and local workspaces are still reachable through the picker and New Session.
- **Deleting only the registration while leaving the browser component dormant.** Rejected as a simplification: the browser is dead weight with no runtime surface, so it and its specs are removed together.

## Consequences

- The sidebar Workspaces area shows the Workspaces section when a collab surface is ready and is empty otherwise; the two-groups-under-one-header framing and its notes are archived.
- ui-workspace shrinks to the picker registration; the regenerated client slot catalog lists `CollabSection` as the `sidebar.workspaces` occupant.
- The web e2e sidebar workflows (workspace management, cold-blank-session, rail search, sidebar scrollbar/subagent activity, subagent conversation) need rewrites against the workspaces-only sidebar.
- The section's session behavior (rows expand, sessions open on click, auto-mount) is unchanged; its note stays active, with the local-browser filtering machinery gone.

## Related

- [collab sidebar section browses and opens the sessions inside each workspace](2026-08-29-collab-sidebar-section-session-browse.md) — the section's session behavior, unchanged.
- The superseded two-groups design is archived history: [collab sidebar consolidates public and private workspaces into one section](../../archived/feature/2026-09-01-collab-sidebar-one-section-two-groups.md).
- The browsing-region format the section keeps is archived history: [collab sidebar section mirrors the Workspaces browsing region](../../archived/feature/2026-08-29-collab-sidebar-section-format.md).
