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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Upper bound for one repository clone; exceeded clones abort and the workspace is removed. */
export const COLLAB_CLONE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * A git command runner: like the generic no-shell command runner plus an
 * optional env override that carries credential plumbing (a temporary
 * `GIT_CONFIG_GLOBAL` pointing at a host-scoped `Authorization` header), so
 * the token never enters argv or the clone's own config.
 */
export type GitCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>

/**
 * The production `git clone` runner. Unlike the generic no-shell runner it
 * never feeds the child stdin and disables the terminal credential prompt, so
 * a URL the user cannot access fails fast with git's stderr instead of leaving
 * the clone job pending while git waits for credential input.
 * @param command - the executable to spawn (`git`).
 * @param args - argv, including the subcommand.
 * @param signal - abort signal cancelling the process.
 * @param extraEnv - additional environment merged over the process env.
 * @returns the captured stdout and stderr once the child closes or errors.
 */
export const gitCloneRunner: GitCommandRunner = (command, args, signal, extraEnv) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
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
 * A server-side git credential for cloning private repositories: a basic-auth
 * username/token pair pinned to one host. Set through the collab API operator
 * config; never exposed to the browser, persisted, or echoed in diagnostics.
 */
export interface GitCloneCredentials {
  /** The host this credential authorizes (e.g. `github.com`); other hosts clone unauthenticated. */
  readonly host: string
  /** Basic-auth username; GitHub accepts any value alongside a personal access token. */
  readonly username: string
  /** The token (personal access token / app password) sent as the password. */
  readonly token: string
}

/**
 * The host a repository URL clones from, for matching against a pinned
 * credential; '' for non-HTTPS or unparsable URLs.
 * @param repoUrl - the repository URL.
 * @returns the lowercase HTTPS hostname, or '' when not an HTTPS repository URL.
 */
export function repoHostOf(repoUrl: string): string {
  try {
    const url = new URL(repoUrl.trim())
    return url.protocol === 'https:' ? url.hostname : ''
  } catch {
    return ''
  }
}

/**
 * A temporary git global config scoping an `Authorization` header to one host,
 * handed to the clone through `GIT_CONFIG_GLOBAL` so the token never appears in
 * argv, the clone's own config, or any stored value. The temp directory is
 * created private to the server user and must be removed by the caller's
 * cleanup.
 * @param credentials - the pinned credential to materialize.
 * @returns the env to spread and the cleanup of the temp directory.
 */
export async function gitAuthEnv(credentials: GitCloneCredentials): Promise<{
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-collab-git-'))
  const configFile = join(dir, 'config')
  const basic = Buffer.from(`${credentials.username}:${credentials.token}`, 'utf8').toString('base64')
  await writeFile(configFile, `[http "https://${credentials.host}/"]\n\textraheader = AUTHORIZATION: basic ${basic}\n`)
  return {
    env: { GIT_CONFIG_GLOBAL: configFile },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/**
 * Clone a git repository into an empty target directory. The dispatch chooses
 * the target, so a clone lands in `<clone root>/<repo>-<workspaceId>`. When a
 * pinned credential matches the repository's host, the clone sends it through
 * a temporary host-scoped git config for that invocation only; otherwise it
 * clones unauthenticated.
 * @param repoUrl - the repository URL to clone.
 * @param target - absolute target directory the repository is cloned into.
 * @param runner - the git command runner executing `git clone`; defaults to
 *   {@link gitCloneRunner} and is injectable for tests.
 * @param credentials - optional server credential for private repositories.
 * @param signal - optional caller cancellation, merged with the clone timeout:
 *   the background clone job aborts it when the collab gateway tears down, so
 *   an in-flight clone never blocks shutdown.
 * @param depth - optional shallow-clone depth; clones with `--depth` when `>= 1`,
 *   otherwise full history.
 * @returns settlement once the clone completes.
 */
export async function cloneRepository(
  repoUrl: string,
  target: string,
  runner: GitCommandRunner = gitCloneRunner,
  credentials?: GitCloneCredentials,
  signal?: AbortSignal,
  depth?: number,
): Promise<void> {
  const auth = credentials !== undefined && repoHostOf(repoUrl) === credentials.host
    ? await gitAuthEnv(credentials)
    : undefined
  const active = signal === undefined
    ? AbortSignal.timeout(COLLAB_CLONE_TIMEOUT_MS)
    : AbortSignal.any([signal, AbortSignal.timeout(COLLAB_CLONE_TIMEOUT_MS)])
  try {
    // An operator-set clone depth makes the bootstrap a shallow clone (a
    // faster first materialization); a later fetch deepens it as needed.
    const args: string[] = depth !== undefined && depth >= 1
      ? ['clone', '--depth', String(depth), repoUrl, target]
      : ['clone', repoUrl, target]
    await runner('git', args, active, auth?.env)
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  } finally {
    if (auth !== undefined) await auth.cleanup()
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
