# Agent Note: Collab clone directories scope to their workspace id

Status: implemented

English | [中文](2026-09-07-collab-clone-layout-membership-scoping.zh.md)

## Problem

The [host-plane membership gate](2026-08-28-collab-host-plane-membership-scoping.md) resolves a Host-plane path to a collab workspace id before checking membership, then scopes the path to that workspace's members. Its resolver parsed the `<collabRoot>/workspaces/` layout first and only consulted the workspace records for a clone directory outside that layout. When no clone directory is configured, a repo-backed workspace clones at `<collabRoot>/workspaces/<repo>-<workspaceId>`, so the resolver returned the directory name `<repo>-<workspaceId>` as the id — which matches no membership. Every member, including the owner, was refused `session.create` on such a workspace with `workspace-forbidden`.

## Decision

Resolve the path through the workspace records before the layout parser. A workspace record names its clone directory, so a clone anywhere — inside the workspaces layout or under a configured clone root — owns the path under the true workspace id, and the issuer scope is enforced by membership on that id. A record-less layout path (a name-only workspace's `<collabRoot>/workspaces/<workspaceId>` directory) then parses its id from the directory name, unchanged.

## Alternatives considered

### Recognize the `<repo>-<workspaceId>` directory name as the id

Rejected: the directory name is not the workspace id, so a layout-first parse returns a value that no membership key matches; mapping the name back to the id would add a parsing rule the records already own.

### Record every clone path as an explicit membership alias

Rejected: it duplicates the `clonePath` the workspace record already owns and adds a second source of truth to keep in sync; consulting the records is the single source and needs no new durable state.

## Consequences

Members — including workspace `developer`-role users and the owner — can create sessions in a repo-backed collab workspace, matching the membership-only scoping the gate already applies to name-only workspaces. The name-only layout path and the clone-outside-layout path behave exactly as before. Only a clone inside the workspaces layout (the default when no clone directory is set) changes, from denied-for-all to member-scoped. The gate still denies a non-member, and a non-collab (Host-owned) path stays allowed for every authenticated principal.
