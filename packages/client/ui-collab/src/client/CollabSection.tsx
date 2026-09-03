// CollabSection: the collaborative-workspaces section that fills the sidebar's
// single Workspaces seat (it replaced the local browsing region as the
// sidebar's workspace surface). It is a section: a title ("Private
// Workspaces") plus its own toolbar (expanding search, view options, and the
// add-workspace button that opens the creation dialog), then the member
// workspaces as rows. Each collab workspace is mounted in the background on
// render so its shared sessions (including ones other members created) are
// browsable immediately; sessions render inline under each workspace row (the
// browsing region's drill), and clicking a session opens it. Rows mirror the
// browsing region's cell anatomy: folder chrome that swaps to the expand
// chevron on hover, inline hover-revealed row actions, a status slot and
// relative time on session rows, and hover cards for both. Shared sessions are
// read-only, so session rows carry no rename/fork/archive actions. Pending
// invitations keep their inline accept rows above the list. The collapsed rail
// (wide=false) keeps only a search control that expands the sidebar, mirroring
// the browsing region's rail. It renders nothing while the collab surface is
// absent, so a single-user web install's sidebar workspace seat is empty.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, HoverCard, IconArchiveOutline20, IconBranchOutline16, IconCloseFill14,
  IconEditOutline16, IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16,
  IconPersonalizationOutline16, IconPlusOutline16, IconProjectAddOutline16,
  IconRefreshOutline16, IconRightUpOutline16, IconSearchOutline16, IconTrashOutline16,
  IconTriangleRightFill14, Menu, Modal, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionId, SessionSummary, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  collabSessionStatuses, collabSessionTitle, createdLabel, hoverTimeLabel,
  timeLabel, type CollabRowTranslate, type CollabSessionStatus,
} from './collab-rows.ts'
import { nextCollabSessionOrder } from './collab-order.ts'
import { CreateWorkspace } from './CreateWorkspace.tsx'
import type { CollabPushView, CollabWorkspaceView } from './contract.ts'
import { pushOutcomeCopy, pushPreviewCopy } from './push-copy.ts'
import { sessionBranchName } from './session-branch.ts'
import type { NS } from './locales.ts'
import type { CollabGroupBy, CollabOrderBy } from './store.ts'
import type { CollabWorkspacesActions, CollabWorkspacesInjected } from './WorkspacesPanel.tsx'
import css from './CollabSection.module.css'

/** Composed section props: the inject face + the locale seat + the root-scope standard seats. */
export type CollabSectionProps = InjectFace<CollabWorkspacesInjected>
  & PropsLocale<typeof NS>
  & PropsRuntime<'sidebar.workspaces'>

/** Session rows visible per Workspace before the overflow control (mirrors the browsing region). */
const COLLAPSED_SESSION_LIMIT = 5

/** Keep the controlled search value free of NUL characters (display-only filter). */
function sanitizeSearchQuery(value: string): string {
  return value.replaceAll('\0', '')
}

/**
 * Row drag wiring supplied by the session-row owner, mirroring the browsing
 * region's row drag contract. `drop` reports the half of the row where the
 * pointer released so the owner can resolve an insert anchor.
 */
export interface CollabRowDragProps {
  /** Start dragging this row. */
  start: () => void
  /** A compatible row drag is in flight. */
  active: boolean
  /** Current marker on this row: insert line above, below, or none. */
  marker: 'before' | 'after' | null
  /** Report the hovered half while a compatible drag passes over this row. */
  hover: (half: 'before' | 'after') => void
  drop: (half: 'before' | 'after') => void
  end: () => void
}

/** Pointer-position half of a row (insert line above or below). */
function rowHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** In-flight session-row drag: the source workspace plus the current marker. */
export interface CollabDragState {
  /** The collab workspace owning the dragged session (its shared order account). */
  workspaceId: string
  sessionId: SessionId
  /** The row the marker sits on and which half (insert above/below it). */
  over: { id: SessionId; half: 'before' | 'after' } | null
}

/**
 * Resolve one session-row drag commit against an ordered account: compute the
 * insert anchor from the dropped row's half (before = that row, after = the
 * next account row; a trailing row appends), skip no-op positions, and report
 * the move to the shared order — anchor omitted appends. Exported so the
 * anchor math and no-op skips are directly unit-tested; the section binds its
 * reorder action here.
 * @param activeDrag - the in-flight drag source.
 * @param over - the row and half where the pointer released.
 * @param order - the account's current displayed order.
 * @param reorder - report one move (session id plus optional anchor).
 */
export function commitCollabSessionDrag(
  activeDrag: CollabDragState,
  over: NonNullable<CollabDragState['over']>,
  order: readonly SessionId[],
  reorder: (sessionId: string, beforeSessionId?: string) => void,
): void {
  const targetIndex = order.findIndex(id => id === over.id)
  if (targetIndex === -1) return
  const anchor = over.half === 'before' ? over.id : order[targetIndex + 1]
  if (anchor === activeDrag.sessionId) return
  const sourceIndex = order.findIndex(id => id === activeDrag.sessionId)
  const anchorIndex = anchor === undefined ? order.length : order.findIndex(id => id === anchor)
  if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
  const nextOrder = order.filter(id => id !== activeDrag.sessionId)
  nextOrder.splice(anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor), 0, activeDrag.sessionId)
  reorder(activeDrag.sessionId as string, anchor === undefined ? undefined : anchor as string)
}

