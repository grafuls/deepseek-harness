// SignOutControl: the sidebar-foot sign-out row registered into the sidebar's
// `sidebar.footer.action` seat. It renders only while a collab session is
// authenticated (the same gate store that covers the app) and otherwise
// nothing, so a single-user install or an unsigned-in browser adds no chrome.
// The wide column shows a labeled row beside Settings; the collapsed rail
// shows the same action as an icon-only circle.

import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconLogoutOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-sidebar SlotMap augmentation ('sidebar.footer.action')
// into this program; the client bundle emits no request for the sidebar.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollabGateState } from './contract.ts'
import type { NS } from './locales.ts'
import css from './SignOutControl.module.css'

/** Registration-side injected facts for the footer action. */
export interface SignOutControlInjected {
  hooks: {
    /** The live gate state, bound by the slot renderer to `useCollabGate`. */
    collabGate: SnapshotStore<CollabGateState>
  }
  /** Clear the server session; on confirmation the gate store flips to unauthenticated. */
  signOut: () => void
}

/** Composed props: the sidebar owner share, the injected face, and the locale seat. */
export type SignOutControlProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<SignOutControlInjected>
  & PropsLocale<typeof NS>

/**
 * Render the sign-out row while a collab session is authenticated.
 * @param props - the column width state, the gate hook, the sign-out callback, and `t`.
 * @returns the footer row button, or null while no authenticated session applies.
 */
export function SignOutControl({ wide, useCollabGate, signOut, t }: SignOutControlProps): ReactNode {
  const state = useCollabGate(current => current)
  if (!state.authenticated) return null
  return (
    <Tooltip label={t('signOut')} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.action, wide ? css.row : css.rail)}
        aria-label={t('signOut')}
        onClick={signOut}
      >
        <IconLogoutOutline16 className={css.icon} size={wide ? 14 : 18} />
        {wide && <span className={css.label}>{t('signOut')}</span>}
      </button>
    </Tooltip>
  )
}
