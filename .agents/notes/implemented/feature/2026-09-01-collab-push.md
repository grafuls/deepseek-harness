# Agent Note: collab branch push

Status: implemented

English | [中文](2026-09-01-collab-push.zh.md)

Builds on [collab repository-backed workspaces](2026-08-29-collab-repo-backed-workspaces.md), [collab async repository provisioning](2026-09-01-collab-async-repo-provisioning.md), and [collab per-session work branches](2026-09-01-collab-session-work-branches.md): this note covers the approval-gated server-side push of a session's branch through the server git credential.

## Problem

Per-session work branches isolate each session's commits, but until now they were local to the clone: the shared tree was never pushed, so a session's completed work could not reach the repository as its own pull request, and an operator had no server-side path to publish it. Pushing needs authentication (the same operator credential the clone uses for private repositories), a safety rule against overwriting remote history, and a human gate so a stray or scripted call cannot move a shared branch.

## Decision

A member-facing RPC `collab/workspace.push` performs the push server-side:

- **Approval gate.** The endpoint fails closed with `collab-approval-required` unless the request carries an explicit `confirm: true`, which the client sets only after the member's own confirmation. The gate is not gated by role: any member may push their session's branch onto its own line. The push runs under the same `collabRepoCloner` no-shell runner and the collab git credential as the clone.
- **Default line.** With no `branch` argument the endpoint pushes the checkout's current branch (`rev-parse --abbrev-ref HEAD`), so a session that forked its own branch pushes that branch, and a checkout sitting on the mainline pushes the mainline. A detached checkout (no named branch) is refused up front with `collab-bad-request`.
- **Non-fast-forward refusal.** Before touching the remote, the branch's live remote tip is read with `ls-remote`, that tip is fetched (remote-tracking ref only; the working tree never moves), and the push is refused with `collab-push-rejected` — naming the remote commit — unless the fetched tip is an ancestor of the local tip. The push itself never carries a force flag, so a branch that moves between the read and the push is also rejected by git atomically.
- **Dry-run.** `dryRun: true` fetches and computes exactly what would move (branch, base, tips, ahead/behind, links) and returns it without pushing, unauthenticated reads fail openly rather than degrading. Because it cannot move a branch, a dry run skips the confirmation gate, so the browser loads a live preview into the push dialog without asking first.
- **Browser surface.** The workspaces manager renders a repository block on a settled clone's detail: the current branch chip, a "Push branch" action that opens a confirmation row, a dry-run preview (what would move onto which base) loaded on open, and — after the member confirms — the outcome with compare and open-a-pull-request links. The client sends `confirm: true` only from that confirmed action, so the server gate and the GUI confirmation are the same decision.
- **Credential pinning.** The server credential is sent only when it is pinned to the origin's host; an HTTPS origin with no matching credential answers `collab-credential-unavailable`. The credential travels through the same temporary host-scoped git config as the clone (an authorization header), is deleted right after the invocation, and never appears in a URL or a stored value.
- **Attribution.** A real push writes the pushing member's `user.name`/`user.email` into the clone's local config (when the member has an identity), so commits born in the shared tree from then on carry that member's attribution; commits already made keep their original authors.
- **Links.** For an HTTPS origin with a known mainline branch (`origin/HEAD`), the response carries the compare (`base...branch`) and open-a-pull-request URLs so the pushed line has a human next step.

## Alternatives considered

- **Push with `--force` / auto-delete of doomed refs.** Rejected: the whole point of per-session branches is safe, reviewable publication; a force push or a reset would throw away remote commits from other sessions without a trace.
- **A model-facing tool instead of a GUI RPC.** Rejected for now: the interaction approval service is turn-scoped (it demands an open agent turn and logs its audit pair to that session), so a push requested between turns has no approval surface there. A GUI-confirmed RPC keeps the gate where the member acts; a model-facing tool can layer on later with the same `pushWorkspaceBranch` core.
- **SSH credential as the push transport.** Deferred: the HTTPS token is the single credential kind today; the host-scoped config plumbing is shared, so a future SSH key kind plugs into the same gate.
- **Resolving the remote tip without a fetch.** The `ls-remote` SHA alone cannot feed `git rev-list` or `git merge-base` because the commit object is not local after a divergent update; a conditional fetch (only when the branch exists upstream) makes the counts and the fast-forward gate deterministic.

## Consequences

- A member pushes with one confirmed action: the branch moves, the response names the new remote commit and offers compare/PR links, and the clone is switched back onto the same branch afterward (the push does not change the checkout).
- The shared tree keeps working normally during a push: the fetch only moves remote-tracking refs, so a session's uncommitted edits are never touched.
- Private-host pushes need the operator credential pinned to that host; without it the endpoint refuses loudly (`collab-credential-unavailable`) instead of guessing. The operator contract is unchanged from cloning: one `gitToken`/`gitHost` pair.
- Everything above the gate stays honest about history: no fast-forward, no force, no credential in a URL, no stored secret.
