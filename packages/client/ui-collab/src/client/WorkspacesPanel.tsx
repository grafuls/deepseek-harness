// WorkspacesPanel: the collab workspaces manager overlay. Registered into the
// layout's shell.overlay list; it renders nothing while the collab surface is
// absent or while the panel is closed, and shows the signed-in member's
// workspaces (create, invite, accept, member role, and delete surfaces) once
// open.

import { useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollabRole } from './contract.ts'
import { CreateWorkspace } from './CreateWorkspace.tsx'
import type { NS } from './locales.ts'
import type { CollabGroupBy, CollabOrderBy, CollabWorkspacesState } from './store.ts'
import css from './WorkspacesPanel.module.css'

/** The collab actions the manager hands down to its surfaces. */
export interface CollabWorkspacesActions {
  /** Open the overlay panel. */
  openPanel: () => void
  /** Close the overlay panel. */
  closePanel: () => void
  /** Reload the workspace list. */
  refresh: () => void
  /** Select a workspace (loading its members and invitations). */
  select: (workspaceId: string | undefined) => void
  /** Open the overlay panel onto one workspace's detail. */
  openManager: (workspaceId: string) => void
  /** Mount a collab workspace as a real Host workspace and switch the GUI into it. */
  openWorkspace: (workspaceId: string) => void
  /** Mount every not-yet-mounted collab workspace in the background (section session browsing). */
  mountAll: () => void
  /** Open one mounted collab session in the GUI (browser row click, like the local section). */
  open: (sessionId: SessionId) => void
  /** Rename one shared collab session (rejects on host failure so the dialog keeps its error). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Fork one shared collab session into a child session and open it. */
  forkSession: (sessionId: SessionId) => void
  /** Archive one shared collab session for every member (rejects on host failure). */
  archiveSession: (sessionId: SessionId) => Promise<void>
  /** Reorder one shared session within its collab workspace's Host account (session row drag). */
  reorderSession: (hostWorkspaceId: string, sessionId: string, beforeSessionId?: string) => void
  /** Rename a collab workspace by id (rejects on host failure so the dialog keeps its error). */
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>
  /** Delete a collab workspace from the section row's options menu. */
  delete: (workspaceId: string) => void
  /** Set the collab list grouping mode (view options). */
  setGroupBy: (mode: CollabGroupBy) => void
  /** Set the collab list order mode (view options). */
  setOrderBy: (mode: CollabOrderBy) => void
  /** Create a workspace by name (optionally bootstrap from a repository URL) and select it; resolves false on failure. */
  create: (name: string, repoUrl?: string) => Promise<boolean>
  /** Invite a user by email to the selected workspace. */
  invite: (email: string, role: CollabRole) => void
  /** Revoke one pending invitation. */
  revokeInvitation: (invitationId: string) => void
  /** Accept a pending invitation addressed to this user and join its workspace. */
  acceptInvitation: (invitationId: string) => void
  /** Change a member's role. */
  setMemberRole: (userId: string, role: CollabRole) => void
  /** Remove a member. */
  removeMember: (userId: string) => void
  /** Delete the selected workspace. */
  deleteSelected: () => void
}

/** Registration-side injected facts: the shared store plus collab actions. */
export interface CollabWorkspacesInjected {
  hooks: {
    /** The live workspaces view, bound by the slot renderer to `useCollabWorkspaces`. */
    collabWorkspaces: SnapshotStore<CollabWorkspacesState>
  }
  /** The collab workspace actions. */
  actions: CollabWorkspacesActions
}

/** Composed manager props (hooks bound, plain members + the `t` seat passed through). */
export type WorkspacesPanelProps = InjectFace<CollabWorkspacesInjected> & PropsLocale<typeof NS>

/** Human-readable role label from the collab.ui dictionary. */
function roleLabel(t: WorkspacesPanelProps['t'], role: CollabRole): string {
  return role === 'admin' ? t('roleAdmin') : t('roleDeveloper')
}

/**
 * Render the workspaces manager overlay when the collab surface is ready and
 * the panel is open.
 * @param props - the workspaces store hook plus the collab actions and the locale seat.
 * @returns the panel, or null when no collab surface or no open panel.
 */
export function WorkspacesPanel({ useCollabWorkspaces, actions, t }: WorkspacesPanelProps): ReactNode {
  const state = useCollabWorkspaces(current => current)
  if (state.availability !== 'ready' || !state.open) return null
  return (
    <div className={css.backdrop} onMouseDown={actions.closePanel}>
      <div
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-workspaces-title"
        onMouseDown={(event) => { event.stopPropagation() }}
      >
        <WorkspacesHeader onClose={actions.closePanel} t={t} />
        {state.error !== undefined && <p className={css.error}>{state.error}</p>}
        <InvitationsForMe invitationsForMe={state.invitationsForMe} onAccept={actions.acceptInvitation} t={t} />
        {state.workspaces.length === 0 && state.selectedId === undefined && (
          <p className={css.empty}>{t('empty')}</p>
        )}
        {/* The list always renders its create affordance, keeping it usable from the empty state. */}
        <WorkspacesList state={state} actions={actions} t={t} />
        {state.selectedId !== undefined && (
          <WorkspaceDetail state={state} actions={actions} t={t} />
        )}
      </div>
    </div>
  )
}

/** The open panel's header row. */
function WorkspacesHeader({ onClose, t }: { onClose: () => void; t: WorkspacesPanelProps['t'] }): ReactNode {
  return (
    <div className={css.header}>
      <h1 id="collab-workspaces-title" className={css.title}>{t('title')}</h1>
      <button type="button" className={css.closeButton} onClick={onClose} aria-label={t('close')}>×</button>
    </div>
  )
}

