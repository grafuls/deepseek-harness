/**
 * Optional request-principal model for Connection's HTTP and WebSocket gates.
 * The principal is opaque to this package: a registered authenticator picks
 * its meaning, and downstream services read it back unchanged. With no
 * authenticator registered the gate stays off (the single-user default) and
 * every request flows as today.
 * @module @deepseek-ai/dsh-client-connection/src/principal (internal)
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'

/** Facts any connection authenticator may read to bless one request. */
export interface ConnectionAuthenticatorFacts {
  /** HTTP method of the request. */
  method: string
  /** URL pathname of the request. */
  pathname: string
  /** Raw request headers (Node `IncomingMessage` or Fetch `Headers`). */
  headers: IncomingHttpHeaders | Headers
}

/**
 * A connection authenticator: decide the opaque principal for one request, or
 * undefined when the request must be refused. Any non-null return becomes the
 * principal visible to downstream services for that request.
 */
export type ConnectionAuthenticator = (facts: ConnectionAuthenticatorFacts) => unknown

/**
 * Build the authenticator facts from a Fetch request.
 * @param request - Fetch request flowing through the shared connection gate.
 * @returns facts usable by the registered authenticator.
 */
export function connectionFacts(request: Request): ConnectionAuthenticatorFacts {
  const url = new URL(request.url)
  return { method: request.method, pathname: url.pathname, headers: request.headers }
}

/**
 * Build the authenticator facts from a Node HTTP upgrade request.
 * @param req - upgrade request whose headers and URL describe the socket.
 * @returns facts usable by the registered authenticator.
 */
export function connectionFactsFromMessage(req: IncomingMessage): ConnectionAuthenticatorFacts {
  return { method: req.method ?? 'GET', pathname: pathnameFrom(req.url ?? '/'), headers: req.headers }
}

/**
 * Current request principal. Returns the value the registered authenticator
 * returned for the request being served, or undefined outside any request.
 * @returns the opaque principal, or undefined.
 */
export function readConnectionPrincipal(): unknown {
  return principalStore.getStore()
}

/**
 * Run a request body with a connection principal attached.
 * @param principal - opaque principal for the request.
 * @param body - work to run under the principal; its result is returned.
 * @returns the body's result, so scopes can await or pipe it.
 */
export function runWithConnectionPrincipal<T>(principal: unknown, body: () => T): T {
  return principalStore.run(principal, body)
}

function pathnameFrom(url: string): string {
  return new URL(url, 'http://localhost').pathname
}

const principalStore = new AsyncLocalStorage<unknown>()
