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
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout and ui-workspace SlotMap augmentations
// (shell.overlay, sidebar.workspaces.collab) into this program; the client
// bundle emits no request for either.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the settings shell's SlotMap merge and the settingsScope
// Context merge (settings.section, ctx.settingsScope) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CollabSection } from './CollabSection.tsx'
import { CollabSettingsSection, type CollabSettingsInjected } from './CollabSettingsSection.tsx'
import {
  COLLAB_SETTINGS_NAMESPACE,
  CollabSettingsController,
  createCollabSettingsStore,
  decodeCollabSettings,
} from './collab-settings-store.ts'
import { CollabApi } from './contract.ts'
import { CollabWorkspacesController } from './controller.ts'
import { NS, en, zh, type CollabKey } from './locales.ts'
import { createCollabWorkspacesStore } from './store.ts'
import { WorkspacesPanel, type CollabWorkspacesInjected } from './WorkspacesPanel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The collab workspaces section, manager, and settings copy. */
    'collab.ui': CollabKey
  }
}

/**
 * Required services (cordis fiber inject): slots for the surfaces, the wire
 * for the collab RPC, the runtime Workspace face for switching into a mounted
 * collab workspace, the locale registry.
 */
export const inject = ['slots', 'connection', 'workspaces', 'sessions', 'locale']

/**
 * The settings-shell scope binder, read optionally so a composition that
 * omits the settings surface still loads (the section simply never appears).
 */
type SettingsScopeBinder = { bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T> }

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
  const controller = new CollabWorkspacesController(api, store, {
    list: ctx.workspaces.list,
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId as WorkspaceId | undefined) },
    // Reordering a collab session is a Host-account move on the same mount
    // every member resolves to, so the shared runtime Workspace face owns the
    // wire call and its returned snapshot.
    reorderSession: (hostWorkspaceId, sessionId, beforeSessionId) =>
      ctx.workspaces.insertSessionBefore(
        hostWorkspaceId as WorkspaceId,
        sessionId as SessionId,
        beforeSessionId === undefined ? undefined : beforeSessionId as SessionId,
      ),
  }, t)
  const injected = (): CollabWorkspacesInjected => ({
    hooks: { collabWorkspaces: store },
    actions: {
      openPanel: () => { controller.openPanel() },
      closePanel: () => { controller.closePanel() },
      refresh: () => { void controller.refresh() },
      select: (workspaceId) => { void controller.select(workspaceId) },
      openManager: (workspaceId) => { controller.openManager(workspaceId) },
      openWorkspace: (workspaceId) => { void controller.openWorkspace(workspaceId) },
      mountAll: () => { void controller.mountAll() },
      open: (sessionId) => { ctx.sessions.open(sessionId) },
      // Row → session-face hop (same as the browsing region): rename is a
      // per-session verb (ISession), resolved by the list binding; a rejection
      // propagates to the browser's rename dialog.
      renameSession: async (sessionId, title) => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
        const result = await session.rename(title)
        if (!result.ok) throw new Error(result.error.message)
      },
      // Fork failure keeps the current selection (the browsing region's
      // posture): the shared session and its log are unchanged.
      forkSession: (sessionId) => {
        ctx.sessions.fork({ sessionId, increaseTitle: true })
          .then((childId) => { ctx.sessions.open(childId) })
          .catch(() => { /* Fork or child-rename failure keeps the selection. */ })
      },
      archiveSession: (sessionId) => ctx.workspaces.archiveSession(sessionId),
      reorderSession: (hostWorkspaceId, sessionId, beforeSessionId) => {
        void controller.reorderSession(hostWorkspaceId, sessionId, beforeSessionId)
      },
      delete: (workspaceId) => { void controller.delete(workspaceId) },
      setGroupBy: (mode) => { controller.setGroupBy(mode) },
      setOrderBy: (mode) => { controller.setOrderBy(mode) },
      create: (name, repoUrl) => controller.create(name, repoUrl).then(id => id !== undefined),
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
    // Keep the list and the invitations accept surface live: pending invites
    // show up in an already-open page without requiring a reload.
    controller.startAutoRefresh()
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
    return () => {
      controller.stopAutoRefresh()
      for (const dispose of disposers) { dispose() }
    }
  }, 'ui-collab: workspaces manager')
  ctx.effect(() => {
    // The settings section is optional: it registers only after the settings
    // shell declares `settings.section` (which implies the settingsScope
    // provider is active), so a composition without the settings surface never
    // stages it. The scope binding tears the section's subscription down with
    // this fiber.
    const scopeBinding = ctx.get('settingsScope', false) as SettingsScopeBinder | undefined
    if (scopeBinding === undefined) return () => {}
    const scope = scopeBinding.bind({ namespace: COLLAB_SETTINGS_NAMESPACE, decode: decodeCollabSettings })
    const settingsStore = createCollabSettingsStore()
    const settingsController = new CollabSettingsController(scope, settingsStore)
    const settingsInjected = (): CollabSettingsInjected => ({
      controller: settingsController,
      hooks: { collabSettings: settingsStore },
    })
    const disposer = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'collab',
      order: 20,
      label: () => t('settingsNav'),
      locale: NS,
      inject: settingsInjected,
    }, CollabSettingsSection))
    return () => {
      disposer()
      settingsController.disconnect()
    }
  }, 'ui-collab: collab settings section')
}
