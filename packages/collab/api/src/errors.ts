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
    'collab-clone-pending': {} // no details; the message names the workspace whose clone is unfinished
    'collab-approval-required': {} // no details; the push refused a missing member confirmation
    'collab-not-a-repository': {} // no details; the workspace has no settled clone to push
    'collab-push-rejected': {} // no details; the message names the branch and the moved remote commit
    'collab-credential-unavailable': {} // no details; the message names the host no credential covers
    'collab-push-failed': {} // no details; the message carries the git diagnostic
  }
}

/** Collab-specific error codes added to the shared envelope. */
export type CollabErrorCode =
  | 'collab-forbidden'
  | 'collab-not-found'
  | 'collab-bad-request'
  | 'collab-internal'
  | 'collab-name-conflict'
  | 'collab-clone-pending'
  | 'collab-approval-required'
  | 'collab-not-a-repository'
  | 'collab-push-rejected'
  | 'collab-credential-unavailable'
  | 'collab-push-failed'

/**
 * Build the failure branch of an RpcResult for one collab code.
 * @param code - the collab error category.
 * @param message - caller-facing diagnostic without sensitive values.
 * @returns the error branch typed against the merged details map.
 */
export function collabError(code: CollabErrorCode, message: string): RpcError {
  return { code, message, details: {} }
}