/**
 * Build one session row's drag wiring from the in-flight drag state. Pure over
 * the visible state (the section passes the current drag state, its setters,
 * and the drop-committed one-shot), exported so the lifecycle's branches — the
 * committed-guard, the idle no-op, and the drag-end resolution — are directly
 * unit-tested, mirroring `handleRowMenuSelect`.
 * @param sessionDrag - the in-flight drag state, or null when idle.
 * @param workspaceId - the collab workspace this row belongs to.
 * @param id - this row's session id.
 * @param commit - commit the drag at the reported insert marker.
 * @param next - replace the drag state.
 * @param dropCommitted - shared one-shot guard so a drop plus its drag-end
 *   never commits the same move twice.
 * @returns the row's drag wiring.
 */
export function buildRowDragProps(
  sessionDrag: CollabDragState | null,
  workspaceId: string,
  id: SessionId,
  commit: (activeDrag: CollabDragState, over: NonNullable<CollabDragState['over']>) => void,
  next: (value: CollabDragState | null) => void,
  dropCommitted: { current: boolean },
): CollabRowDragProps {
  const active = sessionDrag !== null && sessionDrag.workspaceId === workspaceId
  const start = (): void => {
    dropCommitted.current = false
    next({ workspaceId, sessionId: id, over: null })
  }
  return {
    start,
    active,
    marker: active && sessionDrag !== null && sessionDrag.over?.id === id ? sessionDrag.over.half : null,
    hover: (half) => {
      // Rows gate `hover` on their own `active`, which implies the drag source
      // below; the null check re-narrows for the always-wired idle build.
      if (sessionDrag === null) return
      next({ ...sessionDrag, over: { id, half } })
    },
    drop: (half) => {
      if (sessionDrag === null) return
      if (dropCommitted.current) return
      dropCommitted.current = true
      commit(sessionDrag, { id, half })
    },
    end: () => {
      if (dropCommitted.current) return
      if (sessionDrag !== null && sessionDrag.over !== null && sessionDrag.over !== undefined) {
        commit(sessionDrag, sessionDrag.over)
      } else {
        next(null)
      }
      dropCommitted.current = false
    },
  }
}

/**
 * Accept the native drag at document level while a row drag is active: row
 * hover still owns the insertion marker, and releasing outside the list must
 * not be rendered as a rejected drop before dragend commits that last marker
 * (the browsing region's same guard).
 */
function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
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

/** Primary status dot plus every status's screen-reader label, as the browsing region renders. */
function CollabSessionStatusDots({ statuses }: { statuses: readonly [CollabSessionStatus, ...CollabSessionStatus[]] }) {
  return (
    <>
      <StateDot state={statuses[0].state} />
      {statuses.map(status => (
        <span className={css.visuallyHidden} key={status.label}>{status.label}</span>
      ))}
    </>
  )
}

/** Hover-card body for a collab session row: title, the session's work branch, relative time, statuses. */
function CollabSessionHoverContent({ summary, now, branch, t }: {
  summary: SessionSummary
  now: number
  /** The session's work-branch name under a repo-backed workspace; absent otherwise. */
  branch: string | undefined
  t: CollabRowTranslate
}) {
  const title = collabSessionTitle(summary, t)
  const statuses = collabSessionStatuses(summary, t)
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{title}</div>
      {/* Same placeholder rule as the row's trailing cell: no timestamp
          before the first prompt. */}
      {!summary.blank && <div className={css.hoverTime}>{hoverTimeLabel(summary.updatedAt, now, t)}</div>}
      {branch !== undefined && <div className={css.hoverBranch}>{t('branch')}: {branch}</div>}
      {statuses.map(status => (
        <div className={css.hoverStatus} key={status.label}>
          <StateDot state={status.state} />
          <span>{status.label}</span>
        </div>
      ))}
    </div>
  )
}

/** Hover-card body for a collab workspace row: name, mount path, member count, creation time. */
function CollabWorkspaceHoverContent({ label, path, count, createdAt, t }: {
  label: string
  path: string | undefined
  count: number
  createdAt: number
  t: CollabRowTranslate
}) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{label}</div>
      {path !== undefined && <div className={css.hoverPath}>{path}</div>}
      <div className={css.hoverStatus}>{t('memberCount', { count: String(count) })}</div>
      <div className={css.hoverTime}>{createdLabel(createdAt, t)}</div>
    </div>
  )
}

/**
 * One collab session row, mirroring the browsing region's session row: a
 * status slot, the display title, relative time, a hover-revealed row menu
 * (rename/fork/archive, blank placeholders carry no verbs), the selected
 * highlight, and a hover card. Drag wiring (same-workspace markers only) is
 * what lets members reorder the shared order.
 */
