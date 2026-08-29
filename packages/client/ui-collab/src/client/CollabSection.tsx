// CollabSection: the collaborative-workspaces section that sits right below
// the sidebar's local Workspaces browsing region. It mirrors that region's
// format: a section header (title, expanding search, view options, and the
// add-workspace button that opens the creation dialog), then the member
// workspaces as rows. Each collab workspace is mounted in the background on
// render so its shared sessions (including ones other members created) are
// browsable immediately; a workspace row expands to reveal its sessions, and
// clicking a session opens it — the same drill as the local section. Pending
// invitations keep their inline accept rows above the list. It renders
// nothing while the collab surface is absent, so a single-user web install's
// browsing region is unchanged.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCloseFill14,
  IconEllipsisOutline16, IconFolderOpen16, IconPersonalizationOutline16,
  IconPlusOutline16, IconProjectAddOutline16, IconSearchOutline16,
  IconTrashOutline16, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { CreateWorkspace } from './CreateWorkspace.tsx'
import type { CollabWorkspaceView } from './contract.ts'
import type { NS } from './locales.ts'
import type { CollabGroupBy, CollabOrderBy } from './store.ts'
import type { CollabWorkspacesActions, CollabWorkspacesInjected } from './WorkspacesPanel.tsx'
import css from './CollabSection.module.css'

/** Composed section props: the inject face + the locale seat + the root-scope standard seats. */
export type CollabSectionProps = InjectFace<CollabWorkspacesInjected>
  & PropsLocale<typeof NS>
  & PropsRuntime<'sidebar.workspaces.collab'>

/** Keep the controlled search value free of NUL characters (display-only filter). */
function sanitizeSearchQuery(value: string): string {
  return value.replaceAll('\0', '')
}

/**
 * Grouping and ordering menu mirroring the local Workspaces browser's view
 * options; own open state so it resets with the wide chrome.
 */
function CollabViewOptions({ groupBy, orderBy, onGroupPick, onOrderPick, t }: {
  groupBy: CollabGroupBy
  orderBy: CollabOrderBy
  onGroupPick: (mode: CollabGroupBy) => void
  onOrderPick: (mode: CollabOrderBy) => void
  t: CollabSectionProps['t']
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { type: 'label' as const, id: 'group-by', text: t('groupByLabel') },
        { id: 'workspace', label: t('groupByWorkspace') },
        { id: 'flat', label: t('groupByFlat') },
        { type: 'separator' as const, id: 'order-by-separator' },
        { type: 'label' as const, id: 'order-by', text: t('orderByLabel') },
        { id: 'manual', label: t('orderByManual') },
        { id: 'updated', label: t('orderByUpdated') },
      ]}
      selectedIds={[groupBy, orderBy]}
      onSelect={(id) => {
        // The four declared item ids are the whole domain the Menu can hand
        // back: the two group ids map to grouping, the two order ids to ordering.
        if (id === 'workspace' || id === 'flat') onGroupPick(id)
        else onOrderPick(id as CollabOrderBy)
        setOpen(false)
      }}
      align="end"
      dense
      // Portal: the section header clips overflow, so an in-place list would
      // be cut off at the header's bounds.
      portal
      anchor={(
        <Tooltip label={t('viewOptions')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('viewOptions')}
            onClick={() => { setOpen(v => !v) }}
          >
            <IconPersonalizationOutline16 />
          </button>
        </Tooltip>
      )}
    />
  )
}

/**
 * Render the collaborative-workspaces section beneath the browsing list while
 * the collab surface is ready.
 * @param props - the workspaces store hook, the root-scope session and
 *   workspace seats, plus the collab actions and the locale seat.
 * @returns the section, or null when no collab surface applies.
 */
