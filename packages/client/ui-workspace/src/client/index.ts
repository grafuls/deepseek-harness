/**
 * Workspace plugin, browser half. One registration: WorkspacePicker fills the
 * conversation hero's picker hole (`conversation.hero.workspace` — both hero
 * forms), reading real Host Workspaces through the global useWorkspaces hook
 * and declaring its own `single` directory-flow child hole for the composed
 * picker package's client half (see the contract module doc). The sidebar's
 * `sidebar.workspaces` Workspaces seat is owned by the collab workspaces
 * section (ui-collab) — the local browsing region was removed from the
 * sidebar; local workspaces stay reachable through this picker and the New
 * Session flow. Export discipline: packages/client/AGENTS.md.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspacePickerInjected } from './contract/slots.ts'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'

export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workspace pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * the ui-conversation apply, whose activation order relative to this one is
 * NOT constrained: dsh.client.inject edges are informational (loading/prefetch
 * metadata, never apply sequencing) and neither owner provides a waitable
 * service. apply therefore depends on the slot declaration through
 * `slots.inject()` instead of assuming order.
 */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Register the picker once its slot declaration is on the ledger. Inject
 * factories return plain callbacks; data reads use the framework's global
 * hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')

  // Stable per-surface occupancy source (the renderer's hook cache keys by
  // source identity): true while the picker's directory-flow hole is filled.
  const flowSource = (hole: 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => ctx.workspaces.create(input),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // The registration declares its directory-flow child in the same call;
  // slot injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
}