function CollabSessionRow({ summary, current, now, onOpen, drag, flat = false, branch, onPush, onSync, onRename, onFork, onArchive, t }: {
  summary: SessionSummary
  current: SessionId | undefined
  now: number
  onOpen: (sessionId: SessionId) => void
  /** The row's drag wiring (every collab session row is draggable). */
  drag: CollabRowDragProps
  flat?: boolean
  /** The session's work-branch name under a repo-backed workspace; enables the branch hover line and the push/sync verbs. */
  branch: string | undefined
  /** Open the confirm-gated push dialog for the session's branch. */
  onPush: ((sessionId: SessionId) => void) | undefined
  /** Fetch the origin into the shared clone for the session's line. */
  onSync: ((sessionId: SessionId) => void) | undefined
  /** Open the browser-owned rename dialog seeded with the current title. */
  onRename: (sessionId: SessionId, currentTitle: string) => void
  /** Fork the shared session into a child and open it. */
  onFork: (sessionId: SessionId) => void
  /** Archive the shared session for every member. */
  onArchive: (sessionId: SessionId) => void
  t: CollabRowTranslate
}) {
  const title = collabSessionTitle(summary, t)
  const selected = summary.id === current
  const statuses = collabSessionStatuses(summary, t)
  const primaryStatus = statuses[0]
  const showStatus = primaryStatus.state !== 'done' || summary.completed === true
  // The row menu lives in the row (mirroring the browsing region) so the open
  // state survives the HoverCard's pointer capture; an open menu pins the
  // reveal and suppresses the card.
  const [menuOpen, setMenuOpen] = useState(false)
  // The five declared ids are the whole domain the Menu can hand back. The
  // git verbs exist only for a session whose repo-backed clone supplies a
  // branch; a blank placeholder or a name-only workspace carries no line to
  // push or sync.
  const sessionMenuItems = [
    { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> },
    { id: 'fork', label: t('fork'), icon: <IconBranchOutline16 /> },
    // 20-native glyph in the menu's 16px icon slot.
    { id: 'archive', label: t('archiveSession'), icon: <IconArchiveOutline20 size={16} /> },
    ...(branch !== undefined
      ? [
        { id: 'push', label: t('pushBranch'), icon: <IconRightUpOutline16 /> },
        { id: 'sync', label: t('syncBranch'), icon: <IconRefreshOutline16 /> },
      ]
      : []),
  ]
  const ownRow = (
    <div
      className={clsx(
        css.sessionRow, selected && css.selected, menuOpen && css.menuOpen,
        drag.marker === 'before' && css.dropBefore, drag.marker === 'after' && css.dropAfter,
        flat && !showStatus && css.flatSessionRowWithoutStatus,
      )}
      role="treeitem"
      aria-selected={selected}
      aria-label={title}
      onClick={() => { onOpen(summary.id) }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', summary.id as string)
        drag.start()
      }}
      onDragEnd={drag.end}
      onDragOver={(e) => {
        if (!drag.active) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        drag.hover(rowHalf(e))
      }}
      onDrop={(e) => {
        if (!drag.active) return
        e.preventDefault()
        drag.drop(rowHalf(e))
      }}
    >
      {(!flat || showStatus) && (
        <span className={css.slot}>
          {showStatus && <CollabSessionStatusDots statuses={statuses} />}
        </span>
      )}
      <span className={css.title}>{title}</span>
      {/* A blank New Session row is a provisional placeholder: nothing has
          happened in it yet, so no "now" timestamp and no row verbs (rename/
          fork/archive would all act on content that does not exist). */}
      {!summary.blank && <span className={css.time}>{timeLabel(summary.updatedAt, now, t)}</span>}
      {!summary.blank && (
        <span className={css.rowActions}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={sessionMenuItems}
            onSelect={(id) => {
              setMenuOpen(false)
              // The five declared ids are the whole domain the Menu hands
              // back; each routes to its row callback.
              if (id === 'rename') onRename(summary.id, summary.displayTitle)
              if (id === 'fork') onFork(summary.id)
              if (id === 'archive') onArchive(summary.id)
              if (id === 'push' && onPush !== undefined) onPush(summary.id)
              if (id === 'sync' && onSync !== undefined) onSync(summary.id)
            }}
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.rowIconButton}
                aria-label={t('sessionActionsAria', { name: title })}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </span>
      )}
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      content={<CollabSessionHoverContent summary={summary} now={now} branch={branch} t={t} />}
      disabled={menuOpen || drag.active === true}
      copyText={summary.blank ? undefined : summary.displayTitle}
      copyLabel={t('copy')}
      copiedLabel={t('hoverCopied')}
    />
  )
}

/**
 * One collab workspace row mirroring the browsing region's project row: folder
 * chrome that swaps to the expand chevron on hover, the title, the trailing
 * member count, and hover-revealed inline actions (an options menu and a New
 * Session button). The row toggles its nested sessions; the action buttons
 * stop propagation so a click on them never toggles the fold.
 */
