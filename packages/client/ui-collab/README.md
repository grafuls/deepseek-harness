# @deepseek-ai/dsh-client-ui-collab

English | [中文](README.zh.md)

The collab workspaces manager for the Web GUI. This browser plugin lists the workspaces the signed-in user belongs to, creates new ones, and — for the selected workspace — shows its members and invitations, sends invitations, changes member roles, removes members, and deletes it. The sign-in gate itself is [dsh-client-ui-auth](../ui-auth/README.md), which this package composes after: ui-collab only renders once a collab session cookie authorizes the browser.

The plugin registers two entries, both composed out through slot declarators rather than mounted unconditionally: a `sidebar.footer.action` trigger that opens the manager, and a `shell.overlay` panel that renders the list and detail. Apply order against the slot owners (ui-sidebar, ui-layout) is unconstrained; each registration waits on its own declaration with `slots.inject`. Both entries share one store handle created inside `apply`, so opening the manager on the trigger and driving it from the panel read the same state.

## What it mounts

- Node half (`src/index.ts`): inert — the package is entirely browser-side.
- Browser half (`src/client/`): an `apply` that creates the workspaces store and a controller over the collab RPC channel, then registers the two slot entries. The store hook reaches components as the `useCollabWorkspaces` inject hook; the actions (open, close, refresh, select, create, invite, revoke, set role, remove, delete) are passed through the inject face.

## The collab surface contract

The manager talks only through the shared `/api` connection RPC envelope (`collab/workspace.*`, `collab/auth.status`), the same channel the rest of the GUI uses, so it rides the session cookie and needs no localStorage. The availability probe folds every failure — no collab surface mounted, no session cookie, transport error — to `hidden`, and both surfaces render nothing then: a single-user `web` install and an unsigned browser see an unchanged app. The workspace role comes from the wire (`workspace.role`); UI gating of admin actions is presentation only, and the collab API gateway's `requireWorkspaceAndRole` remains the enforcement point.

## Model Experience

None, as this is a presentation-only workspaces manager; the workspace scoping it reflects is enforced server-side by the collab API gateway, which owns any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **Hidden rather than explanatory when unauthorized** — while the browser holds no collab session (or no collab surface is mounted), the trigger and panel simply do not render; there is no banner explaining why. The ui-auth gate is what answers that question on a collab instance.
- **No active-workspace switching** — the collab model scopes per-workspace data to directories, but this manager does not switch the GUI into a workspace; there is no RPC for that yet, and the workspace detail here is limited to members and invitations.
- **One shared instance plane** — workspaces share the single browser session cookie; a workspace does not host its own login or its own set of sessions.
