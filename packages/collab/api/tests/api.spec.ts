/**
 * Unit coverage for the collab API assembly: endpoint dispatch over real
 * collab services, the plugin wiring (auth fence + interceptor + routes), and
 * the browser HTTP handlers.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { UserId } from '@deepseek-ai/dsh-collab-users'
import { CollabAuth, type OidcGateway } from '@deepseek-ai/dsh-collab-auth'
import { CollabUsers } from '@deepseek-ai/dsh-collab-users'
import { CollabWorkspaces } from '@deepseek-ai/dsh-collab-workspaces'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, COLLAB_AUTH_LOGIN_PATH, COLLAB_AUTH_LOGOUT_PATH, COLLAB_AUTH_SESSION_PATH } from '../src/index.ts'
import { dispatchCollabEndpoint, workspaceDataDir } from '../src/dispatch.ts'
import { collabError } from '../src/errors.ts'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { CollabWorkspaceView } from '../src/types.ts'

/** A deterministic OIDC gateway standing in for Google. */
function fakeGateway(overrides: Partial<OidcGateway> = {}): OidcGateway {
  return { ...defaultGateway(), ...overrides }
}

function defaultGateway(): OidcGateway {
  return {
    issuer: 'https://accounts.google.test',
    async authorizationUrl(state: string, nonce: string): Promise<string> {
      return `https://accounts.google.test/auth?state=${state}&nonce=${nonce}`
    },
    async userFromCallback(): Promise<{ sub: string; email: string; emailVerified: boolean; name: string }> {
      return { sub: 'google-1', email: 'owen@example.com', emailVerified: true, name: 'Owen' }
    },
  } satisfies OidcGateway
}

interface Booted {
  ctx: Context
  root: string
  admin: { userId: string; email: string; name: string; globalRole: 'admin' | 'member' }
  member: { userId: string; email: string; name: string; globalRole: 'admin' | 'member' }
  dispose: () => Promise<void>
}

const boots: Booted[] = []

afterEach(async () => {
  for (const boot of boots.splice(0)) {
    await boot.dispose()
    rmSync(boot.root, { recursive: true, force: true })
  }
})

interface GatewayOverrides {
  /** The OIDC gateway to inject; defaults to the deterministic fake. */
  gateway?: OidcGateway
}

async function bootServices(overrides: GatewayOverrides = {}): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-collab-api-'))
  const ctx = new Context()
  await ctx.plugin(CollabUsers, { root: join(root, 'users') })
  await ctx.plugin(CollabWorkspaces, { root: join(root, 'workspaces') })
  await ctx.plugin(CollabAuth, {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    secret: 'test-secret-signing-key',
    redirectUri: 'http://localhost:3080/api/collab/auth/callback',
    gateway: overrides.gateway ?? fakeGateway(),
  })
  const adminRec = await ctx.collabUsers.findOrCreateByGoogle({
    sub: 'google-1',
    email: 'owen@example.com',
    name: 'Owen',
  })
  const memberRec = await ctx.collabUsers.findOrCreateByGoogle({
    sub: 'google-2',
    email: 'lina@example.com',
    name: 'Lina',
  })
  const admin = {
    userId: adminRec.id,
    email: adminRec.email,
    name: adminRec.name,
    globalRole: 'admin' as const,
  }
  const member = {
    userId: memberRec.id,
    email: memberRec.email,
    name: memberRec.name,
    globalRole: 'member' as const,
  }
  const boot: Booted = {
    ctx,
    root,
    admin,
    member,
    dispose: () => ctx.fiber.dispose(),
  }
  boots.push(boot)
  return boot
}

async function call(
  boot: Booted,
  principal: { userId: string; email: string; globalRole: 'admin' | 'member' },
  endpoint: string,
  payload: unknown,
) {
  return dispatchCollabEndpoint(boot.ctx, principal as never, endpoint, payload)
}

function value(result: Awaited<ReturnType<typeof call>>): unknown {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

/** Assert a folded collab refusal with the exact error code. */
function expectCollabError(result: RpcResult<unknown>, code: string): void {
  if (result.ok) throw new Error(`expected collab ${code} refusal`)
  expect(result.error.code).toBe(code)
}

/** Let fire-and-forget route handlers (`void handle…`) settle. */
function flush(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve))
}

