/**
 * Collab session wire facts and the login-page probe. The session and login
 * path literals are the browser half of the collab API gateway's exact auth
 * routes (the host owns the same literals in `@deepseek-ai/dsh-collab-api`);
 * this package cannot import the host package, so the pairing is pinned by
 * both packages' tests.
 */

/** The gateway's plain-JSON session probe route. */
export const COLLAB_SESSION_PATH = '/api/collab/auth/session'
/** The gateway's OIDC start route; the browser is redirected here to sign in. */
export const COLLAB_SIGN_IN_PATH = '/api/collab/auth/login'
/** The gateway's session-clearing route (POST). */
export const COLLAB_LOGOUT_PATH = '/api/collab/auth/logout'

/** One of the four gate states the overlay renders from. */
export type CollabGateStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'absent'

/** The gate store's serializable snapshot. */
export interface CollabGateState {
  /** Current gate status: probing on mount, then the probe's verdict. */
  status: CollabGateStatus
  /** Whether a valid session cookie authorizes this browser. */
  authenticated: boolean
  /** Display name of the signed-in principal, when the session carries one. */
  principalName?: string
}

/** The initial snapshot before the first probe settles. */
export const COLLAB_GATE_INITIAL: CollabGateState = { status: 'checking', authenticated: false }

/** Probe response understood by the client (a superset is allowed). */
interface SessionResponseBody {
  authenticated?: unknown
  principal?: { name?: unknown } | undefined
}

/**
 * Probe the collab session route and fold the wire verdict into a gate state.
 * Any failure mode — network error, non-OK status, non-JSON body, missing
 * `authenticated` field — maps to {@link CollabGateStatus.ABSENT absent}: the
 * gate renders nothing and the server's own gate (a 401 on `/api`) remains
 * the enforcement point, so a UI that fails open never weakens the fence.
 * @returns the folded gate state; never rejects.
 */
export async function probeCollabSession(): Promise<CollabGateState> {
  let response: Response
  try {
    response = await fetch(COLLAB_SESSION_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
  } catch {
    return { status: 'absent', authenticated: false }
  }
  if (!response.ok) return { status: 'absent', authenticated: false }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: 'absent', authenticated: false }
  }
  if (typeof body !== 'object' || body === null) return { status: 'absent', authenticated: false }
  const record = body as SessionResponseBody
  if (record.authenticated === false) return { status: 'unauthenticated', authenticated: false }
  if (record.authenticated === true) {
    const name = record.principal?.name
    const state: CollabGateState = { status: 'authenticated', authenticated: true }
    if (typeof name === 'string' && name !== '') state.principalName = name
    return state
  }
  return { status: 'absent', authenticated: false }
}

/**
 * Build the loopback OIDC start URL preserving the current location as the
 * post-login destination.
 * @param currentLocation - the live browser location (origin, path, search).
 * @returns the absolute sign-in URL for `window.location.assign`.
 */
export function buildSignInUrl(currentLocation: Location): string {
  const target = new URL(COLLAB_SIGN_IN_PATH, currentLocation.origin)
  const redirectTo = `${currentLocation.pathname}${currentLocation.search}`
  if (redirectTo !== '/') target.searchParams.set('redirectTo', redirectTo)
  return target.toString()
}

/**
 * Read the server-side sign-in failure notice (the gateway redirects here
 * with `?collab=<reason>` on a refused exchange).
 * @param search - the current location search string.
 * @returns the failure reason, or undefined when the browser was not bounced.
 */
export function signInFailure(search: string): string | undefined {
  const reason = new URLSearchParams(search).get('collab')
  return reason ?? undefined
}

/**
 * Clear the browser's collab session cookie through the gateway's POST logout
 * route. A non-OK status or a network failure returns false so the caller can
 * leave the authenticated gate in place — the server fence remains the
 * authority, and a UI that fails open never claims a session that survived.
 * @returns whether the server accepted the logout.
 */
export async function signOut(): Promise<boolean> {
  try {
    const response = await fetch(COLLAB_LOGOUT_PATH, {
      method: 'POST',
      credentials: 'same-origin',
    })
    return response.ok
  } catch {
    return false
  }
}
