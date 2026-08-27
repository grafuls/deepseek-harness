/** Host auth-gate: optional authenticator on the shared `/api` and event-stream upgrades. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, apply, inject, MUX_EVENTS_PATH } from '../src/index.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import {
  connectionFacts,
  connectionFactsFromMessage,
  runWithConnectionPrincipal,
} from '../src/principal.ts'

function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade(route) { upgrades.push(route); return () => { upgrades.splice(upgrades.indexOf(route), 1) } },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Minimal ApiProxy whose event sources idle until their signal aborts. */
function apiProxy(): ApiProxy {
  const idle = (signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> => ({
    async * [Symbol.asyncIterator]() {
      if (signal.aborted) return
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    },
  })
  return { events: { mux: (_request, signal) => idle(signal), host: (_request, signal) => idle(signal) } } as ApiProxy
}

function clientRequest(): Request {
  return new Request(`http://dsh.internal${API_PATH}/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'session.list', payload: {} }),
  })
}

async function mounted(): Promise<{
  ctx: Context
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  ctx.provide('apiProxy', apiProxy())
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, routes, upgrades, dispose: () => fiber.dispose() }
}

describe('connection auth gate', () => {
  it('is off by default: with no authenticator every request flows unchanged', async () => {
    const ctx = new Context()
    const service = new HostConnectionService(ctx, [])
    expect(service.requiresAuthentication).toBe(false)
    expect(await service.authenticate({ method: 'POST', pathname: '/api/x', headers: {} })).toBeUndefined()
    const fallback = vi.fn(async () => new Response('reached'))
    const handler = service.createSharedFetchHandler('/api', { fetch: fallback })
    const response = await handler.fetch(clientRequest())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('reached')
    expect(fallback).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('refuses every shared /api request with 401 once an authenticator is registered', async () => {
    const ctx = new Context()
    const service = new HostConnectionService(ctx, [])
    service.registerAuthenticator(ctx, async () => undefined)
    expect(service.requiresAuthentication).toBe(true)
    const fallback = vi.fn(async () => new Response('reached'))
    const handler = service.createSharedFetchHandler('/api', { fetch: fallback })
    const response = await handler.fetch(clientRequest())
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('unauthorized')
    expect(fallback).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('treats null as unauthenticated', async () => {
    const ctx = new Context()
    const service = new HostConnectionService(ctx, [])
    service.registerAuthenticator(ctx, () => null)
    const handler = service.createSharedFetchHandler('/api', {
      fetch: async () => new Response('reached'),
    })
    expect((await handler.fetch(clientRequest())).status).toBe(401)
    await ctx.fiber.dispose()
  })

  it('propagates the authenticator principal to downstream handlers', async () => {
    const ctx = new Context()
    const service = new HostConnectionService(ctx, [])
    service.registerAuthenticator(ctx, async (facts) => {
      expect(facts.method).toBe('POST')
      expect(facts.pathname).toBe(`${API_PATH}/session.list`)
      expect((facts.headers as Headers).get('content-type')).toContain('application/json')
      return { userId: 'u1' }
    })
    const captured: unknown[] = []
    const handler = service.createSharedFetchHandler('/api', {
      fetch: async () => {
        captured.push(service.principal())
        return new Response('reached')
      },
    })
    const response = await handler.fetch(clientRequest())
    expect(response.status).toBe(200)
    expect(captured).toEqual([{ userId: 'u1' }])
    await ctx.fiber.dispose()
  })

  it('throws on a duplicate authenticator and disposal re-opens the gate', async () => {
    const ctx = new Context()
    const service = new HostConnectionService(ctx, [])
    const dispose = service.registerAuthenticator(ctx, () => ({ userId: 'u1' }))
    expect(() => service.registerAuthenticator(ctx, () => ({ userId: 'u2' }))).toThrow(/already registered/)
    await dispose()
    expect(service.requiresAuthentication).toBe(false)
    const handler = service.createSharedFetchHandler('/api', {
      fetch: async () => new Response('reached'),
    })
    expect((await handler.fetch(clientRequest())).status).toBe(200)
    await ctx.fiber.dispose()
  })

  it('rejects an unauthenticated event-stream upgrade over a real server', async () => {
    const { ctx, upgrades, dispose } = await mounted()
    ctx.connection.registerAuthenticator(ctx, () => undefined)
    const route = upgrades.find(candidate => candidate.path === MUX_EVENTS_PATH)!
    const server = createServer()
    server.on('upgrade', (request, socket, head) => { void route.handler(request, socket, head) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const status = await new Promise<number>((resolve) => {
        const client = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
        client.once('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0) })
      })
      expect(status).toBe(403)
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
      await dispose()
    }
  })

  it('accepts an authenticated event-stream upgrade over a real server', async () => {
    const { ctx, upgrades, dispose } = await mounted()
    ctx.connection.registerAuthenticator(ctx, () => ({ userId: 'u1' }))
    const route = upgrades.find(candidate => candidate.path === MUX_EVENTS_PATH)!
    const server = createServer()
    server.on('upgrade', (request, socket, head) => { void route.handler(request, socket, head) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const client = new WebSocket(`ws://127.0.0.1:${String(port)}${MUX_EVENTS_PATH}`)
      await once(client, 'open')
      client.close()
      await once(client, 'close')
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
      await dispose()
    }
  })

  it('builds upgrade facts and scopes request bodies to the principal', async () => {
    const ctx = new Context()
    const service = new HostConnectionService(ctx, [])
    const request = clientRequest()
    const facts = connectionFacts(request)
    expect(facts.method).toBe('POST')
    expect(facts.pathname).toBe(`${API_PATH}/session.list`)

    const upgradeFacts = connectionFactsFromMessage({
      url: MUX_EVENTS_PATH,
      method: 'GET',
      headers: { cookie: 'a=b' },
    } as never)
    expect(upgradeFacts.pathname).toBe(MUX_EVENTS_PATH)
    expect(upgradeFacts.method).toBe('GET')
    // An absolute upgrade URL is reduced to its pathname; a missing method or URL reads as GET '/'.
    expect(connectionFactsFromMessage({ url: `http://dsh.internal${MUX_EVENTS_PATH}`, headers: {} } as never).pathname)
      .toBe(MUX_EVENTS_PATH)
    expect(connectionFactsFromMessage({ url: '/x' } as never).method).toBe('GET')
    expect(connectionFactsFromMessage({ headers: {} } as never).pathname).toBe('/')

    // Scoped bodies see the principal and return their result.
    const seen = runWithConnectionPrincipal({ userId: 'u3' }, () => service.principal())
    expect(seen).toEqual({ userId: 'u3' })
    expect(service.principal()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('replies to a genuine HTTP upgrade path via the PassThrough rejection path', async () => {
    const { ctx, upgrades, dispose } = await mounted()
    ctx.connection.registerAuthenticator(ctx, () => undefined)
    const route = upgrades.find(candidate => candidate.path === MUX_EVENTS_PATH)!
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    const ended = once(socket, 'end')
    const req = Object.assign(socket, {
      url: MUX_EVENTS_PATH,
      method: 'GET',
      headers: { host: '127.0.0.1:3080' },
    })
    void route.handler(req as never, socket, Buffer.alloc(0))
    await ended
    expect(chunks.join('')).toContain('403')
    await dispose()
  })
})
