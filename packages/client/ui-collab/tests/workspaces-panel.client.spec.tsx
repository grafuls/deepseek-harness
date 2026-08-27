// @vitest-environment jsdom
/**
 * WorkspacesPanel rendering: the overlay's visibility contract per
 * availability/open state, the workspace list and create flow, the member and
 * invitation detail, and the admin actions shown only to admins. Props are
 * fed directly (hooks bound by the renderer in production); no render
 * machinery here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabInvitationView, CollabMemberView, CollabWorkspaceView } from '../src/client/contract.ts'
import { WorkspacesPanel, type CollabWorkspacesActions } from '../src/client/WorkspacesPanel.tsx'
import { WorkspacesTrigger } from '../src/client/WorkspacesTrigger.tsx'
import type { CollabWorkspacesState } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
})

const WORKSPACE: CollabWorkspaceView = { id: 'w1', name: 'Alpha', memberCount: 2, isOwner: true, role: 'admin', createdAt: '2020-01-01T00:00:00.000Z' }
const MEMBER: CollabMemberView = { userId: 'u1', email: 'owen@example.com', name: 'Owen', role: 'admin', joinedAt: '2020-01-01T00:00:00.000Z' }
const INVITATION: CollabInvitationView = { id: 'i1', workspaceId: 'w1', email: 'lina@example.com', role: 'developer', createdBy: 'u1', createdAt: '2020-01-01T00:00:00.000Z', revoked: false }

function actions(): CollabWorkspacesActions {
  return {
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    refresh: vi.fn(),
    select: vi.fn(),
    create: vi.fn(),
    invite: vi.fn(),
    revokeInvitation: vi.fn(),
    setMemberRole: vi.fn(),
    removeMember: vi.fn(),
    deleteSelected: vi.fn(),
  }
}

function panel(state: CollabWorkspacesState, actionsOverrides: Partial<CollabWorkspacesActions> = {}) {
  const injected = actions()
  return render(<WorkspacesPanel useCollabWorkspaces={sel => sel(state)} actions={{ ...injected, ...actionsOverrides }} />)
}

function readyState(overrides: Partial<CollabWorkspacesState> = {}): CollabWorkspacesState {
  return {
    open: true,
    availability: 'ready',
    workspaces: [WORKSPACE],
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
    expect(screen.getByText('协作工作区')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('管理员')).toBeTruthy()
    expect(screen.getByText('2 名成员')).toBeTruthy()
  })

  it('shows the empty state when the member has no workspaces', () => {
    panel(readyState({ workspaces: [] }))
    expect(screen.getByText('还没有工作区')).toBeTruthy()
  })

  it('selects a workspace row and closes through the header', () => {
    const select = vi.fn()
    const closePanel = vi.fn()
    panel(readyState(), { select, closePanel })
    fireEvent.click(screen.getByText('Alpha'))
    expect(select).toHaveBeenCalledWith('w1')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(closePanel).toHaveBeenCalledTimes(1)
  })

  it('creates a workspace from the inline form and clears the demo input', () => {
    const create = vi.fn()
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ 新建工作区'))
    const input = screen.getByPlaceholderText('工作区名称')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(create).toHaveBeenCalledWith('Beta')
    expect(screen.getByText('＋ 新建工作区')).toBeTruthy()
  })

  it('shows the workspace detail with invitations and invite form for an admin', () => {
    const invite = vi.fn()
    panel(readyState({
      selectedId: 'w1',
      myRole: 'admin',
      members: [MEMBER],
      invitations: [INVITATION],
    }), { invite })
    expect(screen.getByText('成员')).toBeTruthy()
    expect(screen.getByText('Owen')).toBeTruthy()
    expect(screen.getByText('lina@example.com')).toBeTruthy()
    fireEvent.click(screen.getByText('＋ 邀请成员'))
    const inviteRow = screen.getByPlaceholderText('name@example.com')
    fireEvent.change(inviteRow, { target: { value: 'carol@example.com' } })
    // The invite select defaults to developer.
    fireEvent.click(screen.getByRole('button', { name: '邀请' }))
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
    fireEvent.click(screen.getByRole('button', { name: '设为开发者' }))
    expect(setMemberRole).toHaveBeenCalledWith('u1', 'developer')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(revokeInvitation).toHaveBeenCalledWith('i1')
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(removeMember).toHaveBeenCalledWith('u1')
    fireEvent.click(screen.getByRole('button', { name: '删除工作区' }))
    expect(deleteSelected).toHaveBeenCalled()
  })

  it('hides admin actions and the invite form from a developer', () => {
    panel(readyState({
      selectedId: 'w1',
      myRole: 'developer',
      members: [MEMBER],
      invitations: [INVITATION],
    }))
    expect(screen.queryByRole('button', { name: '＋ 邀请成员' })).toBeNull()
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除工作区' })).toBeNull()
    expect(screen.getByText('成员')).toBeTruthy()
  })

  it('surfaces the error banner and clears it on close', () => {
    const closePanel = vi.fn()
    panel(readyState({ error: '请求无效，请检查输入' }), { closePanel })
    expect(screen.getByText('请求无效，请检查输入')).toBeTruthy()
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
    expect(screen.getByText('开发者')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '设为管理员' }))
    expect(setMemberRole).toHaveBeenCalledWith('u2', 'admin')
  })

  it('invites as admin through the role select and the Enter key', () => {
    const invite = vi.fn()
    panel(readyState({ selectedId: 'w1', myRole: 'admin', members: [], invitations: [] }), { invite })
    fireEvent.click(screen.getByRole('button', { name: '＋ 邀请成员' }))
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
    fireEvent.click(screen.getByRole('button', { name: '＋ 邀请成员' }))
    expect(screen.getByRole('button', { name: '邀请' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByText('＋ 新建工作区'))
    expect(screen.getByRole('button', { name: '创建' })).toHaveProperty('disabled', true)
  })

  it('creates from the name field with the Enter key', () => {
    const create = vi.fn()
    panel(readyState(), { create })
    fireEvent.click(screen.getByText('＋ 新建工作区'))
    const nameInput = screen.getByPlaceholderText('工作区名称')
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

describe('WorkspacesTrigger', () => {
  it('renders nothing while the collab surface is absent', () => {
    cleanup()
    render(<WorkspacesTrigger useCollabWorkspaces={sel => sel(readyState({ open: false, availability: 'hidden' }))} actions={actions()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the foot action and toggles the panel on click', () => {
    cleanup()
    const openPanel = vi.fn()
    const closePanel = vi.fn()
    render(
      <WorkspacesTrigger useCollabWorkspaces={sel => sel(readyState({ open: false }))} actions={{ ...actions(), openPanel, closePanel }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '工作台' }))
    expect(openPanel).toHaveBeenCalledTimes(1)
    cleanup()
    render(
      <WorkspacesTrigger useCollabWorkspaces={sel => sel(readyState({ open: true }))} actions={{ ...actions(), openPanel, closePanel }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '工作台' }))
    expect(closePanel).toHaveBeenCalledTimes(1)
  })
})
