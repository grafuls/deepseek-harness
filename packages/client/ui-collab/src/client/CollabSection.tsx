// CollabSection: the collab workspaces section in the sidebar, under the
// existing Workspaces browsing region. Registered into ui-workspace's
// `sidebar.workspaces.collab` hole; it renders nothing while the collab
// surface is absent, so a single-user web install's browsing region is
// unchanged. Rows open the manager overlay for detail; creation and
// invitation acceptance work inline.

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CreateWorkspace } from './CreateWorkspace.tsx'
import type { NS } from './locales.ts'
import type { CollabWorkspacesInjected } from './WorkspacesPanel.tsx'
import css from './WorkspacesPanel.module.css'

/** Composed section props (hooks bound, plain members + the `t` seat passed through). */
export type CollabSectionProps = InjectFace<CollabWorkspacesInjected> & PropsLocale<typeof NS>

/**
 * Render the collab workspaces section beneath the browsing list while the
 * collab surface is ready.
 * @param props - the workspaces store hook plus the collab actions and the locale seat.
 * @returns the section, or null when no collab surface applies.
 */
export function CollabSection({ useCollabWorkspaces, actions, t }: CollabSectionProps): ReactNode {
  const state = useCollabWorkspaces(current => current)
  if (state.availability !== 'ready') return null
  return (
    <section className={css.detail}>
      <h2 className={css.sectionTitle}>{t('title')}</h2>
      {state.invitationsForMe.length > 0 && (
        <>
          <h2 className={css.sectionTitle}>{t('invitationsForMe')}</h2>
          <div className={css.list}>
            {state.invitationsForMe.map(invitation => (
              <div key={invitation.id} className={css.memberRow}>
                <div className={css.memberIdentity}>
                  <span className={css.memberName}>{invitation.workspaceName}</span>
                </div>
                <button type="button" className={css.primaryButton} onClick={() => { actions.acceptInvitation(invitation.id) }}>{t('accept')}</button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className={css.list}>
        {state.workspaces.map(workspace => (
          <div key={workspace.id} className={css.memberRow}>
            <div className={css.memberIdentity}>
              <span className={css.rowName}>
                <button type="button" className={css.linkButton} onClick={() => { actions.openManager(workspace.id) }}>
                  {workspace.name}
                </button>
              </span>
              <span className={css.rowMeta}>{t('memberCount', { count: String(workspace.memberCount) })}</span>
            </div>
            <div className={css.memberActions}>
              <button type="button" className={css.primaryButton} onClick={() => { actions.openWorkspace(workspace.id) }}>{t('open')}</button>
            </div>
          </div>
        ))}
      </div>
      {state.workspaces.length === 0 && state.invitationsForMe.length === 0 && (
        <p className={css.empty}>{t('empty')}</p>
      )}
      <CreateWorkspace actions={actions} t={t} />
    </section>
  )
}
