// WorkspacesPanel: the collab workspaces manager overlay. Registered into the
// layout's shell.overlay list; it renders nothing while the collab surface is
// absent or while the panel is closed, and shows the signed-in member's
// workspaces (create, invite, member role, and delete surfaces) once open.

import { useState, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollabRole } from './contract.ts'
import type { CollabWorkspacesState } from './store.ts'
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
  /** Create a workspace by name and select it. */
  create: (name: string) => void
  /** Invite a user by email to the selected workspace. */
  invite: (email: string, role: CollabRole) => void
  /** Revoke one pending invitation. */
  revokeInvitation: (invitationId: string) => void
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

/** Composed manager props (hooks bound, plain members passed through). */
export type WorkspacesPanelProps = InjectFace<CollabWorkspacesInjected>

/** Human-readable role label. */
function roleLabel(role: CollabRole): string {
  return role === 'admin' ? '管理员' : '开发者'
}

/**
 * Render the workspaces manager overlay when the collab surface is ready and
 * the panel is open.
 * @param props - the workspaces store hook plus the collab actions.
 * @returns the panel, or null when no collab surface or no open panel.
 */
export function WorkspacesPanel({ useCollabWorkspaces, actions }: WorkspacesPanelProps): ReactNode {
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
        <WorkspacesHeader onClose={actions.closePanel} />
        {state.error !== undefined && <p className={css.error}>{state.error}</p>}
        {state.workspaces.length === 0 && state.selectedId === undefined ? (
          <p className={css.empty}>还没有工作区</p>
        ) : (
          <WorkspacesList state={state} actions={actions} />
        )}
        {state.selectedId !== undefined && (
          <WorkspaceDetail state={state} actions={actions} />
        )}
      </div>
    </div>
  )
}

/** The open panel's header row. */
function WorkspacesHeader({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <div className={css.header}>
      <h1 id="collab-workspaces-title" className={css.title}>协作工作区</h1>
      <button type="button" className={css.closeButton} onClick={onClose} aria-label="关闭">×</button>
    </div>
  )
}

/** The workspace list, a create action, and the selected workspace detail. */
function WorkspacesList({ state, actions }: {
  state: CollabWorkspacesState
  actions: CollabWorkspacesActions
}): ReactNode {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const create = (): void => {
    actions.create(name)
    setName('')
    setCreating(false)
  }
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
          <span className={css.badge}>{roleLabel(workspace.role)}</span>
          <span className={css.rowMeta}>{workspace.memberCount} 名成员</span>
        </button>
      ))}
      {creating ? (
        <div className={css.createRow}>
          <input
            className={css.input}
            type="text"
            value={name}
            placeholder="工作区名称"
            autoFocus
            onChange={(event) => { setName(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') create() }}
          />
          <button type="button" className={css.primaryButton} disabled={name.trim() === ''} onClick={create}>创建</button>
        </div>
      ) : (
        <button type="button" className={css.createButton} onClick={() => { setCreating(true) }}>＋ 新建工作区</button>
      )}
    </div>
  )
}

/** Members, invitations, and the invite surface of the selected workspace. */
function WorkspaceDetail({ state, actions }: {
  state: CollabWorkspacesState
  actions: CollabWorkspacesActions
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
      <h2 className={css.sectionTitle}>成员</h2>
      {state.members.map(member => (
        <div key={member.userId} className={css.memberRow}>
          <div className={css.memberIdentity}>
            <span className={css.memberName}>{member.name || member.email}</span>
            <span className={css.badge}>{roleLabel(member.role)}</span>
          </div>
          {isAdmin && (
            <div className={css.memberActions}>
              {member.role !== 'admin' ? (
                <button type="button" className={css.linkButton} onClick={() => { actions.setMemberRole(member.userId, 'admin') }}>设为管理员</button>
              ) : (
                <button type="button" className={css.linkButton} onClick={() => { actions.setMemberRole(member.userId, 'developer') }}>设为开发者</button>
              )}
              <button type="button" className={css.dangerButton} onClick={() => { actions.removeMember(member.userId) }}>移除</button>
            </div>
          )}
        </div>
      ))}
      <h2 className={css.sectionTitle}>邀请</h2>
      {state.invitations.filter(invitation => !invitation.revoked && invitation.usedAt === undefined).map(invitation => (
        <div key={invitation.id} className={css.memberRow}>
          <div className={css.memberIdentity}>
            <span className={css.memberName}>{invitation.email}</span>
            <span className={css.badge}>{roleLabel(invitation.role)}</span>
          </div>
          {isAdmin && (
            <button type="button" className={css.dangerButton} onClick={() => { actions.revokeInvitation(invitation.id) }}>撤销</button>
          )}
        </div>
      ))}
      {isAdmin && !inviteOpen ? (
        <button type="button" className={css.createButton} onClick={() => { setInviteOpen(true) }}>＋ 邀请成员</button>
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
            <option value="developer">开发者</option>
            <option value="admin">管理员</option>
          </select>
          <button type="button" className={css.primaryButton} disabled={email.trim() === ''} onClick={submitInvite}>邀请</button>
        </div>
      )}
      {isAdmin && (
        <button type="button" className={css.deleteButton} onClick={actions.deleteSelected}>删除工作区</button>
      )}
    </div>
  )
}