describe('collab/auth methods', () => {
  it('reports the authenticated caller identity', async () => {
    const boot = await bootServices()
    const result = await call(boot, boot.admin, 'collab/auth.status', {})
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      value: { authenticated: true, principal: { userId: boot.admin.userId, email: boot.admin.email, globalRole: 'admin' } },
    })
  })
})

describe('collab/workspace methods', () => {
  it('creates a workspace as owner/admin and lists it', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: ' Visual  Lab ' }))
    expect(created).toMatchObject({ isOwner: true, role: 'admin', memberCount: 1 })
    const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.name).toBe('Visual  Lab')
    const nonMember = value(await call(boot, boot.member, 'collab/workspace.list', {}))
    expect(nonMember).toEqual([])
  })

  it('rejects empty or non-string workspace names', async () => {
    const boot = await bootServices()
    const empty = await call(boot, boot.admin, 'collab/workspace.create', { name: '   ' })
    expectCollabError(empty, 'collab-bad-request')
    const nonString = await call(boot, boot.admin, 'collab/workspace.create', { name: 42 })
    expectCollabError(nonString, 'collab-bad-request')
  })

  it('reads a workspace only for members', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const asUser = value(await call(boot, boot.admin, 'collab/workspace.get', { workspaceId: created.id }))
    expect(asUser).toMatchObject({ id: created.id, name: 'Team' })
    const denied = await call(boot, boot.member, 'collab/workspace.get', { workspaceId: created.id })
    expectCollabError(denied, 'collab-forbidden')
    const missing = await call(boot, boot.admin, 'collab/workspace.get', { workspaceId: 'nope' })
    expectCollabError(missing, 'collab-not-found')
  })

  it('lists members with user-registry enrichment', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const members = value(await call(boot, boot.admin, 'collab/workspace.members', { workspaceId: created.id })) as Array<{ userId: string; email: string; name: string }>
    /* oxlint-disable-next-line typescript/no-unsafe-assignment -- expect() matchers are `any` by design. */
    expect(members).toEqual([{ userId: boot.admin.userId, email: 'owen@example.com', name: 'Owen', role: 'admin', joinedAt: expect.any(String) }])
  })

  it('resolves the per-workspace data directory for members', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = value(await call(boot, boot.admin, 'collab/workspace.dir', { workspaceId: created.id })) as { dir: string }
    expect(dir.dir).toBe(workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id))
    const denied = await call(boot, boot.member, 'collab/workspace.dir', { workspaceId: created.id })
    expectCollabError(denied, 'collab-forbidden')
  })

  it('invites, lists, and revokes invitations with admin-only role gating', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: ' jamie@example.com ',
      role: 'developer',
    })) as { id: string; email: string; role: string; revoked: boolean }
    expect(invitation).toMatchObject({ email: 'jamie@example.com', role: 'developer', revoked: false })
    const invites = value(await call(boot, boot.admin, 'collab/workspace.invitations', { workspaceId: created.id }))
    expect(invites).toHaveLength(1)
    // The second user joins as a developer: developers hold no invite permission.
    const forMember = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
      role: 'developer',
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: forMember.id }))
    const denied = await call(boot, boot.member, 'collab/workspace.invite', { workspaceId: created.id, email: 'x@example.com' })
    expectCollabError(denied, 'collab-forbidden')
    const revoked = value(await call(boot, boot.admin, 'collab/workspace.revokeInvitation', {
      workspaceId: created.id,
      invitationId: invitation.id,
    })) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)
  })

  it('joins a workspace by consuming the invitation addressed to the caller', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
    })) as { id: string }
    const joined = value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id })) as CollabWorkspaceView
    expect(joined).toMatchObject({ id: created.id, role: 'developer', memberCount: 2 })
    const again = await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id })
    expectCollabError(again, 'collab-bad-request')
    const mismatch = await call(boot, boot.admin, 'collab/workspace.join', { invitationId: invitation.id })
    expect(mismatch.ok).toBe(false)
  })

  it('leaves and deletes a workspace by a member and its owner', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))
    const left = value(await call(boot, boot.member, 'collab/workspace.leave', { workspaceId: created.id }))
    expect(left).toEqual({ left: true })
    const ownerLeave = await call(boot, boot.admin, 'collab/workspace.leave', { workspaceId: created.id })
    expect(ownerLeave.ok).toBe(false)
    const deleted = value(await call(boot, boot.admin, 'collab/workspace.delete', { workspaceId: created.id }))
    expect(deleted).toEqual({ deleted: true })
    const missing = await call(boot, boot.admin, 'collab/workspace.delete', { workspaceId: created.id })
    expectCollabError(missing, 'collab-not-found')
  })

  it('setMemberRole and removeMember are admin-gated and validated', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
      role: 'developer',
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))
    // A developer cannot manage roles or members.
    const developerGated = await call(boot, boot.member, 'collab/workspace.setMemberRole', {
      workspaceId: created.id,
      userId: boot.admin.userId,
      role: 'developer',
    })
    expectCollabError(developerGated, 'collab-forbidden')
    const changed = value(await call(boot, boot.admin, 'collab/workspace.setMemberRole', {
      workspaceId: created.id,
      userId: boot.member.userId,
      role: 'admin',
    })) as { role: string }
    expect(changed.role).toBe('admin')
    const removed = value(await call(boot, boot.admin, 'collab/workspace.removeMember', {
      workspaceId: created.id,
      userId: boot.member.userId,
    })) as { removed: string }
    expect(removed.removed).toBe(boot.member.userId)
    const badRole = await call(boot, boot.admin, 'collab/workspace.setMemberRole', {
      workspaceId: created.id,
      userId: boot.admin.userId,
      role: 'owner',
    })
    expectCollabError(badRole, 'collab-bad-request')
  })
})

