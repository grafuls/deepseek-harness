// @vitest-environment jsdom
/**
 * CollabSection rendering (the sidebar section right below the Workspaces
 * browsing region): the visibility contract per availability, the header
 * (title, expanding search, view options, add workspace), collab workspace
 * rows that expand to their mounted sessions and open those on click, search
 * filtering, the view options grouping/order behavior, invitation accept rows,
 * the empty message, and creation through the header add affordance. Props are
 * fed directly (hooks bound by the renderer in production); no render
 * machinery here.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { CollabSection, handleRowMenuSelect } from '../src/client/CollabSection.tsx'
import type { CollabMyInvitationView, CollabWorkspaceView } from '../src/client/contract.ts'
import { en } from '../src/client/locales.ts'
import type { CollabWorkspacesActions, WorkspacesPanelProps } from '../src/client/WorkspacesPanel.tsx'
import type { CollabWorkspacesState } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
})

const ALPHA: CollabWorkspaceView = { id: 'w1', name: 'Alpha', memberCount: 2, isOwner: true, role: 'admin', createdAt: '2020-01-01T00:00:00.000Z' }
const BETA: CollabWorkspaceView = { id: 'w2', name: 'Beta', memberCount: 3, isOwner: false, role: 'developer', createdAt: '2021-02-02T00:00:00.000Z' }
const INVITATION: CollabMyInvitationView = { id: 'i1', workspaceId: 'w3', workspaceName: 'Gamma', role: 'developer', createdAt: '2020-01-01T00:00:00.000Z' }

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** One Host workspace bringing a collab workspace's sessions to the GUI. */
function hostWorkspace(id: string, collabWorkspaceId: string, sessionIds: string[], title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/collab/${id}`, title,
    sessionIds: sessionIds.map(sid),
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    collab: { workspaceId: collabWorkspaceId },
  }
}

function sessionSummary(id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, ...overrides }
}

function sessionState(items: readonly SessionSummary[]): SessionListState {
  return {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current: undefined,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

function hostState(items: readonly WorkspaceView[]): WorkspaceListState {
  return {
    items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true,
    recentWorkspaceId: items[0]?.workspaceId,
  }
}

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
    workspaces: [ALPHA, BETA],
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

/** Render the section with direct hook stubs; sessions/workspaces seed the root seats. */
function section(
  state: CollabWorkspacesState,
  overrides: Partial<CollabWorkspacesActions> = {},
  host: { sessions?: readonly SessionSummary[]; workspaces?: readonly WorkspaceView[] } = {},
) {
  const injected = actions()
  return render((
    <CollabSection
      useCollabWorkspaces={sel => sel(state)}
      useSessions={sel => sel(sessionState(host.sessions ?? []))}
      useWorkspaces={sel => sel(hostState(host.workspaces ?? []))}
      actions={{ ...injected, ...overrides }}
      t={t}
      wide={false}
    />
  ))
}

describe('CollabSection', () => {
  it('renders nothing while the collab surface is absent', () => {
    section(readyState({ availability: 'hidden' }))
    expect(screen.queryByText('Private Workspaces')).toBeNull()
  })

  it('renders the section header with search, view options, and add workspace', () => {
    section(readyState())
    expect(screen.getByText('Private Workspaces')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View options' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '＋ New workspace' })).toBeTruthy()
  })

  it('lists the member workspaces and expands a row to its sessions', () => {
    const open = vi.fn()
    section(
      readyState(),
      { open },
      {
        sessions: [sessionSummary('s1', 3), sessionSummary('s2', 1)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2'], 'Alpha')],
      },
    )
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('2 members')).toBeTruthy()
    // The former per-row Open button is gone; the row toggles its sessions.
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    // Folded: the sessions stay hidden until the row expands.
    expect(screen.queryByText('s1')).toBeNull()
    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.getByText('s1')).toBeTruthy()
    expect(screen.getByText('s2')).toBeTruthy()
    fireEvent.click(screen.getByText('s1'))
    expect(open).toHaveBeenCalledWith('s1')
    // Clicking the row again folds the sessions back.
    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.queryByText('s1')).toBeNull()
    expect(screen.queryByText('s2')).toBeNull()
  })

  it('ignores host workspaces that carry no collab marker', () => {
    const local: WorkspaceView = {
      workspaceId: wid('local1'), path: '/data/local', title: 'Local', sessionIds: [sid('local-s')],
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    }
    section(
      readyState(),
      {},
      {
        sessions: [sessionSummary('s1', 5), sessionSummary('local-s', 9)],
        workspaces: [local, hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')],
      },
    )
    // The collab mount's sessions still browse and open.
    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.getByText('s1')).toBeTruthy()
    // The non-collab host workspace contributes neither a row nor sessions.
    expect(screen.queryByText('Local')).toBeNull()
    expect(screen.queryByText('local-s')).toBeNull()
  })

  it('mounts every collab workspace in the background once the section is ready', () => {
    const mountAll = vi.fn()
    section(readyState(), { mountAll })
    expect(mountAll).toHaveBeenCalledTimes(1)
  })

  it('shows no session placeholder when workspaces exist but none carry sessions', () => {
    // No host mounts yet: auto-mount is pending, so no sessions render — the
    // rows carry the hover actions instead of an empty-state note.
    section(readyState())
    expect(screen.queryByText('No sessions yet')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('expands a sessionless workspace row to an empty list without a placeholder', () => {
    // Alpha has a host mount but no sessions; the expanded row mirrors the
    // browsing region's empty group: no explanatory note.
    section(
      readyState(),
      {},
      { workspaces: [hostWorkspace('hw1', 'w1', [], 'Alpha')], sessions: [] },
    )
    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.queryByText('No sessions yet')).toBeNull()
    expect(screen.queryAllByRole('button', { name: 'Open session' })).toHaveLength(0)
  })

  it('starts a new session in the collab workspace from the row button', () => {
    const openWorkspace = vi.fn()
    section(
      readyState(),
      { openWorkspace },
      {
        sessions: [sessionSummary('s1', 5)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')],
      },
    )
    fireEvent.click(screen.getByRole('button', { name: 'New session in Alpha' }))
    // openWorkspace mounts the workspace (idempotent when it already is) and
    // starts the session in it — the same flow the manager surface uses.
    expect(openWorkspace).toHaveBeenCalledWith('w1')
    // The row itself still expands; the hover button did not steal the click.
    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.getByText('s1')).toBeTruthy()
  })

  it('starts a session from the row button even before the workspace is mounted', () => {
    const openWorkspace = vi.fn()
    // The collab workspace is listed but auto-mount has not echoed yet: the
    // click still dispatches, and the openWorkspace action mounts first.
    section(readyState(), { openWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'New session in Alpha' }))
    expect(openWorkspace).toHaveBeenCalledWith('w1')
  })

  it('manages or deletes a workspace through the row options menu', () => {
    const openManager = vi.fn()
    const remove = vi.fn()
    section(readyState(), { openManager, delete: remove })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    expect(screen.getByRole('menuitem', { name: 'Manage' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage' }))
    expect(openManager).toHaveBeenCalledWith('w1')
    // Reopen and take the destructive path.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workspace' }))
    expect(remove).toHaveBeenCalledWith('w1')
  })

  it('fails closed on an unknown row options-menu id', () => {
    // The menu carries exactly manage/delete; a forged future id must not
    // inherit the destructive branch as an else fallback.
    const openManager = vi.fn()
    const remove = vi.fn()
    const rowActions: CollabWorkspacesActions = { ...actions(), openManager, delete: remove }
    handleRowMenuSelect('manage', 'w1', rowActions)
    expect(openManager).toHaveBeenCalledWith('w1')
    handleRowMenuSelect('delete', 'w1', rowActions)
    expect(remove).toHaveBeenCalledWith('w1')
    handleRowMenuSelect('bogus-future-item', 'w1', rowActions)
    expect(openManager).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('closes the row options menu through Escape and the anchor', () => {
    section(readyState())
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toBeTruthy()
    // Escape invokes the Menu's onClose and folds the row actions away.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: 'Delete workspace' })).toBeNull()
    // Reopen; clicking the anchor again also dismisses.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    expect(screen.getByRole('menuitem', { name: 'Delete workspace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    expect(screen.queryByRole('menuitem', { name: 'Delete workspace' })).toBeNull()
  })

  it('labels a blank collab session with the localized New Session row title', () => {
    section(
      readyState(),
      {},
      {
        sessions: [sessionSummary('s-blank', 1, { blank: true })],
        workspaces: [hostWorkspace('hw1', 'w1', ['s-blank'], 'Alpha')],
      },
    )
    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.getByText('New Session')).toBeTruthy()
  })

  it('keeps the manual flat order and dedupes a session shared across workspaces', () => {
    const { unmount } = section(
      readyState({ groupBy: 'flat', orderBy: 'manual' }),
      {},
      {
        sessions: [sessionSummary('beta-s', 5), sessionSummary('alpha-s', 2)],
        workspaces: [
          hostWorkspace('hw1', 'w1', ['alpha-s'], 'Alpha'),
          hostWorkspace('hw2', 'w2', ['beta-s', 'alpha-s'], 'Beta'),
        ],
      },
    )
    // Manual flat keeps the workspace-then-account order, no recency sort.
    const titles = screen.getAllByRole('button', { name: 'Open session' }).map(button => button.textContent?.trim() ?? '')
    expect(titles).toEqual(['alpha-s', 'beta-s'])
    unmount()
    // Updated flat sorts newest-first across workspaces.
    section(readyState({ groupBy: 'flat', orderBy: 'updated' }), {}, {
      sessions: [sessionSummary('beta-s', 5), sessionSummary('alpha-s', 2)],
      workspaces: [
        hostWorkspace('hw1', 'w1', ['alpha-s'], 'Alpha'),
        hostWorkspace('hw2', 'w2', ['beta-s'], 'Beta'),
      ],
    })
    const sorted = screen.getAllByRole('button', { name: 'Open session' }).map(button => button.textContent?.trim() ?? '')
    expect(sorted).toEqual(['beta-s', 'alpha-s'])
  })

  it('filters flat sessions by title through the search capsule', () => {
    section(
      readyState({ groupBy: 'flat' }),
      {},
      {
        sessions: [sessionSummary('beta-s', 5), sessionSummary('alpha-s', 2)],
        workspaces: [
          hostWorkspace('hw1', 'w1', ['alpha-s'], 'Alpha'),
          hostWorkspace('hw2', 'w2', ['beta-s'], 'Beta'),
        ],
      },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search collaborative workspaces…'), { target: { value: 'alpha' } })
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(screen.queryByText('beta-s')).toBeNull()
    // A query matching nothing shows the no-match message in flat mode too.
    fireEvent.change(screen.getByPlaceholderText('Search collaborative workspaces…'), { target: { value: 'zzz' } })
    expect(screen.getByText('No matching collaborative workspaces')).toBeTruthy()
  })

  it('orders a workspace’s sessions newest-first under the updated view option', () => {
    section(
      readyState({ orderBy: 'updated' }),
      {},
      {
        sessions: [sessionSummary('older', 1), sessionSummary('newer', 9)],
        workspaces: [hostWorkspace('hw1', 'w1', ['older', 'newer'], 'Alpha')],
      },
    )
    fireEvent.click(screen.getByText('Alpha'))
    const titles = screen.getAllByRole('button').map(button => button.textContent)
    const indexOfNewer = titles.indexOf('newer')
    const indexOfOlder = titles.indexOf('older')
    expect(indexOfNewer).toBeGreaterThan(-1)
    expect(indexOfOlder).toBeGreaterThan(-1)
    expect(indexOfNewer).toBeLessThan(indexOfOlder)
  })

  it('renders one flat session list under the flat view option', () => {
    const open = vi.fn()
    const { unmount } = section(
      readyState({ groupBy: 'flat' }),
      { open },
      {
        sessions: [sessionSummary('beta-s', 5), sessionSummary('alpha-s', 2)],
        workspaces: [
          hostWorkspace('hw1', 'w1', ['alpha-s'], 'Alpha'),
          hostWorkspace('hw2', 'w2', ['beta-s'], 'Beta'),
        ],
      },
    )
    // Flat mode lists sessions directly, newest first, with no workspace rows.
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Open session' })).toHaveLength(2)
    expect(screen.getByText('beta-s')).toBeTruthy()
    expect(screen.getByText('alpha-s')).toBeTruthy()
    fireEvent.click(screen.getByText('beta-s'))
    expect(open).toHaveBeenCalledWith('beta-s')
    unmount()
    // Workspace mode restores the workspace rows.
    section(readyState(), { open })
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('orders the list by creation recency under the updated view option', () => {
    section(readyState({ orderBy: 'updated' }))
    const names = screen.getAllByRole('button', { name: /members$/ }).map(row => row.textContent)
    // Beta (2021) precedes Alpha (2020).
    expect(names[0]).toContain('Beta')
    expect(names[1]).toContain('Alpha')
  })

  it('keeps the server-provided order under the manual view option', () => {
    // Server order: Alpha before Beta; 'manual' leaves it untouched.
    section(readyState({ orderBy: 'manual', workspaces: [BETA, ALPHA] }))
    const names = screen.getAllByRole('button', { name: /members$/ }).map(row => row.textContent)
    expect(names[0]).toContain('Beta')
    expect(names[1]).toContain('Alpha')
  })

  it('filters the workspace list by name from the expanding search', () => {
    section(readyState())
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const input = screen.getByPlaceholderText('Search collaborative workspaces…')
    fireEvent.change(input, { target: { value: 'bet' } })
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Beta')).toBeTruthy()
    // Clearing through the clear button restores the full list.
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('collapses the search with Escape and shows the no-match message', () => {
    section(readyState())
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const input = screen.getByPlaceholderText('Search collaborative workspaces…')
    // A non-Escape key keeps the expanded search around (no-op path).
    fireEvent.keyDown(input, { key: 'a' })
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.getByText('No matching collaborative workspaces')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByText('Private Workspaces')).toBeTruthy()
    expect(screen.queryByText('No matching collaborative workspaces')).toBeNull()
  })

  it('closes the expanded empty search when the pointer leaves it', () => {
    section(readyState())
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    // The input is always mounted; expansion is the capsule's open state, so
    // assert the expanding control's aria-expanded flip instead.
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(document.body)
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the expanded search open while the query is non-empty', () => {
    section(readyState())
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search collaborative workspaces…'), { target: { value: 'be' } })
    fireEvent.click(document.body)
    expect(screen.getByPlaceholderText('Search collaborative workspaces…')).toBeTruthy()
  })

  it('mirrors the local view options menu: group by and order by', () => {
    const setGroupBy = vi.fn()
    const setOrderBy = vi.fn()
    section(readyState(), { setGroupBy, setOrderBy })
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByText('Group by')).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'WorkSpace', 'In one list', 'Manual', 'Newest',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one list' }))
    expect(setGroupBy).toHaveBeenCalledWith('flat')
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manual' }))
    expect(setOrderBy).toHaveBeenCalledWith('manual')
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Newest' }))
    expect(setOrderBy).toHaveBeenCalledWith('updated')
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'WorkSpace' }))
    expect(setGroupBy).toHaveBeenCalledWith('workspace')
    // Escape closes the menu without picking.
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the expanded search open while the pointer is inside it', () => {
    section(readyState())
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    // A click inside the capsule (the search button itself) is not an
    // outside dismissal.
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('renders expandable workspace rows with chevron and folder chrome in the grouped mode', () => {
    // Grouped rows lead with a chevron, then folder chrome, name, member count.
    const { unmount } = section(readyState())
    const row = screen.getAllByRole('button', { name: /members$/ })[0]
    expect(row!.querySelectorAll('span')).toHaveLength(4)
    expect(row!.getAttribute('aria-expanded')).toBe('false')
    unmount()
    // Flat mode has no workspace rows at all — its list is the sessions.
    section(readyState({ groupBy: 'flat' }))
    expect(screen.queryAllByRole('button', { name: /members$/ })).toHaveLength(0)
  })

  it('shows accept rows for pending invitations addressed to the user', () => {
    const acceptInvitation = vi.fn()
    section(readyState({ invitationsForMe: [INVITATION] }), { acceptInvitation })
    expect(screen.getByText('Gamma')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(acceptInvitation).toHaveBeenCalledWith('i1')
  })

  it('shows the empty message only when there are neither workspaces nor invitations', () => {
    const { unmount } = section(readyState({ workspaces: [] }))
    expect(screen.getByText('No workspaces yet')).toBeTruthy()
    unmount()
    // With an invitation pending the empty message stays away.
    section(readyState({ workspaces: [], invitationsForMe: [INVITATION] }))
    expect(screen.queryByText('No workspaces yet')).toBeNull()
  })

  it('creates a workspace through the header add affordance', async () => {
    const create = vi.fn(async () => true)
    section(readyState({ workspaces: [] }), { create })
    fireEvent.click(screen.getByRole('button', { name: '＋ New workspace' }))
    expect(screen.getByText('New collaborative workspace')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(create).toHaveBeenCalledWith('Gamma')
    await waitFor(() => { expect(screen.queryByText('New collaborative workspace')).toBeNull() })
  })

  it('renders the list when availability resolves on an already-mounted section', () => {
    // The availability probe starts absent and resolves to 'ready' while the
    // section is already mounted. In the assembled app this in-place flip is
    // also why the search hooks must sit above the availability guard: a
    // return before them would change the hook count between renders and
    // crash the mounted section (verified against the live server; jsdom does
    // not surface the hook-order throw, so this asserts the visible outcome).
    const current = readyState({ availability: 'hidden', workspaces: [] })
    const { rerender } = render((
      <CollabSection
        useCollabWorkspaces={sel => sel(current)}
        useSessions={sel => sel(sessionState([]))}
        useWorkspaces={sel => sel(hostState([]))}
        actions={actions()}
        t={t}
        wide={false}
      />
    ))
    expect(screen.queryByRole('button', { name: '＋ New workspace' })).toBeNull()
    current.availability = 'ready'
    current.workspaces = [ALPHA]
    rerender((
      <CollabSection
        useCollabWorkspaces={sel => sel(current)}
        useSessions={sel => sel(sessionState([]))}
        useWorkspaces={sel => sel(hostState([]))}
        actions={actions()}
        t={t}
        wide={false}
      />
    ))
    expect(screen.queryByRole('button', { name: '＋ New workspace' })).not.toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })
})
