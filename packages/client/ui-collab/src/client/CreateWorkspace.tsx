// CreateWorkspace: the inline "＋ New workspace" affordance (a dashed button)
// shared by the workspaces manager overlay and the sidebar collab section.
// Clicking it pops up a modal dialog carrying the collab workspace creation
// detail — name and optional repository URL — for the user to populate. When
// the user supplies a repository URL the server clones it into the configured
// clone directory and opens the clone as the workspace. The dialog stays open
// showing Creating… while the create request (possibly a slow clone) is in
// flight, closes on success, and stays open with the error banner on failure —
// a silent no-op is never possible.

import { useState, type ReactNode } from 'react'
import type { WorkspacesPanelProps } from './WorkspacesPanel.tsx'
import type { CollabWorkspacesActions } from './WorkspacesPanel.tsx'
import css from './WorkspacesPanel.module.css'

/**
 * Render the create-new-workspace affordance and its creation dialog.
 * @param actions - the collab actions (the `create` callback).
 * @param error - the current store error banner, shown inside the dialog while
 *   it is open so a failed create stays visible above the backdrop.
 * @param t - the locale seat from the `collab.ui` dictionary.
 * @param renderTrigger - optional custom trigger rendering, receiving the
 *   opener; defaults to the dashed "＋ New workspace" button. The sidebar
 *   section passes its header's add-workspace icon button here.
 * @returns the trigger plus, once opened, the creation dialog.
 */
export function CreateWorkspace({ actions, error, t, renderTrigger }: {
  actions: CollabWorkspacesActions
  error: string | undefined
  t: WorkspacesPanelProps['t']
  renderTrigger?: (open: () => void) => ReactNode
}): ReactNode {
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [attempted, setAttempted] = useState(false)
  const open = (): void => {
    setName('')
    setRepoUrl('')
    setAttempted(false)
    setCreating(true)
  }
  const create = async (): Promise<void> => {
    // Unreachable through the UI: every entry checks `busy` before invoking
    // create, and React flushes the busy state between discrete events.
    /* v8 ignore start -- defensive double-submit guard below the entry checks. */
    if (busy) return
    /* v8 ignore stop */
    const trimmedName = name.trim()
    const trimmedRepoUrl = repoUrl.trim()
    setBusy(true)
    setAttempted(true)
    let created = false
    try {
      created = trimmedRepoUrl === ''
        ? await actions.create(trimmedName)
        : await actions.create(trimmedName, trimmedRepoUrl)
    } catch {
      // The controller folds failures into the store; a rejecting action is an
      // unexpected host bug that must not wedge the form in Creating….
      created = false
    }
    setBusy(false)
    if (created) {
      setName('')
      setRepoUrl('')
      setCreating(false)
    }
  }
  return (
    <>
      {renderTrigger === undefined
        ? <button type="button" className={css.createButton} onClick={open}>{t('newWorkspace')}</button>
        : renderTrigger(open)}
      {creating && (
        <div className={css.backdrop} onMouseDown={() => { setCreating(false) }}>
          <div
            className={css.createDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="collab-create-title"
            onMouseDown={(event) => { event.stopPropagation() }}
          >
            <div className={css.header}>
              <h1 id="collab-create-title" className={css.title}>{t('createTitle')}</h1>
              <button type="button" className={css.closeButton} onClick={() => { setCreating(false) }} aria-label={t('close')}>×</button>
            </div>
            {/* Shown only once the attempt has settled: while busy the box is
                absent, and an empty/absent store error never renders an empty
                banner — it falls back to the generic failure message. */}
            {attempted && !busy && <p className={css.error}>{error || t('errorFailed')}</p>}
            <div className={css.createForm}>
              <input
                className={css.input}
                type="text"
                value={name}
                placeholder={t('workspaceName')}
                autoFocus
                disabled={busy}
                onChange={(event) => { setName(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void create() }}
              />
              <input
                className={css.input}
                type="text"
                value={repoUrl}
                placeholder={t('workspaceRepoUrl')}
                disabled={busy}
                onChange={(event) => { setRepoUrl(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void create() }}
              />
              <div className={css.createRow}>
                <button type="button" className={css.primaryButton} disabled={name.trim() === '' || busy} onClick={() => { void create() }}>
                  {busy ? t('creating') : t('create')}
                </button>
                <button type="button" className={css.linkButton} disabled={busy} onClick={() => { setCreating(false) }}>{t('cancel')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
