/**
 * Collab workspaces controller, browser half. Owns the async orchestration
 * over the {@link CollabApi} and the shared workspaces store: availability
 * probing, list/detail loads, and every mutation, folding server wire codes
 * into the store's user-facing error banner. Built by the plugin body; the
 * inject face exposes plain callback members over it.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CollabError, type CollabApi, type CollabRole } from './contract.ts'
import type { CollabWorkspacesState } from './store.ts'

/** Join a wire code with a muted, user-facing banner. */
function foldWireError(error: unknown): string {
  if (error instanceof CollabError) {
    switch (error.code) {
      case 'collab-forbidden': return '没有权限执行此操作'
      case 'collab-not-found': return '工作区不存在或已被删除'
      case 'collab-bad-request': return '请求无效，请检查输入'
      default: return '操作失败，请重试'
    }
  }
  return '连接服务失败，请重试'
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
   */
  constructor(
    private readonly api: CollabApi,
    private readonly store: SnapshotStore<CollabWorkspacesState>,
  ) {}

  /**
   * Open the panel.
   * @returns the new open state.
   */
  openPanel(): void {
    this.store.set({ ...this.store.getSnapshot(), open: true })
  }

  /**
   * Close the panel.
   * @returns the new open state.
   */
  closePanel(): void {
    this.store.set({ ...this.store.getSnapshot(), open: false, error: undefined })
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
   * Reload the member workspace list, keeping a still-present selection's
   * detail when one is selected.
   * @returns the loaded workspace list.
   */
  async refresh(): Promise<CollabWorkspacesState['workspaces']> {
    const workspaces = await this.api.listWorkspaces()
    const current = this.store.getSnapshot()
    const selectedId = current.selectedId !== undefined
      && workspaces.some(workspace => workspace.id === current.selectedId)
      ? current.selectedId
      : undefined
    this.store.set({
      ...current,
      workspaces,
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
      this.store.set({ ...this.store.getSnapshot(), working: false, error: foldWireError(error) })
    }
  }

  /**
   * Create a workspace and select it.
   * @param name - the workspace display name.
   * @returns the created workspace id.
   */
  async create(name: string): Promise<string | undefined> {
    const trimmed = name.trim()
    if (trimmed === '') {
      this.store.set({ ...this.store.getSnapshot(), error: '请输入工作区名称' })
      return undefined
    }
    this.store.set({ ...this.store.getSnapshot(), working: true, error: undefined })
    try {
      const created = await this.api.createWorkspace(trimmed)
      const current = this.store.getSnapshot()
      this.store.set({ ...current, working: false, workspaces: [created, ...current.workspaces] })
      await this.select(created.id)
      return created.id
    } catch (error) {
      this.store.set({ ...this.store.getSnapshot(), working: false, error: foldWireError(error) })
      return undefined
    }
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
      this.store.set({ ...this.store.getSnapshot(), working: false, error: foldWireError(error) })
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
      this.store.set({ ...this.store.getSnapshot(), working: false, error: foldWireError(error) })
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
      this.store.set({ ...this.store.getSnapshot(), working: false, error: foldWireError(error) })
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
      this.store.set({ ...this.store.getSnapshot(), working: false, error: foldWireError(error) })
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
      this.store.set({ ...this.store.getSnapshot(), working: false, error: foldWireError(error) })
      return false
    }
  }
}
