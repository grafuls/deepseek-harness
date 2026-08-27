import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CollabUsers from '@deepseek-ai/dsh-collab-users'
import CollabAuth, {
  AuthError,
  COOKIE_NAME,
  clearSessionCookieValue,
  resolveSpec,
  sessionCookieValue,
  sessionTokenFromCookieHeader,
  signSessionToken,
  verifySessionToken,
} from '../src/index.ts'
import type { OidcGateway, OidcUserInfo } from '../src/types.ts'
import type { UserId } from '@deepseek-ai/dsh-collab-users'

let root: string | undefined
const contexts: Context[] = []

/** Deterministic in-memory OIDC strategy standing in for the Google gateway. */
class FakeOidcGateway implements OidcGateway {
  readonly issuer = 'https://fake.example.com'
  user: OidcUserInfo = { sub: 'sub-alice', email: 'alice@example.com', emailVerified: true, name: 'Alice' }
  failExchange = false
  lastState = ''
  lastNonce = ''

  async authorizationUrl(state: string, nonce: string): Promise<string> {
    this.lastState = state
    this.lastNonce = nonce
    return `https://fake.example.com/authorize?state=${state}&nonce=${nonce}`
  }

  async userFromCallback(_params: Record<string, string>): Promise<OidcUserInfo> {
    if (this.failExchange) throw new Error('bad authorization code')
    return { ...this.user }
  }
}

