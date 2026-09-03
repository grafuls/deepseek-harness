/**
 * The per-session work-branch name, browser half. A session created inside a
 * settled repository-backed collab workspace runs on its own line named
 * `<workspace>-<session>`; the host derives that name in
 * `@deepseek-ai/dsh-collab-api/src/sessions.ts` when it forks the branch. The
 * browser mirrors the derivation so the session hover card can name the line
 * and the session push/sync verbs can route onto it without a per-session
 * round trip. Both packages pin the same examples in their specs, so a
 * divergence in the sanitization fails a build instead of silently renaming
 * sessions' lines.
 */

/** Sanitize one branch component to `[A-Za-z0-9._-]`, falling back to a fixed word. */
function branchComponent(raw: string, fallback: 'workspace' | 'session'): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned === '' ? fallback : cleaned
}

/**
 * The branch a session inside a repo-backed collab workspace runs on: the
 * sanitized workspace name and the session id joined with `-`, matching the
 * host's fork derivation so re-creating or re-attaching a session rejoins the
 * same line.
 * @param workspaceName - the collab workspace display name.
 * @param sessionId - the session's opaque id.
 * @returns a git-check-refname-safe branch name.
 */
export function sessionBranchName(workspaceName: string, sessionId: string): string {
  return `${branchComponent(workspaceName, 'workspace')}-${branchComponent(sessionId, 'session')}`
}
