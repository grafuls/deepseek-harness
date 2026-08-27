/**
 * REAL-composition product test for the collab API: boots the real Web server,
 * the real connection host, the three collab services, and the collab API from
 * a test-only cordis.yml through the Loader, then drives the browser OIDC
 * flow and the collab RPC surface over real HTTP, asserting user-visible and
 * durable per-workspace output. The only mocked external is Google OIDC.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { CollabAuth, type OidcGateway } from '@deepseek-ai/dsh-collab-auth'
import { CollabUsers } from '@deepseek-ai/dsh-collab-users'
import { CollabWorkspaces } from '@deepseek-ai/dsh-collab-workspaces'
import { apply as connectionApply } from '@deepseek-ai/dsh-client-connection'
import { apply as collabApiApply } from '../src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'

interface Observed {
  root: string
  base: string
  gateway: OidcGateway
}

interface RuntimeGlobals {
  __collabWebServerClass: typeof WebServer
  __collabConnectionApply: typeof connectionApply
  __collabUsersClass: typeof CollabUsers
  __collabWorkspacesClass: typeof CollabWorkspaces
  __collabAuthClass: typeof CollabAuth
  __collabApiApply: typeof collabApiApply
  __collabFakeGateway: OidcGateway
  __collabWebContext: Context
}

const globals = globalThis as unknown as RuntimeGlobals & { __collabRealObserved?: Observed }

globals.__collabWebServerClass = WebServer
globals.__collabConnectionApply = connectionApply
globals.__collabUsersClass = CollabUsers
globals.__collabWorkspacesClass = CollabWorkspaces
globals.__collabAuthClass = CollabAuth
globals.__collabApiApply = collabApiApply
globals.__collabFakeGateway = {
  issuer: 'https://accounts.google.test',
  async authorizationUrl(state: string, nonce: string): Promise<string> {
    return `https://accounts.google.test/auth?state=${state}&nonce=${nonce}`
  },
  async userFromCallback(params: Record<string, string>): Promise<{ sub: string; email: string; emailVerified: boolean; name: string }> {
    return params.code === 'oauth-owen'
      ? { sub: 'google-owen', email: 'owen@example.com', emailVerified: true, name: 'Owen' }
      : { sub: 'google-lina', email: 'lina@example.com', emailVerified: true, name: 'Lina' }
  },
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  if (globals.__collabRealObserved) {
    rmSync(globals.__collabRealObserved.root, { recursive: true, force: true })
    delete globals.__collabRealObserved
  }
})

/** Boot the real collab Web composition from a test-only cordis.yml. */
async function boot(): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-collab-real-'))
  const rows: string[] = []
  const fixture = (name: string, body: string): string => {
    const file = join(root, name)
    writeFileSync(file, body)
    return pathToFileURL(file).href
  }
  const webserver = fixture('webserver.mjs', `
export const name = 'webserver'
export function apply(ctx, config) {
  globalThis.__collabWebContext = ctx
  return ctx.plugin(globalThis.__collabWebServerClass, config)
}
`)
  const connection = fixture('connection.mjs', `
export const name = 'client-connection'
export const inject = ['webServer']
export function apply(ctx, config) { return globalThis.__collabConnectionApply(ctx, config) }
`)
  const users = fixture('users.mjs', `
export const name = 'collab-users'
export function apply(ctx, config) { return ctx.plugin(globalThis.__collabUsersClass, config) }
`)
  const workspaces = fixture('workspaces.mjs', `
export const name = 'collab-workspaces'
export function apply(ctx, config) { return ctx.plugin(globalThis.__collabWorkspacesClass, config) }
`)
  const auth = fixture('auth.mjs', `
export const name = 'collab-auth'
export function apply(ctx, config) {
  return ctx.plugin(globalThis.__collabAuthClass, { ...config, gateway: globalThis.__collabFakeGateway })
}
`)
  const api = fixture('api.mjs', `
export const name = 'collab-api'
export const inject = ['webServer', 'connection', 'collabAuth', 'collabUsers', 'collabWorkspaces']
export function apply(ctx) { return globalThis.__collabApiApply(ctx) }
`)
  rows.push('- id: webserver', `  name: ${webserver}`, '  config:', '    host: 127.0.0.1', '    port: 0')
  rows.push('- id: client-connection', `  name: ${connection}`)
  rows.push('- id: collab-users', `  name: ${users}`, '  config:', `    root: ${join(root, 'users')}`)
  rows.push('- id: collab-workspaces', `  name: ${workspaces}`, '  config:', `    root: ${join(root, 'workspaces')}`)
  rows.push('- id: collab-auth', `  name: ${auth}`, '  config:', '    clientId: test-client', '    clientSecret: test-secret', '    secret: test-signing-secret')
  rows.push('- id: collab-api', `  name: ${api}`)
  const cordisFile = join(root, 'cordis.yml')
  writeFileSync(cordisFile, rows.join('\n'))

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(cordisFile).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  const webCtx = globals.__collabWebContext
  const webServer = webCtx.get('webServer')
  if (webServer === undefined) throw new Error('webServer missing')
  const base = `http://127.0.0.1:${(webServer as { port: number }).port}`
  await waitForReady(base)
  const observed: Observed = {
    root,
    base,
    gateway: globals.__collabFakeGateway,
  }
  globals.__collabRealObserved = observed
  return observed
}