/** Pending invitations addressed to the signed-in user, with an accept action. */
function InvitationsForMe({ invitationsForMe, onAccept, t }: {
  invitationsForMe: CollabWorkspacesState['invitationsForMe']
  onAccept: (invitationId: string) => void
  t: WorkspacesPanelProps['t']
}): ReactNode {
  if (invitationsForMe.length === 0) return null
  return (
    <section className={css.detail}>
      <h2 className={css.sectionTitle}>{t('invitationsForMe')}</h2>
      {invitationsForMe.map(invitation => (
        <div key={invitation.id} className={css.memberRow}>
          <div className={css.memberIdentity}>
            <span className={css.memberName}>{invitation.workspaceName}</span>
            <span className={css.badge}>{roleLabel(t, invitation.role)}</span>
          </div>
          <button type="button" className={css.primaryButton} onClick={() => { onAccept(invitation.id) }}>{t('accept')}</button>
        </div>
      ))}
    </section>
  )
}

/** The workspace list and a create action; the selected workspace detail renders below. */
function WorkspacesList({ state, actions, t }: {
  state: CollabWorkspacesState
  actions: CollabWorkspacesActions
  t: WorkspacesPanelProps['t']
}): ReactNode {
  return (
    <div className={css.list}>
      {state.workspaces.map(workspace => (
        <button
          key={workspace.id}
          type="button"
          className={workspace.id === state.selectedId ? `${css.row} ${css.rowSelected}` : css.row}
          onClick={() => { actions.select(workspace.id) }}
        >
          <span className={css.rowName}>{workspace.name}</span>
          {workspace.cloneState === 'cloning' && (
            <span className={`${css.badge} ${css.cloneBadge}`}>{t('cloneCloning')}</span>
          )}
          {workspace.gitState && (
            <span
              className={`${css.gitState} ${workspace.gitState.dirty ? css.gitStateDirty : ''}`}
              title={workspace.gitState.dirty ? t('gitUncommitted') : undefined}
            >
              {workspace.gitState.dirty && '● '}
              {workspace.gitState.branch} · {workspace.gitState.sha}
            </span>
          )}
          <span className={css.badge}>{roleLabel(t, workspace.role)}</span>
          <span className={css.rowMeta}>{t('memberCount', { count: String(workspace.memberCount) })}</span>
        </button>
      ))}
      <CreateWorkspace actions={actions} error={state.error} t={t} />
    </div>
  )
}

/** Members, invitations, and the invite surface of the selected workspace. */
function WorkspaceDetail({ state, actions, t }: {
  state: CollabWorkspacesState
  actions: CollabWorkspacesActions
  t: WorkspacesPanelProps['t']
}): ReactNode {
  const isAdmin = state.myRole === 'admin'
  const [inviteOpen, setInviteOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<CollabRole>('developer')
  const submitInvite = (): void => {
    actions.invite(email, inviteRole)
    setEmail('')
    setInviteOpen(false)
  }
  return (
    <div className={css.detail}>
      <h2 className={css.sectionTitle}>{t('members')}</h2>
      {state.members.map(member => (
        <div key={member.userId} className={css.memberRow}>
          <div className={css.memberIdentity}>
            <span className={css.memberName}>{member.name || member.email}</span>
            <span className={css.badge}>{roleLabel(t, member.role)}</span>
          </div>
          {isAdmin && (
            <div className={css.memberActions}>
              {member.role !== 'admin' ? (
                <button type="button" className={css.linkButton} onClick={() => { actions.setMemberRole(member.userId, 'admin') }}>{t('makeAdmin')}</button>
              ) : (
                <button type="button" className={css.linkButton} onClick={() => { actions.setMemberRole(member.userId, 'developer') }}>{t('makeDeveloper')}</button>
              )}
              <button type="button" className={css.dangerButton} onClick={() => { actions.removeMember(member.userId) }}>{t('remove')}</button>
            </div>
          )}
        </div>
      ))}
      <h2 className={css.sectionTitle}>{t('invitations')}</h2>
      {state.invitations.filter(invitation => !invitation.revoked && invitation.usedAt === undefined).map(invitation => (
        <div key={invitation.id} className={css.memberRow}>
          <div className={css.memberIdentity}>
            <span className={css.memberName}>{invitation.email}</span>
            <span className={css.badge}>{roleLabel(t, invitation.role)}</span>
          </div>
          {isAdmin && (
            <button type="button" className={css.dangerButton} onClick={() => { actions.revokeInvitation(invitation.id) }}>{t('revoke')}</button>
          )}
        </div>
      ))}
      {isAdmin && !inviteOpen ? (
        <button type="button" className={css.createButton} onClick={() => { setInviteOpen(true) }}>{t('inviteMember')}</button>
      ) : isAdmin && (
        <div className={css.createRow}>
          <input
            className={css.input}
            type="text"
            value={email}
            placeholder="name@example.com"
            autoFocus
            onChange={(event) => { setEmail(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') submitInvite() }}
          />
          <select
            className={css.select}
            value={inviteRole}
            onChange={(event) => { setInviteRole(event.target.value as CollabRole) }}
          >
            <option value="developer">{t('roleDeveloper')}</option>
            <option value="admin">{t('roleAdmin')}</option>
          </select>
          <button type="button" className={css.primaryButton} disabled={email.trim() === ''} onClick={submitInvite}>{t('invite')}</button>
        </div>
      )}
      {isAdmin && (
        <button type="button" className={css.deleteButton} onClick={actions.deleteSelected}>{t('deleteWorkspace')}</button>
      )}
    </div>
  )
}