describe('collab/users admin surface', () => {
  it('lists accounts and mutates roles only as an instance admin', async () => {
    const boot = await bootServices()
    const denied = await call(boot, boot.member, 'collab/users.list', {})
    expectCollabError(denied, 'collab-forbidden')
    const listed = value(await call(boot, boot.admin, 'collab/users.list', {})) as Array<{ id: string; globalRole: string }>
    expect(listed.map(entry => entry.id)).toEqual([boot.admin.userId, boot.member.userId])
    const promoted = value(await call(boot, boot.admin, 'collab/users.setGlobalRole', {
      userId: boot.member.userId,
      role: 'admin',
    })) as { globalRole: string }
    expect(promoted.globalRole).toBe('admin')
    const disabled = value(await call(boot, boot.admin, 'collab/users.setDisabled', {
      userId: boot.member.userId,
      disabled: true,
    })) as { disabled: boolean }
    expect(disabled.disabled).toBe(true)
    const badFlag = await call(boot, boot.admin, 'collab/users.setDisabled', { userId: boot.member.userId, disabled: 'yes' })
    expectCollabError(badFlag, 'collab-bad-request')
  })
})

describe('wire validation and error folding', () => {
  it('rejects unknown endpoints and non-object payloads', async () => {
    const boot = await bootServices()
    const unknown = await call(boot, boot.admin, 'collab/whatever', {})
    expectCollabError(unknown, 'collab-not-found')
    const array = await call(boot, boot.admin, 'collab/workspace.list', [1])
    expectCollabError(array, 'collab-bad-request')
  })

})

describe('collabError helper', () => {
  it('builds the failure branch with a merged details map', () => {
    const error = collabError('collab-not-found', 'collab: workspace nope does not exist')
    expect(error).toEqual({ code: 'collab-not-found', message: 'collab: workspace nope does not exist', details: {} })
  })
})

/** Minimal ServerResponse stand-in capturing the emitted response. */
function fakeResponse() {
  let status = 0
  let location = ''
  let cookie = ''
  let sent = ''
  const headers: Record<string, string> = {}
  return {
    get statusCode(): number {
      return status
    },
    get locationHeader(): string {
      return location
    },
    get cookieHeader(): string {
      return cookie
    },
    get sent(): string {
      return sent
    },
    headers,
    setHeader(name: string, value: string): void {
      headers[name] = value
      if (name === 'Set-Cookie') cookie = value
    },
    writeHead(code: number, extra: Record<string, string> | undefined): void {
      status = code
      if (extra?.Location !== undefined) location = extra.Location
    },
    end(body?: string): void {
      sent = body ?? ''
      status = status === 0 ? 200 : status
    },
  }
}

interface StubConnection {
  authenticator: ((facts: { headers: IncomingHttpHeaders | Headers }) => unknown) | undefined
  intercept: { matcher: (endpoint: string) => boolean; handler: (endpoint: string, payload: unknown) => Promise<unknown> } | undefined
  principalValue: unknown
  registerAuthenticator: (owner: object, fn: (facts: { headers: IncomingHttpHeaders | Headers }) => unknown) => () => void
  principal: () => unknown
  rpc: {
    intercept: (
      channel: string,
      matcher: (endpoint: string) => boolean,
      handler: (endpoint: string, payload: unknown) => Promise<unknown>,
      options: { authority: string },
    ) => () => void
  }
}

