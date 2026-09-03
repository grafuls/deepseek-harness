// @vitest-environment jsdom
/**
 * CollabSection rendering (the "Workspaces" section that fills the
 * sidebar's single Workspaces seat, replacing the local browsing region): the
 * visibility contract per availability, the section toolbar (title, expanding
 * search, view options, add workspace), collab workspace rows that mirror the
 * browsing region's project-row anatomy with inline sessions below them (open
 * on click), the session rows' status/time/selected chrome, the
 * hover-revealed row actions, search filtering, the view options
 * grouping/order behavior, invitation accept rows, the empty message, and
 * creation through the toolbar add affordance, plus the collapsed-rail search
 * control. Props are fed directly (hooks bound by the renderer in
 * production); no render machinery here.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const ALPHA: CollabWorkspaceView = { id: 'w1', name: 'Alpha', memberCount: 2, isOwner: true, role: 'admin', createdAt: '2020-01-01T00:00:00.000Z', cloneState: 'ready' }
const BETA: CollabWorkspaceView = { id: 'w2', name: 'Beta', memberCount: 3, isOwner: false, role: 'developer', createdAt: '2021-02-02T00:00:00.000Z', cloneState: 'ready' }
const INVITATION: CollabMyInvitationView = { id: 'i1', workspaceId: 'w3', workspaceName: 'Gamma', role: 'developer', createdAt: '2020-01-01T00:00:00.000Z' }

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** One Host workspace bringing a collab workspace's sessions to the GUI. */
function hostWorkspace(id: string, collabWorkspaceId: string, sessionIds: string[], title = id, path = `/collab/${id}`): WorkspaceView {
  return {
    workspaceId: wid(id), path, title,
    sessionIds: sessionIds.map(sid),
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    collab: { workspaceId: collabWorkspaceId },
  }
}

function sessionSummary(id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, ...overrides }
}

function sessionState(items: readonly SessionSummary[], current?: SessionId): SessionListState {
  return {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current,
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
    renameSession: vi.fn(async () => { }),
    forkSession: vi.fn(),
    archiveSession: vi.fn(async () => { }),
    renameWorkspace: vi.fn(async () => { }),
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
    previewPush: vi.fn(),
    pushBranch: vi.fn(),
    reorderSession: vi.fn(),
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
  host: { sessions?: readonly SessionSummary[]; workspaces?: readonly WorkspaceView[]; current?: SessionId } = {},
) {
  const injected = actions()
  return render((
    <CollabSection
      useCollabWorkspaces={sel => sel(state)}
      useSessions={sel => sel(sessionState(host.sessions ?? [], host.current))}
      useWorkspaces={sel => sel(hostState(host.workspaces ?? []))}
      actions={{ ...injected, ...overrides }}
      t={t}
      wide={true}
      expandSidebar={vi.fn()}
    />
  ))
}

/** A drag event object React can assign to: jsdom events carry no DataTransfer. */
function dragData(): { effectAllowed: string; dropEffect: string; setData: ReturnType<typeof vi.fn> } {
  return { effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn() }
}

/** Confine a row to a 0..10px box so `rowHalf` picks the marker from clientY. */
function boundRow(row: HTMLElement): void {
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: vi.fn(() => ({ top: 0, height: 10, bottom: 10, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) })),
  })
}

/** jsdom DragEvent ignores init props, so build the event and pin clientY/dataTransfer. */
function dragEvent(kind: string, clientY: number): Event {
  const event = new Event(kind, { bubbles: true })
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: dragData() })
  return event
}

function dragStart(source: HTMLElement): void {
  const event = new Event('dragstart', { bubbles: true })
  Object.defineProperty(event, 'dataTransfer', { value: dragData() })
  fireEvent(source, event)
}

function dragEnd(source: HTMLElement): void {
  fireEvent.dragEnd(source, {})
}

function dragOverAt(target: HTMLElement, half: 'before' | 'after'): void {
  boundRow(target)
  fireEvent(target, dragEvent('dragover', half === 'before' ? 2 : 8))
}

