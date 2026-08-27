/**
 * Collab auth service (`ctx.collabAuth`): Google OpenID Connect sign-in that
 * mints stateless, HMAC-signed session cookies and resolves a
 * {@link CollabPrincipal} for one authenticated request. The session token is
 * self-contained (the cookie is the session), so the service keeps no
 * per-user server-side state; the OIDC strategy is a seam, defaulting to the
 * `openid-client` Google gateway.
 * @module @deepseek-ai/dsh-collab-auth
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { UserId } from '@deepseek-ai/dsh-collab-users'
import { GoogleOidcGateway } from './gateway.ts'
import type { CollabPrincipal, OidcGateway } from './types.ts'

/** The session cookie the collab assembly expects on authenticated requests. */
export const COOKIE_NAME = 'dsh_collab_session'

/** Default expiry for a signed session cookie. */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/** How long an authorization challenge stays usable before it must be ingressed. */
export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000

/** Errors surfaced by the auth flow (sign-in, callback, session). */
export class AuthError extends Error {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Collab auth service. */
    collabAuth: CollabAuth
  }
}

/** Plugin config for the Google sign-in surface and cookie session. */
export interface Config {
  /** Google OpenID Connect client id. */
  clientId?: string
  /** Google OpenID Connect client secret. */
  clientSecret?: string
  /** Registered redirect URI (must match the Google console entry). */
  redirectUri?: string
  /** Public base URL used to derive the redirect URI when omitted. */
  baseUrl?: string
  /** HMAC secret signing session cookies; a dshHome-derived dev default when omitted. */
  secret?: string
  /** Harness home used for the dev secret default and shared roots. */
  dshHome?: string
  /** Session cookie lifetime in seconds. */
  sessionTtlSeconds?: number
  /** Strictness: mark cookies `Secure` (set true behind TLS termination). */
  secureCookies?: boolean
  /** OIDC scopes, space-joined for Google. */
  scopes?: string[]
  /** Authorization challenge TTL in milliseconds. */
  stateTtlMs?: number
}

/** Mount-time config: the public surface plus a programmatic gateway override. */
export interface CollabAuthConfig extends Config {
  /** OIDC strategy override for the authorization-code exchange (defaults to Google). */
  gateway?: OidcGateway
}

/** Plugin config schema. */
export const Config: z<Config> = z.object({
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  redirectUri: z.string().default(''),
  baseUrl: z.string().default('http://localhost:3080'),
  secret: z.string().default(''),
  dshHome: z.string().default(''),
  sessionTtlSeconds: z.natural().min(60).default(DEFAULT_SESSION_TTL_SECONDS),
  secureCookies: z.boolean().default(false),
  scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
  stateTtlMs: z.natural().min(1_000).default(DEFAULT_STATE_TTL_MS),
})

/** Resolved runtime spec derived from raw config; defaulting happens here. */
interface ResolvedSpec {
  clientId: string
  clientSecret: string
  redirectUri: string
  secret: string
  sessionTtlSeconds: number
  secureCookies: boolean
  scopes: readonly string[]
  stateTtlMs: number
}

/**
 * Resolve the runtime spec: an explicit `secret` wins; otherwise derive a
 * deterministic dev-only secret from the harness home so a localhost checkout
 * works without configuration. Production must set `secret`.
 * @param config - unresolved plugin config.
 * @returns the resolved runtime spec with defaults applied.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const baseUrl = config.baseUrl ?? 'http://localhost:3080'
  const rawRedirectUri = config.redirectUri ?? ''
  const rawSecret = config.secret ?? ''
  return {
    clientId: config.clientId ?? '',
    clientSecret: config.clientSecret ?? '',
    redirectUri: rawRedirectUri.trim() !== '' ? rawRedirectUri : `${baseUrl}/api/collab/auth/callback`,
    secret: rawSecret !== '' ? rawSecret : `dev-only:${resolveDshHome(config.dshHome)}:collab-session`,
    sessionTtlSeconds: config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
    secureCookies: config.secureCookies ?? false,
    scopes: config.scopes ?? ['openid', 'profile', 'email'],
    stateTtlMs: config.stateTtlMs ?? DEFAULT_STATE_TTL_MS,
  }
}

/** One in-flight authorization exchange, keyed by its anti-CSRF `state`. */
interface PendingChallenge {
  nonce: string
  redirectTo: string
  createdAt: number
}

