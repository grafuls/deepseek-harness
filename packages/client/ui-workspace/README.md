# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

Workspace picker plugin. `WorkspacePicker` fills the conversation empty-state hero's `conversation.hero.workspace` slot. The sidebar's `sidebar.workspaces` Workspaces seat is owned by the collab workspaces section (ui-collab) — the local browsing region was removed from the sidebar, so this package registers only the picker; local workspaces stay reachable through it and the New Session flow.

The picker lists real Host Workspace entities through the global `useWorkspaces` hook. Selecting a Workspace invokes the slot owner's `onPick` callback to retarget the frontend Session object. Distinct canonical paths remain separate id-keyed Workspaces when their basenames and display titles match. A menu only appears where there is something to choose between — with no Workspace listed, the anchor gesture raises the add flow directly instead of a one-row popover, and it waits for the list baseline before treating an empty list as final.

The registration declares a **directory-flow child hole** (`single` kind: `conversation.hero.workspace.directoryFlow`) that the composed picker package's client half fills with its picking interaction — the [`-native`](../../host/directory-picker-native/README.md) backend's renderless OS-chooser driver today, an in-app browsing dialog under a `-browse` composition. The `sidebar.workspaces.directoryFlow` hole is the type-only remnant of the removed browsing region: it stays in the shared contract so the picker packages' type chain keeps compiling, but nothing mounts it. The flat **Add workspace...** action renders only while the hero's hole is occupied (occupancy read per menu render; an empty hole means the composition has no picking affordance — the seam's documented no-flow default, under which the picker drops its add button rather than offering a dead one). This package owns the trigger and the adoption: the occupant reports one picked path per open through the hole's owner conversation (`open`/`busy`/`onPicked`/`onCancel`/`onError`), and the owner adopts it through the object layer, selecting the committed Workspace only after its list projection has refreshed; cancellation is silent, and errors land in the retryable folder dialog whose **Choose again** reopens the flow (the retry is disabled once the hole empties mid-conversation, so it cannot open a flow nobody can answer). Adding has exactly one route: the occupant's own create-folder affordance already covers a brand-new directory, so no separate create-by-name dialog exists. The runtime Session and Workspace services own materialization.

The target slot is declared by another plugin, so `apply` uses `slots.inject()` to register for each declaration lifetime and re-register after a declaring slot is restored; its inject names only the `slots`, `workspaces`, and `locale` services it reads.

## Model Experience

None, as the picker is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No sidebar navigation for local workspaces** — the sidebar browsing region was removed; its Workspaces seat shows the collab Workspaces section when a collab surface is ready and is empty otherwise, and local workspaces are reached through this picker and the New Session flow.
- **No session management surface** — the picker lists and adds workspaces but never rows of sessions, so rename, fork, archive, and ordering of sessions have no UI here (they live with the collab section or the host).
- **Native folder selection depends on the local Host carrier** — under the `-native` composition, in-process or remote browser deployments cannot open a local operating-system dialog; platform failures are shown in a retryable modal. Remote-capable picking is the `-browse` composition's in-app flow.
