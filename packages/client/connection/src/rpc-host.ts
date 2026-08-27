/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type ServerResponse as RpcServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import {
  connectionFacts,
  readConnectionPrincipal,
  runWithConnectionPrincipal,
  type ConnectionAuthenticator,
  type ConnectionAuthenticatorFacts,
} from './principal.ts'
import { API_PATH } from './api-path.ts'
import type {
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: FetchHandler
  readonly options: ConnectionRpcHandlerOptions
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle & ConnectionAuthenticatorHandle
  }
}

/** Auth surface the Host Connection service adds beside the RPC registry. */
export interface ConnectionAuthenticatorHandle {
  /**
   * Register the optional connection request authenticator. With one
   * registered, the connection gates every shared `/api` request and event
   * WebSocket upgrade on it; without one both stay open (the single-user
   * default).
   * @param owner - context owning the registration (its disposal removes it).
   * @param authenticator - request principal decision.
   * @returns asynchronous disposer removing the authenticator.
   * @throws when a different authentication is already registered.
   */
  registerAuthenticator(owner: Context, authenticator: ConnectionAuthenticator): () => Promise<void>
  /** Whether an authenticator is registered, and thus the connection gate is active. */
  readonly requiresAuthentication: boolean
  /** Principal of the connection request being served, or undefined. */
  principal(): unknown
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle, ConnectionAuthenticatorHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor[]>()
  private authenticator: ConnectionAuthenticator | undefined

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by trusted-host channels.
   */
  constructor(ctx: Context, private readonly trustedHosts: readonly string[]) {
    super(ctx, 'connection')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  /**
   * Register the connection request authenticator. With one registered, the
   * shared `/api` gate and the event-stream WebSocket upgrades refuse
   * unauthenticated requests; without one both stay open (the single-user
   * default).
   * @param owner - context owning the registration (its disposal removes it).
   * @param authenticator - request principal decision, or undefined to disable.
   * @returns asynchronous disposer removing the authenticator.
   * @throws when a different authentication is already registered.
   */
  registerAuthenticator(owner: Context, authenticator: ConnectionAuthenticator): () => Promise<void> {
    return owner.effect(() => {
      if (this.authenticator !== undefined) {
        throw new Error('connection: an authenticator is already registered')
      }
      this.authenticator = authenticator
      return () => {
        this.authenticator = undefined
      }
    }, 'client-connection: request authenticator')
  }

  /** Whether an authenticator is registered, and thus the request gate is active. */
  get requiresAuthentication(): boolean {
    return this.authenticator !== undefined
  }

  /**
   * Ask the registered authenticator for this request's principal, or
   * undefined when the request is refused or no authenticator exists.
   * @param facts - authenticator facts built from the connection request.
   * @returns the opaque principal, or undefined when unauthenticated.
   */
  async authenticate(facts: ConnectionAuthenticatorFacts): Promise<unknown> {
    if (this.authenticator === undefined) return undefined
    const principal = await this.authenticator(facts)
    return principal == null ? undefined : principal
  }

  /** Principal of the connection request being served, or undefined. */
  principal(): unknown {
    return readConnectionPrincipal()
  }

  /**
   * Compose one shared-channel Fetch handler from its interceptor and fallback.
   * @param channel - shared channel mounted by Connection.
   * @param fallback - handler for endpoints not claimed by the interceptor.
   * @returns Fetch handler that authenticates when configured, then selects
   * exactly one target for each request.
   */
  createSharedFetchHandler(
    channel: '/api',
    fallback: FetchHandler,
  ): FetchHandler {
    return {
      fetch: request => this.gatedFetch(channel, fallback, request),
    }
  }

  private async gatedFetch(
    channel: '/api',
    fallback: FetchHandler,
    request: Request,
  ): Promise<Response> {
    const principal = await this.authenticate(connectionFacts(request))
    if (principal === undefined && this.requiresAuthentication) {
      return new Response('unauthorized', { status: 401 })
    }
    return runWithConnectionPrincipal(principal, () => {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      const candidates = this.interceptors.get(channel)
      const interceptor = candidates?.find(candidate => endpoint !== undefined && candidate.matches(endpoint))
      if (interceptor === undefined) {
        return fallback.fetch(request)
      }
      if (interceptor.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {
        return Promise.resolve(new Response('forbidden', { status: 403 }))
      }
      return interceptor.fetchHandler.fetch(request)
    })
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    const trustedHosts = options.authority === 'loopback' ? [] : this.trustedHosts
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        await bridge(req, res, fetchHandler)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    // Chain, not single slot: the shared channel carries one interceptor per
    // owning surface (e.g. the Typert Gateway and the collab overlay), each
    // appended in registration order and consulted first-match-wins.
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
      options,
    }
    return owner.effect(() => {
      const chain = this.interceptors.get(channel) ?? []
      chain.push(interceptor)
      this.interceptors.set(channel, chain)
      // Disposers are idempotent, so a dispose after the chain was fully
      // deleted (or of an interceptor the chain no longer holds) cannot be
      // observed; these guards keep teardown strict for the owner invariant.
      /* v8 ignore start -- unreachable through effect disposal. */
      return () => {
        const live = this.interceptors.get(channel)
        if (live === undefined) return
        const index = live.lastIndexOf(interceptor)
        if (index >= 0) live.splice(index, 1)
        if (live.length === 0) this.interceptors.delete(channel)
      }
      /* v8 ignore stop */
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): FetchHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: RpcErrorDetailsMap['bad-request']['issues']): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: RpcError): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: RpcServerResponse['result']): Response {
  const body: RpcServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}