/** Successful outcome of {@link CollabAuth.completeLogin}. */
export interface LoginOutcome {
  /** Where the browser should continue after the code exchange. */
  location: string
  /** The session cookie value to set. */
  sessionToken: string
  /** Resolved identity for the new session. */
  principal: CollabPrincipal
}

/** Outer payload of a signed session token. */
export interface SessionTokenPayload {
  userId: UserId
  iat: number
  exp: number
}

/**
 * Sign a stateless session token bound to {@link COOKIE_NAME}.
 * @param secret - HMAC key validated at verification time.
 * @param userId - account the token authenticates.
 * @param ttlSeconds - session lifetime in seconds.
 * @param nowMs - clock instant used for `iat`/`exp` (for tests).
 * @returns the self-contained `payload.signature` token.
 */
export function signSessionToken(secret: string, userId: UserId, ttlSeconds: number, nowMs: number = Date.now()): string {
  const payload: SessionTokenPayload = { userId, iat: nowMs, exp: nowMs + ttlSeconds * 1000 }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${hmac(secret, encoded)}`
}

/**
 * Verify a session token and return its payload, or undefined when invalid/expired.
 * @param secret - HMAC key the token was signed with.
 * @param token - raw session token value.
 * @param nowMs - clock instant used for the expiry check (for tests).
 * @returns the decoded payload, or undefined for a bad signature or expired token.
 */
export function verifySessionToken(secret: string, token: string, nowMs: number = Date.now()): SessionTokenPayload | undefined {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return undefined
  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!constantTimeEqual(hmac(secret, encoded), signature)) return undefined
  let payload: SessionTokenPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionTokenPayload
  } catch {
    return undefined
  }
  if (typeof payload.userId !== 'string' || payload.exp <= nowMs) return undefined
  return payload
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Read the session cookie value from a raw `Cookie` request header.
 * @param header - value of the `Cookie` request header, or undefined.
 * @returns the session token when the cookie is present, otherwise undefined.
 */
export function sessionTokenFromCookieHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) return trimmed.slice(COOKIE_NAME.length + 1)
  }
  return undefined
}

/**
 * Render the `Set-Cookie` value that mints a session.
 * @param token - session token to hand the browser.
 * @param ttlSeconds - cookie lifetime in seconds.
 * @param secure - whether to mark the cookie `Secure`.
 * @returns the `Set-Cookie` value.
 */
export function sessionCookieValue(token: string, ttlSeconds: number, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${secure ? '; Secure' : ''}`
}

/**
 * Render the `Set-Cookie` value that clears a session.
 * @param secure - whether to mark the cookie `Secure`.
 * @returns the `Set-Cookie` value.
 */