function dropAt(target: HTMLElement, half: 'before' | 'after'): void {
  boundRow(target)
  fireEvent(target, dragEvent('drop', half === 'before' ? 2 : 8))
}

describe('CollabSection', () => {
  it('renders nothing while the collab surface is absent', () => {
    section(readyState({ availability: 'hidden' }))
    expect(screen.queryByText('Workspaces')).toBeNull()
  })

  it('renders as the sidebar workspace section with search, view options, and add workspace', () => {
    section(readyState())
    // The block is an ARIA group labeled by its title — the sole occupant of
    // the sidebar's Workspaces seat (the local browsing region is gone).
    expect(screen.getByRole('group', { name: 'Workspaces' })).toBeTruthy()
    expect(screen.getByText('Workspaces')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View options' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '＋ New workspace' })).toBeTruthy()
  })

  it('collapsed rail keeps only the search control that expands the sidebar', () => {
    const expandSidebar = vi.fn()
    render((
      <CollabSection
        useCollabWorkspaces={sel => sel(readyState())}
        useSessions={sel => sel(sessionState([]))}
        useWorkspaces={sel => sel(hostState([]))}
        actions={actions()}
        t={t}
        wide={false}
        expandSidebar={expandSidebar}
      />
    ))
    // The wide body is not rendered at all in the rail: the only search
    // control present is the rail one, and clicking it requests the wide flip.
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.queryByText('Alpha')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(expandSidebar).toHaveBeenCalledTimes(1)
  })

  it('lands in the search box once the collapsed rail flips wide', () => {
    const expandSidebar = vi.fn()
    const { container, rerender } = render((
      <CollabSection
        useCollabWorkspaces={sel => sel(readyState())}
        useSessions={sel => sel(sessionState([]))}
        useWorkspaces={sel => sel(hostState([]))}
        actions={actions()}
        t={t}
        wide={false}
        expandSidebar={expandSidebar}
      />
    ))
    // The rail search arms the focus-on-expand flag and asks for the wide flip.
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(expandSidebar).toHaveBeenCalledTimes(1)
    // The shell flips wide in place: the flag's effect focuses the now-mounted
    // search input and clears itself, so the next flip does not re-focus.
    rerender((
      <CollabSection
        useCollabWorkspaces={sel => sel(readyState())}
        useSessions={sel => sel(sessionState([]))}
        useWorkspaces={sel => sel(hostState([]))}
        actions={actions()}
        t={t}
        wide={true}
        expandSidebar={expandSidebar}
      />
    ))
    const input = container.querySelector('input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('lists the member workspaces with their sessions inline and opens on click', () => {
    const open = vi.fn()
    section(
      readyState(),
      { open },
      {
        sessions: [sessionSummary('s1', 3), sessionSummary('s2', 1)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2'], 'Alpha')],
      },
    )
    expect(screen.getByRole('treeitem', { name: 'Alpha' })).toBeTruthy()
    expect(screen.getByText('2 members')).toBeTruthy()
    // Sessions render directly under the workspace row (the browsing region's
    // drill), no explicit expand needed.
    expect(screen.getByRole('treeitem', { name: 's1' })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: 's2' })).toBeTruthy()
    fireEvent.click(screen.getByRole('treeitem', { name: 's1' }))
    expect(open).toHaveBeenCalledWith('s1')
    // Clicking the workspace row folds its sessions back.
    fireEvent.click(screen.getByRole('treeitem', { name: 'Alpha' }))
    expect(screen.queryByRole('treeitem', { name: 's1' })).toBeNull()
    expect(screen.queryByRole('treeitem', { name: 's2' })).toBeNull()
    expect(screen.getByRole('treeitem', { name: 'Alpha' }).getAttribute('aria-expanded')).toBe('false')
    // And clicking again unfolds them.
    fireEvent.click(screen.getByRole('treeitem', { name: 'Alpha' }))
    expect(screen.getByRole('treeitem', { name: 's2' })).toBeTruthy()
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
    // The collab mount's sessions browse and open inline.
    expect(screen.getByRole('treeitem', { name: 's1' })).toBeTruthy()
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
    // workspace rows carry the hover actions instead of an empty-state note.
    section(readyState())
    expect(screen.queryByText('No sessions yet')).toBeNull()
    expect(screen.getByRole('treeitem', { name: 'Alpha' })).toBeTruthy()
  })

  it('renders a sessionless workspace row with an empty inline group and no placeholder', () => {
    // Alpha has a host mount but no sessions; the inline group mirrors the
    // browsing region's empty group: no explanatory note.
    section(
      readyState(),
      {},
      { workspaces: [hostWorkspace('hw1', 'w1', [], 'Alpha')], sessions: [] },
    )
    expect(screen.queryByText('No sessions yet')).toBeNull()
    expect(screen.queryAllByRole('treeitem', { name: /s/ })).toHaveLength(0)
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
    // starts the session in it — the same flow the manager surface uses. The
    // inline button sits inside the row, so the group stays unfolded.
    expect(openWorkspace).toHaveBeenCalledWith('w1')
    expect(screen.getByRole('treeitem', { name: 's1' })).toBeTruthy()
  })

  it('tags a cloning workspace and disables new sessions until it settles', () => {
    section(readyState({ workspaces: [{ ...ALPHA, cloneState: 'cloning' }] }))
    expect(screen.getByText('Cloning…')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'New session in Alpha' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows the branch and commit of a settled clone on the workspace folder', () => {
    section(readyState({ workspaces: [{ ...ALPHA, gitState: { branch: 'main', sha: 'a1b2c3', dirty: false } }] }))
    expect(screen.getByText('main · a1b2c3')).toBeTruthy()
  })

  it('flags a workspace folder whose working tree has uncommitted changes', () => {
    section(readyState({ workspaces: [{ ...ALPHA, gitState: { branch: 'feature/x', sha: 'dead12', dirty: true } }] }))
    expect(screen.getByText('● feature/x · dead12')).toBeTruthy()
    expect(screen.getByTitle('Uncommitted changes')).toBeTruthy()
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

  it('opens the workspace rename dialog from the Rename menu item, seeded with the current name', () => {
    const renameWorkspace = vi.fn(async () => { })
    section(readyState(), { renameWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = screen.getByRole('dialog', { name: 'Rename workspace' })
    const input = within(dialog).getByLabelText<HTMLInputElement>('Workspace name')
    expect(input.value).toBe('Alpha')
    expect(renameWorkspace).not.toHaveBeenCalled()
  })

  it('renames a workspace on confirm: unchanged drafts stay blocked, enter commits', async () => {
    const renameWorkspace = vi.fn(async () => { })
    section(readyState(), { renameWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Workspace name')
    // The seeded draft equals the current name: unchanged is blocked even
    // through the Enter accelerator, and the confirm button is disabled.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rename' }).disabled).toBe(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    // A blank draft is blocked the same way; a non-Enter key never confirms.
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'a' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    // While an IME composition is active Enter must not commit half a word.
    fireEvent.change(input, { target: { value: 'Eng' } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    // A real change commits the shared rename and closes the dialog.
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(renameWorkspace).toHaveBeenCalledWith('w1', 'Eng') })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('a rejected workspace rename keeps the dialog open with the error; typing clears it', async () => {
    const renameWorkspace = vi.fn(async () => { throw new Error('name taken') })
    section(readyState(), { renameWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText('Workspace name')
    fireEvent.change(input, { target: { value: 'Eng' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('name taken') })
    fireEvent.change(input, { target: { value: 'Eng 2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    // Cancel after a failure dismisses the dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports non-Error workspace rename failures as text', async () => {
    const renameWorkspace = vi.fn(async () => { throw 'denied' })
    section(readyState(), { renameWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Eng' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('while renaming a workspace the dialog locks: input disabled, close blocked, Enter ignored', async () => {
    let resolveRename!: () => void
    const renameWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveRename = resolve }))
    section(readyState(), { renameWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions for Alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Workspace name')
    fireEvent.change(input, { target: { value: 'Eng' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(renameWorkspace).toHaveBeenCalledWith('w1', 'Eng')
    expect(input.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
    // A second submit through the Enter accelerator is ignored while in flight.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).toHaveBeenCalledTimes(1)
    // Escape (mask/close) cannot dismiss the dialog while the rename runs.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { resolveRename() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('labels a blank collab session with the localized New Session row title', () => {
    section(
      readyState(),
      {},
      {
        sessions: [sessionSummary('s-blank', 1, { blank: true })],
        workspaces: [hostWorkspace('hw1', 'w1', ['s-blank'], 'Alpha')],
        current: sid('s-blank'),
      },
    )
    expect(screen.getByRole('treeitem', { name: 'New Session' })).toBeTruthy()
  })

  it('hides a blank New Session row once the current session moves elsewhere', () => {
    section(
      readyState(),
      {},
      {
        sessions: [sessionSummary('s-blank', 1, { blank: true }), sessionSummary('s-kept', 2)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s-blank', 's-kept'], 'Alpha')],
        // The untouched placeholder is not the selected session: like the
        // browsing region it disappears from the workspace row.
        current: sid('s-kept'),
      },
    )
    expect(screen.queryByRole('treeitem', { name: 'New Session' })).toBeNull()
    expect(screen.getByRole('treeitem', { name: 's-kept' })).toBeTruthy()
  })

  it('keeps a current blank session shown in flat mode and hides a departed one', () => {
    const { unmount } = section(
      readyState({ groupBy: 'flat', orderBy: 'manual' }),
      {},
      {
        sessions: [sessionSummary('s-blank', 1, { blank: true }), sessionSummary('s-kept', 2)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s-blank', 's-kept'], 'Alpha')],
        current: sid('s-blank'),
      },
    )
    // The selected placeholder keeps its account slot; the real session follows.
    expect(screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label'))).toEqual(['New Session', 's-kept'])
    unmount()
    // Leaving it hides the placeholder from flat mode too.
    section(
      readyState({ groupBy: 'flat', orderBy: 'manual' }),
      {},
      {
        sessions: [sessionSummary('s-blank', 1, { blank: true }), sessionSummary('s-kept', 2)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s-blank', 's-kept'], 'Alpha')],
        current: sid('s-kept'),
      },
    )
    expect(screen.queryByRole('treeitem', { name: 'New Session' })).toBeNull()
    expect(screen.getByRole('treeitem', { name: 's-kept' })).toBeTruthy()
  })

  it('shows the running/completed/pending status slot on session rows', () => {
    section(
      readyState(),
      {},
      {
        sessions: [
          sessionSummary('s-running', 5, { running: true }),
          sessionSummary('s-done', 4, { completed: true }),
          sessionSummary('s-wait', 3, { pendingInteraction: 'approval' }),
          sessionSummary('s-idle', 2),
        ],
        workspaces: [hostWorkspace('hw1', 'w1', ['s-running', 's-done', 's-wait', 's-idle'], 'Alpha')],
      },
    )
    // Status labels render screen-reader-hidden under the dot.
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.getByText('Waiting for approval')).toBeTruthy()
    // An idle session shows no status slot.
    expect(screen.queryByText('Idle')).toBeNull()
  })

  it('marks the currently-open session row as selected', () => {
    section(
      readyState(),
      {},
      {
        sessions: [sessionSummary('s1', 5), sessionSummary('s2', 1)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2'], 'Alpha')],
        current: sid('s1'),
      },
    )
    expect(screen.getByRole('treeitem', { name: 's1' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 's2' }).getAttribute('aria-selected')).toBe('false')
    // The workspace row containing the current session renders the folder
    // chrome (open + the active tint class is applied to its leading slot).
    const row = screen.getByRole('treeitem', { name: 'Alpha' })
    expect(row.querySelectorAll('span').length).toBeGreaterThan(0)
  })

  it('offers Rename/Fork/Archive on a non-blank session row through its hover menu', () => {
    section(
      readyState(),
      {},
      {
        sessions: [sessionSummary('s1', 5), sessionSummary('s2', 1)],
        workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2'], 'Alpha')],
      },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Fork' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Archive session' })).toBeTruthy()
  })

  it('carries no hover menu on a blank New Session placeholder', () => {
    section(
      readyState(),
      {},
      {
        sessions: [sessionSummary('s-blank', 1, { blank: true })],
        workspaces: [hostWorkspace('hw1', 'w1', ['s-blank'], 'Alpha')],
        current: sid('s-blank'),
      },
    )
    expect(screen.getByRole('treeitem', { name: 'New Session' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Session actions/ })).toBeNull()
  })

  it('opens the session on row click but not on its menu button', () => {
    const open = vi.fn()
    section(
      readyState(),
      { open },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    expect(open).not.toHaveBeenCalled()
    // The menu list sits in a portal; clicking the row itself still opens it.
    fireEvent.click(screen.getByRole('treeitem', { name: 's1' }))
    expect(open).toHaveBeenCalledWith(sid('s1'))
  })

  it('forks a shared session from its row menu', () => {
    const forkSession = vi.fn()
    section(
      readyState(),
      { forkSession },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork' }))
    expect(forkSession).toHaveBeenCalledWith(sid('s1'))
  })

  it('archives a shared session from its row menu and surfaces a rejection as a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
    const archiveSession = vi.fn(async () => { throw new Error('denied') })
    try {
      section(
        readyState(),
        { archiveSession },
        { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
      )
      fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Archive session' }))
      expect(archiveSession).toHaveBeenCalledWith(sid('s1'))
      await waitFor(() => { expect(warn).toHaveBeenCalledTimes(1) })
      const call = warn.mock.calls[0]!
      expect(call[0]!).toBe('collab session archive rejected:')
      expect(call[1]).toBeInstanceOf(Error)
    } finally {
      warn.mockRestore()
    }
  })

  it('shows the same session row menu in flat mode and forks from it', () => {
    const forkSession = vi.fn()
    section(
      readyState({ groupBy: 'flat', orderBy: 'manual' }),
      { forkSession },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork' }))
    expect(forkSession).toHaveBeenCalledWith(sid('s1'))
  })

  it('closes the session row menu through Escape', () => {
    section(
      readyState(),
      {},
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    expect(screen.getByRole('menuitem', { name: 'Fork' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: 'Fork' })).toBeNull()
  })

  it('renames a shared session through the dialog: seeded draft, confirm closes', async () => {
    const renameSession = vi.fn(async () => { })
    section(
      readyState(),
      { renameSession },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Session name')
    expect(input.value).toBe('s1')
    fireEvent.change(input, { target: { value: 'Research log' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => { expect(renameSession).toHaveBeenCalledWith(sid('s1'), 'Research log') })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('keeps the rename from an empty draft and while composing, then commits on Enter', async () => {
    const renameSession = vi.fn(async () => { })
    section(
      readyState(),
      { renameSession },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Session name')
    expect(input.value).toBe('s1')
    // A blank draft blocks the confirm even through the Enter accelerator.
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    // While an IME composition is active Enter must not commit half a word.
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.change(input, { target: { value: 'Research log' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(renameSession).toHaveBeenCalledWith(sid('s1'), 'Research log') })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('a rejected rename keeps the dialog open with the error surfaced; typing clears it', async () => {
    const renameSession = vi.fn(async () => { throw new Error('rename conflict') })
    section(
      readyState(),
      { renameSession },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText('Session name')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('rename conflict') })
    fireEvent.change(input, { target: { value: 'Renamed 2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports non-Error rename failures as text', async () => {
    const renameSession = vi.fn(async () => { throw 'denied' })
    section(
      readyState(),
      { renameSession },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('while renaming the dialog locks: input disabled, close blocked, Enter ignored', async () => {
    let resolveRename!: () => void
    const renameSession = vi.fn(() => new Promise<void>((resolve) => { resolveRename = resolve }))
    section(
      readyState(),
      { renameSession },
      { sessions: [sessionSummary('s1', 5)], workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')] },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for s1' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Session name')
    fireEvent.change(input, { target: { value: 'Busy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(renameSession).toHaveBeenCalledWith(sid('s1'), 'Busy')
    expect(input.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
    // A second submit through the Enter accelerator is ignored while in flight.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).toHaveBeenCalledTimes(1)
    // Escape (mask/close) cannot dismiss the dialog while the rename runs.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { resolveRename() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the workspace hover card with name, member count, mount path, and created time', () => {
    vi.useFakeTimers()
    try {
      section(
        readyState(),
        {},
        { workspaces: [hostWorkspace('hw1', 'w1', [], 'Alpha')], sessions: [] },
      )
      const wrapper = screen.getByRole('treeitem', { name: 'Alpha' }).parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      // Card body: the row title repeated in white, the member count, the
      // mount directory, and the absolute creation line.
      expect(screen.getAllByText('Alpha')).toHaveLength(2)
      expect(screen.getAllByText('2 members')).toHaveLength(2)
      expect(screen.getByText('/collab/hw1')).toBeTruthy()
      expect(screen.getByText(/^Created /)).toBeTruthy()
      fireEvent.pointerLeave(wrapper)
    } finally {
      vi.useRealTimers()
    }
  })

  it('omits the path from the workspace hover card until the workspace is mounted', () => {
    vi.useFakeTimers()
    try {
      // The collab workspace is listed but its auto-mount has not echoed yet:
      // the hover card keeps the title and member count but drops the path
      // (and its copy affordance).
      section(readyState())
      const wrapper = screen.getByRole('treeitem', { name: 'Alpha' }).parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('2 members')).toHaveLength(2)
      expect(screen.queryByText('/collab/')).toBeNull()
      expect(screen.queryByRole('button', { name: /^Copy:/ })).toBeNull()
      fireEvent.pointerLeave(wrapper)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the session hover card with its status but no timestamp for a blank row', () => {
    vi.useFakeTimers()
    try {
      section(
        readyState(),
        {},
        {
          sessions: [sessionSummary('s1', 5, { running: true, blank: true })],
          workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')],
          current: sid('s1'),
        },
      )
      const wrapper = screen.getByRole('treeitem', { name: 'New Session' }).parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      // The row's screen-reader status label and the card's status line both
      // read Running; a blank row keeps both time cells out.
      expect(screen.getAllByText('Running')).toHaveLength(2)
      expect(screen.queryByText(/^now$/)).toBeNull()
      fireEvent.pointerLeave(wrapper)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the relative time line on a non-blank session hover card', () => {
    vi.useFakeTimers()
    try {
      section(
        readyState(),
        {},
        {
          sessions: [sessionSummary('s1', Date.now() - 5 * 60_000, { completed: true })],
          workspaces: [hostWorkspace('hw1', 'w1', ['s1'], 'Alpha')],
        },
      )
      const wrapper = screen.getByRole('treeitem', { name: 's1' }).parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('5min ago')).toBeTruthy()
      fireEvent.pointerLeave(wrapper)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps a workspace’s inline sessions and exposes the overflow control', () => {
    section(
      readyState(),
      {},
      {
        sessions: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id, index) => sessionSummary(id, 9 - index)),
        workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], 'Alpha')],
      },
    )
    // First five render; the sixth is behind the overflow button.
    expect(screen.getByRole('treeitem', { name: 's5' })).toBeTruthy()
    expect(screen.queryByRole('treeitem', { name: 's6' })).toBeNull()
    const overflow = screen.getByRole('button', { name: 'Show 2 more sessions' })
    fireEvent.click(overflow)
    expect(screen.getByRole('treeitem', { name: 's7' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByRole('treeitem', { name: 's6' })).toBeNull()
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
    const titles = screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label'))
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
    const sorted = screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label'))
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
    const titles = screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label'))
    expect(titles.indexOf('newer')).toBeGreaterThan(-1)
    expect(titles.indexOf('older')).toBeGreaterThan(-1)
    expect(titles.indexOf('newer')).toBeLessThan(titles.indexOf('older'))
  })

  it('renders each session row as draggable', () => {
    section(readyState(), {}, {
      sessions: [sessionSummary('s1', 1), sessionSummary('s2', 2)],
      workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2'], 'Alpha')],
    })
    expect(screen.getByRole('treeitem', { name: 's1' }).getAttribute('draggable')).toBe('true')
    expect(screen.getByRole('treeitem', { name: 's2' }).getAttribute('draggable')).toBe('true')
  })

  it('reorders a session before a target within its workspace on drop', () => {
    const reorderSession = vi.fn()
    section(readyState({ orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('s1', 1), sessionSummary('s2', 2), sessionSummary('s3', 3)],
      workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2', 's3'], 'Alpha')],
    })
    dragStart(screen.getByRole('treeitem', { name: 's1' }))
    // While a drag is active the document accepts native drags; a transferless
    // dragover still must be prevented from default without touching its null
    // DataTransfer.
    const nativeOver = new Event('dragover', { bubbles: true })
    Object.defineProperty(nativeOver, 'dataTransfer', { value: null })
    fireEvent(document, nativeOver)
    dragOverAt(screen.getByRole('treeitem', { name: 's3' }), 'before')
    dropAt(screen.getByRole('treeitem', { name: 's3' }), 'before')
    expect(reorderSession).toHaveBeenCalledExactlyOnceWith('hw1', 's1', 's3')
  })

  it('reorders a session after a target through its successor anchor', () => {
    const reorderSession = vi.fn()
    section(readyState({ orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('s1', 1), sessionSummary('s2', 2), sessionSummary('s3', 3)],
      workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2', 's3'], 'Alpha')],
    })
    dragStart(screen.getByRole('treeitem', { name: 's1' }))
    dragOverAt(screen.getByRole('treeitem', { name: 's2' }), 'after')
    dropAt(screen.getByRole('treeitem', { name: 's2' }), 'after')
    expect(reorderSession).toHaveBeenCalledExactlyOnceWith('hw1', 's1', 's3')
  })

  it('skips a drop that does not move the session', () => {
    const reorderSession = vi.fn()
    section(readyState({ orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('s1', 1), sessionSummary('s2', 2), sessionSummary('s3', 3)],
      workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2', 's3'], 'Alpha')],
    })
    dragStart(screen.getByRole('treeitem', { name: 's1' }))
    dropAt(screen.getByRole('treeitem', { name: 's2' }), 'before')
    expect(reorderSession).not.toHaveBeenCalled()
  })

  it('commits the last marker on drag end when the pointer drops nowhere', () => {
    const reorderSession = vi.fn()
    section(readyState({ orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('s1', 1), sessionSummary('s2', 2), sessionSummary('s3', 3)],
      workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2', 's3'], 'Alpha')],
    })
    dragStart(screen.getByRole('treeitem', { name: 's1' }))
    dragOverAt(screen.getByRole('treeitem', { name: 's3' }), 'before')
    dragEnd(screen.getByRole('treeitem', { name: 's1' }))
    expect(reorderSession).toHaveBeenCalledExactlyOnceWith('hw1', 's1', 's3')
  })

  it('clears a drag that never marked a row', () => {
    const reorderSession = vi.fn()
    section(readyState({ orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('s1', 1), sessionSummary('s2', 2)],
      workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2'], 'Alpha')],
    })
    dragStart(screen.getByRole('treeitem', { name: 's1' }))
    dragEnd(screen.getByRole('treeitem', { name: 's1' }))
    expect(reorderSession).not.toHaveBeenCalled()
  })

  it('commits a drop once even when the drag end follows', () => {
    const reorderSession = vi.fn()
    section(readyState({ orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('s1', 1), sessionSummary('s2', 2), sessionSummary('s3', 3)],
      workspaces: [hostWorkspace('hw1', 'w1', ['s1', 's2', 's3'], 'Alpha')],
    })
    dragStart(screen.getByRole('treeitem', { name: 's1' }))
    dragOverAt(screen.getByRole('treeitem', { name: 's3' }), 'before')
    dropAt(screen.getByRole('treeitem', { name: 's3' }), 'before')
    dragEnd(screen.getByRole('treeitem', { name: 's1' }))
    expect(reorderSession).toHaveBeenCalledTimes(1)
  })

  it('ignores a row dragged onto another workspace', () => {
    const reorderSession = vi.fn()
    section(readyState({ orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('alpha-a', 1), sessionSummary('beta-x', 2)],
      workspaces: [
        hostWorkspace('hw1', 'w1', ['alpha-a'], 'Alpha'),
        hostWorkspace('hw2', 'w2', ['beta-x'], 'Beta'),
      ],
    })
    dragStart(screen.getByRole('treeitem', { name: 'alpha-a' }))
    dragOverAt(screen.getByRole('treeitem', { name: 'beta-x' }), 'before')
    dropAt(screen.getByRole('treeitem', { name: 'beta-x' }), 'before')
    expect(reorderSession).not.toHaveBeenCalled()
  })

  it('reorders within the same workspace in flat mode too', () => {
    const reorderSession = vi.fn()
    section(readyState({ groupBy: 'flat', orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('a1', 1), sessionSummary('a2', 2)],
      workspaces: [hostWorkspace('hw1', 'w1', ['a1', 'a2'], 'Alpha')],
    })
    dragStart(screen.getByRole('treeitem', { name: 'a2' }))
    dragOverAt(screen.getByRole('treeitem', { name: 'a1' }), 'before')
    dropAt(screen.getByRole('treeitem', { name: 'a1' }), 'before')
    expect(reorderSession).toHaveBeenCalledExactlyOnceWith('hw1', 'a2', 'a1')
  })

  it('keeps a flat drag inside its owner workspace', () => {
    const reorderSession = vi.fn()
    section(readyState({ groupBy: 'flat', orderBy: 'manual' }), { reorderSession }, {
      sessions: [sessionSummary('alpha-s', 1), sessionSummary('beta-s', 2)],
      workspaces: [
        hostWorkspace('hw1', 'w1', ['alpha-s'], 'Alpha'),
        hostWorkspace('hw2', 'w2', ['beta-s'], 'Beta'),
      ],
    })
    dragStart(screen.getByRole('treeitem', { name: 'alpha-s' }))
    dragOverAt(screen.getByRole('treeitem', { name: 'beta-s' }), 'before')
    dropAt(screen.getByRole('treeitem', { name: 'beta-s' }), 'before')
    expect(reorderSession).not.toHaveBeenCalled()
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
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    expect(screen.getByText('beta-s')).toBeTruthy()
    expect(screen.getByText('alpha-s')).toBeTruthy()
    fireEvent.click(screen.getByRole('treeitem', { name: 'beta-s' }))
    expect(open).toHaveBeenCalledWith('beta-s')
    unmount()
    // Workspace mode restores the workspace rows.
    section(readyState(), { open })
    expect(screen.getByRole('treeitem', { name: 'Alpha' })).toBeTruthy()
  })

  it('orders the list by creation recency under the updated view option', () => {
    section(readyState({ orderBy: 'updated' }))
    const names = screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label'))
    // Beta (2021) precedes Alpha (2020).
    expect(names[0]).toBe('Beta')
    expect(names[1]).toBe('Alpha')
  })

  it('keeps the server-provided order under the manual view option', () => {
    // Server order: Alpha before Beta; 'manual' leaves it untouched.
    section(readyState({ orderBy: 'manual', workspaces: [BETA, ALPHA] }))
    const names = screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label'))
    expect(names[0]).toBe('Beta')
    expect(names[1]).toBe('Alpha')
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
    expect(screen.getByText('Workspaces')).toBeTruthy()
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

  it('renders workspace tree rows with the fold chrome only in the grouped mode', () => {
    const { unmount } = section(readyState())
    const row = screen.getByRole('treeitem', { name: 'Alpha' })
    // Default group state is unfolded, so the first row is expanded.
    expect(row.getAttribute('aria-expanded')).toBe('true')
    unmount()
    // Flat mode has no workspace rows at all — its list is the sessions.
    section(readyState({ groupBy: 'flat' }))
    expect(screen.queryByRole('treeitem', { name: 'Alpha' })).toBeNull()
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
        wide={true}
        expandSidebar={vi.fn()}
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
        wide={true}
        expandSidebar={vi.fn()}
      />
    ))
    expect(screen.queryByRole('button', { name: '＋ New workspace' })).not.toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })
})
