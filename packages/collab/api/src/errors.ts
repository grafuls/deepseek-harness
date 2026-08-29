/**
 * Collab RPC error codes on the shared API error envelope.
 * @module @deepseek-ai/dsh-collab-api
 */

import type { RpcError } from '@deepseek-ai/dsh-host-apiproxy/api'

declare module '@deepseek-ai/dsh-host-apiproxy/api' {
  interface RpcErrorDetailsMap {
    'collab-forbidden': {} // no details; the message names the denied action
    'collab-not-found': {} // no details; the message names the missing referent
    'collab-bad-request': {} // no details; the message names the invalid field
    'collab-internal': {} // no details; the message names the missing host service
    'collab-name-conflict': {} // no details; the message names the colliding title
    'collab-clone-failed': {} // no details; the message names the repository and the git failure
  }
}

/** Collab-specific error codes added to the shared envelope. */
export type CollabErrorCode =
  | 'collab-forbidden'
  | 'collab-not-found'
  | 'collab-bad-request'
  | 'collab-internal'
  | 'collab-name-conflict'
  | 'collab-clone-failed'

/**
 * Build the failure branch of an RpcResult for one collab code.
 * @param code - the collab error category.
 * @param message - caller-facing diagnostic without sensitive values.
 * @returns the error branch typed against the merged details map.
 */
export function collabError(code: CollabErrorCode, message: string): RpcError {
  return { code, message, details: {} }
}