export function CollabSection({
  useCollabWorkspaces, useSessions, useWorkspaces, actions, t,
}: CollabSectionProps): ReactNode {
  const state = useCollabWorkspaces(current => current)
  // The search and mount hooks run on every render, including ones the
  // availability guard will skip: the verdict can flip to 'ready' on an
  // already-mounted section, and a return before them changes the hook count
  // between renders (the mounted section crashes with React #310).
  const [query, setQuery] = useState('')
  const [searchExpanded, setSearchExpanded] = useState(false)
  const normalizedQuery = sanitizeSearchQuery(query).trim()
  const searchRoot = useRef<HTMLDivElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (searchExpanded) searchInput.current?.focus({ preventScroll: true })
  }, [searchExpanded])

  // Outside-click dismissal mirrors the local browser's search: an empty
  // query collapses the capsule when the pointer leaves it.
  useEffect(() => {
    if (!searchExpanded) return
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return
      searchInput.current?.blur()
      if (normalizedQuery !== '') return
      setSearchExpanded(false)
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, [normalizedQuery, searchExpanded])

  // Root-scope standard seats: the collab sessions ARE the Host sessions of
  // the mounted collab workspaces, so the section reads them from the shared
  // runtime list — the same fact source the local browser uses.
  const sessionsState = useSessions(current => current)
  const byId = sessionsState.byId
  const hostWorkspaces = useWorkspaces(current => current.items)
  // Collab workspace id -> its Host mount (the record the collab `open` created).
  const hostByCollabId = useMemo(() => {
    const byCollabId = new Map<string, WorkspaceView>()
    for (const workspace of hostWorkspaces) {
      const collab = workspace.collab
      if (collab !== undefined) byCollabId.set(collab.workspaceId, workspace)
    }
    return byCollabId
  }, [hostWorkspaces])
  // Component-local viewing state: which collab workspace rows are expanded,
  // and which row's options menu is open (shown while hovered or expanded).
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<ReadonlySet<string>>(new Set())
  const [menuOpenWorkspaceId, setMenuOpenWorkspaceId] = useState<string | null>(null)
  const toggleExpansion = (workspaceId: string): void => {
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }

  // Background materialization: mount every collab workspace the runtime does
  // not yet reflect, so its sessions (even ones created by other members) show
  // up without an explicit open. The Idempotent mount makes re-runs no-ops;
  // re-running when the collab list changes picks up newly joined workspaces.
  useEffect(() => {
    if (state.availability !== 'ready') return
    actions.mountAll()
    // Intentional narrow deps: firing on every session/runtime movement would
    // be wrong; the runtime list converges from the mount calls themselves.
  }, [state.availability, state.workspaces])

  if (state.availability !== 'ready') return null

  // Grouping modes: workspace rows with nested sessions, or one flat session
  // list. Order mode 'updated' sorts by creation recency for the rows and by
  // session recency for the sessions; 'manual' keeps the server list order
  // and, inside a workspace, the Host session account order.
  const orderedWorkspaces = state.orderBy === 'updated'
    ? [...state.workspaces].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : state.workspaces
  const queryLower = normalizedQuery.toLowerCase()
  const visibleWorkspaces = queryLower === ''
    ? orderedWorkspaces
    : orderedWorkspaces.filter(workspace => workspace.name.toLowerCase().includes(queryLower))

  const sessionIdsOf = (workspace: CollabWorkspaceView): readonly SessionId[] => {
    const host = hostByCollabId.get(workspace.id)
    if (host === undefined) return []
    // `sessionIds` may lead the list pull, so drop ids the session store has
    // not pulled yet; the rest are guaranteed present below.
    const ids = host.sessionIds.filter(id => byId[id] !== undefined)
    if (state.orderBy !== 'updated') return ids
    return ids
      .map(id => byId[id] as SessionSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summary => summary.id)
  }

  // Flat mode rows: every collab session, workspace group then session order,
  // or newest-first under 'updated'. A session id appears in at most one Host
  // account, but dedupe defensively against any ledger anomaly.
  const flatSessions: SessionSummary[] = []
  const seen = new Set<SessionId>()
  for (const workspace of orderedWorkspaces) {
    for (const id of sessionIdsOf(workspace)) {
      if (seen.has(id)) continue
      seen.add(id)
      flatSessions.push(byId[id] as SessionSummary)
    }
  }
  if (state.groupBy === 'flat' && state.orderBy === 'updated') {
    flatSessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  const visibleFlatSessions = queryLower === ''
    ? flatSessions
    : flatSessions.filter(session => sessionLabel(session, t).toLowerCase().includes(queryLower))

  const showNoMatches = state.workspaces.length > 0 && normalizedQuery !== ''
    && (state.groupBy === 'flat'
      ? visibleFlatSessions.length === 0
      : visibleWorkspaces.length === 0)

  return (
    <section className={css.root} aria-label={t('title')}>
      <div className={css.sectionHeader}>
        <span className={clsx(css.sectionLabel, searchExpanded && css.sectionLabelHidden)}>{t('title')}</span>
        <div className={clsx(css.searchSlot, searchExpanded && css.searchSlotExpanded)}>
          <div
            ref={searchRoot}
            className={clsx(css.search, searchExpanded && css.searchExpanded)}
            onClick={() => { setSearchExpanded(true) }}
          >
            <Tooltip label={t('search')} side="bottom" delayMs={500} disabled={searchExpanded}>
              <button
                type="button"
                className={css.searchButton}
                aria-label={t('search')}
                aria-expanded={searchExpanded}
                onClick={() => { setSearchExpanded(true) }}
              >
                <IconSearchOutline16 size={searchExpanded ? 11 : 14} />
              </button>
            </Tooltip>
            <input
              ref={searchInput}
              className={css.searchInput}
              type="text"
              placeholder={t('searchPlaceholder')}
              value={query}
              tabIndex={searchExpanded ? 0 : -1}
              onChange={(e) => { setQuery(sanitizeSearchQuery(e.target.value)) }}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                setQuery('')
                setSearchExpanded(false)
              }}
            />
            {searchExpanded && (
              <button
                type="button"
                className={css.clearButton}
                aria-label={t('searchClear')}
                onClick={(e) => {
                  e.stopPropagation()
                  setQuery('')
                  setSearchExpanded(false)
                }}
              >
                <IconCloseFill14 />
              </button>
            )}
          </div>
        </div>
        <div className={clsx(css.headerActions, searchExpanded && css.headerActionsHidden)}>
          <CollabViewOptions
            groupBy={state.groupBy}
            orderBy={state.orderBy}
            onGroupPick={(mode) => { actions.setGroupBy(mode) }}
            onOrderPick={(mode) => { actions.setOrderBy(mode) }}
            t={t}
          />
          {/* Adding is the header's one action: the icon button opens the same
              creation dialog the manager's dashed entry uses. */}
          <CreateWorkspace
            actions={actions}
            error={state.error}
            t={t}
            renderTrigger={openDialog => (
              <Tooltip label={t('newWorkspace')} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('newWorkspace')}
                  onClick={openDialog}
                >
                  <IconProjectAddOutline16 />
                </button>
              </Tooltip>
            )}
          />
        </div>
      </div>

      {/* Pending invitations keep their inline accept rows above the list. */}
      {state.invitationsForMe.length > 0 && (
        <div className={css.invitations}>
          {state.invitationsForMe.map(invitation => (
            <div key={invitation.id} className={css.invitationRow}>
              <span className={css.invitationName}>{invitation.workspaceName}</span>
              <button
                type="button"
                className={css.acceptButton}
                onClick={() => { actions.acceptInvitation(invitation.id) }}
              >
                {t('accept')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={css.listArea}>
        {state.workspaces.length === 0 && state.invitationsForMe.length === 0 && (
          <div className={css.empty}>{t('empty')}</div>
        )}
        {showNoMatches && (
          <div className={css.empty}>{t('searchNoMatches')}</div>
        )}
        {state.groupBy === 'flat'
          ? visibleFlatSessions.map(session => (
            <button
              key={session.id}
              type="button"
              className={css.sessionRow}
              aria-label={t('sessionOpen')}
              onClick={() => { actions.open(session.id) }}
            >
              <span className={css.sessionTitle}>{sessionLabel(session, t)}</span>
            </button>
          ))
          : visibleWorkspaces.map((workspace) => {
            const expandedState = expandedWorkspaces.has(workspace.id)
            const sessionIds = sessionIdsOf(workspace)
            const menuOpen = menuOpenWorkspaceId === workspace.id
            return (
              <div key={workspace.id} className={css.group}>
                <div className={css.rowWrapper}>
                  <button
                    type="button"
                    className={css.row}
                    aria-expanded={expandedState}
                    onClick={() => { toggleExpansion(workspace.id) }}
                  >
                    <span className={css.chevron} aria-hidden="true">
                      {expandedState ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                    </span>
                    <span className={css.folderSlot} aria-hidden="true"><IconFolderOpen16 /></span>
                    <span className={css.rowName}>{workspace.name}</span>
                    <span className={css.rowMeta}>{t('memberCount', { count: String(workspace.memberCount) })}</span>
                  </button>
                  {/* Hover actions mirror the browsing region's workspace rows: an
                      options menu (Manage / Delete) and a New Session button. */}
                  <span className={clsx(css.rowActions, menuOpen && css.rowActionsOpen)}>
                    <Menu
                      open={menuOpen}
                      onClose={() => { setMenuOpenWorkspaceId(null) }}
                      items={[
                        { id: 'manage', label: t('openManager'), icon: <IconPersonalizationOutline16 /> },
                        { id: 'delete', label: t('deleteWorkspace'), icon: <IconTrashOutline16 />, danger: true },
                      ]}
                      onSelect={(id) => {
                        setMenuOpenWorkspaceId(null)
                        handleRowMenuSelect(id, workspace.id, actions)
                      }}
                      portal
                      closeOnPointerLeave
                      anchor={(
                        <button
                          type="button"
                          className={css.iconButton}
                          aria-label={t('workspaceActionsAria', { name: workspace.name })}
                          onClick={() => { setMenuOpenWorkspaceId(current => current === workspace.id ? null : workspace.id) }}
                        >
                          <IconEllipsisOutline16 />
                        </button>
                      )}
                    />
                    <button
                      type="button"
                      className={css.iconButton}
                      aria-label={t('newSessionAria', { name: workspace.name })}
                      // New Session mounts the collab workspace (idempotent when
                      // it already is) and starts a session in it, exactly like
                      // the browsing region's row button — so the click works
                      // even before the background auto-mount echoes the Host
                      // record, and a failure surfaces in the manager banner.
                      onClick={() => { actions.openWorkspace(workspace.id) }}
                    >
                      <IconPlusOutline16 />
                    </button>
                  </span>
                </div>
                {expandedState && (
                  <div className={css.sessionList}>
                    {sessionIds
                      .map(id => byId[id])
                      .filter((summary): summary is SessionSummary => summary !== undefined)
                      .map(summary => (
                        <button
                          key={summary.id}
                          type="button"
                          className={css.sessionRow}
                          aria-label={t('sessionOpen')}
                          onClick={() => { actions.open(summary.id) }}
                        >
                          <span className={css.sessionTitle}>{sessionLabel(summary, t)}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )
          })}
      </div>
    </section>
  )
}

/** The row label for a collab session: the localized New Session name for blank rows. */
function sessionLabel(session: SessionSummary, t: CollabSectionProps['t']): string {
  return session.blank ? t('newSession') : session.displayTitle
}

/**
 * Dispatch one row-options menu item for a collab workspace. Unknown ids fail
 * closed before the dispatch so a future menu row never inherits the
 * destructive branch as an else fallback.
 * @param id - the selected menu item id.
 * @param workspaceId - the collab workspace the row refers to.
 * @param actions - the collab actions face to drive.
 */
export function handleRowMenuSelect(id: string, workspaceId: string, actions: CollabWorkspacesActions): void {
  if (id !== 'manage' && id !== 'delete') return
  if (id === 'manage') actions.openManager(workspaceId)
  else actions.delete(workspaceId)
}
