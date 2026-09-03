/**
 * The collab push audit trail: appends one JSONL line per push under the
 * collab data root, preparing the audit directory once per root, and folds a
 * write failure into a throw the caller warns about — the push it describes
 * must never fail over its log. The directory-ensure slot is cleared on a
 * failed attempt so a later append retries.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendPushAudit, prepareAuditDir, COLLAB_PUSH_AUDIT_FILE } from '../src/audit.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true })
    root = undefined
  }
})

/** A deterministic push audit entry for the trail probes. */
function entry(id = 'w1'): Record<string, unknown> {
  return {
    ts: '2026-09-01T00:00:00.000Z',
    workspaceId: id,
    actorId: 'u1',
    actorName: 'Owen',
    branch: 'main',
    dryRun: false,
    pushed: true,
    upToDate: false,
    remoteSha: 'a1b2c3',
    compareUrl: 'https://github.com/acme/repo/compare/main...main',
  }
}

describe('appendPushAudit', () => {
  it('appends one JSONL line under the data root, creating the audit directory', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    await expect(appendPushAudit(root, entry() as never)).resolves.toBeUndefined()
    const trail = join(root, 'audit', COLLAB_PUSH_AUDIT_FILE)
    expect((await stat(trail)).isFile()).toBe(true)
    const entries = readFileSync(trail, 'utf8').trim().split('\n')
    expect(entries).toHaveLength(1)
    expect(JSON.parse(entries[0]!)).toEqual(entry())
    expect(readFileSync(join(root, 'audit', COLLAB_PUSH_AUDIT_FILE), 'utf8').endsWith('\n')).toBe(true)
  })

  it('reuses the ensured audit directory for a second append on the same root', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    await appendPushAudit(root, entry() as never)
    await appendPushAudit(root, { ...entry(), branch: 'topic' } as never)
    const entries = readFileSync(join(root, 'audit', COLLAB_PUSH_AUDIT_FILE), 'utf8').trim().split('\n')
    expect(entries).toHaveLength(2)
    expect(JSON.parse(entries[1]!)).toEqual({ ...entry(), branch: 'topic' })
  })

  it('warns out a root whose audit directory cannot be created, then retries', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    // A file named `audit` blocks the directory from being created.
    const blocker = join(root, 'audit')
    writeFileSync(blocker, '')
    await expect(appendPushAudit(root, entry() as never)).rejects.toThrow()
    // The failed attempt cleared its slot, so removing the blocker lets a
    // later append prepare the directory and write its trail.
    rmSync(blocker)
    await expect(appendPushAudit(root, entry() as never)).resolves.toBeUndefined()
    const trail = join(root, 'audit', COLLAB_PUSH_AUDIT_FILE)
    expect(readFileSync(trail, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('folds a failed append into a throw while another root still works', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const other = mkdtempSync(join(tmpdir(), 'dsh-audit-other-'))
    try {
      // Prime one root's directory; the append itself then succeeds.
      await appendPushAudit(root, entry() as never)
      // A path under a non-directory parent cannot host the audit directory.
      const fileRoot = join(other, 'file.txt')
      writeFileSync(fileRoot, '')
      await expect(appendPushAudit(fileRoot, entry() as never)).rejects.toThrow()
      // The earlier root is unaffected by the other root's failure.
      const entries = readFileSync(join(root, 'audit', COLLAB_PUSH_AUDIT_FILE), 'utf8').trim().split('\n')
      expect(entries).toHaveLength(1)
    } finally { rmSync(other, { recursive: true, force: true }) }
  })
})

describe('prepareAuditDir', () => {
  it('returns the cached promise for an already-prepared root', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const first = prepareAuditDir(root)
    await first
    // A second prepare on the same root resolves without creating anything new.
    await expect(prepareAuditDir(root)).resolves.toBe(join(root, 'audit'))
  })

  it('clears its slot when the mkdir fails so a later attempt retries', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const blocker = join(root, 'audit')
    writeFileSync(blocker, '')
    await expect(prepareAuditDir(root)).rejects.toThrow()
    rmSync(blocker)
    await expect(prepareAuditDir(root)).resolves.toBe(join(root, 'audit'))
  })
})