function CollabWorkspaceRow({ workspace, expanded, active, path, menuOpen, onToggle, onMenuChange, onSelectMenu, onRename, onNewSession, t }: {
  workspace: CollabWorkspaceView
  expanded: boolean
  active: boolean
  path: string | undefined
  menuOpen: boolean
  onToggle: () => void
  onMenuChange: (open: boolean) => void
  onSelectMenu: (id: string) => void
  /** Open the browser-owned workspace rename dialog seeded with the current name. */
  onRename: (workspaceId: string, currentName: string) => void
  onNewSession: () => void
  t: CollabRowTranslate
}) {
  const workspaceMenuItems = [
    { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> },
    { id: 'manage', label: t('openManager'), icon: <IconPersonalizationOutline16 /> },
    { id: 'delete', label: t('deleteWorkspace'), icon: <IconTrashOutline16 />, danger: true },
  ]
  const ownRow = (
    <div
      className={clsx(css.projectRow, menuOpen && css.menuOpen)}
      role="treeitem"
      aria-expanded={expanded}
      aria-label={workspace.name}
      onClick={onToggle}
    >
      <span className={clsx(css.slot, css.folder, active && css.folderActive)}>
        {expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={clsx(css.slot, css.chevron)}>
        <IconTriangleRightFill14 className={clsx(css.arrow, expanded && css.arrowOpen)} />
      </span>
      <span className={css.projectText}>
        <span className={css.title}>{workspace.name}</span>
      </span>
      {workspace.cloneState === 'cloning' && (
        <span className={css.cloneBadge}>{t('cloneCloning')}</span>
      )}
      <span className={css.meta}>{t('memberCount', { count: String(workspace.memberCount) })}</span>
      <span className={css.rowActions}>
        <Menu
          open={menuOpen}
          onClose={() => { onMenuChange(false) }}
          items={workspaceMenuItems}
          onSelect={(id) => {
            onMenuChange(false)
            // Rename routes to the browser-owned dialog (it needs the current
            // name); the remaining declared ids dispatch through the menu.
            if (id === 'rename') onRename(workspace.id, workspace.name)
            else onSelectMenu(id)
          }}
          portal
          closeOnPointerLeave
          anchor={(
            <button
              type="button"
              className={css.rowIconButton}
              aria-label={t('workspaceActionsAria', { name: workspace.name })}
              onClick={(e) => { e.stopPropagation(); onMenuChange(!menuOpen) }}
            >
              <IconEllipsisOutline16 />
            </button>
          )}
        />
        <button
          type="button"
          className={css.rowIconButton}
          aria-label={t('newSessionAria', { name: workspace.name })}
          disabled={workspace.cloneState === 'cloning'}
          // New Session mounts the collab workspace (idempotent when it
          // already is) and starts a session in it, exactly like the browsing
          // region's row button — so the click works even before the
          // background auto-mount echoes the Host record, and a failure
          // surfaces in the manager banner.
          onClick={(e) => { e.stopPropagation(); onNewSession() }}
        >
          <IconPlusOutline16 />
        </button>
      </span>
    </div>
  )
  return (
    <HoverCard
      anchor={ownRow}
      content={<CollabWorkspaceHoverContent
        label={workspace.name}
        path={path}
        count={workspace.memberCount}
        createdAt={Date.parse(workspace.createdAt)}
        t={t}
      />}
      disabled={menuOpen}
      copyText={path}
      copyLabel={t('copy')}
      copiedLabel={t('hoverCopied')}
    />
  )
}

/**
 * Render the collaborative-workspaces group beneath the browsing list while
 * the collab surface is ready.
 * @param props - the workspaces store hook, the root-scope session and
 *   workspace seats, plus the collab actions and the locale seat.
 * @returns the group, or null when no collab surface applies.
 */
export function CollabSection({
  wide,
  expandSidebar,
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

  // Rail search = expand + land in the search box: the flag arms before the
  // expand request; once the shell flips wide the input mounts and takes focus.
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (wide && searchOnExpand) {
      searchInput.current?.focus({ preventScroll: true })
      setSearchOnExpand(false)
    }
  }, [wide, searchOnExpand])

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
  // Component-local browsing state: which workspace rows are folded, which
  // have overflowed their session limit, and which row's options menu is open.
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<ReadonlySet<string>>(new Set())
  const [expandedOverflow, setExpandedOverflow] = useState<ReadonlySet<string>>(new Set())
  const [menuOpenWorkspaceId, setMenuOpenWorkspaceId] = useState<string | null>(null)
  const toggleCollapsed = (workspaceId: string): void => {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }
  const toggleOverflow = (workspaceId: string): void => {
    setExpandedOverflow((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }

  // Session rename dialog (browser-owned so it outlives row unmounts during
  // collapse; same pattern as the browsing region). Sessions have no
  // client-side name-conflict rule — the host normalizes — and an unchanged
  // title is NOT blocked: confirming the current title is the gesture that
  // pins it. The draft deliberately survives a successful confirm and a
  // cancel, so reopening re-seeds it from the row's current title.
  const composingRef = useRef(false)
  const [sessionRenameTarget, setSessionRenameTarget] = useState<{ sessionId: SessionId; currentTitle: string } | null>(null)
  const [sessionRenameDraft, setSessionRenameDraft] = useState('')
  const [sessionRenaming, setSessionRenaming] = useState(false)
  const [sessionRenameError, setSessionRenameError] = useState<string | null>(null)
  const sessionRenameTrimmed = sessionRenameDraft.trim()
  const sessionRenameBlocked = sessionRenaming || sessionRenameTrimmed === '' || sessionRenameTarget === null
  const closeSessionRename = (): void => {
    if (sessionRenaming) return
    setSessionRenameTarget(null)
    setSessionRenameError(null)
  }
  const confirmSessionRename = (): void => {
    if (sessionRenameBlocked) return
    setSessionRenaming(true)
    setSessionRenameError(null)
    actions.renameSession(sessionRenameTarget.sessionId, sessionRenameTrimmed).then(() => {
      setSessionRenaming(false)
      setSessionRenameTarget(null)
    }).catch((reason: unknown) => {
      setSessionRenaming(false)
      setSessionRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const onSessionRename = (sessionId: SessionId, currentTitle: string): void => {
    setSessionRenameTarget({ sessionId, currentTitle })
    setSessionRenameDraft(currentTitle)
    setSessionRenameError(null)
  }
  const onSessionArchive = (sessionId: SessionId): void => {
    // Archive is dialog-free: the row disappears when the archive-set echo
    // lands; failures are non-fatal console diagnostics (the reorder posture).
    void actions.archiveSession(sessionId).catch((reason: unknown) => {
      console.warn('collab session archive rejected:', reason)
    })
  }

  // Workspace rename dialog (browser-owned, matching the browsing region's):
  // mirror the session dialog, but an UNCHANGED title is blocked — the shared
  // name must actually move for confirm to mean anything. The host owns the
  // authorization fence and name normalization; a rejection keeps the dialog
  // open with the host message.
  const [workspaceRenameTarget, setWorkspaceRenameTarget] = useState<{ workspaceId: string; currentName: string } | null>(null)
  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState('')
  const [workspaceRenaming, setWorkspaceRenaming] = useState(false)
  const [workspaceRenameError, setWorkspaceRenameError] = useState<string | null>(null)
  const workspaceRenameTrimmed = workspaceRenameDraft.trim()
  const workspaceRenameBlocked = workspaceRenaming || workspaceRenameTrimmed === ''
    || workspaceRenameTarget === null || workspaceRenameTrimmed === workspaceRenameTarget.currentName
  const closeWorkspaceRename = (): void => {
    if (workspaceRenaming) return
    setWorkspaceRenameTarget(null)
    setWorkspaceRenameError(null)
  }
  const confirmWorkspaceRename = (): void => {
    if (workspaceRenameBlocked) return
    setWorkspaceRenaming(true)
    setWorkspaceRenameError(null)
    actions.renameWorkspace(workspaceRenameTarget.workspaceId, workspaceRenameTrimmed).then(() => {
      setWorkspaceRenaming(false)
      // The list re-labels through the controller's store patch; the draft
      // deliberately survives so reopening re-seeds it from the new name.
      setWorkspaceRenameTarget(null)
    }).catch((reason: unknown) => {
      setWorkspaceRenaming(false)
      setWorkspaceRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const onWorkspaceRename = (workspaceId: string, currentName: string): void => {
    setWorkspaceRenameTarget({ workspaceId, currentName })
    setWorkspaceRenameDraft(currentName)
    setWorkspaceRenameError(null)
  }

  // Session push dialog (browser-owned, mirroring the workspaces manager's
  // confirm-gated flow): opening a session's Push verb starts a server dry-run
  // preview, the member confirms the push, and the outcome keeps the dialog
  // open with its compare and pull-request links.
  const [pushTarget, setPushTarget] = useState<{ workspaceId: string; branch: string } | null>(null)
  const [pushPreview, setPushPreview] = useState<CollabPushView | undefined>(undefined)
  const [pushResult, setPushResult] = useState<CollabPushView | undefined>(undefined)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const openSessionPush = (workspaceId: string, branch: string): void => {
    setPushResult(undefined)
    setPushPreview(undefined)
    setPushError(null)
    setPushTarget({ workspaceId, branch })
    setPushBusy(true)
    void actions.previewPush(workspaceId, branch).then((preview) => {
      setPushPreview(preview)
      setPushBusy(false)
      // A folded preview failure returns undefined; the dialog reports the
      // generic failure rather than reverting to the pre-preview confirm copy.
      if (preview === undefined) setPushError(t('errorFailed'))
    })
  }
  const closeSessionPush = (): void => {
    if (pushBusy) return
    setPushTarget(null)
    setPushPreview(undefined)
    setPushResult(undefined)
    setPushError(null)
  }
  const confirmSessionPush = (): void => {
    if (pushTarget === null || pushBusy || pushPreview?.upToDate === true) return
    setPushBusy(true)
    setPushError(null)
    void actions.pushBranch(pushTarget.workspaceId, pushTarget.branch).then((result) => {
      setPushBusy(false)
      if (result !== undefined) {
        setPushResult(result)
      } else {
        setPushPreview(undefined)
        setPushError(t('errorFailed'))
      }
    })
  }

  // Session sync notice: a transient line above the list acknowledging a
  // fetch, or surfacing a folded failure. No timer — the next git verb (or a
  // dialog open) replaces it, mirroring the collapsed-rail search state.
  const [syncNote, setSyncNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const runSessionSync = (workspaceId: string): void => {
    setSyncNote(null)
    void actions.syncWorkspace(workspaceId).then((result) => {
      setSyncNote(result === undefined
        ? { kind: 'error', text: t('syncFailed') }
        : { kind: 'ok', text: t('syncedOk') })
    })
  }

  // Session drag: the per-workspace insert-marker state (source identity plus
  // the current hover target), mirroring the browsing region's row drag.
  // Rows only ever receive markers within their own workspace, because collab
  // order is shared per workspace — a session cannot move between workspaces.
  const [sessionDrag, setSessionDrag] = useState<CollabDragState | null>(null)
  const sessionDropCommitted = useRef(false)
  useNativeDragAcceptance(sessionDrag !== null)
  // Per-session update times observed since this mount, backing the shared
  // account's activity-promotion (the browsing region's account discipline).
  const observedUpdatedAtRef = useRef<Readonly<Record<string, number>>>({})
  // Drag commit arms are filled below, once the account order cache exists;
  // declaring the map here keeps the flat and grouped rows sharing one handle.
  const commitsByWorkspace = new Map<string, (activeDrag: CollabDragState, over: NonNullable<CollabDragState['over']>) => void>()

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
  // list. Order mode 'updated' sorts by creation recency for the rows; inside
  // a workspace the shared Host session account is the order base, and
  // 'updated' promotes sessions whose update advanced since last observed
  // (the browsing region's discipline, so a member's drag is never undone by
  // a blind recency sort). 'manual' shows the account order verbatim.
  const orderedWorkspaces = state.orderBy === 'updated'
    ? [...state.workspaces].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : state.workspaces
  const queryLower = normalizedQuery.toLowerCase()
  const visibleWorkspaces = queryLower === ''
    ? orderedWorkspaces
    : orderedWorkspaces.filter(workspace => workspace.name.toLowerCase().includes(queryLower))

  // One promotion pass per render: compute every mounted workspace's displayed
  // order first, so the observation baseline is refreshed exactly once and the
  // later render reads a stable cache (mirrors the browsing region's effect-
  // driven account, but in a single synchronous pass).
  const ordersByWorkspace = new Map<string, readonly SessionId[]>()
  for (const workspace of state.workspaces) {
    const host = hostByCollabId.get(workspace.id)
    if (host === undefined) continue
    // `sessionIds` may lead the list pull, so drop ids the session store has
    // not pulled yet; the rest are guaranteed present below.
    const present = host.sessionIds.filter((id): id is SessionId => byId[id] !== undefined)
    const { order, observedUpdatedAt } = nextCollabSessionOrder(
      present, byId, observedUpdatedAtRef.current, state.orderBy,
    )
    observedUpdatedAtRef.current = observedUpdatedAt
    // A blank session is the workspace's provisional New Session row and, like
    // the browsing region, only shows while it is the selected session: moving
    // to another session hides the untouched placeholder (it stays reusable
    // for the next New Session). The observed baseline above still counts it,
    // so a later reactivation does not re-promote.
    ordersByWorkspace.set(workspace.id, order.filter(id => !byId[id]!.blank || id === sessionsState.current))
  }
  const sessionIdsOf = (workspace: CollabWorkspaceView): readonly SessionId[] => {
    // A workspace without a mount has no order to show (no sessions yet).
    return ordersByWorkspace.get(workspace.id) ?? []
  }

  /**
   * The branch a session runs on, when its workspace's repo-backed clone has
   * settled: session lines exist only for ready clones (a name-only workspace
   * has no repository to fork from), so `undefined` there keeps the branch
   * hover line and the push/sync verbs off those sessions.
   */
  const sessionBranch = (workspace: CollabWorkspaceView, sessionId: SessionId): string | undefined =>
    workspace.cloneState === 'ready' ? sessionBranchName(workspace.name, sessionId) : undefined

  // Per-workspace drag commit arms: the account order and mount id captured at
  // render, in workspace order. A workspace without a mount renders no session
  // rows and thus no drag arm.
  for (const workspace of state.workspaces) {
    const mount = hostByCollabId.get(workspace.id)
    if (mount === undefined) continue
    // The mount's workspace entered the order cache above, so the arm's
    // captured order is present for every draggable row.
    const order = [...ordersByWorkspace.get(workspace.id)!]
    commitsByWorkspace.set(workspace.id, (activeDrag, over) => {
      setSessionDrag(null)
      // The shared Host account move: the runtime echoes the returned snapshot
      // immediately and `workspace-changed` reaches every member.
      commitCollabSessionDrag(activeDrag, over, order, (sessionId, beforeSessionId) => {
        actions.reorderSession(mount.workspaceId as string, sessionId, beforeSessionId)
      })
    })
  }

  // Flat mode rows: every collab session, in workspace order, each workspace's
  // sessions under its shared account order. The owner travels with each row so
  // flat drags stay inside their workspace's account. A session id appears in
  // at most one Host account, but dedupe defensively against any ledger anomaly.
  const flatSessions: { summary: SessionSummary; workspaceId: string }[] = []
  const seen = new Set<SessionId>()
  for (const workspace of orderedWorkspaces) {
    for (const id of sessionIdsOf(workspace)) {
      if (seen.has(id)) continue
      seen.add(id)
      flatSessions.push({ summary: byId[id] as SessionSummary, workspaceId: workspace.id })
    }
  }

  const visibleFlatSessions = queryLower === ''
    ? flatSessions
    : flatSessions.filter(entry => collabSessionTitle(entry.summary, t).toLowerCase().includes(queryLower))

  const showNoMatches = state.workspaces.length > 0 && normalizedQuery !== ''
    && (state.groupBy === 'flat'
      ? visibleFlatSessions.length === 0
      : visibleWorkspaces.length === 0)

  // One shared clock for the relative time cells and hover cards, computed at
  // render like the browsing region does.
  const now = Date.now()

  return (
    <div role="group" className={clsx(css.root, !wide && css.rail)} aria-label={t('title')}>
      {/* The collapsed rail keeps search as its own 36px control. */}
      {!wide && (
        <div className={css.railSearch}>
          <Tooltip label={t('search')}>
            <button
              type="button"
              className={css.searchButton}
              aria-label={t('search')}
              onClick={() => {
                setSearchExpanded(true)
                setSearchOnExpand(true)
                expandSidebar()
              }}
            >
              <IconSearchOutline16 size={18} />
            </button>
          </Tooltip>
        </div>
      )}
      {/* The wide body: section header, invitations, and the scrolling list. */}
      {wide && (
        <>
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

          {syncNote !== null && (
            <div
              className={clsx(css.sessionNotice, syncNote.kind === 'error' && css.sessionNoticeError)}
              role={syncNote.kind === 'error' ? 'alert' : undefined}
            >
              {syncNote.text}
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
              ? (
                <div className={css.list} role="tree" aria-label={t('title')}>
                  {visibleFlatSessions.map((entry) => {
                    // A flat session's owner workspace is mounted by construction
                    // (rows only stem from mounts), so its drag arm always exists.
                    const commitDrag = commitsByWorkspace.get(entry.workspaceId)!
                    const workspace = state.workspaces.find(candidate => candidate.id === entry.workspaceId)
                    const branch = workspace === undefined ? undefined : sessionBranch(workspace, entry.summary.id)
                    return (
                      <CollabSessionRow
                        key={entry.summary.id}
                        summary={entry.summary}
                        current={sessionsState.current}
                        now={now}
                        onOpen={actions.open}
                        drag={buildRowDragProps(
                          sessionDrag, entry.workspaceId, entry.summary.id,
                          commitDrag, setSessionDrag, sessionDropCommitted,
                        )}
                        branch={branch}
                        onPush={branch === undefined ? undefined : () => { openSessionPush(entry.workspaceId, branch) }}
                        onSync={branch === undefined ? undefined : () => { runSessionSync(entry.workspaceId) }}
                        onRename={onSessionRename}
                        onFork={(id) => { actions.forkSession(id) }}
                        onArchive={onSessionArchive}
                        flat
                        t={t}
                      />
                    )
                  })}
                </div>
              )
              : (
                <div className={css.list} role="tree" aria-label={t('title')}>
                  {visibleWorkspaces.map((workspace) => {
                    const sessionIds = sessionIdsOf(workspace)
                    const collapsed = collapsedWorkspaces.has(workspace.id)
                    const expanded = !collapsed
                    const menuOpen = menuOpenWorkspaceId === workspace.id
                    const mount = hostByCollabId.get(workspace.id)
                    // Session rows (and their drag wiring) require a mounted
                    // workspace; without one the group is just the workspace row.
                    const shownSessions: readonly SessionSummary[] = (mount === undefined
                      ? []
                      : (expandedOverflow.has(workspace.id)
                        ? sessionIds
                        : sessionIds.slice(0, COLLAPSED_SESSION_LIMIT)))
                    // `sessionIdsOf` drops ids the session store has not pulled
                    // yet, so every remaining id resolves below (same cast the
                    // flat path uses against the same guarantee).
                      .map(id => byId[id] as SessionSummary)
                    return (
                      <div key={workspace.id} className={css.group}>
                        <CollabWorkspaceRow
                          workspace={workspace}
                          expanded={expanded}
                          active={sessionsState.current !== undefined && sessionIds.includes(sessionsState.current)}
                          path={mount?.path}
                          menuOpen={menuOpen}
                          onToggle={() => { toggleCollapsed(workspace.id) }}
                          onMenuChange={(open) => { setMenuOpenWorkspaceId(open ? workspace.id : null) }}
                          onSelectMenu={(id) => {
                            setMenuOpenWorkspaceId(null)
                            handleRowMenuSelect(id, workspace.id, actions)
                          }}
                          onRename={onWorkspaceRename}
                          onNewSession={() => { actions.openWorkspace(workspace.id) }}
                          t={t}
                        />
                        {expanded && shownSessions.map((summary) => {
                          const branch = sessionBranch(workspace, summary.id)
                          return (
                            <CollabSessionRow
                              key={summary.id}
                              summary={summary}
                              current={sessionsState.current}
                              now={now}
                              onOpen={actions.open}
                              drag={buildRowDragProps(
                                sessionDrag, workspace.id, summary.id,
                                // Session rows only render for a mounted workspace,
                                // so its drag arm exists (see the guard above).
                                commitsByWorkspace.get(workspace.id)!,
                                setSessionDrag, sessionDropCommitted,
                              )}
                              branch={branch}
                              onPush={branch === undefined ? undefined : () => { openSessionPush(workspace.id, branch) }}
                              onSync={branch === undefined ? undefined : () => { runSessionSync(workspace.id) }}
                              onRename={onSessionRename}
                              onFork={(id) => { actions.forkSession(id) }}
                              onArchive={onSessionArchive}
                              t={t}
                            />
                          )
                        })}
                        {expanded && sessionIds.length > COLLAPSED_SESSION_LIMIT && (
                          <button
                            type="button"
                            className={css.sessionOverflowButton}
                            aria-expanded={expandedOverflow.has(workspace.id)}
                            onClick={() => { toggleOverflow(workspace.id) }}
                          >
                            {expandedOverflow.has(workspace.id)
                              ? t('sessionsCollapse')
                              : t('sessionsExpand', { n: sessionIds.length - COLLAPSED_SESSION_LIMIT })}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
          </div>
        </>
      )}

      {/* The modal portals to document.body, so it can render inside the
          section while the mask covers the whole viewport. */}
      <Modal
        open={sessionRenameTarget !== null}
        onClose={closeSessionRename}
        closeLabel={t('close')}
        title={t('renameSessionTitle')}
        footer={(
          <>
            <Button variant="outline" disabled={sessionRenaming} onClick={closeSessionRename}>{t('cancel')}</Button>
            <Button variant="primary" disabled={sessionRenameBlocked} onClick={confirmSessionRename}>{t('rename')}</Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={sessionRenameDraft}
          aria-label={t('fieldSessionName')}
          autoFocus
          disabled={sessionRenaming}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setSessionRenameDraft(e.target.value); setSessionRenameError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmSessionRename()
            }
          }}
        />
        {sessionRenameError !== null && <div className={css.renameError} role="alert">{sessionRenameError}</div>}
      </Modal>

      <Modal
        open={workspaceRenameTarget !== null}
        onClose={closeWorkspaceRename}
        closeLabel={t('close')}
        title={t('renameWorkspaceTitle')}
        footer={(
          <>
            <Button variant="outline" disabled={workspaceRenaming} onClick={closeWorkspaceRename}>{t('cancel')}</Button>
            <Button variant="primary" disabled={workspaceRenameBlocked} onClick={confirmWorkspaceRename}>{t('rename')}</Button>
          </>
        )}
      >
        <input
          className={css.renameInput}
          value={workspaceRenameDraft}
          aria-label={t('workspaceName')}
          autoFocus
          disabled={workspaceRenaming}
          onFocus={(e) => { e.target.select() }}
          onChange={(e) => { setWorkspaceRenameDraft(e.target.value); setWorkspaceRenameError(null) }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composingRef.current) {
              e.preventDefault()
              confirmWorkspaceRename()
            }
          }}
        />
        {workspaceRenameError !== null && <div className={css.renameError} role="alert">{workspaceRenameError}</div>}
      </Modal>

      <Modal
        open={pushTarget !== null}
        onClose={closeSessionPush}
        closeLabel={t('close')}
        title={t('pushSessionTitle', { branch: pushTarget?.branch ?? '' })}
        footer={pushResult !== undefined ? (
          <Button variant="primary" onClick={closeSessionPush}>{t('close')}</Button>
        ) : (
          <>
            <Button variant="outline" disabled={pushBusy} onClick={closeSessionPush}>{t('cancel')}</Button>
            <Button variant="primary" disabled={pushBusy || pushPreview?.upToDate === true} onClick={confirmSessionPush}>{t('push')}</Button>
          </>
        )}
      >
        {pushTarget !== null && (
          <div className={css.pushDialogBody}>
            {pushResult !== undefined ? (
              <>
                <div className={css.pushOutcome}>{pushOutcomeCopy(t, pushResult)}</div>
                {pushResult.compareUrl !== undefined && (
                  <a href={pushResult.compareUrl} target="_blank" rel="noreferrer" className={css.linkButton}>{t('openCompare')}</a>
                )}
                {pushResult.prUrl !== undefined && (
                  <a href={pushResult.prUrl} target="_blank" rel="noreferrer" className={css.linkButton}>{t('openPullRequest')}</a>
                )}
              </>
            ) : (
              <>
                <div className={css.pushPreviewLine}>{pushPreviewCopy(t, pushPreview, pushTarget.branch)}</div>
                {pushError !== null && <div className={css.renameError} role="alert">{pushError}</div>}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
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
