// LoginGate: the full-screen collab sign-in overlay. Registered into the
// layout's shell.overlay list; it renders nothing while the instance is
// authenticated (or while the collab surface is absent, so a single-user web
// install is visually unchanged) and replaces the whole app behind a signing
// backdrop while the session probe reports checking/unauthenticated.

import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollabGateState } from './contract.ts'
import type { NS } from './locales.ts'
import css from './LoginGate.module.css'

/** Registration-side injected facts: the gate store plus sign-in plumbing. */
export interface CollabGateInjected {
  hooks: {
    /** The live gate state, bound by the slot renderer to `useCollabGate`. */
    collabGate: SnapshotStore<CollabGateState>
  }
  /** Start the browser OIDC round-trip (full-page navigation). */
  signIn: () => void
  /** Server-side sign-in refusal reason, when the browser was bounced here. */
  signInError?: string
}

/** Composed login gate props (hooks bound, plain members + the `t` seat passed through). */
export type LoginGateProps = InjectFace<CollabGateInjected> & PropsLocale<typeof NS>

/**
 * Render the sign-in backdrop unless the browser is authorized or the collab
 * surface is absent.
 * @param props - the gate store hook plus the sign-in plumbing and the locale seat.
 * @returns the backdrop, or null when no gate applies.
 */
export function LoginGate({ useCollabGate, signIn, signInError, t }: LoginGateProps): ReactNode {
  const state = useCollabGate(current => current)
  if (state.authenticated || state.status === 'absent') return null
  return (
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-labelledby="collab-login-title">
      <div className={css.card}>
        <div className={css.brand}>DeepSeek Harness</div>
        <h1 id="collab-login-title" className={css.title}>{t('title')}</h1>
        <p className={css.hint}>{t('hint')}</p>
        {signInError !== undefined && (
          <p className={css.error}>{t('signinError', { error: signInError })}</p>
        )}
        <button type="button" className={css.button} onClick={signIn}>{t('signin')}</button>
      </div>
    </div>
  )
}
