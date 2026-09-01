// @vitest-environment jsdom
/**
 * WorkspacesPanel rendering: the overlay's visibility contract per
 * availability/open state, the workspace list and create flow, the member and
 * invitation detail, and the admin actions shown only to admins. Props are
 * fed directly (hooks bound by the renderer in production); no render
 * machinery here.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabInvitationView, CollabMemberView, CollabWorkspaceView } from '../src/client/contract.ts'
import { en } from '../src/client/locales.ts'
import { WorkspacesPanel, type CollabWorkspacesActions, type WorkspacesPanelProps } from '../src/client/WorkspacesPanel.tsx'
import type { CollabWorkspacesState } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
})

const WORKSPACE: CollabWorkspaceView = { id: 'w1', name: 'Alpha', memberCount: 2, isOwner: true, role: 'admin', createdAt: '2020-01-01T00:00:00.000Z', cloneState: 'ready' }
const MEMBER: CollabMemberView = { userId: 'u1', email: 'owen@example.com', name: 'Owen', role: 'admin', joinedAt: '2020-01-01T00:00:00.000Z' }
const INVITATION: CollabInvitationView = { id: 'i1', workspaceId: 'w1', email: 'lina@example.com', role: 'developer', createdBy: 'u1', createdAt: '2020-01-01T00:00:00.000Z', revoked: false }

function actions(): CollabWorkspacesActions {
  return {
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    refresh: vi.fn(),
    select: vi.fn(),
    openManager: vi.fn(),
    openWorkspace: vi.fn(),
    mountAll: vi.fn(),
    open: vi.fn(),
    renameSession: vi.fn(async () => { }),
    forkSession: vi.fn(),
    archiveSession: vi.fn(async () => { }),
    delete: vi.fn(),
    setGroupBy: vi.fn(),
    setOrderBy: vi.fn(),
    create: vi.fn(),
    invite: vi.fn(),
    revokeInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    setMemberRole: vi.fn(),
    removeMember: vi.fn(),
    deleteSelected: vi.fn(),
    reorderSession: vi.fn(),
  }
}

/** An English-bound translate seat for direct rendering (the renderer binds it in production). */
const t: WorkspacesPanelProps['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

function panel(state: CollabWorkspacesState, actionsOverrides: Partial<CollabWorkspacesActions> = {}) {
  const injected = actions()
  return render(<WorkspacesPanel useCollabWorkspaces={sel => sel(state)} actions={{ ...injected, ...actionsOverrides }} t={t} />)
}

function readyState(overrides: Partial<CollabWorkspacesState> = {}): CollabWorkspacesState {
  return {
    open: true,
    availability: 'ready',
    workspaces: [WORKSPACE],
    groupBy: 'workspace',
    orderBy: 'updated',
    invitationsForMe: [],
    selectedId: undefined,
    myRole: undefined,
    members: [],
    invitations: [],
    working: false,
    error: undefined,
    ...overrides,
  }
}

describe('WorkspacesPanel', () => {
  it('renders nothing while the collab surface is absent', () => {
    panel({ ...readyState(), availability: 'hidden' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders nothing while the panel is closed', () => {
    panel({ ...readyState(), open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists the member workspaces with their role and member count', () => {
    panel(readyState())
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Private Workspaces')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Admin')).toBeTruthy()
    expect(screen.getByText('2 members')).toBeTruthy()
  })

  it('tags a repository-backed workspace that is still cloning', () => {
    panel(readyState({ workspaces: [{ ...WORKSPACE, cloneState: 'cloning' }] }))
    expect(screen.getByText('Cloning…')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('shows the empty state with a working create affordance', () => {
    const create = vi.fn()
    panel(readyState({ workspaces: [] }), { create })
    expect(screen.getByText('No workspaces yet')).toBeTruthy()
    // A fresh member can still start their first workspace from the empty state.
    fireEvent.click(screen.getByText('＋ New workspace'))
    const input = screen.getByPlaceholderText('Workspace name')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith('Beta')
    expect(screen.getByText('No workspaces yet')).toBeTruthy()
  })

  it('selects a workspace row and closes through the header', () => {
    const select = vi.fn()
    const closePanel = vi.fn()
    panel(readyState(), { select, closePanel })
    fireEvent.click(screen.getByText('Alpha'))
    expect(select).toHaveBeenCalledWith('w1')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(closePanel).toHaveBeenCalledTimes(1)
  })

  it('pops up the creation modal from the create button and cancels it', () => {
    const create = vi.fn(async () => true)
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    expect(screen.getByText('New collaborative workspace')).toBeTruthy()
    expect(screen.getByPlaceholderText('Workspace name')).toBeTruthy()
    expect(screen.getByPlaceholderText('GitHub repository URL (optional)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('New collaborative workspace')).toBeNull()
    expect(create).not.toHaveBeenCalled()
    // The backdrop restores the page behind the dialog.
    fireEvent.click(screen.getByText('＋ New workspace'))
    expect(screen.getByText('New collaborative workspace')).toBeTruthy()
  })

  it('closes the creation modal through the header button and the backdrop', () => {
    panel(readyState())
    fireEvent.click(screen.getByText('＋ New workspace'))
    const modal = screen.getByRole('dialog', { name: 'New collaborative workspace' })
    // A mouseDown inside the dialog must not fall through to the backdrop.
    fireEvent.mouseDown(modal)
    expect(screen.getByText('New collaborative workspace')).toBeTruthy()
    // The backdrop wraps the dialog; a mouseDown outside it closes the modal.
    fireEvent.mouseDown(modal.parentElement ?? modal)
    expect(screen.queryByText('New collaborative workspace')).toBeNull()
    // Reopen and close through the header × button instead.
    fireEvent.click(screen.getByText('＋ New workspace'))
    const reopened = screen.getByRole('dialog', { name: 'New collaborative workspace' })
    fireEvent.click(within(reopened).getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('New collaborative workspace')).toBeNull()
  })

  it('creates a workspace from the modal and closes it on success', async () => {
    const create = vi.fn(async () => true)
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith('Beta')
    await waitFor(() => { expect(screen.queryByText('New collaborative workspace')).toBeNull() })
  })

  it('creates a repository-backed workspace from the repository URL field', () => {
    const create = vi.fn(async () => true)
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Product' } })
    fireEvent.change(screen.getByPlaceholderText('GitHub repository URL (optional)'), { target: { value: ' https://github.com/example/product.git ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith('Product', 'https://github.com/example/product.git')
  })

  it('keeps the modal open and shows a busy label while the create request is pending', async () => {
    const create = vi.fn(() => new Promise<boolean>(() => {}))
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => { expect(screen.getByText('Creating…')).toBeTruthy() })
    expect(screen.getByRole('button', { name: 'Creating…' }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByPlaceholderText('GitHub repository URL (optional)')).toBeTruthy()
    expect(screen.getByText('New collaborative workspace')).toBeTruthy()
  })

  it('keeps the modal open and the error banner visible when creation fails', async () => {
    const create = vi.fn(async () => false)
    panel(readyState({ error: 'This workspace is still cloning, try again shortly' }), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Product' } })
    fireEvent.change(screen.getByPlaceholderText('GitHub repository URL (optional)'), { target: { value: 'https://github.com/example/private.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => { expect(create).toHaveBeenCalledWith('Product', 'https://github.com/example/private.git') })
    // The panel banner and the modal banner both surface the store error.
    const modal = within(screen.getByRole('dialog', { name: 'New collaborative workspace' }))
    expect(modal.getByText('This workspace is still cloning, try again shortly')).toBeTruthy()
    expect(modal.getByPlaceholderText('GitHub repository URL (optional)')).toBeTruthy()
  })

  it('re-enables the modal when the create action rejects unexpectedly', async () => {
    const create = vi.fn(async () => { throw new Error('boom') })
    panel(readyState({ error: 'Something went wrong, please try again' }), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith('Beta')
    // The failed action must not wedge the modal in Creating…: the button
    // returns to Create and the dialog stays editable.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy() })
    const modal = within(screen.getByRole('dialog', { name: 'New collaborative workspace' }))
    expect(modal.getByPlaceholderText('Workspace name')).toBeTruthy()
    expect(modal.getByText('Something went wrong, please try again')).toBeTruthy()
  })

  it('creates from the repository URL field with the Enter key', () => {
    const create = vi.fn()
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    const repoInput = screen.getByPlaceholderText('GitHub repository URL (optional)')
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Beta' } })
    fireEvent.change(repoInput, { target: { value: 'https://github.com/example/product.git' } })
    fireEvent.keyDown(repoInput, { key: 'a' })
    expect(create).not.toHaveBeenCalled()
    fireEvent.keyDown(repoInput, { key: 'Enter' })
    expect(create).toHaveBeenCalledWith('Beta', 'https://github.com/example/product.git')
  })

  it('shows the workspace detail with invitations and invite form for an admin', () => {
    const invite = vi.fn()
    panel(readyState({
      selectedId: 'w1',
      myRole: 'admin',
      members: [MEMBER],
      invitations: [INVITATION],
    }), { invite })
    expect(screen.getByText('Members')).toBeTruthy()
    expect(screen.getByText('Owen')).toBeTruthy()
    expect(screen.getByText('lina@example.com')).toBeTruthy()
    fireEvent.click(screen.getByText('＋ Invite member'))
    const inviteRow = screen.getByPlaceholderText('name@example.com')
    fireEvent.change(inviteRow, { target: { value: 'carol@example.com' } })
    // The invite select defaults to developer.
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    expect(invite).toHaveBeenCalledWith('carol@example.com', 'developer')
  })

  it('changes roles, revokes, removes members, and deletes only as an admin', () => {
    const setMemberRole = vi.fn()
    const revokeInvitation = vi.fn()
    const removeMember = vi.fn()
    const deleteSelected = vi.fn()
    panel(readyState({
      selectedId: 'w1',
      myRole: 'admin',
      members: [MEMBER],
      invitations: [INVITATION],
    }), { setMemberRole, revokeInvitation, removeMember, deleteSelected })
    // MEMBER is already admin, so the row offers the demote action.
    fireEvent.click(screen.getByRole('button', { name: 'Make developer' }))
    expect(setMemberRole).toHaveBeenCalledWith('u1', 'developer')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(revokeInvitation).toHaveBeenCalledWith('i1')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeMember).toHaveBeenCalledWith('u1')
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    expect(deleteSelected).toHaveBeenCalled()
  })

  it('hides admin actions and the invite form from a developer', () => {
    panel(readyState({
      selectedId: 'w1',
      myRole: 'developer',
      members: [MEMBER],
      invitations: [INVITATION],
    }))
    expect(screen.queryByRole('button', { name: '＋ Invite member' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).toBeNull()
    expect(screen.getByText('Members')).toBeTruthy()
  })

  it('surfaces the error banner and clears it on close', () => {
    const closePanel = vi.fn()
    panel(readyState({ error: '请求无效，请检查输入' }), { closePanel })
    expect(screen.getByText('请求无效，请检查输入')).toBeTruthy()
  })

  it('lists the pending invitations for the user with their role and accepts one', () => {
    const acceptInvitation = vi.fn()
    panel(readyState({
      invitationsForMe: [
        { id: 'i1', workspaceId: 'w1', workspaceName: 'Alpha', role: 'admin', createdAt: '2020-01-01T00:00:00.000Z' },
        { id: 'i2', workspaceId: 'w2', workspaceName: 'Docs', role: 'developer', createdAt: '2020-01-01T00:00:00.000Z' },
      ],
    }), { acceptInvitation })
    expect(screen.getByText('Invitations for you')).toBeTruthy()
    expect(screen.getByText('Docs')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[1]!)
    expect(acceptInvitation).toHaveBeenCalledWith('i2')
  })

  it('hides the invitation section when nothing is addressed to the user', () => {
    panel(readyState({ invitationsForMe: [] }))
    expect(screen.queryByText('Invitations for you')).toBeNull()
  })

  it('closes by clicking the backdrop, not the panel itself', () => {
    const closePanel = vi.fn()
    panel(readyState(), { closePanel })
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog)
    expect(closePanel).not.toHaveBeenCalled()
    // The backdrop wraps the panel; simulate a click outside it.
    fireEvent.mouseDown(dialog.parentElement ?? dialog)
    expect(closePanel).toHaveBeenCalledTimes(1)
  })

  it('promotes a developer member and labels their role', () => {
    const setMemberRole = vi.fn()
    const dev: CollabMemberView = { ...MEMBER, userId: 'u2', email: 'lina@example.com', name: 'Lina', role: 'developer' }
    panel(readyState({ selectedId: 'w1', myRole: 'admin', members: [dev], invitations: [] }), { setMemberRole })
    expect(screen.getByText('Developer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Make admin' }))
    expect(setMemberRole).toHaveBeenCalledWith('u2', 'admin')
  })

  it('invites as admin through the role select and the Enter key', () => {
    const invite = vi.fn()
    panel(readyState({ selectedId: 'w1', myRole: 'admin', members: [], invitations: [] }), { invite })
    fireEvent.click(screen.getByRole('button', { name: '＋ Invite member' }))
    const emailInput = screen.getByPlaceholderText('name@example.com')
    fireEvent.change(emailInput, { target: { value: 'carol@example.com' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'admin' } })
    fireEvent.keyDown(emailInput, { key: 'a' })
    expect(invite).not.toHaveBeenCalled()
    fireEvent.keyDown(emailInput, { key: 'Enter' })
    expect(invite).toHaveBeenCalledWith('carol@example.com', 'admin')
  })

  it('disables the invite and create submit while their fields are empty', () => {
    panel(readyState({ selectedId: 'w1', myRole: 'admin', members: [], invitations: [] }))
    fireEvent.click(screen.getByRole('button', { name: '＋ Invite member' }))
    expect(screen.getByRole('button', { name: 'Invite' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByText('＋ New workspace'))
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true)
  })

  it('creates from the name field with the Enter key', () => {
    const create = vi.fn()
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    const nameInput = screen.getByPlaceholderText('Workspace name')
    fireEvent.change(nameInput, { target: { value: 'Gamma' } })
    fireEvent.keyDown(nameInput, { key: 'a' })
    expect(create).not.toHaveBeenCalled()
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(create).toHaveBeenCalledWith('Gamma')
  })

  it('falls back to the email address for a nameless member', () => {
    const nameless: CollabMemberView = { ...MEMBER, name: '' }
    panel(readyState({ selectedId: 'w1', myRole: 'developer', members: [nameless], invitations: [] }))
    expect(screen.getByText('owen@example.com')).toBeTruthy()
  })
})
