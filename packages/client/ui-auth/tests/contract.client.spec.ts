// @vitest-environment jsdom
/**
 * ui-auth wire contract: the session probe's verdict folding and the
 * sign-in URL / failure-notice helpers, all pure over a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSignInUrl, COLLAB_GATE_INITIAL, COLLAB_SESSION_PATH, COLLAB_SIGN_IN_PATH,
  probeCollabSession, signInFailure,
} from '../src/client/contract.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

describe('probeCollabSession', () => {
  it('starts checking and folds an authenticated session with a principal name', async () => {
    expect(COLLAB_GATE_INITIAL).toEqual({ status: 'checking', authenticated: false })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(true, 200, {
      authenticated: true,
      principal: { name: 'Owen', email: 'owen@deepseek.test' },
    })))
    await expect(probeCollabSession()).resolves.toEqual({
      status: 'authenticated', authenticated: true, principalName: 'Owen',
    })
    expect(fetch).toHaveBeenCalledWith(COLLAB_SESSION_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
  })

  it('drops an absent or non-string principal name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(true, 200, {
      authenticated: true,
      principal: { name: '' },
    })))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'authenticated', authenticated: true })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(true, 200, {
      authenticated: true,
      principal: { name: 7 },
    })))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'authenticated', authenticated: true })
  })

  it('folds an explicit unauthenticated verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(true, 200, { authenticated: false })))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'unauthenticated', authenticated: false })
  })

  it('treats a missing authenticated field as absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(true, 200, { ok: true })))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'absent', authenticated: false })
  })

  it('treats a non-object body as absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(true, 200, 42)))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'absent', authenticated: false })
  })

  it('treats a non-JSON body as absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } } as unknown as Response
    }))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'absent', authenticated: false })
  })

  it('treats a non-OK status as absent so the server gate stays the authority', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(false, 404, { error: 'no such route' })))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'absent', authenticated: false })
  })

  it('treats a network failure as absent without rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset') }))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'absent', authenticated: false })
  })

  it('never rejects on hostile bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => null }) as unknown as Response))
    await expect(probeCollabSession()).resolves.toEqual({ status: 'absent', authenticated: false })
  })
})

describe('sign-in URL and failure notice', () => {
  const origin = 'http://localhost:3080'
  const location = (pathname: string, search: string): Location => ({
    origin, pathname, search,
  } as Location)

  it('builds the loopback OIDC start URL preserving the current location', () => {
    expect(buildSignInUrl(location('/agents/work', '?ref=1'))).toBe(
      'http://localhost:3080/api/collab/auth/login?redirectTo=%2Fagents%2Fwork%3Fref%3D1')
  })

  it('omits the redirect param for the bare root', () => {
    expect(buildSignInUrl(location('/', ''))).toBe('http://localhost:3080/api/collab/auth/login')
    expect(buildSignInUrl(location('/', ''))).toContain(COLLAB_SIGN_IN_PATH)
  })

  it('reads a server-side sign-in refusal reason', () => {
    expect(signInFailure('?collab=signin-failed')).toBe('signin-failed')
    expect(signInFailure('?collab=')).toBe('')
    expect(signInFailure('?ref=1')).toBeUndefined()
    expect(signInFailure('')).toBeUndefined()
  })
})
