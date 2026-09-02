/**
 * ui-workspace contracts. One registration shares this package:
 *
 * - WorkspacePicker fills the conversation empty-state hole (menu + error
 *   dialog). The sidebar's `sidebar.workspaces` Workspaces seat is no longer
 *   this package's: the collab workspaces section (ui-collab) owns it, and the
 *   local browsing region was removed from the sidebar.
 *
 * The picker registration declares one **directory-flow hole** (`single`
 * kind): the slot a composed picker package's client half fills with its
 * picking interaction — a renderless native-chooser driver or an in-app
 * browsing dialog. ui-workspace owns the trigger (the "Add workspace…"
 * entry, present only while the hole is occupied) and the adoption
 * semantics (`createWorkspace({ path })`, the retryable error dialog,
 * Choose again); the occupant owns everything between `open` and the picked path,
 * including creating a new directory to hand back. That occupant-owned
 * creation is why adding a workspace has a single route: an unoccupied hole
 * leaves the surface with no add affordance at all.
 * The `sidebar.workspaces.directoryFlow` hole belonged to the retired sidebar
 * browsing region: it stays declared for the picker packages' shared type
 * chain, and its occupant never renders because nothing mounts that hole
 * anymore (the sidebar shows the collab Workspaces section).
 */
import type { HostObservable, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the owner SlotMap merges into programs that resolve the
// runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Owner share of the directory-flow holes: the complete conversation between
 * the trigger surface and the picking interaction. The occupant reads `open`
 * to run/render its interaction and reports exactly one outcome per open.
 */
export interface DirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner shows its error surface. */
  onError: (message: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). */
    'conversation.hero.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /** Directory-flow slot of the retired sidebar browsing region (type-only: kept for the picker packages' shared chain; nothing mounts it). */
    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
}

/** The two directory-flow holes; a flow package's client half registers its one component into both. */
export type DirectoryFlowSlotName =
  | 'conversation.hero.workspace.directoryFlow'
  | 'sidebar.workspaces.directoryFlow'

/**
 * Directory-picking share both trigger surfaces consume. Occupancy rides the
 * inject face's reserved `hooks` compartment: the renderer binds the source
 * into the `useDirectoryFlow` selector hook, so an empty hole hides the
 * "Add workspace…" entry reactively and the surface withdraws an open
 * flow whose occupant unloaded mid-interaction (nobody is left to cancel).
 */
export type DirectoryPickingInjected = {
  hooks: {
    /** True while this surface's directory-flow hole is occupied. */
    directoryFlow: HostObservable<boolean>
  }
}

/** Component-side view of the picking share: the bound occupancy selector hook. */
export type DirectoryPickingHooks = PropsHooks<DirectoryPickingInjected['hooks']>

/**
 * Picker-private injected share. Pick semantics remain in the owner's onPick
 * callback; this callback creates only the real Host Workspace. A type alias
 * supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = DirectoryPickingInjected & {
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/**
 * Full picker props: the owner share plus the creation callback and the
 * locale seat. The picker hole (blank-session hero / New-Session view)
 * carries one owner currency, so one composed type serves the registration.
 */
export type WorkspacePickerProps =
  PropsRuntime<'conversation.hero.workspace'>
  & PropsRenderSlots<'conversation.hero.workspace.directoryFlow'>
  & Omit<WorkspacePickerInjected, 'hooks'>
  & DirectoryPickingHooks
  & PropsLocale<'workspace'>
