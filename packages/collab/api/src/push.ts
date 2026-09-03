/**
 * Server-side branch push for repo-backed collab workspaces: moves the
 * workspace's session branch (or an explicit one) to the clone's origin
 * through the server git credential, refusing non-fast-forward updates and
 * returning the new remote SHA plus compare/PR links. The push never rewrites
 * history, never sends the credential anywhere but the origin's host, and
 * never embeds credentials in a URL. A member-approved push is the only entry
 * point; the RPC that calls here enforces the confirmation gate.
 */

import { gitAuthEnv, gitCloneRunner, repoHostOf, type GitCloneCredentials, type GitCommandRunner } from './clone.ts'
import { GIT_STATE_TIMEOUT_MS } from './repo-state.ts'

/** Upper bound for one branch push (a large session branch may upload a lot). */
export const COLLAB_PUSH_TIMEOUT_MS = 10 * 60 * 1000

/** The outcome of a push request: what moved and the links to act on it. */
export interface CollabPushResult {
  /** Whether the push reached the remote (`false` for dry-run or up-to-date). */
  readonly pushed: boolean
  /** Whether the remote branch already pointed at the local tip. */
  readonly upToDate: boolean
  /** The pushed branch name. */
  readonly branch: string
  /** The mainline (default) branch compare links root at; '' when unknown. */
  readonly base: string
  /** The pushed commit on the local side. */
  readonly localSha: string
  /** The remote tip after the push (or the pre-push remote tip on dry-run). */
  readonly remoteSha: string | undefined
  /** Local commits not on the remote branch, when the remote tip is known. */
  readonly ahead: number | undefined
  /** Remote commits not on the local branch, when the remote tip is known. */
  readonly behind: number | undefined
  /** The origin URL the branch was pushed to (credentials never appear in it). */
  readonly remote: string
  /** Compare (base...branch) URL for an HTTPS origin with a known base. */
  readonly compareUrl?: string
  /** Pull-request-open URL for an HTTPS origin with a known base. */
  readonly prUrl?: string
}

/** The collab user identity asserted into the clone before a real push. */
export interface CollabPushIdentity {
  /** The member's display name (written as `user.name` when present). */
  readonly name?: string
  /** The member's email (written as `user.email` when present). */
  readonly email?: string
}

/**
 * The push was refused because the remote branch moved: the server never
 * force-pushes, so a diverged branch needs a fetch/merge before it can go up.
 */
export class CollabPushRejectedError extends Error {
  constructor(public readonly remoteSha: string) {
    super(`collab: push of the branch is not a fast-forward; the remote moved to '${remoteSha}'`)
    this.name = 'CollabPushRejectedError'
  }
}

/** The push cannot authenticate to the origin's host: no matching server credential. */
export class CollabCredentialUnavailableError extends Error {
  constructor(public readonly host: string) {
    super(`collab: no server git credential is pinned to host '${host}'`)
    this.name = 'CollabCredentialUnavailableError'
  }
}

/**
 * The compare and pull-request-open links for an HTTPS origin, or an empty
 * set for a local/SSH origin or an unknown default branch.
 * @param origin - the clone's origin URL.
 * @param base - the mainline branch the comparison roots at ('' skips links).
 * @param branch - the branch being pushed.
 * @returns the two links, each present only when both are derivable.
 */
export function pushLinks(origin: string, base: string, branch: string): { compareUrl?: string; prUrl?: string } {
  if (base === '') return {}
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:') return {}
    const path = url.pathname.replace(/\.git$/, '')
    return {
      compareUrl: `${url.origin}${path}/compare/${base}...${branch}`,
      prUrl: `${url.origin}${path}/pull/new/${branch}`,
    }
  } catch {
    return {}
  }
}

/**
 * Resolve the pushable state of one branch in a clone's origin: the mainline
 * branch, both tips, and how far they diverge. A branch that exists upstream
 * is fetched first (remote-tracking ref only; the working tree is untouched)
 * so its commit object is present locally for the counts and the FF gate; a
 * network/auth failure on that fetch rejects the resolution.
 * @param clonePath - the settled clone's directory.
 * @param branch - the branch name to resolve.
 * @param runner - the no-shell git runner (defaults to the clone runner).
 * @param env - optional credential env (the branch fetch needs it for private repos).
 * @returns the branch's { remote, base, localSha, remoteSha, ahead, behind }.
 */