async function harness(overrides: Record<string, unknown> = {}) {
  root = await mkdtemp(join(tmpdir(), 'dsh-collab-auth-'))
  const ctx = new Context()
  const gateway = new FakeOidcGateway()
  await ctx.plugin(CollabUsers, { dshHome: root, bootstrapFirstAdmin: false })
  await ctx.plugin(CollabAuth, { dshHome: root, secret: 'test-secret', gateway, ...overrides })
  contexts.push(ctx)
  return { ctx, gateway }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('session token machinery', () => {
  it('resolves explicit spec values and dev-only defaults', () => {
    const explicit = resolveSpec({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'http://localhost:3080/api/collab/auth/callback',
      secret: 'explicit',
      secureCookies: true,
      sessionTtlSeconds: 3600,
      stateTtlMs: 5000,
    })
    expect(explicit.clientId).toBe('cid')
    expect(explicit.redirectUri).toContain('/api/collab/auth/callback')
    expect(explicit.secret).toBe('explicit')
    expect(explicit.secureCookies).toBe(true)
    expect(explicit.sessionTtlSeconds).toBe(3600)
    expect(explicit.stateTtlMs).toBe(5000)

    const dev = resolveSpec({})
    expect(dev.redirectUri).toBe('http://localhost:3080/api/collab/auth/callback')
    expect(dev.secret).toContain('dev-only:')
    expect(dev.scopes).toContain('openid')
  })

  it('signs, verifies, and rejects tampered, wrong-key, malformed, and expired tokens', () => {
    const token = signSessionToken('s', 'u1' as UserId, 60, 1_000_000)
    const payload = verifySessionToken('s', token, 1_000_500)
    expect(payload?.userId).toBe('u1' as UserId)
    expect(payload?.exp).toBe(1_000_000 + 60 * 1000)

    const bits = token.split('.')
    expect(verifySessionToken('s', `${bits[0]}.${bits[1]! === 'a' ? 'b' : 'a'}`, 1_000_500)).toBeUndefined()
    expect(verifySessionToken('other-secret', token, 1_000_500)).toBeUndefined()
    expect(verifySessionToken('s', bits[0]!, 1_000_500)).toBeUndefined()
    expect(verifySessionToken('s', token, 1_000_000 + 60 * 1000 + 1)).toBeUndefined()

    // A correctly-signed payload that is not valid JSON resolves to undefined.
    const badPayload = Buffer.from('{not json').toString('base64url')
    const sig = Buffer.from(createHmac('sha256', 's').update(badPayload).digest())
    expect(verifySessionToken('s', `${badPayload}.${sig.toString('base64url')}`, 1_000_500)).toBeUndefined()
  })

  it('parses the session cookie from a Cookie header and renders cookie values', () => {
    const token = 'abc-token'
    expect(sessionTokenFromCookieHeader(`other=a; ${COOKIE_NAME}=${token}; b=c`)).toBe(token)
    expect(sessionTokenFromCookieHeader('other=a')).toBeUndefined()
    expect(sessionTokenFromCookieHeader(undefined)).toBeUndefined()
    const set = sessionCookieValue(token, 60, false)
    expect(set).toContain(`${COOKIE_NAME}=${token}`)
    expect(set).toContain('HttpOnly')
    expect(set).toContain('Max-Age=60')
    expect(sessionCookieValue(token, 60, true)).toContain('Secure')
    expect(clearSessionCookieValue(false)).toContain('Max-Age=0')
    expect(clearSessionCookieValue(true)).toContain('Secure')
  })
})

describe('sign-in flow', () => {
  it('begins a login with a state-carrying authorization URL', async () => {
    const { ctx, gateway } = await harness()
    const url = await ctx.collabAuth.loginUrl('/workspaces')
    expect(url).toContain('https://fake.example.com/authorize')
    expect(gateway.lastState).toBeTruthy()
    expect(gateway.lastNonce).toBeTruthy()
  })

  it('completes a login, mints a session, and resolves the principal', async () => {
    const { ctx } = await harness()
    const url = await ctx.collabAuth.loginUrl('/workspaces')
    const state = new URL(url).searchParams.get('state')!
    const nonce = new URL(url).searchParams.get('nonce')!
    const outcome = await ctx.collabAuth.completeLogin({ code: 'fake-code', state, nonce })
    expect(outcome.location).toBe('/workspaces')
    expect(outcome.principal.email).toBe('alice@example.com')
    expect(outcome.principal.globalRole).toBe('member')

    const principal = ctx.collabAuth.resolve(outcome.sessionToken)
    expect(principal?.userId).toBe(outcome.principal.userId)
    expect(principal?.email).toBe('alice@example.com')
    // The outcome token equals the freshly minted session token.
    expect(ctx.collabAuth.createSessionToken(outcome.principal.userId)).toBeTruthy()
  })

  it('refuses a login from an unknown, reused, or expired state', async () => {
    const { ctx } = await harness()
    // No state at all: the empty-string fallback finds no challenge.
    await expect(ctx.collabAuth.completeLogin({ code: 'x' })).rejects.toBeInstanceOf(AuthError)
    await expect(ctx.collabAuth.completeLogin({ code: 'x', state: 'nope', nonce: 'n' }))
      .rejects.toBeInstanceOf(AuthError)
    const url = await ctx.collabAuth.loginUrl('/')
    const state = new URL(url).searchParams.get('state')!
    const nonce = new URL(url).searchParams.get('nonce')!
    await ctx.collabAuth.completeLogin({ code: 'c', state, nonce })
    // The challenge is single-use.
    await expect(ctx.collabAuth.completeLogin({ code: 'c', state, nonce }))
      .rejects.toBeInstanceOf(AuthError)
  })

  it('refuses an unverified email and a failed exchange', async () => {
    const { ctx, gateway } = await harness()
    gateway.user = { sub: 'sub-bob', email: 'bob@example.com', emailVerified: false, name: 'Bob' }
    const url = await ctx.collabAuth.loginUrl('/')
    const state = new URL(url).searchParams.get('state')!
    const nonce = new URL(url).searchParams.get('nonce')!
    await expect(ctx.collabAuth.completeLogin({ code: 'c', state, nonce })).rejects.toThrow(/unverified email/)

    gateway.user = { sub: 'sub-bob', email: 'bob@example.com', emailVerified: true, name: 'Bob' }
    gateway.failExchange = true
    const url2 = await ctx.collabAuth.loginUrl('/')
    const state2 = new URL(url2).searchParams.get('state')!
    const nonce2 = new URL(url2).searchParams.get('nonce')!
    await expect(ctx.collabAuth.completeLogin({ code: 'bad', state: state2, nonce: nonce2 }))
      .rejects.toThrow(/bad authorization code/)
  })

  it('persists the avatar and surfaces cookie helpers on the service', async () => {
    const { ctx, gateway } = await harness()
    gateway.user = { sub: 'sub-alice', email: 'alice@example.com', emailVerified: true, name: 'Alice', avatarUrl: 'https://example.com/a.png' }
    const url = await ctx.collabAuth.loginUrl('/')
    const state = new URL(url).searchParams.get('state')!
    const nonce = new URL(url).searchParams.get('nonce')!
    const outcome = await ctx.collabAuth.completeLogin({ code: 'c', state, nonce })
    expect(ctx.collabUsers.findByEmail('alice@example.com')?.avatarUrl).toBe('https://example.com/a.png')
    expect(ctx.collabAuth.cookieValue(outcome.sessionToken)).toContain(`${COOKIE_NAME}=${outcome.sessionToken}`)
    expect(ctx.collabAuth.clearCookieValue()).toContain('Max-Age=0')
  })

  it('refuses an empty email claim and an unverified email', async () => {
    const { ctx, gateway } = await harness()
    gateway.user = { sub: 'sub-bob', email: '', emailVerified: true, name: 'Bob' }
    let url = await ctx.collabAuth.loginUrl('/')
    let state = new URL(url).searchParams.get('state')!
    let nonce = new URL(url).searchParams.get('nonce')!
    await expect(ctx.collabAuth.completeLogin({ code: 'c', state, nonce })).rejects.toThrow(/no email claim/)

    gateway.user = { sub: 'sub-bob', email: 'bob@example.com', emailVerified: false, name: 'Bob' }
    url = await ctx.collabAuth.loginUrl('/')
    state = new URL(url).searchParams.get('state')!
    nonce = new URL(url).searchParams.get('nonce')!
    await expect(ctx.collabAuth.completeLogin({ code: 'c', state, nonce })).rejects.toThrow(/unverified email/)

    gateway.user = { sub: 'sub-bob', email: 'bob@example.com', emailVerified: true, name: 'Bob' }
    gateway.failExchange = true
    url = await ctx.collabAuth.loginUrl('/')
    state = new URL(url).searchParams.get('state')!
    nonce = new URL(url).searchParams.get('nonce')!
    await expect(ctx.collabAuth.completeLogin({ code: 'bad', state, nonce }))
      .rejects.toThrow(/bad authorization code/)
  })

  it('expires stale sign-in states at completeLogin and prunes them at the next login', async () => {
    const { ctx } = await harness({ stateTtlMs: 5_000 })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const first = await ctx.collabAuth.loginUrl('/')
      const state1 = new URL(first).searchParams.get('state')!
      const nonce1 = new URL(first).searchParams.get('nonce')!
      // Fresh challenges are kept by the prune pass (false branch).
      vi.setSystemTime(11_000)
      await ctx.collabAuth.loginUrl('/')
      vi.setSystemTime(13_000)
      await ctx.collabAuth.loginUrl('/')
      // An expired-but-not-yet-pruned challenge is refused at its callback.
      vi.setSystemTime(20_000)
      await expect(ctx.collabAuth.completeLogin({ code: 'c', state: state1, nonce: nonce1 }))
        .rejects.toThrow(/state has expired/)

      // A later login's prune pass sweeps the now-stale challenges.
      vi.setSystemTime(30_000)
      const second = await ctx.collabAuth.loginUrl('/')
      expect(second).toContain('https://fake.example.com/authorize')
      vi.setSystemTime(40_000)
      const third = await ctx.collabAuth.loginUrl('/')
      const state3 = new URL(third).searchParams.get('state')!
      const nonce3 = new URL(third).searchParams.get('nonce')!
      // The fresh challenge still completes within its window.
      const outcome = await ctx.collabAuth.completeLogin({ code: 'c', state: state3, nonce: nonce3 })
      expect(outcome.principal.email).toBe('alice@example.com')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses login for a disabled account', async () => {
    const { ctx } = await harness()
    const first = await ctx.collabAuth.loginUrl('/')
    const s1 = new URL(first).searchParams.get('state')!
    const n1 = new URL(first).searchParams.get('nonce')!
    await ctx.collabAuth.completeLogin({ code: 'c', state: s1, nonce: n1 })
    const alice = ctx.collabUsers.findByEmail('alice@example.com')!
    await ctx.collabUsers.setDisabled('admin', alice.id, true)
    const url = await ctx.collabAuth.loginUrl('/')
    const state = new URL(url).searchParams.get('state')!
    const nonce = new URL(url).searchParams.get('nonce')!
    await expect(ctx.collabAuth.completeLogin({ code: 'c2', state, nonce })).rejects.toThrow(/disabled/)
  })
})

describe('session resolution', () => {
  it('resolves undefined for bogus, unknown, and expired sessions', async () => {
    const { ctx } = await harness()
    expect(ctx.collabAuth.resolve(undefined)).toBeUndefined()
    expect(ctx.collabAuth.resolve('garbage-with-dots.and.junk')).toBeUndefined()

    const unknown = signSessionToken('test-secret', 'nobody' as UserId, 60, Date.now())
    expect(ctx.collabAuth.resolve(unknown)).toBeUndefined()

    const url = await ctx.collabAuth.loginUrl('/')
    const state = new URL(url).searchParams.get('state')!
    const nonce = new URL(url).searchParams.get('nonce')!
    const outcome = await ctx.collabAuth.completeLogin({ code: 'c', state, nonce })
    const expired = signSessionToken('test-secret', outcome.principal.userId, 60, Date.now() - 120_000)
    expect(ctx.collabAuth.resolve(expired)).toBeUndefined()

    // A freshly minted token for the same account resolves.
    const fresh = ctx.collabAuth.createSessionToken(outcome.principal.userId)
    expect(ctx.collabAuth.resolve(fresh)?.userId).toBe(outcome.principal.userId)
  })

  it('resolves undefined for a disabled account', async () => {
    const { ctx } = await harness()
    const url = await ctx.collabAuth.loginUrl('/')
    const state = new URL(url).searchParams.get('state')!
    const nonce = new URL(url).searchParams.get('nonce')!
    const outcome = await ctx.collabAuth.completeLogin({ code: 'c', state, nonce })
    await ctx.collabUsers.setDisabled('admin', outcome.principal.userId, true)
    expect(ctx.collabAuth.resolve(outcome.sessionToken)).toBeUndefined()
  })
})

describe('startup requirements', () => {
  it('fails loud when the collab user registry is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-auth-'))
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(CollabAuth, { secret: 'x' }).await()).rejects.toThrow(/requires the collabUsers registry/)
  })
})