/** One JSON-RPC collab call over the real `/api` bridge. */
async function call(
  base: string,
  cookie: string | undefined,
  endpoint: string,
  payload: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message?: string } }> {
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ type: 'client-request', rpcId: '1', method: endpoint, payload }),
  })
  if (res.status !== 200) {
    return { ok: false, error: { code: `http-${res.status}`, message: await res.text() } }
  }
  const envelope = (await res.json()) as { result: { ok: boolean; value?: unknown; error?: { code: string; message?: string } } }
  return envelope.result
}

/**
 * Wait for the collab surface to report an unauthenticated session probe.
 * Loader activation of injected dependents settles a tick after
 * `loader.await()` resolves, so real clients gate readiness on the surface.
 */
async function waitForReady(base: string): Promise<void> {
  const deadline = Date.now() + 5000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/collab/auth/session`)
      if (res.status === 200 && (await res.json() as { authenticated?: boolean }).authenticated === false) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`collab web surface did not become ready: ${String(lastError)}`)
}

/** Drive the real browser OIDC flow and return the session cookie. */
async function signIn(base: string, code: string): Promise<string> {
  const entry = await fetch(`${base}/api/collab/auth/login?redirectTo=%2Fapp`, { redirect: 'manual' })
  expect(entry.status).toBe(302)
  const state = new URL(entry.headers.get('location')!).searchParams.get('state')!
  const callback = await fetch(`${base}/api/collab/auth/callback?code=${code}&state=${state}`, { redirect: 'manual' })
  expect(callback.status).toBe(302)
  expect(callback.headers.get('location')).toBe('/app')
  const setCookie = callback.headers.get('set-cookie')!
  expect(setCookie).toMatch(/^dsh_collab_session=/)
  return setCookie.split(';')[0]!
}

describe('real collab web composition', () => {
  it('gates the API without a session and signs users in through Google', async () => {
    const { base } = await boot()
    const probe = await fetch(`${base}/api/collab/auth/session`)
    expect(await probe.json()).toEqual({ authenticated: false })
    const gated = await call(base, undefined, 'collab/workspace.create', { name: 'Alpha' })
    expect(gated.ok).toBe(false)
    expect(gated.error?.code).toBe('http-401')
    const cookie = await signIn(base, 'oauth-owen')
    const probe2 = await fetch(`${base}/api/collab/auth/session`, { headers: { cookie } })
    expect(await probe2.json()).toMatchObject({ authenticated: true, principal: { email: 'owen@example.com' } })
  })

  it('persists durable per-workspace output scoped to each user', async () => {
    const { base, root } = await boot()
    const owen = await signIn(base, 'oauth-owen')
    const created = await call(base, owen, 'collab/workspace.create', { name: 'Alpha' })
    expect(created.ok).toBe(true)
    expect(created.value).toMatchObject({ name: 'Alpha', isOwner: true, role: 'admin', memberCount: 1 })
    const wsId = (created.value as { id: string }).id

    // The user registry and workspace registry are durable documents.
    expect(existsSync(join(root, 'users', 'users.json'))).toBe(true)
    expect(existsSync(join(root, 'workspaces', 'workspaces.json'))).toBe(true)
    // The per-workspace data directory is materialized and scoped.
    const dir = await call(base, owen, 'collab/workspace.dir', { workspaceId: wsId })
    expect(dir.ok).toBe(true)
    expect(dir.value).toMatchObject({ dir: join(root, 'workspaces', 'workspaces', wsId) })
    expect(existsSync(join(root, 'workspaces', 'workspaces', wsId))).toBe(true)

    // The admin surface answers the instance admin over real HTTP.
    const users = await call(base, owen, 'collab/users.list', {})
    expect(users.ok).toBe(true)
    expect(users.value).toEqual([
      /* oxlint-disable-next-line typescript/no-unsafe-assignment -- expect() matchers are `any` by design. */
      { id: expect.any(String), email: 'owen@example.com', name: 'Owen', globalRole: 'admin', disabled: false },
    ])

    // A second user signs in to an empty, isolated world.
    const lina = await signIn(base, 'oauth-lina')
    const linaList = await call(base, lina, 'collab/workspace.list', {})
    expect(linaList.ok).toBe(true)
    expect(linaList.value).toEqual([])

    // The owner invites the second user, who then joins and sees the workspace.
    const invitation = await call(base, owen, 'collab/workspace.invite', { workspaceId: wsId, email: 'lina@example.com' })
    expect(invitation.ok).toBe(true)
    const invitations = await call(base, owen, 'collab/workspace.invitations', { workspaceId: wsId })
    const inviteId = (invitations.value as Array<{ id: string }>)[0]!.id
    const joined = await call(base, lina, 'collab/workspace.join', { invitationId: inviteId })
    expect(joined.ok).toBe(true)
    expect(joined.value).toMatchObject({ id: wsId, role: 'developer', memberCount: 2 })
    const afterJoin = await call(base, lina, 'collab/workspace.list', {})
    expect(afterJoin.value).toHaveLength(1)
  })

  it('signs out by clearing the session cookie', async () => {
    const { base } = await boot()
    const cookie = await signIn(base, 'oauth-owen')
    const logout = await fetch(`${base}/api/collab/auth/logout`, { method: 'POST', redirect: 'manual' })
    expect(logout.status).toBe(204)
    expect(logout.headers.get('set-cookie')).toMatch(/^dsh_collab_session=;/)
    const probe = await fetch(`${base}/api/collab/auth/session`)
    expect(await probe.json()).toEqual({ authenticated: false })
    void cookie
  })
})
