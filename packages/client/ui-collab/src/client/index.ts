/**
 * Collab workspaces manager, browser half. Owns one shared workspaces store
 * over the Connection RPC channel, and mounts two surfaces: the collab
 * section under the sidebar's Workspaces browsing region and the manager
 * panel in the layout's shell overlay. Both render nothing while the collab
 * surface is absent (a hidden availability verdict), so a single-user web
 * install is unchanged; the collab API gateway's `/api` fence remains the
 * enforcement point.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout and ui-workspace SlotMap augmentations
// (shell.overlay, sidebar.workspaces.collab) into this program; the client
// bundle emits no request for either.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CollabSection } from './CollabSection.tsx'
import { CollabApi } from './contract.ts'
import { CollabWorkspacesController } from './controller.ts'
import { NS, en, zh, type CollabKey } from './locales.ts'
import { createCollabWorkspacesStore } from './store.ts'
import { WorkspacesPanel, type CollabWorkspacesInjected } from './WorkspacesPanel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The collab workspaces section and manager copy. */
    'collab.ui': CollabKey
  }
}

/**
 * Required services (cordis fiber inject): slots for the surfaces, the wire
 * for the collab RPC, the runtime Workspace face for switching into a mounted
 * collab workspace, the locale registry.
 */
export const inject = ['slots', 'connection', 'workspaces', 'locale']

/**
 * Client plugin body: build the collab RPC surface and one shared store, then
 * register the section and panel; probe the surface availability on mount.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const api = new CollabApi(connection.rpc.call.bind(connection.rpc))
  const store = createCollabWorkspacesStore()
  const t = ctx.locale.bind(NS)
  const controller = new CollabWorkspacesController(api, store, ctx.workspaces, t)
  const injected = (): CollabWorkspacesInjected => ({
    hooks: { collabWorkspaces: store },
    actions: {
      openPanel: () => { controller.openPanel() },
      closePanel: () => { controller.closePanel() },
      refresh: () => { void controller.refresh() },
      select: (workspaceId) => { void controller.select(workspaceId) },
      openManager: (workspaceId) => { controller.openManager(workspaceId) },
      openWorkspace: (workspaceId) => { void controller.openWorkspace(workspaceId) },
      create: (name) => { void controller.create(name) },
      invite: (email, role) => { void controller.invite(email, role) },
      revokeInvitation: (invitationId) => { void controller.revokeInvitation(invitationId) },
      acceptInvitation: (invitationId) => { void controller.acceptInvitation(invitationId) },
      setMemberRole: (userId, role) => { void controller.setMemberRole(userId, role) },
      removeMember: (userId) => { void controller.removeMember(userId) },
      deleteSelected: () => { void controller.deleteSelected() },
    },
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-collab: workspaces manager dictionaries')
  ctx.effect(() => {
    void controller.refreshAvailability()
    // Both surfaces share one store handle; each waits on its slot's
    // declaration (sidebar.workspaces.collab from ui-workspace,
    // shell.overlay from ui-layout) so apply order across those owners is
    // unconstrained.
    const disposers = [
      ctx.slots.inject('sidebar.workspaces.collab', () => ctx.slots.register({
        name: 'sidebar.workspaces.collab',
        locale: NS,
        inject: injected,
      }, CollabSection)),
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'collab-workspaces-panel',
        locale: NS,
        inject: injected,
      }, WorkspacesPanel)),
    ]
    return () => { for (const dispose of disposers) { dispose() } }
  }, 'ui-collab: workspaces manager')
}