export function clearSessionCookieValue(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

/** The user-registry surface the auth service relies on. */
export interface RegistryView {
  findOrCreateByGoogle(profile: { sub: string; email: string; name: string; avatarUrl?: string }): Promise<{
    id: UserId
    email: string
    name: string
    globalRole: 'admin' | 'member'
    disabled: boolean
  }>
  findById(id: UserId): {
    id: UserId
    email: string
    name: string
    globalRole: 'admin' | 'member'
    disabled: boolean
  } | undefined
}

/**
 * Collab auth service. Startup binds the Google OIDC strategy and the
 * required collab user registry; session resolution is a pure function of the
 * cookie and the registry, keeping authenticated requests off any store path.
 */
export class CollabAuth extends Service {
  private readonly spec: ResolvedSpec
  /** The OIDC strategy carrying the authorization-code exchange. */
  readonly gateway: OidcGateway
  /** The user registry's surface the auth service relies on; set at init. */
  private users!: RegistryView
  private readonly pending = new Map<string, PendingChallenge>()

  /**
   * @param ctx - owning context.
   * @param config - resolved plugin config; a programmatic `gateway` overrides the Google strategy.
   */
  constructor(ctx: Context, config: CollabAuthConfig = {}) {
    super(ctx, 'collabAuth')
    this.spec = resolveSpec(config)
    if (config.gateway !== undefined) {
      this.gateway = config.gateway
    } else {
      this.gateway = new GoogleOidcGateway(
        this.spec.clientId,
        this.spec.clientSecret,
        this.spec.redirectUri,
        this.spec.scopes,
      )
    }
  }

  /** The registered redirect URI the callback route must be reachable at. */
  get redirectUri(): string {
    return this.spec.redirectUri
  }

  /** Open the service: require the collab user registry for identity facts. */
  protected [Service.init](): void {
    const users = this.ctx.get('collabUsers', false)
    if (users === undefined) {
      throw new AuthError('collab auth requires the collabUsers registry to be mounted')
    }
    this.users = users
  }

  /**
   * Begin a sign-in: stash an anti-CSRF challenge and return the provider's
   * authorization URL.
   * @param redirectTo - where the browser lands after the callback (default `/`).
   * @returns the provider authorization URL carrying `state` and `nonce`.
   */
  async loginUrl(redirectTo: string = '/'): Promise<string> {
    this.pruneExpiredStates()
    const state = randomUUID()
    const nonce = randomBytes(18).toString('base64url')
    this.pending.set(state, { nonce, redirectTo, createdAt: Date.now() })
    return this.gateway.authorizationUrl(state, nonce)
  }

  /**
   * Finish a sign-in from the callback parameters: validate the exchange
   * against the pending challenge, upsert the Google identity, mint a session
   * token, and return the outcome for the host to apply.
   * @param params - raw callback query/form parameters (`code`, `state`, `nonce`).
   * @returns the post-login location and the session token to set.
   */
  async completeLogin(params: Record<string, string>): Promise<LoginOutcome> {
    const state = params.state ?? ''
    const challenge = this.pending.get(state)
    if (challenge === undefined) throw new AuthError('collab sign-in state is missing, unknown, or already used')
    if (Date.now() - challenge.createdAt > this.spec.stateTtlMs) {
      this.pending.delete(state)
      throw new AuthError('collab sign-in state has expired')
    }
    this.pending.delete(state)
    const user = await this.gateway.userFromCallback({ ...params, nonce: challenge.nonce })
    if (user.email === '' || !user.emailVerified) {
      throw new AuthError(`collab sign-in refused: ${user.email === '' ? 'no email claim' : 'unverified email'}`)
    }
    const account = await this.users.findOrCreateByGoogle({
      sub: user.sub,
      email: user.email,
      name: user.name,
      ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
    })
    if (account.disabled) throw new AuthError(`collab sign-in refused: account '${account.id}' is disabled`)
    const sessionToken = signSessionToken(this.spec.secret, account.id, this.spec.sessionTtlSeconds)
    return {
      location: challenge.redirectTo,
      sessionToken,
      principal: {
        userId: account.id,
        email: account.email,
        name: account.name,
        globalRole: account.globalRole,
        disabled: account.disabled,
      },
    }
  }

  /**
   * Resolve the principal for a session cookie value, or undefined when the
   * token, its signature, its expiry, or the account is invalid. Never throws
   * on attacker-supplied tokens — it is the auth fence's hot path.
   * @param token - raw session token, or undefined for an unauthenticated call.
   * @param nowMs - clock instant used for the expiry check (for tests).
   * @returns the resolved principal, or undefined when unauthenticated.
   */
  resolve(token: string | undefined, nowMs: number = Date.now()): CollabPrincipal | undefined {
    if (token === undefined) return undefined
    const payload = verifySessionToken(this.spec.secret, token, nowMs)
    if (payload === undefined) return undefined
    const record = this.users.findById(payload.userId)
    if (record === undefined || record.disabled) return undefined
    return {
      userId: record.id,
      email: record.email,
      name: record.name,
      globalRole: record.globalRole,
      disabled: record.disabled,
    }
  }

  /**
   * Mint a session token for an account (primarily for tests and tooling).
   * @param userId - account the token authenticates.
   * @param nowMs - clock instant used for `iat`/`exp` (for tests).
   * @returns the freshly signed session token.
   */
  createSessionToken(userId: UserId, nowMs: number = Date.now()): string {
    return signSessionToken(this.spec.secret, userId, this.spec.sessionTtlSeconds, nowMs)
  }

  /**
   * The `Set-Cookie` value that mints this service's session.
   * @param token - session token to hand the browser.
   * @returns the `Set-Cookie` value.
   */
  cookieValue(token: string): string {
    return sessionCookieValue(token, this.spec.sessionTtlSeconds, this.spec.secureCookies)
  }

  /**
   * The `Set-Cookie` value that clears this service's session.
   * @returns the `Set-Cookie` value.
   */
  clearCookieValue(): string {
    return clearSessionCookieValue(this.spec.secureCookies)
  }

  private pruneExpiredStates(): void {
    const now = Date.now()
    for (const [state, challenge] of this.pending) {
      if (now - challenge.createdAt > this.spec.stateTtlMs) this.pending.delete(state)
    }
  }
}

export type { CollabPrincipal, OidcGateway, OidcUserInfo } from './types.ts'

/** {@inheritDoc CollabAuth} */
export default CollabAuth
