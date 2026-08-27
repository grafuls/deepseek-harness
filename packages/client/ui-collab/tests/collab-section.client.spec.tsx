// @vitest-environment jsdom
/**
 * CollabSection rendering (the sidebar section under the Workspaces browsing
 * region): the visibility contract per availability, the workspace rows that
 * open the manager overlay for detail, the inline invitation accept rows,
 * the empty message, and the inline create affordance. Props are fed directly
 * (hooks bound by the renderer in production); no render machinery here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollabSection } from '../src/client/CollabSection.tsx'
import type { CollabMyInvitationView, CollabWorkspaceView } from '../src/client/contract.ts'
import { en } from '../src/client/locales.ts'
import type { CollabWorkspacesActions, WorkspacesPanelProps } from '../src/client/WorkspacesPanel.tsx'
import type { CollabWorkspacesState } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
})

const WORKSPACE: CollabWorkspaceView = { id: 'w1', name: 'Alpha', memberCount: 2, isOwner: true, role: 'admin', createdAt: '2020-01-01T00:00:00.000Z' }
const INVITATION: CollabMyInvitationView = { id: 'i1', workspaceId: 'w2', workspaceName: 'Beta', role: 'developer', createdAt: '2020-01-01T00:00:00.000Z' }

function actions(): CollabWorkspacesActions {
  return {
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    refresh: vi.fn(),
    select: vi.fn(),
    openManager: vi.fn(),
    openWorkspace: vi.fn(),
    create: vi.fn(),
    invite: vi.fn(),
    revokeInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    setMemberRole: vi.fn(),
    removeMember: vi.fn(),
    deleteSelected: vi.fn(),
  }
}

/** An English-bound translate seat for direct rendering (the renderer binds it in production). */
const t: WorkspacesPanelProps['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

function readyState(overrides: Partial<CollabWorkspacesState> = {}): CollabWorkspacesState {
  return {
    open: false,
    availability: 'ready',
    workspaces: [WORKSPACE],
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

function section(state: CollabWorkspacesState, overrides: Partial<CollabWorkspacesActions> = {}) {
  const injected = actions()
  return render(<CollabSection useCollabWorkspaces={sel => sel(state)} actions={{ ...injected, ...overrides }} t={t} />)
}

describe('CollabSection', () => {
  it('renders nothing while the collab surface is absent', () => {
    section(readyState({ availability: 'hidden' }))
    expect(screen.queryByText('Collaborative workspaces')).toBeNull()
  })

  it('lists the member workspaces and opens the manager overlay onto a row', () => {
    const openManager = vi.fn()
    section(readyState(), { openManager })
    expect(screen.getByText('Collaborative workspaces')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('2 members')).toBeTruthy()
    fireEvent.click(screen.getByText('Alpha'))
    expect(openManager).toHaveBeenCalledWith('w1')
  })

  it('opens a mounted workspace into the GUI from its row button', () => {
    const openWorkspace = vi.fn()
    section(readyState(), { openWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(openWorkspace).toHaveBeenCalledWith('w1')
  })

  it('shows accept rows for pending invitations addressed to the user', () => {
    const acceptInvitation = vi.fn()
    section(readyState({ invitationsForMe: [INVITATION] }), { acceptInvitation })
    expect(screen.getByText('Invitations for you')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(acceptInvitation).toHaveBeenCalledWith('i1')
  })

  it('shows the empty message only when there are neither workspaces nor invitations', () => {
    const { unmount } = section(readyState({ workspaces: [], invitationsForMe: [] }))
    expect(screen.getByText('No workspaces yet')).toBeTruthy()
    unmount()
    // With an invitation pending the empty message stays away.
    section(readyState({ workspaces: [], invitationsForMe: [INVITATION] }))
    expect(screen.queryByText('No workspaces yet')).toBeNull()
  })

  it('creates a workspace inline from the section', () => {
    const create = vi.fn()
    section(readyState({ workspaces: [] }), { create })
    fireEvent.click(screen.getByText('＋ New workspace'))
    const input = screen.getByPlaceholderText('Workspace name')
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith('Gamma')
    expect(screen.getByText('＋ New workspace')).toBeTruthy()
  })
})
