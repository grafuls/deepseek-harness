// CreateWorkspace: the inline "＋ New workspace" affordance (a dashed button
// that expands into a name input plus Create), shared by the workspaces
// manager overlay and the sidebar collab section.

import { useState, type ReactNode } from 'react'
import type { WorkspacesPanelProps } from './WorkspacesPanel.tsx'
import type { CollabWorkspacesActions } from './WorkspacesPanel.tsx'
import css from './WorkspacesPanel.module.css'

/**
 * Render the create-new-workspace affordance.
 * @param actions - the collab actions (the `create` callback).
 * @param t - the locale seat from the `collab.ui` dictionary.
 * @returns the dashed button or, once opened, the name input plus Create button.
 */
export function CreateWorkspace({ actions, t }: {
  actions: CollabWorkspacesActions
  t: WorkspacesPanelProps['t']
}): ReactNode {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const create = (): void => {
    actions.create(name)
    setName('')
    setCreating(false)
  }
  if (!creating) {
    return <button type="button" className={css.createButton} onClick={() => { setCreating(true) }}>{t('newWorkspace')}</button>
  }
  return (
    <div className={css.createRow}>
      <input
        className={css.input}
        type="text"
        value={name}
        placeholder={t('workspaceName')}
        autoFocus
        onChange={(event) => { setName(event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Enter') create() }}
      />
      <button type="button" className={css.primaryButton} disabled={name.trim() === ''} onClick={create}>{t('create')}</button>
    </div>
  )
}
