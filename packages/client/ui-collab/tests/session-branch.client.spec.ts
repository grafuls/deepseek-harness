// @vitest-environment node
/**
 * Client mirror of the collab host's per-session work branch derivation
 * (`sessionBranchName` in `@deepseek-ai/dsh-collab-api/src/sessions.ts`).
 * The browser names a session's line on the hover card and routes the push /
 * sync verbs onto it, so the sanitization must agree with the branch the host
 * actually forks; any drift fails this spec (and the host's own) instead of
 * silently pushing onto a differently-named line. The examples mirror the
 * server spec's four cases exactly.
 */
import { describe, expect, it } from 'vitest'
import { sessionBranchName } from '../src/client/session-branch.ts'

describe('sessionBranchName', () => {
  it('joins the sanitized workspace name and session id', () => {
    expect(sessionBranchName('Product Team', 'sess-1')).toBe('Product-Team-sess-1')
    expect(sessionBranchName('A/B:repo', 'a1b2')).toBe('A-B-repo-a1b2')
  })

  it('falls back to a fixed word for empty or punctuation-only components', () => {
    expect(sessionBranchName('  ..-- ', '')).toBe('workspace-session')
    expect(sessionBranchName('Alpha', '---')).toBe('Alpha-session')
  })
})
