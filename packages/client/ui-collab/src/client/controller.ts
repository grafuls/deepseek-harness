/**
 * Collab workspaces controller, browser half. Owns the async orchestration
 * over the {@link CollabApi} and the shared workspaces store: availability
 * probing, list/detail loads, and every mutation, folding server wire codes
 * into the store's user-facing error banner. Built by the plugin body; the
 * inject face exposes plain callback members over it.
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CollabError, type CollabApi, type CollabPushView, type CollabRole } from './contract.ts'
import type { CollabGroupBy, CollabOrderBy, CollabWorkspacesState } from './store.ts'

/** The runtime Workspace face the opener switches into a mounted collab workspace. */
export interface WorkspacePort {
  /** The live Host Workspace list snapshot store (client projection). */
  list: {
    getSnapshot(): {
      items: readonly { workspaceId: string; collab?: { workspaceId: string } }[]
    }
    subscribe(listener: () => void): () => void
  }
  /** The shared New Session action: connect the target Workspace and open it. */
  startSession(workspaceId?: string): void
  /**
   * Move one accounted session within its collab workspace's shared manual
   * order (the browsing region's workspace-session drag, ported to the Host
   * account the collab workspaces resolve to).
   * @param hostWorkspaceId - the Host workspace the collab workspace resolves to.
   * @param sessionId - the accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   */
  reorderSession(hostWorkspaceId: string, sessionId: string, beforeSessionId?: string): Promise<unknown>
}

/**
 * Drives the collab workspaces store: every async transition funnels through
 * this owner so the store stays a plain snapshot source and the RPC surface
 * stays behind one seam.
 */
export class CollabWorkspacesController {
  /**
   * Create the controller.
   * @param api - the collab RPC surface.
   * @param store - the shared workspaces snapshot store.
   * @param workspaces - the runtime Workspace face, used to switch the GUI
   *   into a mounted collab workspace.
   * @param t - the `collab.ui` namespace translate, so error banners and
   *   validation copy follow the GUI's active language.
   */
  constructor(
    private readonly api: CollabApi,
    private readonly store: SnapshotStore<CollabWorkspacesState>,
    private readonly workspaces: WorkspacePort,
    private readonly t: TranslateNS<'collab.ui'>,
  ) {}

  /** Join a wire code with the muted, locale-seated banner. */
  private foldWireError(error: unknown): string {
    if (error instanceof CollabError) {
      switch (error.code) {
        case 'collab-forbidden': return this.t('errorForbidden')
        case 'collab-not-found': return this.t('errorNotFound')
        case 'collab-bad-request': return this.t('errorBadRequest')
        case 'collab-clone-pending': return this.t('errorClonePending')
        default: return this.t('errorFailed')
      }
    }
    return this.t('errorUnreachable')
  }


  /**
   * Move one accounted session within its collab workspace's Host account.
   * The order is shared and server-owned, so this mirrors the browsing
   * region's workspace drag: the move lands on the Host and the
   * `workspace-changed` echo reaches every member. A rejected move is a
   * browsing nicety — the runtime keeps the authoritative order and the next
   * echo reconciles — so failures are dropped rather than surfaced as a
   * blocking banner.
   * @param hostWorkspaceId - the Host workspace the collab workspace resolves to.
   * @param sessionId - the accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   */
  async reorderSession(hostWorkspaceId: string, sessionId: string, beforeSessionId?: string): Promise<void> {
    try {
      await this.workspaces.reorderSession(hostWorkspaceId, sessionId, beforeSessionId)
    } catch (error) {
      console.warn('collab session reorder rejected:', error)
    }
  }

  /**
   * Open the panel and refresh the workspace list and pending invitations, so
   * the manager never shows an accept surface or list stale since page load.
   * @returns the new open state.
   */
  openPanel(): void {
    this.store.set({ ...this.store.getSnapshot(), open: true })
    void this.refresh()
  }

  /**
   * Open the panel onto one workspace's detail.
   * @param workspaceId - the workspace to load into the manager.
   */
  openManager(workspaceId: string): void {
    this.openPanel()
    void this.select(workspaceId)
  }

