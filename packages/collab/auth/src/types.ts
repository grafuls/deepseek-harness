/**
 * Type-only module for the collab auth service: the OIDC strategy seam and
 * the principal the collab surface resolves for one authenticated request.
 * @module @deepseek-ai/dsh-collab-auth/types
 */

import type { GlobalRole } from '@deepseek-ai/dsh-collab-rbac'
import type { UserId } from '@deepseek-ai/dsh-collab-users'

/** Verified identity facts returned by an OIDC strategy for a successful login. */
export interface OidcUserInfo {
  /** Stable Google `sub` claim — the identity key. */
  sub: string
  /** Verified email (Google sets `email_verified`). */
  email: string
  /** Whether the provider confirmed email ownership at this sign-in. */
  emailVerified: boolean
  /** Display name preferred by the provider. */
  name: string
  /** Profile picture URL, when the provider returns one. */
  avatarUrl?: string
}

/**
 * The identity the collab surface holds for one authenticated request. The
 * collab-api gateway resolves it from the session cookie through the user
 * registry and propagates it to Typert dispatch.
 */
export interface CollabPrincipal {
  /** The durable account id. */
  userId: UserId
  /** Verified account email (canonicalized). */
  email: string
  /** Display name. */
  name: string
  /** Instance-wide role, read from the user registry at resolution time. */
  globalRole: GlobalRole
  /** Whether the account is disabled at this moment. */
  disabled: boolean
}

/**
 * OIDC strategy seam. The real Google strategy is built on `openid-client`;
 * tests and alternate providers implement the same facts over their own
 * transports, so the session machinery stays provider-agnostic.
 */
export interface OidcGateway {
  /** Authorization endpoint family, for diagnostics. */
  readonly issuer: string
  /**
   * Build the authorization URL carrying the caller's `state` and `nonce`.
   * @param state - anti-CSRF token echoed by the provider at the callback.
   * @param nonce - replay-proof claim echoed by the provider at the callback.
   * @param redirectUri - the redirect URI for this exchange; omitted to use the gateway's registered URI.
   */
  authorizationUrl(state: string, nonce: string, redirectUri?: string): Promise<string>
  /**
   * Validate a callback exchange (code, state, nonce) and return the
   * verified user. Throws when the exchange is invalid.
   * @param params - raw query/form parameters from the callback request.
   * @param redirectUri - the same redirect URI this login started with, when the caller derived it; omitted for the registered URI.
   */
  userFromCallback(params: Record<string, string>, redirectUri?: string): Promise<OidcUserInfo>
}