type StubWebServer = {
  routes: Array<{ kind: 'exact'; path: string; handler: (req: { method: string; url?: string; headers: Record<string, string>; on?: (event: string, cb: (chunk?: string) => void) => void }, res: ReturnType<typeof fakeResponse>) => void | Promise<void> }>
  register: (route: { kind: 'exact'; path: string; handler: unknown }) => () => void
}

async function bootPlugin(overrides: GatewayOverrides = {}): Promise<{
  ctx: Context
  connection: StubConnection
  web: StubWebServer
  auth: CollabAuth
  booted: Booted
}> {
  const boot = await bootServices(overrides)
  const connection: StubConnection = {
    authenticator: undefined,
    intercept: undefined,
    principalValue: undefined,
    registerAuthenticator(_owner, fn) {
      this.authenticator = fn
      return () => { this.authenticator = undefined }
    },
    principal() {
      return this.principalValue
    },
    rpc: {
      intercept(channel, matcher, handler, options) {
        void channel
        void options
        connection.intercept = { matcher, handler }
        return () => { connection.intercept = undefined }
      },
    },
  }
  const web: StubWebServer = { routes: [], register(route) { web.routes.push({ ...route } as StubWebServer['routes'][number]); return () => {} } }
  boot.ctx.provide('connection' as never, connection as never)
  boot.ctx.provide('webServer' as never, web as never)
  apply(boot.ctx)
  return { ctx: boot.ctx, connection, web, auth: boot.ctx.collabAuth, booted: boot }
}

describe('plugin wiring', () => {
  it('registers the cookie authenticator and resolves principals off the fence', async () => {
    const { connection, booted } = await bootPlugin()
    expect(connection.authenticator).toBeDefined()
    expect(connection.authenticator!({ headers: {} })).toBeUndefined()
    const token = booted.ctx.collabAuth.createSessionToken(UserId(booted.admin.userId))
    const principal = connection.authenticator!({ headers: { cookie: `dsh_collab_session=${token}` } }) as { userId: string; email: string }
    expect(principal).toMatchObject({ userId: booted.admin.userId, email: 'owen@example.com' })
  })

  it('registers the collab interceptor and dispatches under the gate principal', async () => {
    const { connection, booted } = await bootPlugin()
    expect(connection.intercept?.matcher('collab/workspace.list')).toBe(true)
    expect(connection.intercept?.matcher('session.create')).toBe(false)
    connection.principalValue = {
      userId: booted.admin.userId,
      email: booted.admin.email,
      name: booted.admin.name,
      globalRole: 'admin',
    }
    const interceptor = connection.intercept
    expect(interceptor).toBeDefined()
    const result = await interceptor!.handler('collab/workspace.list', {})
    expect(result).toMatchObject({ ok: true, value: [] })
    connection.principalValue = undefined
    const gate = await interceptor!.handler('collab/workspace.list', {})
    expectCollabError(gate as RpcResult<unknown>, 'collab-forbidden')
  })

  it('registers the login, callback, logout, and session exact routes', async () => {
    const { web } = await bootPlugin()
    const paths = web.routes.map(route => route.path)
    expect(paths).toEqual(expect.arrayContaining([COLLAB_AUTH_LOGIN_PATH, '/api/collab/auth/callback', COLLAB_AUTH_LOGOUT_PATH, COLLAB_AUTH_SESSION_PATH]))
  })

  it('signs the browser in end to end through the exact routes', async () => {
    const { web } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: `${COLLAB_AUTH_LOGIN_PATH}?redirectTo=%2Fapp`, headers: {} }, loginRes)
    await flush()
    expect(loginRes.statusCode).toBe(302)
    expect(loginRes.locationHeader).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=/)
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!

    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const callbackRes = fakeResponse()
    void callback.handler({ method: 'GET', url: `/api/collab/auth/callback?code=abc&state=${state}`, headers: {} }, callbackRes)
    await flush()
    expect(callbackRes.statusCode).toBe(302)
    expect(callbackRes.locationHeader).toBe('/app')
    expect(callbackRes.cookieHeader).toMatch(/^dsh_collab_session=/)

    const session = web.routes.find(route => route.path === COLLAB_AUTH_SESSION_PATH)!
    const cookie = callbackRes.cookieHeader.split(';')[0]!
    const probeRes = fakeResponse()
    void session.handler({ method: 'GET', url: COLLAB_AUTH_SESSION_PATH, headers: { cookie } }, probeRes)
    await flush()
    expect(probeRes.statusCode).toBe(200)
    expect(JSON.parse(probeRes.sent)).toMatchObject({ authenticated: true, principal: { email: 'owen@example.com' } })
    const signedOut = fakeResponse()
    void session.handler({ method: 'GET', url: COLLAB_AUTH_SESSION_PATH, headers: {} }, signedOut)
    await flush()
    expect(JSON.parse(signedOut.sent)).toEqual({ authenticated: false })

    const logout = web.routes.find(route => route.path === COLLAB_AUTH_LOGOUT_PATH)!
    const logoutRes = fakeResponse()
    void logout.handler({ method: 'POST', url: COLLAB_AUTH_LOGOUT_PATH, headers: {} }, logoutRes)
    expect(logoutRes.statusCode).toBe(204)
    expect(logoutRes.cookieHeader).toMatch(/^dsh_collab_session=;/)
    const wrongMethodRes = fakeResponse()
    await logout.handler({ method: 'GET', url: COLLAB_AUTH_LOGOUT_PATH, headers: {} }, wrongMethodRes)
    expect(wrongMethodRes.statusCode).toBe(405)
  })

  it('supports the urlencoded POST callback and refuses a failed exchange', async () => {
    const { web, booted } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, loginRes)
    await flush()
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!

    const postRes = fakeResponse()
    const postReq = new EventEmitter() as EventEmitter &
      { method: string; url: string; headers: Record<string, string>; readEntries?: boolean }
    postReq.method = 'POST'
    postReq.url = '/api/collab/auth/callback'
    postReq.headers = {}
    void callback.handler(postReq, postRes)
    queueMicrotask(() => {
      postReq.emit('data', `code=abc&state=${state}`)
      postReq.emit('end')
    })
    await flush()
    await flush()
    expect(postRes.statusCode).toBe(302)
    expect(postRes.cookieHeader).toMatch(/^dsh_collab_session=/)

    // A bogus state never completes: the callback refuses and clears the cookie.
    const failRes = fakeResponse()
    void callback.handler({ method: 'GET', url: '/api/collab/auth/callback?code=abc&state=bogus', headers: {} }, failRes)
    await flush()
    expect(failRes.statusCode).toBe(302)
    expect(failRes.locationHeader).toBe('/?collab=signin-failed')
    expect(failRes.cookieHeader).toMatch(/^dsh_collab_session=;/)
    await booted.dispose()
  })

  it('answers the login route only for GET', async () => {
    const { web } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'POST', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, res)
    expect(res.statusCode).toBe(405)
  })
})

