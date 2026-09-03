# Agent Note: collab per-session work branches

Status: implemented

English | [中文](2026-09-01-collab-session-work-branches.zh.md)

Builds on [collab repository-backed workspaces](2026-08-29-collab-repo-backed-workspaces.md), [collab async repository provisioning](2026-09-01-collab-async-repo-provisioning.md), and [collab git state visibility](2026-09-01-collab-git-state-visibility.md): this note covers the per-session branch the shared clone is switched onto when a session opens inside a repo-backed workspace.

## Problem

A repository-backed workspace's clone is one shared checkout that every member's sessions operate on. Without any per-session git concept, all sessions in a workspace commit onto the same branch, so work from different sessions piles onto one line with no way to tell commits apart or push one session's work as its own pull request. The workspace also exposes no hook that distinguishes one session's activity from another's.

## Decision

When a session is created inside a settled repository-backed collab workspace, the collab API subscribes to `session/created` (global scope) and switches the shared clone onto a branch named after that session:

- The owning workspace is resolved from the session's canonical working directory through the collab registry's `workspaceHolding` (canonical clone containment) — the same relationship the membership gate uses, so a session at the clone root or any subdirectory resolves to its workspace, and sessions anywhere else resolve to nothing.
- The branch name is `<workspace>-<session>` (both components sanitized to `[A-Za-z0-9._-]`), so it is stable and unique per session and readable in the gitState chip surfaced by the view and the sidebar.
- The switch runs as `git switch -c <branch>` and falls back to a plain `git switch <branch>` when the branch already exists, so a re-created or re-attached session rejoins its own line instead of forking a second one or resetting the first. Both moves run through the shared no-shell `gitCloneRunner` under the same five-second state-read timeout.
- The fork is fire-and-forget with a debug log on success and a warn log on any failure: it must never hold up or fail session creation. Every guard is a silent no-op — a session outside a repo-backed workspace, a still-cloning workspace, a name-only workspace, or an unusable clone keeps the checkout untouched.
- The switch is the whole mechanic: the branch is a label on the shared tree, and the mainline branch (the clone's default at creation) is never modified by a fork. Registered through `ctx.effect`, the subscriber disposes with the collab gateway.

## Alternatives considered

- **Fork at `collab/workspace.open`.** The section's New Session flow opens the workspace then starts a session, so a fork there would run before the session id exists and could not name the branch per-session; it would also fork on every plain workspace view. Rejected: the session id is the branch's identity, and only a session-scoped hook carries it.
- **Fork in the workspace host's `attachSession`.** The Host entity learns a session joined when its cwd lands under a workspace path, but attaching collab-specific git behavior there would couple the workspace package to the clone model; the collab API owns the clone contract and reaches the same fact through `workspaceHolding`. Rejected for ownership, not reachability.
- **Fork lazily on the first session git write.** There is no observable "first write" event, and switching mid-work would carry uncommitted edits onto a different branch only when they merge cleanly. Rejected: a switch before the session starts is deterministic, and a post-hoc switch is not.

## Consequences

- Every session in a repo-backed workspace has its own line: its commits (and later pushes) stay on `<workspace>-<session>` while the workspace's mainline branch stays untouched. The gitState chip already renders the branch, so the per-session line is visible to every member without opening a terminal.
- Re-creating or re-attaching a session is idempotent: the fork's create-or-switch fallback moves the checkout onto the existing branch without resetting it, so a session's committed work survives.
- The fork is eventual by design — the session/created announce starts the async switch, and a session that runs git in its first milliseconds can briefly observe the previous branch. The window is a few milliseconds on a healthy checkout and never blocks creation.
- Two sessions do still share one working tree: the branch isolates history, not uncommitted files, so a member's uncommitted edits are visible to the next session that switches. Shared-tree overwrite awareness is deferred alongside the push phase rather than solved here.
- Non-collab sessions (home-directory sessions, subagent work outside a clone) and sessions in name-only workspaces never fork — the clone-containment guard is the single gate, so a single-user profile that omits the collab overlay is entirely unaffected.
