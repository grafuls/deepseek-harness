/**
 * Collab API assembly: the opt-in multi-user overlay. Mounts the collab auth
 * fence onto the connection gate, exposes the `collab/*` RPC surface under the
 * shared `/api` channel, and owns the OIDC callback, logout, and session-probe
 * HTTP routes.
 * @module @deepseek-ai/dsh-collab-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CollabPrincipal } from '@deepseek-ai/dsh-collab-auth'
import { sessionTokenFromCookieHeader } from '@deepseek-ai/dsh-collab-auth'
import type { ConnectionAuthenticatorFacts } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { collabError } from './errors.ts'
import { createCollabWorkspaceAccess } from './access-gate.ts'
import { dispatchCollabEndpoint } from './dispatch.ts'
import { cloneAuthFromConfig, installCollabSettings } from './settings.ts'
import { forkCollabSessionBranch } from './sessions.ts'
import type { CollabPrincipalView } from './types.ts'

export const name = 'dsh-collab-api'

/**
 * Services this plugin requires: the Web server (callback/logout/session
 * routes), the connection host (auth fence + `/api` interceptor), and the
 * three collab services. Mounting is loud — a composition with collab API
 * without its services fails at load.
 */
export const inject = ['webServer', 'connection', 'collabAuth', 'collabUsers', 'collabWorkspaces']

/** Plugin config: the default clone directory and the optional server git credential for private clones. */
export interface Config {
  /** Default directory for cloning repositories that back new workspaces; empty uses the collab data root. */
  cloneDir?: string
  /** Host the git credential authorizes; defaults to `github.com`. */
  gitHost?: string
  /** Basic-auth username paired with the token; defaults to `x-access-token` (accepted by GitHub PATs). */
  gitUsername?: string
  /** Operator git token (PAT / app password) for cloning private repositories; never shown in the GUI. */
  gitToken?: string
}

/** Namespace schema: all optional, an empty clone directory is the schema default. */
export const Config = z.object({
  cloneDir: z.string().default(''),
  gitHost: z.string().default(''),
  gitUsername: z.string().default(''),
  gitToken: z.string().default(''),
})

/** Sign-in entry (GET): redirects to the OIDC provider, served as an exact route. */
export const COLLAB_AUTH_LOGIN_PATH = '/api/collab/auth/login'
/** Fixed logout endpoint (POST) served as an exact route. */
export const COLLAB_AUTH_LOGOUT_PATH = '/api/collab/auth/logout'
/** Fixed session-probe endpoint (GET) served as an exact route. */
export const COLLAB_AUTH_SESSION_PATH = '/api/collab/auth/session'

/** Plugin body: wire the auth fence, the collab RPC surface, and the HTTP routes. */
export function apply(ctx: Context, config: Config = {}): void {
  // Register the clone-directory settings namespace while a provider is mounted.
  installCollabSettings(ctx, config)
  // The server git credential for cloning private repositories. Operator
  // config only: deliberately routed via this service, never through the
  // collab settings namespace the GUI reads back.
  ctx.effect(() => ctx.provide('collabGitCloneAuth', cloneAuthFromConfig(config)))
  // Membership gate over the Host plane: collab-rooted workspaces and their
  // sessions are served only to their members. The Host reads it structurally
  // when present, so a single-user composition that omits this overlay never
  // stages the decision.
  ctx.effect(() => ctx.provide('collabWorkspaceAccess', createCollabWorkspaceAccess(ctx)))
  // Per-session work branches: a session that opens inside a settled
  // repository-backed workspace switches the shared clone onto a branch named
  // after that session, so its commits (and later pushes) stay on their own
  // line. Fire-and-forget with a warn log: a fork must never hold up or fail
  // session creation.
  ctx.effect(() => ctx.on('session/created', (session: Session) => {
    void forkCollabSessionBranch(ctx.collabWorkspaces, session).then((branch) => {
      if (branch !== undefined) {
        ctx.logger.debug(`collab: session '${session.id}' forked on branch '${branch}'`)
      }
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`collab: failed to fork a session branch for '${session.id}': ${reason}`)
    })
  }, { global: true }))
  // Auth fence: every `/api` request requires a signed session cookie. The
  // gate contract lives in client-connection; here we only provide identity.
  ctx.effect(() => {
    const disposer = ctx.connection.registerAuthenticator(ctx, (facts) => {
      const token = sessionTokenFromCookieHeader(headerCookie(facts.headers))
      if (token === undefined) return undefined
      return ctx.collabAuth.resolve(token)
    })
    return disposer
  })

  // Collab RPC surface: `collab/*` endpoints on the shared `/api` channel.
  ctx.effect(() => {
    const disposer = ctx.connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'collab' || endpoint.startsWith('collab/'),
      async (endpoint, payload) => {
        const principal = ctx.connection.principal()
        if (principal === undefined) {
          return { ok: false, error: collabError('collab-forbidden', 'collab: unauthenticated') }
        }
        return dispatchCollabEndpoint(ctx, principal as CollabPrincipal, endpoint, payload)
      },
      { authority: 'trusted-host' },
    )
    return disposer
  })

  // Exact HTTP routes for the browser flows (OIDC redirect, logout, probe).
  // Exact routes match before the `/api` prefix route, so these bypass the
  // JSON-RPC envelope; the login entry and session probe are deliberately
  // unauthenticated so the sign-in page can start and inspect a session.
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: COLLAB_AUTH_LOGIN_PATH,
        handler: (req, res) => void handleAuthLogin(ctx, req, res),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: callbackPathname(ctx.collabAuth.redirectUri),
        handler: (req, res) => void handleCollabCallback(ctx, req, res),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: COLLAB_AUTH_LOGOUT_PATH,
        handler: (req, res) => { handleCollabLogout(ctx, req, res) },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: COLLAB_AUTH_SESSION_PATH,
        handler: (req, res) => { handleCollabSession(ctx, req, res) },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

