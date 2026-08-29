// CollabSettingsSection: the Collaborative Workspaces settings page. One form
// row edits the default clone directory for repository-backed workspaces
// (namespace `collab`, registered by the collab API host plugin). An empty
// value means "use the collab data root"; clearing the field and saving resets
// to that default. Registered into `settings.section` by the plugin body, so
// it renders only while the settings shell contributes the section nav.

import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollabSettingsController, CollabSettingsState } from './collab-settings-store.ts'
import type { NS } from './locales.ts'
import css from './CollabSettings.module.css'

/** Injected dependencies of {@link CollabSettingsSection} (slot `inject`). */
export interface CollabSettingsInjected {
  /** The section controller owning the scope write lifecycle. */
  controller: CollabSettingsController
  hooks: {
    /** The section snapshot, bound by the renderer as `useCollabSettings`. */
    collabSettings: SnapshotStore<CollabSettingsState>
  }
}

/** Composed section props (hooks bound, plain members + the `t` seat passed through). */
export type CollabSettingsSectionProps = InjectFace<CollabSettingsInjected> & PropsLocale<typeof NS>

/**
 * Render the Collaborative Workspaces settings section.
 * @param props - the settings snapshot hook, the section controller, and the locale seat.
 * @returns the clone-directory form, the unavailable notice, or a loading placeholder.
 */
export function CollabSettingsSection({ useCollabSettings, controller, t }: CollabSettingsSectionProps): ReactNode {
  const state = useCollabSettings(current => current)
  const [busy, setBusy] = useState(false)
  if (state.status === 'unavailable') {
    return <p className={css.empty}>{t('settingsUnavailable')}</p>
  }
  if (state.status === 'loading') {
    return null
  }
  const dirty = state.draft.trim() !== state.cloneDir
  const save = (): void => {
    setBusy(true)
    void controller.save().finally(() => { setBusy(false) })
  }
  const reset = (): void => { controller.setDraft(state.cloneDir) }
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('settingsCloneDirLabel')}</h2>
      <p className={css.hint}>{t('settingsCloneDirHint')}</p>
      <div className={css.row}>
        <input
          className={css.input}
          type="text"
          value={state.draft}
          placeholder={t('settingsCloneDirPlaceholder')}
          aria-label={t('settingsCloneDirLabel')}
          spellCheck={false}
          onChange={(event) => { controller.setDraft(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && dirty && !busy) save() }}
        />
        <button type="button" className={css.primaryButton} disabled={!dirty || busy} onClick={save}>
          {busy ? t('settingsSaving') : t('settingsSave')}
        </button>
        <button type="button" className={css.secondaryButton} disabled={!dirty || busy} onClick={reset}>
          {t('settingsReset')}
        </button>
      </div>
      {state.saved && <p className={css.meta} role="status">{t('settingsSaved')}</p>}
    </div>
  )
}
