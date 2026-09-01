# Agent Note: collab repository-backed workspaces

Status: implemented

English | [中文](2026-08-29-collab-repo-backed-workspaces.zh.md)

Superseded in part by [collab async repository provisioning](2026-09-01-collab-async-repo-provisioning.md): the clone now runs in the background with an auto-removing provisioning record, and `collab-clone-failed` is no longer an answer.

## Problem

Creating a collaborative workspace produced a name-only workspace whose data directory was materialized empty under the collab data root. There was no way to start a workspace from an existing repository: members had to create an empty workspace, then bring their own code in by hand. The requested flow was the opposite: type a GitHub repository URL at creation, have that repository cloned into a local directory, and use the clone as the workspace — plus a settings entry on the Collaborative Workspaces settings page for the default directory those clones land in.

## Decision

`collab/workspace.create` accepts an optional `repoUrl` (omitted or empty string means a name-only workspace). A non-empty URL makes the collab API gateway clone the repository and register the clone as the workspace's data:

- The clone runs through a collab-local no-shell `git clone` runner (`gitCloneRunner`, spawned with no stdin and `GIT_TERMINAL_PROMPT=0`) with a ten-minute timeout, so no shell interpolation reaches the process boundary and a repository the user cannot access fails fast with git's stderr instead of hanging on an interactive credential prompt.
- The clone target is `<cloneRoot>/<repoName>-<workspaceId>` where `<workspaceId>` is the generated workspace id and `<repoName>` is the repository name sanitized to a filesystem-safe component, so an administrator can recognize which repository a clone roots at. `<cloneRoot>` is the `cloneDir` value of the `collab` settings namespace when set, otherwise the collab data root's `workspaces` directory.
- The namespace is mounted by the collab API through `installSettingsSection`, so the Collaborative Workspaces settings page (a `settings.section` entry in ui-collab, the `collab` namespace) writes it, and `cloneDir` in the gateway's `Config` only seeds the composition default before the user overrides it.
- A failed clone removes the partial target directory and answers `collab-clone-failed`; no workspace record is created, so a failed repository bootstrap leaves nothing behind.
- `collab/workspace.open` and `collab/workspace.dir` resolve a repo-backed record's working directory to `record.clonePath`, so every member shares the cloned working tree as the mounted workspace's data. The clone path is stored on the record rather than re-derived, so later changes to `cloneDir` do not relocate or orphan existing workspaces.
- The access gate consults the workspaces service's `workspaceHolding(path)` relationship (the first record whose canonical clone path contains the path), which covers clones outside the data root; paths under the data root's `workspaces` prefix remain covered by the existing prefix check.
- A private repository clones only when the operator configures a server git credential (`gitToken`, with `gitHost` defaulting to `github.com` and `gitUsername` defaulting to `x-access-token`). The credential is plugin config only — deliberately never routed through the settings namespace the GUI reads back — and the clone sends it to its pinned host through a temporary `GIT_CONFIG_GLOBAL` carrying a host-scoped `Authorization` header that exists for the clone and is removed on every path, so the token never reaches argv, the workspace record, the clone's own config, or the wire diagnostics.

## Alternatives considered

- **Client-chosen directory.** The "pick a directory" model the request replaced — the browser names a host path. Rejected: the collab process runs as one server for many users; a member-chosen host path is an unsanctioned filesystem grant and stale across users. A repository URL is server-executed and uniform, so membership gating stays meaningful.
- **Empty workspace plus a later "clone into it" verb.** Rejected: it leaves a pending half-initialized workspace and needs a second authority for who may write the clone; making the clone part of creation keeps registration and materialization atomic, so the record never points at a missing directory.
- **Deriving the clone path from the current setting.** Rejected: moving the default clone directory would orphan every repo-backed workspace; storing `clonePath` on the record keeps access scoping and mounting stable regardless of later settings edits.

## Consequences

- Creating from a URL is now a one-step flow with an explicit, localized failure banner if the clone fails; the create affordance (shared by the empty state and the sidebar section) pops up a creation modal with the workspace name and optional repository URL fields. While a create request is in flight the modal stays open showing `Creating…` and re-enables on the outcome, closing on success and remaining open with the banner on failure — it never closes silently while the clone is still running.
- The new settings section is optional: ui-collab registers it only once the settings surface is present (it reads `settingsScope` optionally), so a single-user `web` profile that omits the settings surface is unchanged.
- Repository-backed and data-dir workspaces now differ in where their data lives; delete still removes only the registry record, deliberately leaving the clone (or data) directory on disk.
- The clone contract and its access gate stay server-owned; the URL in the UI is a convenience, not an enforcement point.
- A private-repository clone fails fast with git's stderr until the operator configures the server credential, then clones through basic auth; public repositories still clone unauthenticated, and a host the credential does not own never receives it, so a member pointing at a hostile URL cannot exfiltrate the server token.
- Surfacing the create failure exposed a latent theme defect: the dark theme's error aliases mapped both the banner text (`state-error-primary`) and its backdrop (`state-error-secondary`) to `red-400`, so any error banner read as empty. The dark theme now backs error banners with the deep `red-900` so the `red-400` text is legible; the modal also renders a generic message when the store error is absent rather than an empty box.
- The invitation accept surface is kept live without a reload: opening the manager panel refreshes the workspace list and the signed-in user's pending invitations, and while the collab surface is mounted the controller re-reads both on a thirty-second interval (skipping while a mutation or the availability probe is in flight), so an invitation sent after page load appears on its own.