describe('additional dispatch wire paths', () => {
  it('folds a hostile non-Error service throw into collab-bad-request', async () => {
    const boot = await bootServices()
    const hostile = new Proxy({}, { get: () => { throw 'boom' } })
    const result = await dispatchCollabEndpoint(boot.ctx, boot.admin as never, 'collab/workspace.create', hostile)
    if (result.ok) throw new Error('expected collab-bad-request refusal')
    expect(result.error.message).toBe('collab: boom')
  })

  it('rejects non-string optional and global roles', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const badInviteRole = await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: 'a@b.c',
      role: 5,
    })
    expectCollabError(badInviteRole, 'collab-bad-request')
    const badGlobalRole = await call(boot, boot.admin, 'collab/users.setGlobalRole', {
      userId: boot.member.userId,
      role: 'owner',
    })
    expectCollabError(badGlobalRole, 'collab-bad-request')
  })

  it('enriches member views and falls back for unknown accounts', async () => {
    const boot = await bootServices()
    const ghost = { userId: 'ghost-1', email: 'ghost@example.com', globalRole: 'member' as const }
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: ghost.email,
    })) as { id: string }
    value(await call(boot, ghost, 'collab/workspace.join', { invitationId: invitation.id }))
    const members = value(await call(boot, boot.admin, 'collab/workspace.members', { workspaceId: created.id })) as Array<{ email: string; name: string }>
    expect(members).toContainEqual(expect.objectContaining({ userId: 'ghost-1', email: '', name: '', role: 'developer' }))
  })

  it('cars usedAt on consumed invitations and lastSeenAt on touched accounts', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))
    const invites = value(await call(boot, boot.admin, 'collab/workspace.invitations', { workspaceId: created.id })) as Array<{ usedAt?: string }>
    expect(invites[0]!.usedAt).toBeTypeOf('string')
    await boot.ctx.collabUsers.touch(UserId(boot.admin.userId))
    await boot.ctx.collabUsers.touch(UserId(boot.admin.userId))
    const listed = value(await call(boot, boot.admin, 'collab/users.list', {})) as Array<{ id: string; lastSeenAt?: string }>
    expect(listed.find(entry => entry.id === boot.admin.userId)?.lastSeenAt).toBeTypeOf('string')
  })
})

