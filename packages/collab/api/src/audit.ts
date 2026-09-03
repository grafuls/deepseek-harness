/**
 * The collab push audit trail: one append-only JSONL line per push (or dry
 * run) a member triggers, written under the collab data root's `audit`
 * directory. The trail is an operator record of who moved which line where;
 * a write failure is folded by the caller (the push itself never fails over
 * its log). The entry carries no secrets — the token travels as an
 * authorization header and never enters this file.
 * @module @deepseek-ai/dsh-collab-api/src/audit (internal)
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** The audit file name under the collab data root. */
export const COLLAB_PUSH_AUDIT_FILE = 'push.jsonl'

/** One append-only push audit record, written as one JSON line. */
export interface CollabPushAuditEntry {
  /** ISO 8601 timestamp of the push. */
  ts: string
  /** The workspace whose clone was pushed. */
  workspaceId: string
  /** The pushing member's user id. */
  actorId: string
  /** The pushing member's display name ('' when unknown). */
  actorName: string
  /** The branch that was pushed or previewed. */
  branch: string
  /** Whether this was a dry run (nothing moved). */
  dryRun: boolean
  /** Whether the branch actually moved on the remote. */
  pushed: boolean
  /** Whether the remote already pointed at the local tip. */
  upToDate: boolean
  /** The remote tip after the push; absent when the branch never existed upstream. */
  remoteSha?: string
  /** Compare link for the pushed branch, for HTTPS origins with a known mainline. */
  compareUrl?: string
}

/** The audit directory write already ensured per collab data root (cached within one process). */
const auditDirReady = new Map<string, Promise<unknown>>()

/**
 * Append one push audit line under a collab data root, creating the `audit`
 * directory on first use. A failure to write is thrown for the caller to fold
 * (warn) — it must never fail the push that produced the record. The
 * directory is ensured once per root; a failed ensure clears its slot so a
 * later append can retry.
 * @param root - the collab data root.
 * @param entry - the push audit record to persist.
 */
export async function appendPushAudit(root: string, entry: CollabPushAuditEntry): Promise<void> {
  await prepareAuditDir(root)
  await appendFile(join(root, 'audit', COLLAB_PUSH_AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Ensure the audit directory exists under a collab data root exactly once per
 * process and root, so the append path stays cheap on every push.
 * @param root - the collab data root.
 * @returns a promise settling when the directory is (or was) ensured.
 */
export function prepareAuditDir(root: string): Promise<unknown> {
  const ready = auditDirReady.get(root)
  if (ready !== undefined) return ready
  const attempt = mkdir(join(root, 'audit'), { recursive: true })
    .catch((error: unknown) => {
      auditDirReady.delete(root)
      throw error
    })
  auditDirReady.set(root, attempt)
  return attempt
}
