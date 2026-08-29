/**
 * Repository cloning for collab workspace bootstrap: one no-shell `git clone`
 * into an empty target, bounded by a timeout, with a best-effort cleanup of a
 * partial target when the clone fails or times out. The command runner is
 * injectable so unit tests fake git instead of touching the network, and the
 * production runner is hardened so a clone that needs credentials fails
 * immediately instead of blocking on an interactive terminal prompt.
 * @module @deepseek-ai/dsh-collab-api/src/clone (internal)
 */

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'

/** Upper bound for one repository clone; exceeded clones fail as `collab-clone-failed`. */
export const COLLAB_CLONE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The production `git clone` runner. Unlike the generic no-shell runner it
 * never feeds the child stdin and disables the terminal credential prompt, so
 * a URL the user cannot access fails fast with git's stderr instead of leaving
 * the create request pending while git waits for credential input. Captured
 * stderr is what `cloneFailureMessage` prefers.
 */
export const gitCloneRunner: NativeCommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    // A spawn failure surfaces as both `error` and a trailing `close`; settle
    // exactly once so the promise takes the first terminal event.
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      finish()
    }
    child.on('error', (error) => {
      settle(() => {
        const failure = Object.assign(new Error(error.message, { cause: error }), {
          code: (error as NodeJS.ErrnoException).code,
          stdout,
          stderr,
        })
        reject(failure)
      })
    })
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }
        const failure = Object.assign(new Error(`git clone exited with code ${code ?? 'a signal'}`), {
          code,
          stdout,
          stderr,
        })
        reject(failure)
      })
    })
  })

/**
 * Clone a git repository into an empty target directory. The dispatch chooses
 * the target, so a clone lands in `<clone root>/<repo>-<workspaceId>`.
 * @param repoUrl - the repository URL to clone.
 * @param target - absolute target directory the repository is cloned into.
 * @param runner - the no-shell command runner executing `git clone`; defaults to
 *   {@link gitCloneRunner} and is injectable for tests.
 * @returns settlement once the clone completes.
 */
export async function cloneRepository(
  repoUrl: string,
  target: string,
  runner: NativeCommandRunner = gitCloneRunner,
): Promise<void> {
  try {
    await runner('git', ['clone', repoUrl, target], AbortSignal.timeout(COLLAB_CLONE_TIMEOUT_MS))
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

/**
 * The repository-name component for a clone directory, derived from its URL:
 * the last path segment (after the last `/` or `:` separator) with a trailing
 * `.git` and any query or fragment stripped, then collapsed to
 * `[A-Za-z0-9._-]` and trimmed of leading/trailing `-` and `.`. Empty when
 * the URL carries no recognizable repository name.
 * @param repoUrl - the repository URL to name.
 * @returns the sanitized repository name, or '' when none can be derived.
 */
export function repoDirName(repoUrl: string): string {
  const plain = (repoUrl.trim().replace(/[?#].*/, '').replace(/\/+$/, ''))
  const cut = Math.max(plain.lastIndexOf('/'), plain.lastIndexOf(':'))
  const segment = plain.slice(cut + 1)
  const stem = segment.replace(/\.git$/i, '')
  return stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
}

/** Upper bound for the repository-name prefix so the clone directory name stays within filesystem name limits. */
export const CLONE_REPO_PREFIX_MAX = 80

/**
 * The directory name for a repository-backed workspace's clone target: the
 * sanitized repository name prefixed onto the workspace id (`<repo>-<id>`),
 * so an administrator can recognize which repository a clone roots at; the
 * bare workspace id when the URL yields no usable name. Always a single,
 * filesystem-safe path component.
 * @param workspaceId - the generated workspace id.
 * @param repoUrl - the repository URL the workspace was created from.
 * @returns the clone target directory name.
 */
export function cloneDirectoryName(workspaceId: string, repoUrl: string): string {
  const prefix = repoDirName(repoUrl).slice(0, CLONE_REPO_PREFIX_MAX)
  return prefix === '' ? workspaceId : `${prefix}-${workspaceId}`
}

/**
 * Fold a git failure into one caller-safe diagnostic line, preferring the
 * process's stderr over the exec error message.
 * @param repoUrl - the repository the clone attempted.
 * @param error - the rejected command outcome.
 * @returns a single-line failure description for the wire error message.
 */
export function cloneFailureMessage(repoUrl: string, error: unknown): string {
  const detail = (error as { stderr?: unknown; message?: unknown } | null)?.stderr
    ?? (error as { message?: unknown } | null)?.message
  const text = typeof detail === 'string' && detail.trim() !== '' ? detail.trim() : 'git clone failed'
  return `failed to clone '${repoUrl}': ${text}`
}
