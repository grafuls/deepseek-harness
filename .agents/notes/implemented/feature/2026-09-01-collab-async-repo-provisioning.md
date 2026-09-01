# Agent Note: collab async repository provisioning

Status: implemented

English | [中文](2026-09-01-collab-async-repo-provisioning.zh.md)

## Problem

A repository-backed collab workspace ran its `git clone` synchronously inside the browser's HTTP create request. On a remote deployment the request was long-lived enough that a reverse proxy or NAT idle timeout cut the connection, so the browser saw a transport failure and surfaced `errorUnreachable` ("Could not reach the server") even though the server was healthy and the (public) repository cloned fine in isolation. Name-only creates worked because they are fast; repo-URL creates "waited, then failed". The failure was the transport, not the clone: the repo was public and `git ls-remote` succeeded from the server, ruling out credentials.

## Decision

`collab/workspace.create` for a repository URL now registers a provisioning workspace and answers immediately; the clone runs as a fire-and-forget background job on the collab gateway. The registry and API surface the lifecycle explicitly:

- `WorkspaceSummary`/`CollabWorkspaceView` carry a required `cloneState: 'none' | 'cloning' | 'ready'`. A repo-bootstrapped record starts `cloning` (`repoUrl` set, `clonePath` undefined) and flips to `ready` once the background job records the clone path.
- New `settleClone(workspaceId, outcome)` on the workspaces service settles a job: `{ kind: 'cloned', clonePath }` persists the path and returns `'added'` (idempotent), `{ kind: 'failed' }` removes the provisioning record and returns `'removed'`, and a record that is already settled or gone returns `'absent'` so the caller can `rm` an orphaned target. The clone job folds a clone failure into the `failed` outcome rather than throwing, so a failed bootstrap auto-removes the record — no failed-state record, no `collab-clone-failed` on the wire, no failed-state UI. The job logs the git error at warn before settling: the operator is the only audience the no-failed-state contract leaves, and the log line is how a vanished workspace gets a cause.
- The server creates the clone root (`cloneDir` or the default collab-layout `workspaces` directory) recursively at create time, because `git clone` creates only the leaf target. A configured directory that cannot be created answers `collab-bad-request` at create — misconfiguration fails loud at the earliest resolvable point instead of removing a workspace after a doomed clone.
- `collab/workspace.open` and `collab/workspace.dir` refuse an unsettled record with `collab-clone-pending`, and the client folds that code to a localized "workspace is still cloning" banner; list rows and the sidebar show a `Cloning…` badge and the sidebar disables New Session while `cloning`.
- The clone job owns one `AbortController`: the fire-and-forget chain awaits nothing on the fiber, so a slow transfer never blocks a request or plugin teardown, and a plain disposer aborts the in-flight clone when the gateway tears down (`cloneRepository` merges the job signal with its internal ten-minute timeout via `AbortSignal.any`, so an aborted clone settles promptly).
- Rationale from the incident stands: `collab-clone-failed` was removed from the `RpcError` code set; the create endpoint no longer answers a clone failure at all.

A provisioning record can survive only a gateway restart mid-clone (the disposer cannot abort past a dead process); the creating user can delete it. This is documented under Known Limitations.

## Alternatives considered

- **Longer timeout / configurable timeout.** Rejected: the cut is the proxy's idle timeout, which the harness cannot raise, so keeping the clone out of the request is the only durable fix.
- **Failed state surfaced in the UI (record + `collab-clone-failed` banner).** Discussed with the user, who chose silent auto-remove: a stale failed row is worse than none, and the transport symptom this replaces gave no actionable cause anyway.
- **Keeping credentials plumbing.** Kept: a genuinely private repo still needs a server git credential, unchanged from the credential feature; it is orthogonal to and unaffected by the async flow.

## Consequences

Create is now O(request-latency) for every workspace; slow clones degrade only the workspace's own readiness. `cloneState` is a required wire + client field on every view literal. The auto-remove contract means the API intentionally has no clone-failure wire or UI diagnostic; the git error surfaces server-side at warn, and a clone root that cannot be created fails the create itself with `collab-bad-request`. Tests must await background settlement (polling the fake cloner and the list state) instead of asserting a synchronous failure.

The synchronous-clone and `collab-clone-failed` behavior of the [original repo-backed proposal](2026-08-29-collab-repo-backed-workspaces.md) is superseded by this note.