export async function resolvePushState(
  clonePath: string,
  branch: string,
  runner: GitCommandRunner = gitCloneRunner,
  env?: NodeJS.ProcessEnv,
): Promise<Pick<CollabPushResult, 'remote' | 'base' | 'localSha' | 'remoteSha' | 'ahead' | 'behind'>> {
  const signal = AbortSignal.timeout(GIT_STATE_TIMEOUT_MS)
  const [originOut, localOut, remoteOut, headOut] = await Promise.all([
    runner('git', ['-C', clonePath, 'remote', 'get-url', 'origin'], signal),
    runner('git', ['-C', clonePath, 'rev-parse', `refs/heads/${branch}`], signal),
    runner('git', ['-C', clonePath, 'ls-remote', 'origin', `refs/heads/${branch}`], signal),
    runner('git', ['-C', clonePath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], signal).then(
      result => ({ stdout: result.stdout }),
      () => ({ stdout: '' }),
    ),
  ])
  const remote = originOut.stdout.trim()
  const localSha = localOut.stdout.trim()
  // `--short` renders refs/remotes/origin/HEAD as `<remote>/<branch>`; the
  // compare links want the bare mainline branch name.
  const base = headOut.stdout.trim().split('/').slice(1).join('/')
  const liveSha = remoteOut.stdout.trim() === '' ? undefined : remoteOut.stdout.trim().split(/\s+/)[0]
  if (liveSha === undefined) {
    return { remote, base, localSha, remoteSha: undefined, ahead: undefined, behind: undefined }
  }
  await runner('git', ['-C', clonePath, 'fetch', 'origin', branch], AbortSignal.timeout(COLLAB_PUSH_TIMEOUT_MS), env)
  const tracked = (await runner('git', ['-C', clonePath, 'rev-parse', `refs/remotes/origin/${branch}`], signal)).stdout.trim()
  // An empty trace means the branch vanished between the ls-remote and the
  // fetch; treat it like a never-pushed branch instead of a ghost tip.
  if (tracked === '') {
    return { remote, base, localSha, remoteSha: undefined, ahead: undefined, behind: undefined }
  }
  const [aheadOut, behindOut] = await Promise.all([
    runner('git', ['-C', clonePath, 'rev-list', '--count', `${tracked}..${localSha}`], signal),
    runner('git', ['-C', clonePath, 'rev-list', '--count', `${localSha}..${tracked}`], signal),
  ])
  return {
    remote,
    base,
    localSha,
    remoteSha: tracked,
    ahead: Number.parseInt(aheadOut.stdout.trim(), 10),
    behind: Number.parseInt(behindOut.stdout.trim(), 10),
  }
}

/**
 * Push one branch to the clone's origin. Refuses a non-fast-forward update
 * before touching the remote (the fetched remote tip must be an ancestor of
 * the local tip), asserts the collab user's identity into the clone for
 * subsequent commits, and sends the server credential only when it is pinned
 * to the origin's host.
 * @param clonePath - the settled clone's directory.
 * @param branch - the branch to push.
 * @param options - dry-run, credential, attribution, runner, and cancellation.
 * @returns the push outcome; `pushed` is false for a dry-run or an
 *   already-up-to-date branch.
 * @throws {@link CollabPushRejectedError} on a diverged remote branch and
 *   {@link CollabCredentialUnavailableError} when an HTTPS origin has no
 *   matching server credential. Other git failures reject with their stderr.
 */
/**
 * The credential to send to a clone's origin: an empty no-op auth for a
 * non-HTTPS (local-path) origin, the host-scoped authorization env when the
 * pinned credential matches the origin's host, and an explicit refusal when
 * an HTTPS origin has no matching credential.
 * @param origin - the clone's origin URL.
 * @param credentials - the optional pinned server credential.
 * @returns the auth env (and its temp-config cleanup) to hand to git.
 */
async function resolveCredentialEnv(
  origin: string,
  credentials: GitCloneCredentials | undefined,
): Promise<{ env: NodeJS.ProcessEnv | undefined; cleanup: () => Promise<void> }> {
  const originHost = repoHostOf(origin)
  return originHost === ''
    ? { env: undefined as NodeJS.ProcessEnv | undefined, cleanup: () => Promise.resolve() }
    : credentials === undefined || credentials.host !== originHost
      ? throwCredentialUnavailable(originHost)
      : gitAuthEnv(credentials)
}

/**
 * Fetch the origin's current state into a settled clone without touching the
 * working tree or any branch (member- and operator-safe: a fetch moves only
 * remote-tracking refs, so open session edits are never disturbed). Uses the
 * same host-pinned credential rule and temporary host-scoped git config as a
 * push.
 * @param clonePath - the settled clone directory.
 * @param options - runner override (unit tests), credential, and cancellation.
 * @returns whether the fetch completed.
 */
