# Agent Note: The collab section hides archived sessions

Status: implemented

English | [中文](2026-09-07-collab-section-hides-archived-sessions.zh.md)

## Problem

Archiving a shared session from the collab section's session row menu left the row on the sidebar, and selecting that row opened a blank New Session instead of the session's chat history. The host's `workspace.archiveSession` never removes an archived session from its workspace's `sessionIds` account — it only adds the id to the per-principal `archivedSessionIds` set, leaving each grouping surface to hide archived ids itself ("Archiving never touches workspace accounting... grouping surfaces hide them" in the workspace registry). The collab section is such a grouping surface, but it rendered every id in `host.sessionIds`, so an archived session stayed visible and remained selectable.

## Decision

The collab section reads the registry-global `archivedSessionIds` from the workspace snapshot (via the standing `useWorkspaces` hook) and drops any session id in that set when it computes each workspace's displayed session order, exactly as the runtime's own session-reuse and selection projections already do. This mirrors the browsing region's archive hiding: an archived session is absent from the section's workspace row and flat bucket until a future unarchive returns it to the account. The session log and `sessionIds` slot are untouched — only the display filter changed.

## Outcome

Archiving a shared session hides its row immediately (the section re-renders on the `archivedSessionIds` change), and the row can no longer be selected, so the "new blank chat" path is unreachable. Covered by grouped- and flat-mode tests asserting an archived session is absent while a survivor stays.
