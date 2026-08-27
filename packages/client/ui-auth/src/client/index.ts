/**
 * Collab sign-in gate, browser half. Probes the collab session endpoint and
 * registers a full-screen signing overlay into the layout's shell overlay;
 * the overlay covers the app until a session cookie authorizes the browser
 * and renders nothing on an absent collab surface (a single-user web install
 * mounted with the row inactive is visually unchanged). The server's own
 * `/api` gate remains the enforcement point in every case.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout SlotMap augmentation (shell.overlay) into
// this program; the client bundle emits no request for the layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollabGateInjected } from './LoginGate.tsx'
import { LoginGate } from './LoginGate.tsx'
import {
  buildSignInUrl, COLLAB_GATE_INITIAL, probeCollabSession, signInFailure,
  type CollabGateState,
} from './contract.ts'
import { NS, en, zh, type AuthKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The collab sign-in gate copy. */
    'collab.auth': AuthKey
  }
}

/** Required services (cordis fiber inject): the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: probe the session on mount (and whenever the window
 * regains focus), then gate the app with the sign-in overlay.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const gate = createSnapshotStore<CollabGateState>(COLLAB_GATE_INITIAL)
  // Probe is fire-and-forget; the store settles within a round-trip and the
  // overlay tracks it. Fail-open verdicts land too, so the overlay never
  // wedges the app behind the server gate.
  const probe = (): void => {
    void probeCollabSession().then((next) => { gate.set(next) })
  }
  const signIn = (): void => { window.location.assign(buildSignInUrl(window.location)) }
  const injected = (): CollabGateInjected => {
    const failure = signInFailure(window.location.search)
    return {
      hooks: { collabGate: gate },
      signIn,
      ...(failure === undefined ? {} : { signInError: failure }),
    }
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-auth: sign-in gate dictionaries')
  ctx.effect(() => {
    probe()
    const dispose = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'collab-login-gate',
      locale: NS,
      inject: injected,
    }, LoginGate))
    window.addEventListener('focus', probe)
    return () => {
      dispose()
      window.removeEventListener('focus', probe)
    }
  }, 'ui-auth: collab sign-in gate')
}
