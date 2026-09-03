# Agent Note: collab repository lifecycle hygiene

Status: implemented

English | [中文](2026-09-01-collab-lifecycle-hygiene.zh.md)

Builds on [collab repository-backed workspaces](2026-08-29-collab-repo-backed-workspaces.md), [collab async repository provisioning](2026-09-01-collab-async-repo-provisioning.md), [collab per-session work branches](2026-09-01-collab-session-work-branches.md), and [collab branch push](2026-09-01-collab-push.md): this note covers the operations-third of the repository workflow — deleting a workspace closes its clone instead of leaving roots, members can fetch the shared clone up to date, new clones can be shallow, and every push leaves an audit trail.

## Problem

Repository-backed workspaces gained session branches and server-side push, but the surrounding operational lifecycle was still hole-punched: deleting a workspace unregistered it while leaving its clone on disk for the host process to trip over; a member could push their own line but had no cooperative way to pull the rest of the shared clone's latest upstream into the same shared tree; every fresh bootstrap paid the full-history transfer even when only recent commits mattered; and a push moved a shared branch with no server-side record of who did what, so an administrator had no post-hoc answer for "who pushed this branch and when".

## Decision

Four small server-side changes round out the lifecycle, each keeping the established no-shell runner, credential pinning, and silent-clone-failure contracts:

- **Delete removes the clone.** `collab/workspace.delete` now also removes the clone directory backing a repository-backed workspace (recursive and forced) after the record is unregistered, so deleting a workspace closes its working tree instead of leaving roots available to the host process; a clone that resists removal never blocks the delete — it warns (`collab clone removal ... failed`) and the record deletion stands.
- **Fetch/sync endpoint.** `collab/workspace.fetch` fetches the origin into a settled clone *without touching the checkout*: remote-tracking refs only, stale ones pruned, so a member can pull the shared repository's latest upstream with no disturbance to any session's working tree or current branch, and no hard-reset path is offered. A name-only or still-cloning record is refused (`collab-not-a-repository`); git failures fold to `collab-bad-request`. The panel exposes it as the repository row's "Sync" action with a transient acknowledgement.
- **Shallow bootstraps.** A `collab` settings-namespace `cloneDepth` (positive integer) makes new clones `git clone --depth <n>`, cutting the first transfer at the cost of truncated history; clearing it (or leaving it unset) restores full-history clones. The GUI settings page gains a matching depth field beside the clone-directory field.
- **Push audit trail.** Every push — dry run or real — appends one JSON line to `<collabWorkspacesRoot>/audit/push.jsonl` (workspace and actor ids, actor display name, branch, dry-run flag, pushed/up-to-date, and for a successful push the new remote SHA and compare link). The write is best-effort (a failure only warns, never fails the push) and the trail lives under the collab root, so it outlives a workspace deletion and gives an administrator a durable record of who pushed what and when.

## Alternatives considered

- **Hard-reset / destructive sync.** Deferred, deliberately: fetch-only keeps the shared working tree authoritative for every session, whereas a reset would discard another session's uncommitted work with nothing but the remote to blame; if a member ever needs to move the shared tree destructively, that is a separate, explicitly destructive operation with its own gate.
- **Deleting the name-only data directory too.** Deferred: name-only workspaces materialize their data directory on demand and may still be referenced by open sessions; removing only the settled clone keeps delete predictable while the data directory stays host-managed, matching the existing per-workspace semantics.
- **An audit table instead of a JSONL log.** The trail is a linear append-only history with no query surface yet; a JSONL line per push under the root costs nothing to keep and is trivially consumable, so the durable, homed location is the right first form.
- **Fetching into a work branch.** Rejected: that would move the shared tree (or require a per-session working ref dance) for a read every member can answer with remote-tracking refs alone.

## Consequences

- Deleting a repository-backed workspace now actually frees its working tree; a user who pushed work has already published it on the remote, and a user who wants the clone back re-creates from the same URL into a fresh id-named directory.
- The shared clone stays authoritative through syncs: no working-tree movement, no branch switches, no reset — a member pulls upstream the same way they push their own line.
- Shallow bootstraps are an operator/default knob per the existing settings-namespace contract, so a slow-link instance can cut clone time without changing create semantics.
- Push history is inspectable after the fact and independent of workspace retention; the read/write/delete surfaces stay honest about what touched the shared repository.
