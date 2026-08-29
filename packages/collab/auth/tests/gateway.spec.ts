import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  discovery: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  authorizationCodeGrant: vi.fn(),
}))

vi.mock('openid-client', () => mocks)

import { GoogleOidcGateway, OidcGatewayError } from '../src/gateway.ts'

/** Build the fake configuration object the mocked module returns. */
function fakeConfiguration(): { marker: boolean } {
  return { marker: true }
}

describe('GoogleOidcGateway (offline via mocked openid-client)', () => {
  it('discovers lazily and builds the authorization URL with state and nonce', async () => {
    mocks.discovery.mockResolvedValue(fakeConfiguration())
    mocks.buildAuthorizationUrl
      .mockReturnValue(new URL('https://accounts.google.com/o/oauth2/v2/auth?client_id=cid'))
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/api/collab/auth/callback')
    const url = await gateway.authorizationUrl('state-1', 'nonce-1')
    expect(url).toContain('accounts.google.com')
    expect(mocks.discovery).toHaveBeenCalledWith(
      new URL('https://accounts.google.com'),
      'cid',
      'csecret',
    )
    expect(mocks.buildAuthorizationUrl).toHaveBeenCalledWith(
      expect.any(Object),
      /* oxlint-disable-next-line typescript/no-unsafe-assignment -- expect() matchers are `any` by design. */
      expect.objectContaining({ redirect_uri: expect.stringContaining('/api/collab/auth/callback'), state: 'state-1', nonce: 'nonce-1' }),
    )
  })

  it('builds the authorization URL with a derived redirect URI when one is supplied', async () => {
    mocks.discovery.mockResolvedValue(fakeConfiguration())
    mocks.buildAuthorizationUrl.mockReturnValue(new URL('https://accounts.google.com/o/oauth2/v2/auth'))
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/api/collab/auth/callback')
    await gateway.authorizationUrl('state-1', 'nonce-1', 'https://collab.example.com/api/collab/auth/callback')
    expect(mocks.buildAuthorizationUrl).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ redirect_uri: 'https://collab.example.com/api/collab/auth/callback', state: 'state-1', nonce: 'nonce-1' }),
    )
  })

  it('validates the exchange against a supplied derived redirect URI', async () => {
    mocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: 'sub-4', email: 'd@example.com', email_verified: true, name: 'D' }),
    })
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/cb')
    await gateway.userFromCallback({ code: 'c', state: 's', nonce: 'n' }, 'https://collab.example.com/api/collab/auth/callback')
    const call = mocks.authorizationCodeGrant.mock.calls[0] as [unknown, URL, unknown] | undefined
    expect(call).toBeDefined()
    expect(call![1].origin).toBe('https://collab.example.com')
    expect(call![1].pathname).toBe('/api/collab/auth/callback')
    expect(call![1].searchParams.get('code')).toBe('c')
  })

  it('surfaces a failed discovery once', async () => {
    mocks.discovery.mockRejectedValue(new Error('network down'))
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/cb')
    await expect(gateway.authorizationUrl('s', 'n')).rejects.toThrow(/discovery failed/)
    await expect(gateway.userFromCallback({ code: 'c', state: 's', nonce: 'n' }))
      .rejects.toThrow(/discovery failed/)
  })

  it('refuses to operate without client credentials', async () => {
    const gateway = new GoogleOidcGateway('', '', 'http://localhost:3080/cb')
    await expect(gateway.authorizationUrl('s', 'n')).rejects.toThrow(/clientId and clientSecret are required/)
  })

  it('maps verified id_token claims to a collab user', async () => {
    mocks.discovery.mockResolvedValue(fakeConfiguration())
    mocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({
        sub: 'sub-1',
        email: 'a@example.com',
        email_verified: true,
        name: 'A',
        picture: 'https://example.com/a.png',
      }),
    })
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/cb')
    const user = await gateway.userFromCallback({ code: 'c', state: 's', nonce: 'n' })
    expect(user).toEqual({
      sub: 'sub-1',
      email: 'a@example.com',
      emailVerified: true,
      name: 'A',
      avatarUrl: 'https://example.com/a.png',
    })
    expect(mocks.authorizationCodeGrant).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(URL),
      expect.objectContaining({ expectedState: 's', expectedNonce: 'n' }),
    )
  })

  it('handles string email_verified and an absent avatar', async () => {
    mocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: 'sub-2', email: 'b@example.com', email_verified: 'true', name: 'B' }),
    })
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/cb')
    const user = await gateway.userFromCallback({ code: 'c', state: 's', nonce: 'n' })
    expect(user.emailVerified).toBe(true)
    expect('avatarUrl' in user).toBe(false)
  })

  it('falls back to empty strings when claims omit email or name', async () => {
    mocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: 'sub-3', email_verified: true }),
    })
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/cb')
    const user = await gateway.userFromCallback({ code: 'c', state: 's', nonce: 'n' })
    expect(user.email).toBe('')
    expect(user.name).toBe('')
  })

  it('wraps an invalid exchange and requires a sub claim', async () => {
    mocks.authorizationCodeGrant.mockRejectedValue(new Error('invalid_grant'))
    const gateway = new GoogleOidcGateway('cid', 'csecret', 'http://localhost:3080/cb')
    await expect(gateway.userFromCallback({ code: 'bad' })).rejects.toBeInstanceOf(OidcGatewayError)

    mocks.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ email: 'c@example.com' }),
    })
    await expect(gateway.userFromCallback({ code: 'c', state: 's' })).rejects.toThrow(/no sub claim/)
  })
})
