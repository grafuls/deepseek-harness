/**
 * Collab workspaces manager, browser half. Owns one shared workspaces store
 * over the Connection RPC channel, and mounts two surfaces: a foot action in
 * the sidebar and the manager panel in the layout's shell overlay. Both
 * render nothing while the collab surface is absent (a hidden availability
 * verdict), so a single-user web install is unchanged; the collab API
 * gateway's `/api` fence remains the enforcement point.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout and ui-sidebar SlotMap augmentations
// (shell.overlay, sidebar.footer.action) into this program; the client bundle
// emits no request for either.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CollabApi } from './contract.ts'
import { CollabWorkspacesController } from './controller.ts'
import { createCollabWorkspacesStore } from './store.ts'
import { WorkspacesPanel, type CollabWorkspacesInjected } from './WorkspacesPanel.tsx'
import { WorkspacesTrigger } from './WorkspacesTrigger.tsx'

/** Required services (cordis fiber inject): slots for the surfaces, the wire for the collab RPC. */
export const inject = ['slots', 'connection']

/**
 * Client plugin body: build the collab RPC surface and one shared store, then
 * register the trigger and panel; probe the surface availability on mount.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const api = new CollabApi(connection.rpc.call.bind(connection.rpc))
  const store = createCollabWorkspacesStore()
  const controller = new CollabWorkspacesController(api, store)
  const injected = (): CollabWorkspacesInjected => ({
    hooks: { collabWorkspaces: store },
    actions: {
      openPanel: () => { controller.openPanel() },
      closePanel: () => { controller.closePanel() },
      refresh: () => { void controller.refresh() },
      select: (workspaceId) => { void controller.select(workspaceId) },
      create: (name) => { void controller.create(name) },
      invite: (email, role) => { void controller.invite(email, role) },
      revokeInvitation: (invitationId) => { void controller.revokeInvitation(invitationId) },
      setMemberRole: (userId, role) => { void controller.setMemberRole(userId, role) },
      removeMember: (userId) => { void controller.removeMember(userId) },
      deleteSelected: () => { void controller.deleteSelected() },
    },
  })
  ctx.effect(() => {
    void controller.refreshAvailability()
    // Both surfaces share one store handle; each waits on its slot's
    // declaration (sidebar.footer.action from ui-sidebar, shell.overlay from
    // ui-layout) so apply order across those owners is unconstrained.
    const disposers = [
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'collab-workspaces-trigger',
        inject: injected,
      }, WorkspacesTrigger)),
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'collab-workspaces-panel',
        inject: injected,
      }, WorkspacesPanel)),
    ]
    return () => { for (const dispose of disposers) { dispose() } }
  }, 'ui-collab: workspaces manager')
}