  /**
   * Mount a collab workspace as a real Host workspace and, once the runtime's
   * Workspace list reflects it, switch the GUI into it (open a Session in
   * that workspace). The mount is member-gated and path-stable, so every
   * member opens the same Host workspace; sessions born inside it are shared
   * and scoped to the collab data directory. A late list echo skips only the
   * navigation, never the mount.
   * @param workspaceId - the collab workspace to open.
   * @returns whether the workspace mounted (navigation is best-effort).
   */
  async openWorkspace(workspaceId: string): Promise<boolean> {
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const mounted = await this.api.open(workspaceId)
      if (await this.awaitWorkspaceListed(mounted.workspace.workspaceId)) {
        this.workspaces.startSession(mounted.workspace.workspaceId)
      }
      this.store.set({ ...this.store.getSnapshot(), working: false })
      return true
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return false
    }
  }

  /**
   * Mount every collab workspace the runtime does not already reflect, without
   * switching the GUI (background materialization for the section's session
   * browsing). The collab `open` is path-idempotent, so repeated runs only
   * resolve the already-mounted records; a workspace whose mount fails keeps
   * going and surfaces that error where the manager would show it.
   */
  async mountAll(): Promise<void> {
    const mountedCollabIds = new Set(
      this.workspaces.list.getSnapshot().items
        .map(item => item.collab?.workspaceId)
        .filter((id): id is string => id !== undefined),
    )
    for (const workspace of this.store.getSnapshot().workspaces) {
      if (mountedCollabIds.has(workspace.id)) continue
      try {
        await this.api.open(workspace.id)
      } catch (error) {
        this.store.set({ ...this.store.getSnapshot(), error: this.foldWireError(error) })
      }
    }
  }

  /**
   * Wait (bounded) for the runtime's Host Workspace list to include the
   * mounted workspace id, so the switch navigates into a listing the GUI
   * already knows. Single-threaded settle: the success path clears the timer
   * and removes the listener, the timeout path removes the listener, so
   * `finish` runs exactly once per wait.
   * @param hostWorkspaceId - the Host workspace id just mounted.
   * @returns true when the workspace appeared within the bound.
   */
  private awaitWorkspaceListed(
    hostWorkspaceId: string,
    timeoutMs = 1500,
  ): Promise<boolean> {
    const list = this.workspaces.list
    if (list.getSnapshot().items.some(item => item.workspaceId === hostWorkspaceId)) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      // `finish` runs only after both `timer` and `dispose` exist: the timer is
      // 1500ms out and the listener body runs on a later notify.
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        dispose()
        resolve(value)
      }
      const timer = setTimeout(() => { finish(false) }, timeoutMs)
      const dispose = list.subscribe(() => {
        if (list.getSnapshot().items.some(item => item.workspaceId === hostWorkspaceId)) {
          finish(true)
        }
      })
    })
  }

  /**
   * Close the panel.
   * @returns the new open state.
   */
  closePanel(): void {
    this.store.set({ ...this.store.getSnapshot(), open: false, error: undefined })
  }

  /**
   * Set the collab list grouping mode (view options), mirroring the local
   * Workspaces browser: workspace rows (folder chrome) or one flat list.
   * @param mode - the grouping mode to apply.
   */
  setGroupBy(mode: CollabGroupBy): void {
    this.store.set({ ...this.store.getSnapshot(), groupBy: mode })
  }

  /**
   * Set the collab list order mode (view options), mirroring the local
   * Workspaces browser: the server list order or creation recency.
   * @param mode - the order mode to apply.
   */
  setOrderBy(mode: CollabOrderBy): void {
    this.store.set({ ...this.store.getSnapshot(), orderBy: mode })
  }

  /** Disposers for the running auto-refresh interval, absent while idle. */
  private autoRefresh: (() => void) | undefined

  /**
   * Start refreshing the workspace list and pending invitations on an
   * interval, so invitations addressed to this user appear in an already-open
   * page without a reload (the accept surface would otherwise be a
   * per-page-load snapshot). Ticks skip while the collab surface is not ready
   * or a mutation is in flight. Idempotent; paired with {@link stopAutoRefresh}.
   * @param intervalMs - the refresh period in milliseconds.
   */
  startAutoRefresh(intervalMs = 30_000): void {
    if (this.autoRefresh !== undefined) return
    const timer = setInterval(() => {
      const state = this.store.getSnapshot()
      if (state.availability === 'ready' && !state.working) void this.refresh()
    }, intervalMs)
    this.autoRefresh = () => { clearInterval(timer) }
  }

  /**
   * Stop the auto-refresh interval, if one is running.
   */
  stopAutoRefresh(): void {
    this.autoRefresh?.()
    this.autoRefresh = undefined
  }

  /**
   * Probe the collab surface once and, when ready, load the member
   * workspace list. Never rejects: a refused or missing surface simply hides
   * the panel.
   * @returns the availability verdict that was reached.
   */
  async refreshAvailability(): Promise<CollabWorkspacesState['availability']> {
    const availability = await this.api.availability()
    const current = this.store.getSnapshot()
    this.store.set({ ...current, availability })
    if (availability === 'ready') {
      await this.refresh()
    }
    return availability
  }

  /**
   * Reload the member workspace list and the invitations addressed to this
   * browser's user, keeping a still-present selection's detail when one is
   * selected.
   * @returns the loaded workspace list.
   */
  async refresh(): Promise<CollabWorkspacesState['workspaces']> {
    const [workspaces, invitationsForMe] = await Promise.all([
      this.api.listWorkspaces(),
      this.api.myInvitations(),
    ])
    const current = this.store.getSnapshot()
    const selectedId = current.selectedId !== undefined
      && workspaces.some(workspace => workspace.id === current.selectedId)
      ? current.selectedId
      : undefined
    this.store.set({
      ...current,
      workspaces,
      invitationsForMe,
      selectedId,
      myRole: selectedId === undefined
        ? undefined
        : (workspaces.find(workspace => workspace.id === selectedId)?.role),
      members: selectedId === current.selectedId ? current.members : [],
      invitations: selectedId === current.selectedId ? current.invitations : [],
    })
    return workspaces
  }

  /**
   * Accept a pending invitation addressed to this browser's user, then reload
   * the list and open the joined workspace's detail.
   * @param invitationId - the invitation to consume.
   * @returns the joined workspace view, or undefined on failure.
   */
  async acceptInvitation(invitationId: string): Promise<CollabWorkspacesState['workspaces'][number] | undefined> {
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const joined = await this.api.join(invitationId)
      await this.refresh()
      await this.select(joined.id)
      return joined
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return undefined
    }
  }

  /**
   * Select a workspace and load its members and invitations.
   * @param workspaceId - the workspace to open, or undefined to clear.
   * @returns the new selection id.
   */
  async select(workspaceId: string | undefined): Promise<string | undefined> {
    const current = this.store.getSnapshot()
    if (workspaceId === undefined) {
      this.store.set({ ...current, selectedId: undefined, myRole: undefined, members: [], invitations: [] })
      return undefined
    }
    const role = current.workspaces.find(workspace => workspace.id === workspaceId)?.role
    this.store.set({ ...current, selectedId: workspaceId, myRole: role })
    await this.loadDetail(workspaceId)
    return workspaceId
  }

  /**
   * Load the members and invitations of one workspace into the store.
   * @param workspaceId - the workspace whose detail to load.
   */
  private async loadDetail(workspaceId: string): Promise<void> {
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const [members, invitations] = await Promise.all([
        this.api.members(workspaceId),
        this.api.invitations(workspaceId),
      ])
      this.store.set({ ...this.store.getSnapshot(), members, invitations, working: false })
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
    }
  }

  /**
   * Create a workspace and select it. An optional repository URL bootstraps
   * the workspace from a clone the server materializes.
   * @param name - the workspace display name.
   * @param repoUrl - git repository URL to clone as the workspace; omit for a name-only workspace.
   * @returns the created workspace id.
   */
  async create(name: string, repoUrl?: string): Promise<string | undefined> {
    const trimmed = name.trim()
    if (trimmed === '') {
      this.store.set({ ...this.store.getSnapshot(), error: this.t('errorNameRequired') })
      return undefined
    }
    const cleanedRepoUrl = repoUrl?.trim()
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const created = await this.api.createWorkspace(trimmed, cleanedRepoUrl === '' ? undefined : cleanedRepoUrl)
      const current = this.store.getSnapshot()
      this.store.set({ ...current, working: false, workspaces: [created, ...current.workspaces] })
      await this.select(created.id)
      return created.id
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return undefined
    }
  }

  /**
   * Rename a collab workspace by id (the section row's dialog). The host owns
   * the authorization fence; on success the shared list is patched with the
   * renamed view so every surface re-labels in place. Unlike the banner-driven
   * mutations, a failure PROPAGATES (the dialog keeps its error open) and
   * leaves the store banner quiet — the dialog owns the failure copy.
   * @param workspaceId - the collab workspace to rename.
   * @param name - the new display name.
   * @returns the renamed workspace view.
   * @throws when the host rejects the rename.
   */
  async renameWorkspace(workspaceId: string, name: string): Promise<CollabWorkspacesState['workspaces'][number]> {
    const renamed = await this.api.renameWorkspace(workspaceId, name)
    const current = this.store.getSnapshot()
    this.store.set({
      ...current,
      workspaces: current.workspaces.map(workspace => workspace.id === workspaceId ? renamed : workspace),
    })
    return renamed
  }

  /**
   * Invite a user by email to the selected workspace.
   * @param email - the invitee's email.
   * @param role - the role the invite grants.
   * @returns the created invitation, or undefined on failure.
   */
  async invite(email: string, role: CollabRole): Promise<CollabWorkspacesState['invitations'][number] | undefined> {
    const selectedId = this.store.getSnapshot().selectedId
    if (selectedId === undefined) return undefined
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const invitation = await this.api.invite(selectedId, email, role)
      const current = this.store.getSnapshot()
      this.store.set({ ...current, working: false, invitations: [...current.invitations, invitation] })
      return invitation
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return undefined
    }
  }

  /**
   * Revoke one pending invitation of the selected workspace.
   * @param invitationId - the invitation to revoke.
   * @returns the revoked invitation, or undefined on failure.
   */
  async revokeInvitation(invitationId: string): Promise<CollabWorkspacesState['invitations'][number] | undefined> {
    const selectedId = this.store.getSnapshot().selectedId
    if (selectedId === undefined) return undefined
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const revoked = await this.api.revokeInvitation(selectedId, invitationId)
      const current = this.store.getSnapshot()
      this.store.set({
        ...current,
        working: false,
        invitations: current.invitations.map(invitation => invitation.id === invitationId ? revoked : invitation),
      })
      return revoked
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return undefined
    }
  }

  /**
   * Change a member's role in the selected workspace.
   * @param userId - the target member.
   * @param role - the role to assign.
   * @returns the updated membership, or undefined on failure.
   */
  async setMemberRole(userId: string, role: CollabRole): Promise<CollabWorkspacesState['members'][number] | undefined> {
    const selectedId = this.store.getSnapshot().selectedId
    if (selectedId === undefined) return undefined
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const member = await this.api.setMemberRole(selectedId, userId, role)
      const current = this.store.getSnapshot()
      this.store.set({
        ...current,
        working: false,
        members: current.members.map(entry => entry.userId === userId ? member : entry),
      })
      return member
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return undefined
    }
  }

  /**
   * Remove a member from the selected workspace.
   * @param userId - the member to remove.
   * @returns whether the removal applied.
   */
  async removeMember(userId: string): Promise<boolean> {
    const selectedId = this.store.getSnapshot().selectedId
    if (selectedId === undefined) return false
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      await this.api.removeMember(selectedId, userId)
      const current = this.store.getSnapshot()
      this.store.set({ ...current, working: false, members: current.members.filter(member => member.userId !== userId) })
      return true
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return false
    }
  }

  /**
   * Delete a workspace by id (the section row's options menu); drops the
   * record from the list and, if it was selected, clears the detail like
   * `deleteSelected`.
   * @param workspaceId - the collab workspace to delete.
   * @returns whether the deletion applied.
   */
  async delete(workspaceId: string): Promise<boolean> {
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      await this.api.deleteWorkspace(workspaceId)
      const current = this.store.getSnapshot()
      this.store.set({
        ...current,
        working: false,
        workspaces: current.workspaces.filter(workspace => workspace.id !== workspaceId),
        ...(current.selectedId === workspaceId
          ? { selectedId: undefined, myRole: undefined, members: [], invitations: [] }
          : {}),
      })
      return true
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return false
    }
  }

  /**
   * Delete the selected workspace; the panel closes and the list drops it.
   * @returns whether the deletion applied.
   */
  async deleteSelected(): Promise<boolean> {
    const selectedId = this.store.getSnapshot().selectedId
    if (selectedId === undefined) return false
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      await this.api.deleteWorkspace(selectedId)
      const current = this.store.getSnapshot()
      this.store.set({
        ...current,
        working: false,
        workspaces: current.workspaces.filter(workspace => workspace.id !== selectedId),
        selectedId: undefined,
        myRole: undefined,
        members: [],
        invitations: [],
      })
      return true
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return false
    }
  }

  /**
   * Preview a push (server dry run): fetch the live remote tip and compute
   * what a real push would move without touching the remote. The server does
   * not gate a dry run by confirmation because it cannot move a branch.
   * @param workspaceId - the workspace whose clone to inspect.
   * @param branch - branch to preview; omitted previews the checkout's current branch.
   * @returns the push preview, or undefined on failure (banner).
   */
  async previewPush(workspaceId: string, branch?: string): Promise<CollabPushView | undefined> {
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const preview = await this.api.push(workspaceId, branch, true)
      this.store.set({ ...this.store.getSnapshot(), working: false })
      return preview
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return undefined
    }
  }

  /**
   * Push one branch of a settled repository-backed workspace to its origin
   * after the member's own confirmation (the caller only reaches this with
   * the member's explicit go; the server additionally fails closed unless the
   * request carries `confirm`).
   * @param workspaceId - the workspace whose clone to push.
   * @param branch - branch to push; omitted pushes the checkout's current branch.
   * @returns the push outcome (new remote tip, compare/PR links), or undefined on failure (banner).
   */
  async pushBranch(workspaceId: string, branch?: string): Promise<CollabPushView | undefined> {
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const pushed = await this.api.push(workspaceId, branch, false, true)
      this.store.set({ ...this.store.getSnapshot(), working: false })
      return pushed
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: this.foldWireError(error) })
      return undefined
    }
  }
}
