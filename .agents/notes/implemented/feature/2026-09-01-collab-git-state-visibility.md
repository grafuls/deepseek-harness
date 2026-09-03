# Agent Note: collab git state visibility

Status: implemented

English | [中文](2026-09-01-collab-git-state-visibility.zh.md)

Builds on [collab repository-backed workspaces](2026-08-29-collab-repo-backed-workspaces.md) and [collab async repository provisioning](2026-09-01-collab-async-repo-provisioning.md): this note covers the read-only working-tree surface added to collab workspace views.

## Problem

A repository-backed workspace's clone is a shared live tree that every member's sessions operate on over the mounted Host workspace. Members nonetheless had no read-only way to see where the tree sat: which branch was checked out, which commit, and whether uncommitted changes were lying in the shared working tree. The state was reachable only by opening a terminal on the host, and a tree left dirty by one member is invisible to the rest until it bites them.

## Decision

The collab API view builders load the clone's working-tree state at view-build time and carry it on `CollabWorkspaceView` as an optional `gitState` (`branch`, abbreviated `sha`, and `dirty`):

- Reads run through three short `git` invocations over the clone — `rev-parse --abbrev-ref HEAD`, `rev-parse --short HEAD`, and `status --porcelain` — executed in a single `Promise.all` under one five-second `AbortSignal.timeout`, so a slow or wedged filesystem cannot stall a list. The reads go through the shared no-shell `gitCloneRunner` (the same runner that performs clones), so no shell interpolation reaches the process boundary and the args are pinned.
- `gitState` is computed at view-build time (list, get, create, rename, join) and is deliberately uncached for v1: the tree's state is the product of every member's session writes, and a stale value is worse than a slightly heavier list. The three invocations take milliseconds on a healthy checkout; the provisioned async-create and setup paths were already async, so only the list handler became `Promise.all`-over-views.
- The state is absent — the `gitState` key is omitted, never empty — whenever the clone is not settled or the directory is missing, not a git checkout, or stuck. Absence is the truth that there is no readable tree, so a vanished clone shows no fake branch rather than failing every member's list.
- The browser shows the state as a monospace chip on both workspace rows and the sidebar folder: `branch · sha`, with a dirty tree in the warning alias and a leading marker, titled with a localized "uncommitted changes" label. The chip is presentation only and gated on the optional field, so name-only and cloning workspaces render exactly as before.
- The bridge to the API layer is `WorkspaceSummary.clonePath`, set on the server-side summary by the workspaces service and never forwarded to the browser; the API view builder uses it only to locate the clone for the reads.

## Alternatives considered

- **Workspaces-service-owned git state.** Let the workspaces service itself read git and expose the state. Rejected: the service is an in-memory registry with no git knowledge, and coupling it to the clone layout would put clone semantics in two packages; instead the workspaces service only broadcasts the clone path it already owns and the API package performs the read.
- **Background-cached state.** Keep a periodic updater that refreshes `gitState` out of band so lists never pay for the reads. Rejected for v1: freshness is exactly what the surface is for, and a cache introduces a second authority for "where the tree is now" — the first incorrect value would be worse than the per-list cost. A later background cache can be layered without changing the contract.
- **Deriving everything from a single `git status` call.** Rejected: branch, abbreviated HEAD, and the dirty flag are separate git outputs; folding them into one command would re-introduce shell interpolation or an unsupported flags cocktail. Three pinned invocations under one timeout keep the runner interface untouched.

## Consequences

- The workspace list now performs up to three short `git` invocations per settled repo-backed row. On a healthy checkout these are sub-millisecond reads; a clone whose directory is gone or unwritable reports no `gitState` rather than failing the list, so this does not resurrect the earlier vanish-as-failure behavior.
- The dirty flag surfaces shared-tree writes: a member who modifies the mounted working tree sees the warning chip on every member's next view, which is the intended first step toward per-session branches and push (the collab settings page already lets an operator configure the server git credential those will reuse).
- The browser surface stays purely presentational and localized; the `gitUncommitted` label and the chip styles are the only UI additions, and the chip never changes the open/mount/lifecycle behavior of a row.
- The read requires `git` on the collab gateway host — the same requirement the clone already has — so no new operational dependency is introduced.
