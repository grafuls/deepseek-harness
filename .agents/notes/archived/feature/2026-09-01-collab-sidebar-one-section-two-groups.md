# Agent Note: collab sidebar consolidates public and private workspaces into one section

Status: implemented
Archived: 2026-09-01

English | [中文](2026-09-01-collab-sidebar-one-section-two-groups.zh.md)

## Problem

The sidebar presented two stacked workspace areas: the local Workspaces browsing region (titled Public Workspaces) and, below it, a separate Collaborative Workspaces section (titled Private Workspaces). Each carried its own full section header — title, expanding search, view options, add workspace — and its own bordered block, so one conceptual surface read as two sections and twice the header chrome for the same thing.

## Decision

The sidebar shows one Workspaces section with two labeled groups. The browsing region's header stays the section's only header; the collab block renders beneath the local list as the section's second labeled group, marked by a recessed "Private Workspaces" group label and a compact toolbar (expanding search, view options, add workspace) under a hairline divider — it no longer presents a second section header.

- **The collab block becomes an ARIA group, not a region.** `CollabSection` renders a `role="group"` labeled by its title instead of a `<section>`, so the accessibility tree exposes one workspace region containing a labeled group rather than two regions.
- **Both data flows stay separate.** The local browser and the collab controller/store are unchanged; the group keeps its own search, view options, and add affordance, and its list stays a bounded block that scrolls inside the same insets (max-height 40% of the column), so row alignment with the session rows above is preserved.
- **An absent collab surface still renders nothing.** A single-user install's browsing region is byte-for-byte unchanged; the seat and the wide-only outlet stay exactly where they were.

## Alternatives considered

- **One fully merged unified list** — the same single list for local and collab workspaces with one search and one view-options menu, collab rows interleaved and tagged. Rejected by the user in favor of the lighter grouped design: it would fuse the two data flows, force a shared control surface, and blur which row actions belong to which source.
- **Folding the collab search and view options into the single section header.** Rejected with the unified list: those controls belong to the collab data flow, so the group keeps its own compact toolbar.

## Consequences

- One header at the top; the local group and the Private Workspaces group below it, separated by a hairline and distinguished by the label.
- The collab block's format (toolbar, rows, invitations) is otherwise unchanged, so the session-browsing behavior and its note stay valid; the earlier format note's distinct-block and region-header framing is superseded here, while its "mirror the browsing region" decision still governs the toolbar.
- The `sidebar.workspaces.collab` seat, its owner contract, and the package boundaries are untouched — this is presentation and semantics only.

## Related

- [collab sidebar section mirrors the Workspaces browsing region](2026-08-29-collab-sidebar-section-format.md) — the format decision this note reframes; its distinct-block framing is superseded here, its mirror-the-format decision remains.
- [collab sidebar section browses and opens the sessions inside each workspace](2026-08-29-collab-sidebar-section-session-browse.md) — the session-browsing behavior inside the group, unchanged.