/** Redirect the browser to the OIDC provider (GET only). */
async function handleAuthLogin(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405)
    res.end()
    return
  }
  const redirectTo = new URL(req.url ?? '/', 'http://x').searchParams.get('redirectTo') ?? '/'
  try {
    const url = await ctx.collabAuth.loginUrl(redirectTo, requestOrigin(req))
    res.writeHead(302, { Location: url })
    res.end()
  } catch (error) {
    ctx.logger.debug(error instanceof Error ? error : new Error(String(error)))
    res.writeHead(302, { Location: '/?collab=signin-failed' })
    res.end()
  }
}

/**
 * The request's public origin (`scheme://authority`), or undefined when no
 * `Host` header is present. The scheme honors the first `x-forwarded-proto`
 * entry (from a TLS-terminating proxy — the harness webserver itself does not
 * terminate TLS), otherwise plain HTTP.
 * @param req - the incoming browser request.
 * @returns `${scheme}://${Host}`, or undefined without a Host authority.
 */
function requestOrigin(req: IncomingMessage): string | undefined {
  const authority = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
  if (authority === '') return undefined
  const proto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : ''
  const comma = proto.indexOf(',')
  const first = proto === '' ? '' : (comma === -1 ? proto : proto.slice(0, comma)).trim()
  const scheme = first === '' ? 'http' : first
  return `${scheme}://${authority}`
}

/** The pathname portion of the auth service's redirect URI. */
function callbackPathname(redirectUri: string): string {
  return new URL(redirectUri, 'http://x').pathname
}

/** Read the session cookie from either node or fetch headers. */
function headerCookie(headers: ConnectionAuthenticatorFacts['headers']): string | undefined {
  if (typeof (headers as { cookie?: string }).cookie === 'string') {
    return (headers as { cookie: string }).cookie
  }
  const get = (headers as { get?: (name: string) => string | null }).get
  // Call with `this` bound: a real WHATWG Headers brand-checks its getter.
  return get === undefined ? undefined : (get.call(headers, 'cookie') ?? undefined)
}

/** Finish a sign-in from the provider redirect and hand the browser its session. */
async function handleCollabCallback(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const params = await callbackParameters(req)
    const outcome = await ctx.collabAuth.completeLogin(params)
    res.setHeader('Set-Cookie', ctx.collabAuth.cookieValue(outcome.sessionToken))
    res.writeHead(302, { Location: outcome.location })
    res.end()
  } catch (error) {
    ctx.logger.debug(error instanceof Error ? error : new Error(String(error)))
    res.setHeader('Set-Cookie', ctx.collabAuth.clearCookieValue())
    res.writeHead(302, { Location: '/?collab=signin-failed' })
    res.end()
  }
}

/** Read the OIDC callback parameters from the query string or a urlencoded POST body. */
async function callbackParameters(req: IncomingMessage): Promise<Record<string, string>> {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.searchParams.size > 0) {
    return Object.fromEntries(url.searchParams.entries())
  }
  if (req.method !== 'POST') return {}
  return readUrlencodedBody(req)
}

function readUrlencodedBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer | string) => {
      body += chunk.toString()
      if (body.length > 64 * 1024) {
        reject(new Error('collab callback body exceeds 64 KiB'))
        req.destroy()
      }
    })
    req.on('end', () => {
      const params = new URLSearchParams(body)
      const out: Record<string, string> = {}
      for (const [key, value] of params) {
        if (out[key] === undefined) out[key] = value
      }
      resolve(out)
    })
    req.on('error', reject)
  })
}

/** Clear the session cookie (POST only), e.g. from the sign-out button. */
function handleCollabLogout(ctx: Context, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  res.setHeader('Set-Cookie', ctx.collabAuth.clearCookieValue())
  res.writeHead(204)
  res.end()
}

/** Wire body of the session probe: either `{ authenticated:false }` or the principal view. */
type SessionResponseBody = { authenticated: boolean } | { authenticated: true; principal: CollabPrincipalView }

/** Report the current sign-in state without requiring one (unauthenticated probe). */
function handleCollabSession(ctx: Context, req: IncomingMessage, res: ServerResponse): void {
  const token = sessionTokenFromCookieHeader(headerCookie(req.headers))
  const principal = token === undefined ? undefined : ctx.collabAuth.resolve(token)
  res.setHeader('Content-Type', 'application/json')
  let body: SessionResponseBody
  if (principal === undefined) {
    body = { authenticated: false }
  } else {
    body = {
      authenticated: true,
      principal: {
        userId: principal.userId,
        email: principal.email,
        name: principal.name,
        globalRole: principal.globalRole,
      },
    }
  }
  res.writeHead(200)
  res.end(JSON.stringify(body))
}
