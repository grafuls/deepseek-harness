# Agent Note: collab session patch download

Status: implemented

English | [中文](2026-09-08-collab-session-patch-download.zh.md)

Builds on [collab repository-backed workspaces](2026-08-29-collab-repo-backed-workspaces.md), [collab per-session work branches](2026-09-01-collab-session-work-branches.md), and [collab branch push](2026-09-01-collab-push.md): this note covers the read-only endpoint that gives a member the session branch's diff as a patch file to apply locally with `git apply`.

## Problem

A session's work lives on its own `<workspace>-<session>` branch in the shared clone, and the push verb publishes it to the repository. But a member who wants to take that work somewhere without a pull request — a local checkout at the base, a different fork, an offline patch — had no way to fetch the branch's diff as a file. The git verbs on a session row (push, sync) move state toward the origin or the shared tree; none of them hands back the session's changes as a self-contained patch.

## Decision

A member-facing RPC `collab/workspace.patch` returns the unified diff of one branch against the workspace mainline as a patch a member can save and apply locally:

- **Ref-based; includes the active session's uncommitted edits.** The diff roots at the branch's mainline merge-base, where `<base>` is the workspace's `refs/remotes/origin/HEAD` default branch. For a branch that is not the clone's current checkout it is the deterministic three-dot `git diff <base>...<branch>`, reading only commit objects, so it never includes another session's uncommitted working-tree edits. When the branch **is** the clone's current checkout, the session that holds it may carry uncommitted edits that are its work, so those are included by diffing the working tree against the merge-base (`git diff <merge-base>`); the patch is then that session's full current state.
- **Default line.** With no `branch` argument the endpoint diffs the checkout's current branch (`rev-parse --abbrev-ref HEAD`), mirroring the push default; an explicit `branch` is validated up front with the same plain-branch-name rule as push.
- **Read-only, no confirmation, no credential.** The diff is computed entirely locally from the settled clone, so it needs no member confirmation and no server git credential. It fails closed (`collab-not-a-repository`) on a name-only or still-cloning workspace, and folds a detached checkout, an unresolvable mainline, or a git failure (missing branch, not a repo) into `collab-bad-request`.
- **Response.** The endpoint returns `{ branch, base, patch, filename }`, where `filename` is `<branch>.patch` with any forward slashes replaced so the browser saves a single flat file. The patch text is `git apply`-compatible (`--no-ext-diff --no-color --binary`).
- **Browser surface.** The session row menu gains a "Download patch" verb alongside push/sync, offered only for a repo-backed settled clone (the same `branch !== undefined` gate as the other git verbs). It resolves the patch through the controller and hands the text to the browser to save (the controller never touches the DOM); a folded failure surfaces as a transient note above the list.

## Alternatives considered

- **Include the working-tree diff when the branch is the checkout.** Adopted with a narrow refinement: the working-tree diff is included only for the branch that currently holds the clone's checkout, because those edits belong to that session; a request for a *different* session's branch keeps the deterministic committed-only diff, so it still cannot leak whoever is active. The original reservation — that including the working tree leaks the checkout-holding session — is exactly why the inclusion is gated on the requested branch being the checkout.
- **Server writes the patch to a file and returns a URL.** Rejected: it adds an on-disk artifact and a download path for something the RPC can carry in its JSON result; the controller already routes push/fetch results the same way, so a patch-as-value keeps one transport.
- **Two-dot `base..branch` diff.** Rejected: two-dot compares the two tips directly, which includes every commit on the base the branch has not merged; three-dot shows exactly what the branch introduced, which is what a local `git apply` onto the base should see.

## Consequences

- A member downloads a session's changes as a single `.patch` file from the row menu, applies it locally, and the shared clone and the origin are untouched (the read moves nothing).
- The patch is a snapshot of the branch's work at request time. For the checkout-holding session it reflects the full working state, including uncommitted edits; for any other session it reflects the branch's committed changes. Consistent with the per-session branch model where a session's work lives on its own line.
- The diff direction and units keep git's rules: it is a unified diff over the merge-base, so it applies cleanly to a checkout of the mainline base; renames and binary changes are represented because `--binary` is passed.