describe('additional HTTP handler paths', () => {
  it('falls back to the root redirect and the fetch-header cookie read', async () => {
    const { connection, web, booted } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const bare = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, bare)
    await flush()
    expect(bare.locationHeader).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=/)
    const token = booted.ctx.collabAuth.createSessionToken(UserId(booted.admin.userId))
    const principal = connection.authenticator!({ headers: new Headers({ cookie: `dsh_collab_session=${token}` }) })
    expect(principal).toMatchObject({ userId: booted.admin.userId })
    const plain = connection.authenticator!({ headers: { cookie: `dsh_collab_session=${token}` } })
    expect(plain).toMatchObject({ userId: booted.admin.userId })
    const missing = connection.authenticator!({ headers: new Headers({}) })
    expect(missing).toBeUndefined()
  })

  it('answers an empty callback and refuses an oversized POST body', async () => {
    const { web } = await bootPlugin()
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const empty = fakeResponse()
    void callback.handler({ method: 'GET', headers: {} }, empty)
    await flush()
    expect(empty.statusCode).toBe(302)
    expect(empty.locationHeader).toBe('/?collab=signin-failed')

    const big = fakeResponse()
    const bigReq = new EventEmitter() as EventEmitter &
      { method: string; url?: string; headers: Record<string, string>; destroy: () => void }
    bigReq.method = 'POST'
    bigReq.url = '/api/collab/auth/callback'
    bigReq.headers = {}
    bigReq.destroy = () => undefined
    void callback.handler(bigReq, big)
    queueMicrotask(() => {
      bigReq.emit('data', 'x'.repeat(128 * 1024))
      bigReq.emit('end')
    })
    await flush()
    await flush()
    expect(big.statusCode).toBe(302)
  })

  it('coalesces duplicate form fields in the POST callback', async () => {
    const { web, booted } = await bootPlugin()
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, loginRes)
    await flush()
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!
    const res = fakeResponse()
    const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> }
    req.method = 'POST'
    req.url = '/api/collab/auth/callback'
    req.headers = {}
    void callback.handler(req, res)
    queueMicrotask(() => {
      req.emit('data', `code=abc&state=${state}&code=second`)
      req.emit('end')
    })
    await flush()
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.cookieHeader).toMatch(/^dsh_collab_session=/)
    await booted.dispose()
  })

  it('handles a request without a URL on the login route', async () => {
    const { web } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'GET', headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=/)
  })

  it('directs a failed provider entry to the sign-in failure page', async () => {
    const loginFails: OidcGateway = {
      issuer: 'https://accounts.google.test',
      authorizationUrl: async () => { throw new Error('login down') },
      userFromCallback: async () => { throw new Error('unused') },
    }
    const { web } = await bootPlugin({ gateway: loginFails })
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toBe('/?collab=signin-failed')
  })

  it('logs a bare non-Error from a failed provider entry', async () => {
    const loginFailsBare: OidcGateway = {
      issuer: 'https://accounts.google.test',
      authorizationUrl: async () => { throw 'login down' },
      userFromCallback: async () => { throw new Error('unused') },
    }
    const { web } = await bootPlugin({ gateway: loginFailsBare })
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toBe('/?collab=signin-failed')
  })

  it('refuses a callback whose token exchange rejects with a bare value', async () => {
    const callbackFails: OidcGateway = {
      issuer: 'https://accounts.google.test',
      authorizationUrl: async (state, nonce) => `https://accounts.google.test/auth?state=${state}&nonce=${nonce}`,
      userFromCallback: async () => { throw 'network down' },
    }
    const { web } = await bootPlugin({ gateway: callbackFails })
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, loginRes)
    await flush()
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const res = fakeResponse()
    void callback.handler({ method: 'GET', url: `/api/collab/auth/callback?code=abc&state=${state}`, headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toBe('/?collab=signin-failed')
    expect(res.cookieHeader).toMatch(/^dsh_collab_session=;/)
  })
})