export async function fetchWorkspaceSync(
  clonePath: string,
  options: {
    readonly credentials?: GitCloneCredentials
    readonly runner?: GitCommandRunner
    readonly signal?: AbortSignal
  } = {},
): Promise<{ fetched: boolean }> {
  const runner = options.runner ?? gitCloneRunner
  const origin = (await runner(
    'git',
    ['-C', clonePath, 'remote', 'get-url', 'origin'],
    AbortSignal.timeout(GIT_STATE_TIMEOUT_MS),
  )).stdout.trim()
  const auth = await resolveCredentialEnv(origin, options.credentials)
  const enforce = options.signal === undefined
    ? AbortSignal.timeout(COLLAB_PUSH_TIMEOUT_MS)
    : AbortSignal.any([options.signal, AbortSignal.timeout(COLLAB_PUSH_TIMEOUT_MS)])
  try {
    await runner('git', ['-C', clonePath, 'fetch', 'origin', '--prune'], enforce, auth.env)
    return { fetched: true }
  } finally {
    await auth.cleanup()
  }
}

/**
 * Push one branch of a settled clone to its origin through the server git
 * credential, never force-forcing: a live remote tip that is not an ancestor
 * of the local tip rejects before anything moves, and the push itself carries
 * no force flag. `dryRun` fetches and computes exactly what would move and
 * stops, so a preview never touches the remote.
 * @param clonePath - the settled clone directory.
 * @param branch - the branch to push.
 * @param options - dry run, credential, push identity, runner, cancellation.
 * @returns the pushed (or previewed) outcome with links.
 */
export async function pushWorkspaceBranch(
  clonePath: string,
  branch: string,
  options: {
    readonly dryRun?: boolean
    readonly credentials?: GitCloneCredentials
    readonly identity?: CollabPushIdentity
    readonly runner?: GitCommandRunner
    readonly signal?: AbortSignal
  } = {},
): Promise<CollabPushResult> {
  const runner = options.runner ?? gitCloneRunner
  const origin = (await runner(
    'git',
    ['-C', clonePath, 'remote', 'get-url', 'origin'],
    AbortSignal.timeout(GIT_STATE_TIMEOUT_MS),
  )).stdout.trim()
  const auth = await resolveCredentialEnv(origin, options.credentials)
  const enforce = options.signal === undefined
    ? AbortSignal.timeout(COLLAB_PUSH_TIMEOUT_MS)
    : AbortSignal.any([options.signal, AbortSignal.timeout(COLLAB_PUSH_TIMEOUT_MS)])
  try {
    const state = await resolvePushState(clonePath, branch, runner, auth.env)
    const links = pushLinks(state.remote, state.base, branch)
    const upToDate = state.remoteSha !== undefined && state.remoteSha === state.localSha
    if (upToDate) {
      return {
        pushed: false,
        upToDate: true,
        branch,
        base: state.base,
        localSha: state.localSha,
        remoteSha: state.remoteSha,
        ahead: state.ahead,
        behind: state.behind,
        remote: state.remote,
        ...links,
      }
    }
    // A branch that already exists upstream must fast-forward: the fetched
    // remote tip has to be an ancestor of the local tip, else history was
    // rewritten. The merge-base is authoritative now that the object is local.
    if (state.remoteSha !== undefined) {
      const isAncestor = await runner(
        'git',
        ['-C', clonePath, 'merge-base', '--is-ancestor', state.remoteSha, state.localSha],
        AbortSignal.timeout(GIT_STATE_TIMEOUT_MS),
      ).then(() => true, () => false)
      if (!isAncestor) throw new CollabPushRejectedError(state.remoteSha)
    }
    if (options.dryRun === true) {
      return {
        pushed: false,
        upToDate: false,
        branch,
        base: state.base,
        localSha: state.localSha,
        remoteSha: state.remoteSha,
        ahead: state.ahead,
        behind: state.behind,
        remote: state.remote,
        ...links,
      }
    }
    // Assert the collab user's identity so commits born in the shared tree
    // from here on carry that member's attribution.
    if (options.identity?.name !== undefined && options.identity.name !== '') {
      await runner('git', ['-C', clonePath, 'config', 'user.name', options.identity.name], enforce)
    }
    if (options.identity?.email !== undefined && options.identity.email !== '') {
      await runner('git', ['-C', clonePath, 'config', 'user.email', options.identity.email], enforce)
    }
    // No force flag: a remote that moved between the fetch and the push
    // rejects with git's own non-fast-forward error, which the caller maps.
    await runner('git', ['-C', clonePath, 'push', 'origin', `${branch}:refs/heads/${branch}`], enforce, auth.env)
    return {
      pushed: true,
      upToDate: false,
      branch,
      base: state.base,
      localSha: state.localSha,
      remoteSha: state.localSha,
      ahead: state.ahead,
      behind: state.behind,
      remote: state.remote,
      ...links,
    }
  } finally {
    await auth.cleanup()
  }
}

/** Narrower path: signal the missing credential through a typed error. */
function throwCredentialUnavailable(host: string): never {
  throw new CollabCredentialUnavailableError(host)
}
