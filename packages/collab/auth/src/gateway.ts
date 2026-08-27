/**
 * The Google OpenID Connect strategy built on `openid-client@6`: discovery,
 * authorization URL, and authorization-code exchange with state/nonce checks.
 * @module @deepseek-ai/dsh-collab-auth/src/gateway (internal)
 */

import { authorizationCodeGrant, buildAuthorizationUrl, discovery, type Configuration } from 'openid-client'
import type { OidcGateway, OidcUserInfo } from './types.ts'

/** Google's issuer identifier; `openid-client@6` discovers metadata from it. */
export const GOOGLE_ISSUER = 'https://accounts.google.com'

/** Runtime errors from the Google strategy. */
export class OidcGatewayError extends Error {}

/**
 * Google OIDC strategy. The discovered configuration is created lazily on
 * first use so service startup never requires network access; the
 * authorization-code exchange validates the `state` and `nonce` the caller
 * supplied server-side.
 */
export class GoogleOidcGateway implements OidcGateway {
  readonly issuer = GOOGLE_ISSUER
  private configPromise: Promise<Configuration> | undefined

  /**
   * @param clientId - Google OAuth 2.0 client id.
   * @param clientSecret - Google OAuth 2.0 client secret.
   * @param redirectUri - registered redirect URI (must match the console).
   * @param scopes - requested scopes; defaults to OpenID profile + email.
   */
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly scopes: readonly string[] = ['openid', 'profile', 'email'],
  ) {}

  private configuration(): Promise<Configuration> {
    if (this.configPromise === undefined) {
      this.configPromise = (async () => {
        if (this.clientId === '' || this.clientSecret === '') {
          throw new OidcGatewayError('Google OAuth clientId and clientSecret are required')
        }
        try {
          return await discovery(new URL(GOOGLE_ISSUER), this.clientId, this.clientSecret)
        } catch (error) {
          throw new OidcGatewayError(`Google OIDC discovery failed: ${String(error)}`)
        }
      })()
    }
    return this.configPromise
  }

  async authorizationUrl(state: string, nonce: string): Promise<string> {
    const config = await this.configuration()
    return buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.scopes.join(' '),
      state,
      nonce,
    }).toString()
  }

  async userFromCallback(params: Record<string, string>): Promise<OidcUserInfo> {
    const config = await this.configuration()
    const url = new URL(this.redirectUri)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const checks: { expectedState?: string; expectedNonce?: string } = {}
    if (params.state !== undefined) checks.expectedState = params.state
    if (params.nonce !== undefined) checks.expectedNonce = params.nonce
    let response: Awaited<ReturnType<typeof authorizationCodeGrant>>
    try {
      response = await authorizationCodeGrant(config, url, checks)
    } catch (error) {
      throw new OidcGatewayError(`Google OIDC authorization-code exchange failed: ${String(error)}`)
    }
    const claims = response.claims()
    const sub = stringClaim(claims?.sub)
    const email = stringClaim(claims?.email)
    const emailVerified = claims?.email_verified === true || claims?.email_verified === 'true'
    if (sub === undefined) throw new OidcGatewayError('Google OIDC id_token carries no sub claim')
    const picture = stringClaim(claims?.picture)
    return {
      sub,
      email: email ?? '',
      emailVerified,
      name: stringClaim(claims?.name) ?? '',
      ...(picture !== undefined ? { avatarUrl: picture } : {}),
    }
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
