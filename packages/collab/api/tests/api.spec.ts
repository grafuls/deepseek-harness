/**
 * Unit coverage for the collab API assembly: endpoint dispatch over real
 * collab services, the plugin wiring (auth fence + interceptor + routes), and
 * the browser HTTP handlers.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
// Clone-root writability is checked with `access(W_OK)` at create; the check
// is mocked to pass by default and reject on demand so unwritable-root
// behavior is deterministic under any CI user (incl. root, which bypasses
// permission bits).
const accessMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: accessMock,
    // A path containing `unremovable` rejects removal, so the delete endpoint's
    // folded clone cleanup is deterministic (permission bits are unreliable
    // under root). Every other removal delegates to the real implementation.
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (typeof path === 'string' && path.includes('unremovable')) {
        throw Object.assign(new Error('EACCES: simulated removal failure'), { code: 'EACCES' })
      }
      return actual.rm(path, options) as unknown
    },
  }
})

/** Create a scratch git repository with one committed file, returning its path. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-git-'))
  const git = (args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }) }
  git(['init', '-q'])
  git(['config', 'user.email', 'state-test@example.dev'])
  git(['config', 'user.name', 'state test'])
  writeFileSync(join(dir, 'file.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  return dir
}

/** Read the current branch of a checkout. */
function currentBranchOf(dir: string): string {
  return String(execFileSync('git', ['-C', dir, 'branch', '--show-current'], { stdio: 'pipe' })).trim()
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { UserId } from '@deepseek-ai/dsh-collab-users'
import { CollabAuth, type OidcGateway } from '@deepseek-ai/dsh-collab-auth'
import { CollabUsers } from '@deepseek-ai/dsh-collab-users'
import { CollabWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-collab-workspaces'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollabWorkspaceAccess } from '../src/access-gate.ts'
import { apply, COLLAB_AUTH_LOGIN_PATH, COLLAB_AUTH_LOGOUT_PATH, COLLAB_AUTH_SESSION_PATH } from '../src/index.ts'
import { dispatchCollabEndpoint, workspaceDataDir } from '../src/dispatch.ts'
import { collabError } from '../src/errors.ts'
import { gitCloneRunner, type GitCloneCredentials, type GitCommandRunner } from '../src/clone.ts'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { CollabMountedWorkspaceView, CollabWorkspaceView } from '../src/types.ts'

/** A deterministic OIDC gateway standing in for Google. */
function fakeGateway(overrides: Partial<OidcGateway> = {}): OidcGateway {
  return { ...defaultGateway(), ...overrides }
}

function defaultGateway(): OidcGateway {
  return {
    issuer: 'https://accounts.google.test',
    async authorizationUrl(state: string, nonce: string, redirectUri?: string): Promise<string> {
      const params = new URLSearchParams({ state, nonce })
      if (redirectUri !== undefined) params.set('redirect_uri', redirectUri)
      return `https://accounts.google.test/auth?${params}`
    },
    async userFromCallback(): Promise<{ sub: string; email: string; emailVerified: boolean; name: string }> {
      return { sub: 'google-1', email: 'owen@example.com', emailVerified: true, name: 'Owen' }
    },
  } satisfies OidcGateway
}

interface Booted {
  ctx: Context
  root: string
  admin: { userId: string; email: string; name: string; globalRole: 'admin' | 'member' }
  member: { userId: string; email: string; name: string; globalRole: 'admin' | 'member' }
  /** The injecting repo-clone harness: records each `git clone` and can fail the next one. */
  cloner: ClonerHarness
  dispose: () => Promise<void>
}

/** A controllable stand-in for the `git clone` runner the dispatch reads. */
interface ClonerHarness {
  runner: (
    command: string,
    args: readonly string[],
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string; stderr: string }>
  /** Recorded `git clone` shorthand calls as { repoUrl, target }. */
  calls: Array<{ repoUrl: string; target: string }>
  /** Recorded env each clone ran with, undefined when no credential plumbing was attached. */
  envs: Array<NodeJS.ProcessEnv | undefined>
  /** Recorded full argv of every `git clone` run, including any `--depth`. */
  rawArgs: string[][]
  /** Make the next clone fail with a git-style stderr. */
  fail: (message?: string) => void
  /** Hold the next clone open (a provisioning window) until {@link release}. */
  stall: () => void
  /** Release a held clone so its background job can settle. */
  release: () => void
}

const boots: Booted[] = []

afterEach(async () => {
  for (const boot of boots.splice(0)) {
    await boot.dispose()
    rmSync(boot.root, { recursive: true, force: true })
  }
})

/**
 * A fake `git clone` runner: records the target, succeeds by default, rejects
 * (or stalls) on demand, so creating a repo-backed workspace never touches
 * the network.
 */
function fakeCloner(): ClonerHarness {
  const calls: Array<{ repoUrl: string; target: string }> = []
  const envs: Array<NodeJS.ProcessEnv | undefined> = []
  let failing: string | undefined
  let stalled: Promise<void> | undefined
  let releaseStall: (() => void) | undefined
  const rawArgs: string[][] = []
  const runner = async (_command: string, args: readonly string[], signal: AbortSignal, env?: NodeJS.ProcessEnv) => {
    rawArgs.push([...args])
    // `git clone [--depth N] <repo> <target>`: stay correct when an operator
    // clone depth interposes an option/value pair before the operands.
    let repoUrl = ''
    let target = ''
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i]!
      if (arg === '--depth') { i += 1; continue }
      if (repoUrl === '') repoUrl = arg
      else { target = arg; break }
    }
    calls.push({ repoUrl, target })
    envs.push(env)
    const gate = stalled
    if (gate !== undefined) {
      // A held clone yields to the job's cancellation (the collab gateway
      // disposes mid-clone), so teardown never waits on a stalled runner.
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (signal.aborted) { resolve(); return }
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        }),
      ])
    }
    if (failing !== undefined) {
      throw Object.assign(new Error(`git: ${failing}`), { stderr: `fatal: ${failing}` })
    }
    return { stdout: '', stderr: '' }
  }
  return {
    runner,
    calls,
    rawArgs,
    envs,
    fail: (message = 'repository not found') => { failing = message },
    stall: () => { stalled = new Promise<void>((resolve) => { releaseStall = resolve }) },
    release: () => {
      releaseStall?.()
      stalled = undefined
      releaseStall = undefined
    },
  }
}

interface GatewayOverrides {
  /** The OIDC gateway to inject; defaults to the deterministic fake. */
  gateway?: OidcGateway
  /** Omit the pinned redirect URI so each login derives it from the request origin. */
  derivedRedirect?: boolean
  /** The repo-cloning runner to provide; defaults to the recording fake. */
  repoRunner?: GitCommandRunner
  /** Skip registering `collabRepoCloner` so the dispatch defaults to real git. */
  noRunner?: boolean
}

async function bootServices(overrides: GatewayOverrides = {}): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-collab-api-'))
  const ctx = new Context()
  await ctx.plugin(CollabUsers, { root: join(root, 'users') })
  await ctx.plugin(CollabWorkspaces, { root: join(root, 'workspaces') })
  await ctx.plugin(CollabAuth, {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    secret: 'test-secret-signing-key',
    gateway: overrides.gateway ?? fakeGateway(),
    ...(overrides.derivedRedirect === true
      ? {}
      : { redirectUri: 'http://localhost:3080/api/collab/auth/callback' }),
  })
  // The dispatch reads the repo-clone runner as the optional `collabRepoCloner`
  // service; install the fake so repo-backed creates never run real git, unless
  // the test opts into a real runner (push tests need real local git) or into
  // no runner at all (proving the real-git default).
  const cloner = fakeCloner()
  if (overrides.noRunner !== true) {
    ctx.provide('collabRepoCloner', overrides.repoRunner ?? cloner.runner)
  }
  const adminRec = await ctx.collabUsers.findOrCreateByGoogle({
    sub: 'google-1',
    email: 'owen@example.com',
    name: 'Owen',
  })
  const memberRec = await ctx.collabUsers.findOrCreateByGoogle({
    sub: 'google-2',
    email: 'lina@example.com',
    name: 'Lina',
  })
  const admin = {
    userId: adminRec.id,
    email: adminRec.email,
    name: adminRec.name,
    globalRole: 'admin' as const,
  }
  const member = {
    userId: memberRec.id,
    email: memberRec.email,
    name: memberRec.name,
    globalRole: 'member' as const,
  }
  const boot: Booted = {
    ctx,
    root,
    admin,
    member,
    cloner,
    dispose: () => ctx.fiber.dispose(),
  }
  boots.push(boot)
  return boot
}

async function call(
  boot: Booted,
  principal: { userId: string; email: string; globalRole: 'admin' | 'member' },
  endpoint: string,
  payload: unknown,
) {
  return dispatchCollabEndpoint(boot.ctx, principal as never, endpoint, payload)
}

function value(result: Awaited<ReturnType<typeof call>>): unknown {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

/** Assert a folded collab refusal with the exact error code. */
function expectCollabError(result: RpcResult<unknown>, code: string): void {
  if (result.ok) throw new Error(`expected collab ${code} refusal`)
  expect(result.error.code).toBe(code)
}

/** Let fire-and-forget route handlers (`void handle…`) settle. */
function flush(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve))
}

/**
 * Await a repo-backed workspace's background clone settling to `ready`, then
 * return its list row. The create endpoint returns a provisioning record
 * immediately; the fake cloner and the settle that follows resolve on later
 * microtasks, so the readiness probe polls the list until the row flips.
 * @param boot - the booted collab surface.
 * @param expectedTarget - the clone target the background job must have seen.
 * @returns the settled workspace row.
 */
async function settleCloneToReady(boot: Booted, expectedTarget: string): Promise<CollabWorkspaceView> {
  await vi.waitFor(() => {
    expect(boot.cloner.calls.some(entry => entry.target === expectedTarget)).toBe(true)
  })
  let row: CollabWorkspaceView | undefined
  await vi.waitFor(async () => {
    const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
    row = listed.find(entry => entry.cloneState === 'ready')
    expect(row?.cloneState).toBe('ready')
  })
  return row!
}

/** A fake Host workspace registry: one record created over a given dir plus optional titled lookalikes. */
function fakeWorkspaceRegistry(dir: string): {
  register: (ctx: Context) => void
  entity: {
    id: string
    path: string
    readonly title: string
    sessionIds: string[]
    setTitle: (title: string) => Promise<void>
  }
  createCalls: Array<{ path: string; title?: string; collabWorkspaceId?: string }>
  addConflict: (id: string, title: string) => void
} {
  let title = 'Team'
  const entity = {
    id: 'host-ws-1',
    path: dir,
    get title() { return title },
    sessionIds: [] as string[],
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    setTitle: async (next: string) => { title = next },
  }
  const others: Array<{ id: string; title: string }> = []
  const createCalls: Array<{ path: string; title?: string; collabWorkspaceId?: string }> = []
  const createdPaths = new Set<string>()
  const registry = {
    list: () => [{ id: entity.id, title }, ...others],
    create: async (path: string, wanted?: string, collabWorkspaceId?: string): Promise<typeof entity> => {
      createCalls.push({
        path,
        ...(wanted === undefined ? {} : { title: wanted }),
        ...(collabWorkspaceId === undefined ? {} : { collabWorkspaceId }),
      })
      // The real registry is idempotent by canonical path: the title is seated
      // only at first create, never re-applied on reuse.
      if (!createdPaths.has(path)) {
        createdPaths.add(path)
        if (wanted !== undefined) title = wanted
      }
      return entity
    },
    // The real registry resolves the workspace owning a canonical path without
    // materializing one; only a workspace opened in this lane has a path.
    resolveByPath: async (path: string): Promise<typeof entity | undefined> => {
      return createdPaths.has(path) ? entity : undefined
    },
  }
  return {
    register: (ctx) => { ctx.provide('workspaceRegistry', registry) },
    entity,
    createCalls,
    addConflict: (id, conflictTitle) => { others.push({ id, title: conflictTitle }) },
  }
}

describe('collab/auth methods', () => {
  it('reports the authenticated caller identity', async () => {
    const boot = await bootServices()
    const result = await call(boot, boot.admin, 'collab/auth.status', {})
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      value: { authenticated: true, principal: { userId: boot.admin.userId, email: boot.admin.email, globalRole: 'admin' } },
    })
  })
})

/** A bare remote plus a working clone of it (real local-transport origin). */
async function makeBareTrackedWork(): Promise<{ bare: string; work: string; remove: () => void }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-api-push-'))
  const bare = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')
  const git = (dir: string, args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }) }
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'pipe' })
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: 'pipe' })
  git(seed, ['config', 'user.email', 'seed@example.dev'])
  git(seed, ['config', 'user.name', 'seed'])
  writeFileSync(join(seed, 'file.txt'), 'one\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-q', '-m', 'seed'])
  git(seed, ['remote', 'add', 'origin', bare])
  git(seed, ['push', '-u', 'origin', 'main'])
  execFileSync('git', ['clone', bare, work], { stdio: 'pipe' })
  git(work, ['config', 'user.email', 'work@example.dev'])
  git(work, ['config', 'user.name', 'work'])
  return { bare, work, remove: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** A collab workspace whose record is settled onto a real clone dir. */
async function settleRealClone(boot: Booted, clonePath: string): Promise<string> {
  const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
    name: 'Repo-backed',
  })) as CollabWorkspaceView
  await boot.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath })
  return created.id
}

describe('collab/workspace methods', () => {
  it('creates a workspace as owner/admin and lists it', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: ' Visual  Lab ' }))
    expect(created).toMatchObject({ isOwner: true, role: 'admin', memberCount: 1, cloneState: 'none' })
    const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.name).toBe('Visual  Lab')
    expect(listed[0]!.cloneState).toBe('none')
    const nonMember = value(await call(boot, boot.member, 'collab/workspace.list', {}))
    expect(nonMember).toEqual([])
  })

  it('rejects empty or non-string workspace names', async () => {
    const boot = await bootServices()
    const empty = await call(boot, boot.admin, 'collab/workspace.create', { name: '   ' })
    expectCollabError(empty, 'collab-bad-request')
    const nonString = await call(boot, boot.admin, 'collab/workspace.create', { name: 42 })
    expectCollabError(nonString, 'collab-bad-request')
  })

  it('creates a provisioning workspace from a repository URL and settles it ready', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: ' https://github.com/example/product.git ',
    })) as CollabWorkspaceView
    // The create answers immediately with a provisioning record; the browser
    // request never stays open across the clone. The background clone still
    // starts eagerly (the settle to `ready` below proves it).
    expect(created.cloneState).toBe('cloning')
    const clonePath = join(boot.ctx.collabWorkspaces.root, 'workspaces', `product-${created.id}`)
    const ready = await settleCloneToReady(boot, clonePath)
    expect(ready.cloneState).toBe('ready')
    // The workspace's data directory and mount resolve to the clone.
    const dir = value(await call(boot, boot.admin, 'collab/workspace.dir', { workspaceId: created.id })) as { dir: string }
    expect(dir.dir).toBe(clonePath)
    const fake = fakeWorkspaceRegistry(clonePath)
    fake.register(boot.ctx)
    const mounted = value(await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })) as CollabMountedWorkspaceView
    expect(mounted.dir).toBe(clonePath)
    expect(mounted.workspace).toMatchObject({ path: clonePath, title: 'Product' })
    expect(fake.createCalls).toEqual([{ path: clonePath, title: 'Product', collabWorkspaceId: created.id }])
  })

  it('surfaces readonly git state once a real repository clone settles', async () => {
    const boot = await bootServices()
    const repo = makeGitRepo()
    try {
      const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
        name: 'Repo',
      })) as CollabWorkspaceView
      // A name-only row carries no git state while it has no clone.
      expect(created.cloneState).toBe('none')
      expect('gitState' in created).toBe(false)
      await boot.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath: repo })
      const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
      const row = listed.find(entry => entry.id === created.id)
      expect(row?.cloneState).toBe('ready')
      const branch = currentBranchOf(repo)
      const sha = String(execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { stdio: 'pipe' })).trim()
      expect(row?.gitState).toEqual({ branch, sha, dirty: false })
      const fetched = value(await call(boot, boot.admin, 'collab/workspace.get', { workspaceId: created.id })) as CollabWorkspaceView
      expect(fetched.gitState?.dirty).toBe(false)
      // A real working-tree edit flips the dirty flag on the next read.
      writeFileSync(join(repo, 'file.txt'), 'two\n')
      const stale = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
      const edited = stale.find(entry => entry.id === created.id)
      expect(edited?.gitState?.dirty).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('refuses to open or resolve a provisioning workspace until the clone settles', async () => {
    const boot = await bootServices()
    boot.cloner.stall()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })) as CollabWorkspaceView
    expect(created.cloneState).toBe('cloning')
    const dir = await call(boot, boot.admin, 'collab/workspace.dir', { workspaceId: created.id })
    expectCollabError(dir, 'collab-clone-pending')
    // The mount path needs the host registry present to reach the working-dir
    // gate; the gate itself rejects a provisioning workspace.
    const fake = fakeWorkspaceRegistry(join(boot.root, 'unused'))
    fake.register(boot.ctx)
    const open = await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })
    expectCollabError(open, 'collab-clone-pending')
    // Release the held clone so the background job settles before teardown.
    boot.cloner.release()
  })

  it('removes a provisioning workspace when the background clone fails', async () => {
    const boot = await bootServices()
    const warn = vi.spyOn(boot.ctx.logger, 'warn').mockImplementation(() => {})
    boot.cloner.fail('repository not found')
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/missing.git',
    })) as CollabWorkspaceView
    // The create itself does not fail; the failed clone removes the record.
    expect(created.cloneState).toBe('cloning')
    await vi.waitFor(() => { expect(boot.cloner.calls).toHaveLength(1) })
    // The operator-facing diagnostic carries the git error the bootstrap hid.
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("collab clone of 'https://github.com/example/missing.git' failed"))
    })
    await vi.waitFor(async () => {
      const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
      expect(listed).toEqual([])
    })
    // A partial clone target left by the runner is cleaned up.
    const target = join(boot.ctx.collabWorkspaces.root, 'workspaces', `product-${created.id}`)
    await vi.waitFor(async () => {
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('removes the clone directory when the record was deleted mid-clone', async () => {
    const boot = await bootServices()
    boot.cloner.stall()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })) as CollabWorkspaceView
    await vi.waitFor(() => { expect(boot.cloner.calls).toHaveLength(1) })
    await call(boot, boot.admin, 'collab/workspace.delete', { workspaceId: created.id })
    const target = join(boot.ctx.collabWorkspaces.root, 'workspaces', `product-${created.id}`)
    // The clone finishes after the record is gone; the orphaned target is removed.
    boot.cloner.release()
    await vi.waitFor(async () => {
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('rejects a non-string repository URL', async () => {
    const boot = await bootServices()
    const bad = await call(boot, boot.admin, 'collab/workspace.create', { name: 'Product', repoUrl: 42 })
    expectCollabError(bad, 'collab-bad-request')
    const blank = await call(boot, boot.admin, 'collab/workspace.create', { name: 'Product', repoUrl: '   ' })
    expectCollabError(blank, 'collab-bad-request')
    expect(boot.cloner.calls).toEqual([])
  })

  it('clones into the configured clone directory when the cloneDir setting is set', async () => {
    const boot = await bootServices()
    const clonesRoot = join(boot.root, 'configured-clones')
    // A settings provider is absent from this unit lane; stand one in so the
    // dispatch resolves the configured clone root instead of the default.
    boot.ctx.provide('settings', { get: () => ({ cloneDir: clonesRoot }) } as never)
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })) as CollabWorkspaceView
    const clonePath = join(clonesRoot, `product-${created.id}`)
    await settleCloneToReady(boot, clonePath)
    expect(boot.cloner.calls).toEqual([{ repoUrl: 'https://github.com/example/product.git', target: clonePath }])
  })

  it('clones shallow when the collab clone depth setting is set', async () => {
    const boot = await bootServices()
    boot.ctx.provide('settings', { get: () => ({ cloneDir: '', cloneDepth: 7 }) } as never)
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })) as CollabWorkspaceView
    const clonePath = join(boot.ctx.collabWorkspaces.root, 'workspaces', `product-${created.id}`)
    await settleCloneToReady(boot, clonePath)
    // The operator depth reaches the clone argv as `--depth <n>`.
    const args = boot.cloner.rawArgs.find(entry => entry.includes('--depth'))
    expect(args?.[args.indexOf('--depth') + 1]).toBe('7')
    expect(boot.cloner.calls.some(entry => entry.target === clonePath)).toBe(true)
  })

  it('creates the clone root on demand before cloning', async () => {
    const boot = await bootServices()
    const clonesRoot = join(boot.root, 'created-clones')
    boot.ctx.provide('settings', { get: () => ({ cloneDir: clonesRoot }) } as never)
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })) as CollabWorkspaceView
    // git only creates the leaf target, so the server builds the configured
    // root recursively at create time rather than letting the clone fail.
    expect((await stat(clonesRoot)).isDirectory()).toBe(true)
    const clonePath = join(clonesRoot, `product-${created.id}`)
    await settleCloneToReady(boot, clonePath)
    expect(boot.cloner.calls).toEqual([{ repoUrl: 'https://github.com/example/product.git', target: clonePath }])
  })

  it('answers collab-bad-request when the clone root cannot be created', async () => {
    const boot = await bootServices()
    // A configured root whose parent is a regular file cannot be created, so
    // the create fails loudly instead of silently removing a workspace after
    // a doomed background clone.
    const blocker = join(boot.root, 'clone-blocker')
    await writeFile(blocker, 'not-a-directory')
    boot.ctx.provide('settings', { get: () => ({ cloneDir: join(blocker, 'sub') }) } as never)
    const result = await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })
    expectCollabError(result, 'collab-bad-request')
    // Nothing was provisioned: no record and no background clone.
    expect(boot.cloner.calls).toEqual([])
    const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
    expect(listed).toEqual([])
  })

  it('answers collab-bad-request when the clone root exists but is not writable', async () => {
    const boot = await bootServices()
    const clonesRoot = join(boot.root, 'denied-clones')
    await fsPromises.mkdir(clonesRoot, { recursive: true })
    boot.ctx.provide('settings', { get: () => ({ cloneDir: clonesRoot }) } as never)
    accessMock.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    const result = await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })
    // An existing-but-unwritable root fails the create loudly instead of
    // auto-removing the workspace after a permission-denied clone.
    expectCollabError(result, 'collab-bad-request')
    expect(boot.cloner.calls).toEqual([])
  })

  it('threads the server git credential into a clone of its pinned host', async () => {
    const boot = await bootServices()
    const credentials: GitCloneCredentials = { host: 'github.com', username: 'x-access-token', token: 'ghp_secret' }
    boot.ctx.provide('collabGitCloneAuth', credentials)
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })) as CollabWorkspaceView
    const githubPath = join(boot.ctx.collabWorkspaces.root, 'workspaces', `product-${created.id}`)
    await settleCloneToReady(boot, githubPath)
    const env = boot.cloner.envs[0]!
    // The credential is scoped through a temporary GIT_CONFIG_GLOBAL for this
    // clone only, and the temp dir is removed right after the clone.
    expect(env.GIT_CONFIG_GLOBAL).toContain('dsh-collab-git-')
    await expect(stat(env.GIT_CONFIG_GLOBAL!)).rejects.toMatchObject({ code: 'ENOENT' })
    // A host the credential does not own clones unauthenticated.
    const other = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Other',
      repoUrl: 'https://gitlab.com/example/other.git',
    })) as CollabWorkspaceView
    const otherPath = join(boot.ctx.collabWorkspaces.root, 'workspaces', `other-${other.id}`)
    await settleCloneToReady(boot, otherPath)
    expect(boot.cloner.envs[1]).toBeUndefined()
  })

  it('clones unauthenticated when no server git credential is configured', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', {
      name: 'Product',
      repoUrl: 'https://github.com/example/product.git',
    })) as CollabWorkspaceView
    const clonePath = join(boot.ctx.collabWorkspaces.root, 'workspaces', `product-${created.id}`)
    await settleCloneToReady(boot, clonePath)
    expect(boot.cloner.envs).toEqual([undefined])
  })

  it('reads a workspace only for members', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const asUser = value(await call(boot, boot.admin, 'collab/workspace.get', { workspaceId: created.id }))
    expect(asUser).toMatchObject({ id: created.id, name: 'Team' })
    const denied = await call(boot, boot.member, 'collab/workspace.get', { workspaceId: created.id })
    expectCollabError(denied, 'collab-forbidden')
    const missing = await call(boot, boot.admin, 'collab/workspace.get', { workspaceId: 'nope' })
    expectCollabError(missing, 'collab-not-found')
  })

  it('lists members with user-registry enrichment', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const members = value(await call(boot, boot.admin, 'collab/workspace.members', { workspaceId: created.id })) as Array<{ userId: string; email: string; name: string }>
    /* oxlint-disable-next-line typescript/no-unsafe-assignment -- expect() matchers are `any` by design. */
    expect(members).toEqual([{ userId: boot.admin.userId, email: 'owen@example.com', name: 'Owen', role: 'admin', joinedAt: expect.any(String) }])
  })

  it('resolves the per-workspace data directory for members', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = value(await call(boot, boot.admin, 'collab/workspace.dir', { workspaceId: created.id })) as { dir: string }
    expect(dir.dir).toBe(workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id))
    const denied = await call(boot, boot.member, 'collab/workspace.dir', { workspaceId: created.id })
    expectCollabError(denied, 'collab-forbidden')
  })

  it('mounts a collab workspace as a real host workspace over its data directory', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id)
    const fake = fakeWorkspaceRegistry(dir)
    fake.register(boot.ctx)
    const mounted = value(await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })) as CollabMountedWorkspaceView
    expect(mounted.dir).toBe(dir)
    expect(mounted.workspace).toMatchObject({ workspaceId: 'host-ws-1', path: dir, title: 'Team', sessionIds: [] })
    expect(fake.createCalls).toEqual([{ path: dir, title: 'Team', collabWorkspaceId: created.id }])
  })

  it('mounts idempotently and re-asserts the collab title over a host rename', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id)
    const fake = fakeWorkspaceRegistry(dir)
    fake.register(boot.ctx)
    await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })
    // A host-side rename diverges the title; the next open re-asserts the
    // collab display name as the host title.
    await fake.entity.setTitle('Team Edits')
    const again = value(await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })) as CollabMountedWorkspaceView
    expect(again.workspace).toMatchObject({ workspaceId: 'host-ws-1', title: 'Team' })
    expect(fake.createCalls).toHaveLength(2)
  })

  it('refuses a host title collision when re-asserting a renamed title', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id)
    const fake = fakeWorkspaceRegistry(dir)
    fake.register(boot.ctx)
    await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })
    await fake.entity.setTitle('Team Edits')
    fake.addConflict('host-ws-2', 'Team')
    const conflicted = await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })
    expectCollabError(conflicted, 'collab-name-conflict')
  })

  it('mounts only for members', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id)
    const fake = fakeWorkspaceRegistry(dir)
    fake.register(boot.ctx)
    const denied = await call(boot, boot.member, 'collab/workspace.open', { workspaceId: created.id })
    expectCollabError(denied, 'collab-forbidden')
  })

  it('surfaces a missing host workspace registry as an internal error', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const result = await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })
    expectCollabError(result, 'collab-internal')
  })

  it('renames a workspace for an admin and persists the new name in the list', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const renamed = value(await call(boot, boot.admin, 'collab/workspace.rename', {
      workspaceId: created.id,
      name: 'Engineering',
    })) as CollabWorkspaceView
    expect(renamed.name).toBe('Engineering')
    expect(renamed.id).toBe(created.id)
    const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
    expect(listed.find(entry => entry.id === created.id)?.name).toBe('Engineering')
  })

  it('rejects a blank name and a developer rename', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const blank = await call(boot, boot.admin, 'collab/workspace.rename', { workspaceId: created.id, name: '   ' })
    expectCollabError(blank, 'collab-bad-request')
    // A developer member cannot rename a shared workspace (admin-only).
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
      role: 'developer',
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))
    const denied = await call(boot, boot.member, 'collab/workspace.rename', { workspaceId: created.id, name: 'Eng' })
    expectCollabError(denied, 'collab-forbidden')
  })

  it('keeps a live mount host title in sync and rejects a title conflict before mutating', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id)
    const fake = fakeWorkspaceRegistry(dir)
    fake.register(boot.ctx)
    await call(boot, boot.admin, 'collab/workspace.open', { workspaceId: created.id })
    // The collab rename re-asserts the mounted host workspace's title.
    await call(boot, boot.admin, 'collab/workspace.rename', { workspaceId: created.id, name: 'Eng' })
    expect(fake.entity.title).toBe('Eng')
    // A title another host workspace holds rejects BEFORE the collab record
    // changes: the list still carries the old name after the refusal.
    fake.addConflict('host-ws-2', 'Busy')
    const conflicted = await call(boot, boot.admin, 'collab/workspace.rename', { workspaceId: created.id, name: 'Busy' })
    expectCollabError(conflicted, 'collab-name-conflict')
    const listed = value(await call(boot, boot.admin, 'collab/workspace.list', {})) as CollabWorkspaceView[]
    expect(listed.find(entry => entry.id === created.id)?.name).toBe('Eng')
  })

  it('renames a workspace that has never been opened (no mount to sync)', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id)
    const fake = fakeWorkspaceRegistry(dir)
    fake.register(boot.ctx)
    // No `open` yet: resolveByPath finds no mount and the rename applies cleanly.
    const renamed = value(await call(boot, boot.admin, 'collab/workspace.rename', {
      workspaceId: created.id,
      name: 'Eng',
    })) as CollabWorkspaceView
    expect(renamed.name).toBe('Eng')
    expect(fake.createCalls).toEqual([])
  })

  it('invites, lists, and revokes invitations with admin-only role gating', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: ' jamie@example.com ',
      role: 'developer',
    })) as { id: string; email: string; role: string; revoked: boolean }
    expect(invitation).toMatchObject({ email: 'jamie@example.com', role: 'developer', revoked: false })
    const invites = value(await call(boot, boot.admin, 'collab/workspace.invitations', { workspaceId: created.id }))
    expect(invites).toHaveLength(1)
    // The second user joins as a developer: developers hold no invite permission.
    const forMember = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
      role: 'developer',
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: forMember.id }))
    const denied = await call(boot, boot.member, 'collab/workspace.invite', { workspaceId: created.id, email: 'x@example.com' })
    expectCollabError(denied, 'collab-forbidden')
    const revoked = value(await call(boot, boot.admin, 'collab/workspace.revokeInvitation', {
      workspaceId: created.id,
      invitationId: invitation.id,
    })) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)
  })

  it('joins a workspace by consuming the invitation addressed to the caller', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
    })) as { id: string }
    const joined = value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id })) as CollabWorkspaceView
    expect(joined).toMatchObject({ id: created.id, role: 'developer', memberCount: 2 })
    const again = await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id })
    expectCollabError(again, 'collab-bad-request')
    const mismatch = await call(boot, boot.admin, 'collab/workspace.join', { invitationId: invitation.id })
    expect(mismatch.ok).toBe(false)
  })

  it('lists the pending invitations addressed to the caller and accepts them', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Alpha' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
      role: 'admin',
    })) as { id: string }

    // The invitee sees only their own pending invitation, with the workspace name.
    const mine = value(await call(boot, boot.member, 'collab/workspace.myInvitations', {})) as Array<{
      id: string
      workspaceId: string
      workspaceName: string
      role: string
    }>
    /* oxlint-disable-next-line typescript/no-unsafe-assignment -- expect() matchers are `any` by design. */
    expect(mine).toEqual([{ id: invitation.id, workspaceId: created.id, workspaceName: 'Alpha', role: 'admin', createdAt: expect.any(String) }])
    // A different email holder sees no invitation addressed to them.
    expect(value(await call(boot, boot.admin, 'collab/workspace.myInvitations', {}))).toEqual([])

    // Accepting joins the workspace and empties the caller's accept surface.
    const joined = value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id })) as CollabWorkspaceView
    expect(joined).toMatchObject({ id: created.id, role: 'admin', memberCount: 2 })
    expect(value(await call(boot, boot.member, 'collab/workspace.myInvitations', {}))).toEqual([])
  })

  it('leaves and deletes a workspace by a member and its owner', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))
    const left = value(await call(boot, boot.member, 'collab/workspace.leave', { workspaceId: created.id }))
    expect(left).toEqual({ left: true })
    const ownerLeave = await call(boot, boot.admin, 'collab/workspace.leave', { workspaceId: created.id })
    expect(ownerLeave.ok).toBe(false)
    const deleted = value(await call(boot, boot.admin, 'collab/workspace.delete', { workspaceId: created.id }))
    expect(deleted).toEqual({ deleted: true })
    const missing = await call(boot, boot.admin, 'collab/workspace.delete', { workspaceId: created.id })
    expectCollabError(missing, 'collab-not-found')
  })

  it('deletes a repo-backed workspace together with its clone directory', async () => {
    const boot = await bootServices()
    const clonePath = join(boot.root, 'repos', 'product-w1')
    mkdirSync(clonePath, { recursive: true })
    writeFileSync(join(clonePath, 'file.txt'), 'x\n')
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Repo' })) as CollabWorkspaceView
    await boot.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath })
    expect((await stat(clonePath)).isDirectory()).toBe(true)
    const deleted = value(await call(boot, boot.admin, 'collab/workspace.delete', { workspaceId: created.id }))
    expect(deleted).toEqual({ deleted: true })
    // The shared tree the workspace was cloned into is removed with the record.
    await expect(stat(clonePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still deletes the record when the clone directory cannot be removed', async () => {
    const boot = await bootServices()
    const warn = vi.spyOn(boot.ctx.logger, 'warn').mockImplementation(() => {})
    const clonePath = join(boot.root, 'unremovable-clone')
    mkdirSync(clonePath, { recursive: true })
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Repo' })) as CollabWorkspaceView
    await boot.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath })
    const deleted = value(await call(boot, boot.admin, 'collab/workspace.delete', { workspaceId: created.id }))
    expect(deleted).toEqual({ deleted: true })
    // The folded cleanup warns and leaves the shared tree on disk.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collab clone removal'))
    expect((await stat(clonePath)).isDirectory()).toBe(true)
  })

  it('setMemberRole and removeMember are admin-gated and validated', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
      role: 'developer',
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))
    // A developer cannot manage roles or members.
    const developerGated = await call(boot, boot.member, 'collab/workspace.setMemberRole', {
      workspaceId: created.id,
      userId: boot.admin.userId,
      role: 'developer',
    })
    expectCollabError(developerGated, 'collab-forbidden')
    const changed = value(await call(boot, boot.admin, 'collab/workspace.setMemberRole', {
      workspaceId: created.id,
      userId: boot.member.userId,
      role: 'admin',
    })) as { role: string }
    expect(changed.role).toBe('admin')
    const removed = value(await call(boot, boot.admin, 'collab/workspace.removeMember', {
      workspaceId: created.id,
      userId: boot.member.userId,
    })) as { removed: string }
    expect(removed.removed).toBe(boot.member.userId)
    const badRole = await call(boot, boot.admin, 'collab/workspace.setMemberRole', {
      workspaceId: created.id,
      userId: boot.admin.userId,
      role: 'owner',
    })
    expectCollabError(badRole, 'collab-bad-request')
  })

  describe('collab/workspace.push', () => {
    it('fails closed without an explicit confirmation', async () => {
      const boot = await bootServices()
      const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'WS' })) as CollabWorkspaceView
      const result = await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: created.id })
      expectCollabError(result, 'collab-approval-required')
    })

    it('refuses a workspace with no settled repository', async () => {
      const boot = await bootServices()
      const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Name only' })) as CollabWorkspaceView
      const result = await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: created.id, confirm: true })
      expectCollabError(result, 'collab-not-a-repository')
    })

    it('pushes the current branch to the origin after a member confirmation', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'commit', '--allow-empty', '-m', 'ahead of origin'], { stdio: 'pipe' })
        const pushed = value(await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true })) as {
          pushed: boolean
          branch: string
          base: string
          remoteSha: string
        }
        expect(pushed.pushed).toBe(true)
        expect(pushed.branch).toBe('main')
        expect(pushed.base).toBe('main')
        const tip = String(execFileSync('git', ['-C', fixture.work, 'rev-parse', 'HEAD'], { stdio: 'pipe' })).trim()
        expect(pushed.remoteSha).toBe(tip)
        expect(String(execFileSync('git', ['-C', fixture.bare, 'rev-parse', 'refs/heads/main'], { stdio: 'pipe' })).trim()).toBe(tip)
      } finally { fixture.remove() }
    })

    it('pushes an explicit session branch', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'switch', '-c', 'feature-9'], { stdio: 'pipe' })
        execFileSync('git', ['-C', fixture.work, 'commit', '--allow-empty', '-m', 'work'], { stdio: 'pipe' })
        const pushed = value(await call(boot, boot.admin, 'collab/workspace.push', {
          workspaceId: id,
          branch: 'feature-9',
          confirm: true,
        })) as { pushed: boolean; remoteSha: string }
        expect(pushed.pushed).toBe(true)
        expect(String(execFileSync('git', ['-C', fixture.bare, 'rev-parse', 'refs/heads/feature-9'], { stdio: 'pipe' })).trim()).toBe(pushed.remoteSha)
      } finally { fixture.remove() }
    })

    it('dry-runs without moving the remote branch', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'switch', '-c', 'planned-0'], { stdio: 'pipe' })
        const result = value(await call(boot, boot.admin, 'collab/workspace.push', {
          workspaceId: id,
          dryRun: true,
          confirm: true,
        })) as { pushed: boolean; remoteSha: string | undefined }
        expect(result.pushed).toBe(false)
        expect(result.remoteSha).toBeUndefined()
        let exists = true
        try {
          execFileSync('git', ['-C', fixture.bare, 'show-ref', '--verify', 'refs/heads/planned-0'], { stdio: 'pipe' })
        } catch {
          exists = false
        }
        expect(exists).toBe(false)
      } finally { fixture.remove() }
    })

    it('runs a dry run without requiring a confirmation (it cannot move a branch)', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'switch', '-c', 'preview-0'], { stdio: 'pipe' })
        const result = value(await call(boot, boot.admin, 'collab/workspace.push', {
          workspaceId: id,
          dryRun: true,
        })) as { pushed: boolean; remoteSha: string | undefined }
        expect(result.pushed).toBe(false)
        expect(result.remoteSha).toBeUndefined()
      } finally { fixture.remove() }
    })

    it('defaults to the real git runner when none is registered for a dry-run push', async () => {
      const boot = await bootServices({ noRunner: true })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        const result = value(await call(boot, boot.admin, 'collab/workspace.push', {
          workspaceId: id,
          dryRun: true,
        })) as { pushed: boolean }
        expect(result.pushed).toBe(false)
      } finally { fixture.remove() }
    })

    it('refuses an invalid branch name', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const clone = mkdtempSync(join(tmpdir(), 'dsh-api-branch-'))
      try {
        const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'WS' })) as CollabWorkspaceView
        await boot.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath: clone })
        const result = await call(boot, boot.admin, 'collab/workspace.push', {
          workspaceId: created.id,
          branch: 'bad name',
          confirm: true,
        })
        expectCollabError(result, 'collab-bad-request')
      } finally { rmSync(clone, { recursive: true, force: true }) }
    })

    it('refuses a detached clone with no explicit branch', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        execFileSync('git', ['-C', fixture.work, 'checkout', '--detach'], { stdio: 'pipe' })
        const id = await settleRealClone(boot, fixture.work)
        const result = await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true })
        expectCollabError(result, 'collab-bad-request')
      } finally { fixture.remove() }
    })

    it('maps a diverged remote branch to the rejected code', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'switch', '-c', 'clash'], { stdio: 'pipe' })
        value(await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, branch: 'clash', confirm: true }))
        // Another checkout moves the remote branch forward.
        const other = join(fixture.bare, '.other')
        execFileSync('git', ['clone', fixture.bare, other], { stdio: 'pipe' })
        const gitOther = (dir: string, args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }) }
        gitOther(other, ['switch', '-c', 'clash'])
        gitOther(other, ['commit', '--allow-empty', '-m', 'moved'])
        gitOther(other, ['push', '-u', 'origin', 'clash'])
        // Work now makes its own divergent head; the push is refused atomically.
        execFileSync('git', ['-C', fixture.work, 'commit', '--allow-empty', '-m', 'divergent'], { stdio: 'pipe' })
        const result = await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, branch: 'clash', confirm: true })
        expectCollabError(result, 'collab-push-rejected')
      } finally { fixture.remove() }
    })

    it('maps a missing server credential to its code for an HTTPS origin', async () => {
      const boot = await bootServices({ repoRunner: async () => ({ stdout: 'https://gitlab.example.com/acme/repo.git', stderr: '' }) })
      const repo = makeGitRepo()
      try {
        const id = await settleRealClone(boot, repo)
        const result = await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true })
        expectCollabError(result, 'collab-credential-unavailable')
      } finally { rmSync(repo, { recursive: true, force: true }) }
    })

    it('maps a git failure to the push-failed code', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const notGit = mkdtempSync(join(tmpdir(), 'dsh-api-notgit-'))
      try {
        const id = await settleRealClone(boot, notGit)
        const result = await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true })
        expectCollabError(result, 'collab-push-failed')
      } finally { rmSync(notGit, { recursive: true, force: true }) }
    })

    it('refuses a whitespace-only branch name', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const clone = mkdtempSync(join(tmpdir(), 'dsh-api-branch-'))
      try {
        const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'WS' })) as CollabWorkspaceView
        await boot.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath: clone })
        const result = await call(boot, boot.admin, 'collab/workspace.push', {
          workspaceId: created.id,
          branch: '   ',
          confirm: true,
        })
        expectCollabError(result, 'collab-bad-request')
      } finally { rmSync(clone, { recursive: true, force: true }) }
    })

    it('maps a non-Error service throw to push-failed', async () => {
      const boot = await bootServices({ noRunner: true })
      const clone = mkdtempSync(join(tmpdir(), 'dsh-api-nonerr-'))
      try {
        boot.ctx.provide('collabRepoCloner', async () => { throw 'broken runner' })
        const id = await settleRealClone(boot, clone)
        const result = await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true })
        expectCollabError(result, 'collab-push-failed')
      } finally { rmSync(clone, { recursive: true, force: true }) }
    })

    it('forwards the server credential for a matching HTTPS origin', async () => {
      const localSha = 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead'
      const remoteSha = 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0'
      let revCount = 0
      const runner: GitCommandRunner = async (_command, args) => {
        const key = args.slice(2).join(' ')
        if (key.startsWith('rev-list --count')) {
          revCount += 1
          return { stdout: revCount === 1 ? '1' : '0', stderr: '' }
        }
        if (key === 'merge-base --is-ancestor f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0 g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead') {
          return { stdout: '', stderr: '' }
        }
        const out: Record<string, string> = {
          'remote get-url origin': 'https://github.com/acme/repo.git',
          'rev-parse refs/heads/topic': localSha,
          'ls-remote origin refs/heads/topic': `${remoteSha}\trefs/heads/topic`,
          'rev-parse refs/remotes/origin/topic': remoteSha,
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
        }
        return { stdout: out[key] ?? '', stderr: '' }
      }
      const boot = await bootServices({ repoRunner: runner })
      const clone = mkdtempSync(join(tmpdir(), 'dsh-api-cred-'))
      try {
        boot.ctx.provide('collabGitCloneAuth', { host: 'github.com', username: 'machine', token: 'ghp_secret' })
        const id = await settleRealClone(boot, clone)
        const result = value(await call(boot, boot.admin, 'collab/workspace.push', {
          workspaceId: id,
          branch: 'topic',
          confirm: true,
        })) as { pushed: boolean; compareUrl?: string }
        expect(result.pushed).toBe(true)
        expect(result.compareUrl).toBe('https://github.com/acme/repo/compare/main...topic')
      } finally { rmSync(clone, { recursive: true, force: true }) }
    })

    it('defaults to the real git runner when none is registered', async () => {
      const boot = await bootServices({ noRunner: true })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'commit', '--allow-empty', '-m', 'ahead'], { stdio: 'pipe' })
        const result = value(await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true })) as {
          pushed: boolean
        }
        expect(result.pushed).toBe(true)
      } finally { fixture.remove() }
    })

    it('writes a push audit record under the collab data root', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'switch', '-c', 'audited'], { stdio: 'pipe' })
        execFileSync('git', ['-C', fixture.work, 'commit', '--allow-empty', '-m', 'audited work'], { stdio: 'pipe' })
        value(await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true }))
        const trail = join(boot.ctx.collabWorkspaces.root, 'audit', 'push.jsonl')
        const entry = JSON.parse(readFileSync(trail, 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>
        expect(entry).toMatchObject({
          workspaceId: id,
          actorId: boot.admin.userId,
          actorName: 'Owen',
          branch: 'audited',
          dryRun: false,
          pushed: true,
          upToDate: false,
        })
        expect(typeof entry.ts).toBe('string')
        expect(typeof entry.remoteSha).toBe('string')
      } finally { fixture.remove() }
    })

    it('records a dry run in the push audit trail without moving the branch', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'switch', '-c', 'planned-audit'], { stdio: 'pipe' })
        const result = value(await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, dryRun: true })) as {
          pushed: boolean
        }
        expect(result.pushed).toBe(false)
        const trail = join(boot.ctx.collabWorkspaces.root, 'audit', 'push.jsonl')
        const entry = JSON.parse(readFileSync(trail, 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>
        expect(entry.dryRun).toBe(true)
        expect(entry.pushed).toBe(false)
      } finally { fixture.remove() }
    })

    it('folds an audit write failure into a warn and never fails the push', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const warn = vi.spyOn(boot.ctx.logger, 'warn').mockImplementation(() => {})
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        execFileSync('git', ['-C', fixture.work, 'commit', '--allow-empty', '-m', 'ahead'], { stdio: 'pipe' })
        // A file named `audit` blocks the audit directory from being created.
        writeFileSync(join(boot.ctx.collabWorkspaces.root, 'audit'), '')
        const pushed = value(await call(boot, boot.admin, 'collab/workspace.push', { workspaceId: id, confirm: true })) as {
          pushed: boolean
        }
        expect(pushed.pushed).toBe(true)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('collab push audit write failed'))
      } finally { fixture.remove() }
    })
  })

  describe('collab/workspace.fetch', () => {
    it('fetches the origin into a settled clone without moving the checkout', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const fixture = await makeBareTrackedWork()
      try {
        const id = await settleRealClone(boot, fixture.work)
        // Push a new commit to the mainline from a second checkout.
        const other = join(fixture.bare, '.other')
        execFileSync('git', ['clone', fixture.bare, other], { stdio: 'pipe' })
        const gitOther = (dir: string, args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }) }
        gitOther(other, ['config', 'user.email', 'other@example.dev'])
        gitOther(other, ['config', 'user.name', 'other'])
        gitOther(other, ['commit', '--allow-empty', '-m', 'upstream move'])
        gitOther(other, ['push', 'origin', 'main'])
        const before = String(execFileSync('git', ['-C', fixture.work, 'rev-parse', 'HEAD'], { stdio: 'pipe' })).trim()
        const fetched = value(await call(boot, boot.admin, 'collab/workspace.fetch', { workspaceId: id }))
        expect(fetched).toEqual({ fetched: true })
        // Only remote-tracking refs move; the shared checkout is untouched.
        expect(String(execFileSync('git', ['-C', fixture.work, 'rev-parse', 'HEAD'], { stdio: 'pipe' })).trim()).toBe(before)
        const tip = String(execFileSync('git', ['-C', fixture.bare, 'rev-parse', 'main'], { stdio: 'pipe' })).trim()
        expect(String(execFileSync('git', ['-C', fixture.work, 'rev-parse', 'refs/remotes/origin/main'], { stdio: 'pipe' })).trim()).toBe(tip)
      } finally { fixture.remove() }
    })

    it('refuses a workspace with no settled repository clone', async () => {
      const boot = await bootServices()
      const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Name only' })) as CollabWorkspaceView
      const result = await call(boot, boot.admin, 'collab/workspace.fetch', { workspaceId: created.id })
      expectCollabError(result, 'collab-not-a-repository')
    })

    it('maps a git failure to a bad-request', async () => {
      const boot = await bootServices({ repoRunner: gitCloneRunner })
      const notGit = mkdtempSync(join(tmpdir(), 'dsh-api-notgit-'))
      try {
        const id = await settleRealClone(boot, notGit)
        const result = await call(boot, boot.admin, 'collab/workspace.fetch', { workspaceId: id })
        expectCollabError(result, 'collab-bad-request')
      } finally { rmSync(notGit, { recursive: true, force: true }) }
    })

    it('defaults to the real git runner when none is registered for the fetch', async () => {
      const boot = await bootServices({ noRunner: true })
      const notGit = mkdtempSync(join(tmpdir(), 'dsh-api-notgit-'))
      try {
        const id = await settleRealClone(boot, notGit)
        const result = await call(boot, boot.admin, 'collab/workspace.fetch', { workspaceId: id })
        expectCollabError(result, 'collab-bad-request')
      } finally { rmSync(notGit, { recursive: true, force: true }) }
    })

    it('sends the pinned server credential to a fetch for a matching HTTPS origin', async () => {
      const envs: Array<NodeJS.ProcessEnv | undefined> = []
      const boot = await bootServices({
        repoRunner: async (_command, _args, _signal, env) => {
          envs.push(env)
          return { stdout: 'https://gitlab.example.com/acme/repo.git', stderr: '' }
        },
      })
      boot.ctx.provide('collabGitCloneAuth', { host: 'gitlab.example.com', username: 'machine', token: 'glpat_secret' })
      const repo = makeGitRepo()
      try {
        const id = await settleRealClone(boot, repo)
        const fetched = value(await call(boot, boot.admin, 'collab/workspace.fetch', { workspaceId: id }))
        expect(fetched).toEqual({ fetched: true })
        // The fetched auth used the host-scoped git config carrying the token.
        expect(envs.some(env => typeof env?.GIT_CONFIG_GLOBAL === 'string')).toBe(true)
      } finally { rmSync(repo, { recursive: true, force: true }) }
    })

    it('folds a missing server credential into a bad-request for an HTTPS origin', async () => {
      const boot = await bootServices({ repoRunner: async () => ({ stdout: 'https://gitlab.example.com/acme/repo.git', stderr: '' }) })
      const repo = makeGitRepo()
      try {
        const id = await settleRealClone(boot, repo)
        const result = await call(boot, boot.admin, 'collab/workspace.fetch', { workspaceId: id })
        expectCollabError(result, 'collab-bad-request')
      } finally { rmSync(repo, { recursive: true, force: true }) }
    })
  })
})

describe('collab/users admin surface', () => {
  it('lists accounts and mutates roles only as an instance admin', async () => {
    const boot = await bootServices()
    const denied = await call(boot, boot.member, 'collab/users.list', {})
    expectCollabError(denied, 'collab-forbidden')
    const listed = value(await call(boot, boot.admin, 'collab/users.list', {})) as Array<{ id: string; globalRole: string }>
    expect(listed.map(entry => entry.id)).toEqual([boot.admin.userId, boot.member.userId])
    const promoted = value(await call(boot, boot.admin, 'collab/users.setGlobalRole', {
      userId: boot.member.userId,
      role: 'admin',
    })) as { globalRole: string }
    expect(promoted.globalRole).toBe('admin')
    const disabled = value(await call(boot, boot.admin, 'collab/users.setDisabled', {
      userId: boot.member.userId,
      disabled: true,
    })) as { disabled: boolean }
    expect(disabled.disabled).toBe(true)
    const badFlag = await call(boot, boot.admin, 'collab/users.setDisabled', { userId: boot.member.userId, disabled: 'yes' })
    expectCollabError(badFlag, 'collab-bad-request')
  })
})

describe('wire validation and error folding', () => {
  it('rejects unknown endpoints and non-object payloads', async () => {
    const boot = await bootServices()
    const unknown = await call(boot, boot.admin, 'collab/whatever', {})
    expectCollabError(unknown, 'collab-not-found')
    const array = await call(boot, boot.admin, 'collab/workspace.list', [1])
    expectCollabError(array, 'collab-bad-request')
  })

})

describe('collabError helper', () => {
  it('builds the failure branch with a merged details map', () => {
    const error = collabError('collab-not-found', 'collab: workspace nope does not exist')
    expect(error).toEqual({ code: 'collab-not-found', message: 'collab: workspace nope does not exist', details: {} })
  })
})

/** Minimal ServerResponse stand-in capturing the emitted response. */
function fakeResponse() {
  let status = 0
  let location = ''
  let cookie = ''
  let sent = ''
  const headers: Record<string, string> = {}
  return {
    get statusCode(): number {
      return status
    },
    get locationHeader(): string {
      return location
    },
    get cookieHeader(): string {
      return cookie
    },
    get sent(): string {
      return sent
    },
    headers,
    setHeader(name: string, value: string): void {
      headers[name] = value
      if (name === 'Set-Cookie') cookie = value
    },
    writeHead(code: number, extra: Record<string, string> | undefined): void {
      status = code
      if (extra?.Location !== undefined) location = extra.Location
    },
    end(body?: string): void {
      sent = body ?? ''
      status = status === 0 ? 200 : status
    },
  }
}

interface StubConnection {
  authenticator: ((facts: { headers: IncomingHttpHeaders | Headers }) => unknown) | undefined
  intercept: { matcher: (endpoint: string) => boolean; handler: (endpoint: string, payload: unknown) => Promise<unknown> } | undefined
  principalValue: unknown
  registerAuthenticator: (owner: object, fn: (facts: { headers: IncomingHttpHeaders | Headers }) => unknown) => () => void
  principal: () => unknown
  rpc: {
    intercept: (
      channel: string,
      matcher: (endpoint: string) => boolean,
      handler: (endpoint: string, payload: unknown) => Promise<unknown>,
      options: { authority: string },
    ) => () => void
  }
}

type StubWebServer = {
  routes: Array<{ kind: 'exact'; path: string; handler: (req: { method: string; url?: string; headers: Record<string, string>; on?: (event: string, cb: (chunk?: string) => void) => void }, res: ReturnType<typeof fakeResponse>) => void | Promise<void> }>
  register: (route: { kind: 'exact'; path: string; handler: unknown }) => () => void
}

async function bootPlugin(
  overrides: GatewayOverrides = {},
  config: Parameters<typeof apply>[1] = {},
): Promise<{
  ctx: Context
  connection: StubConnection
  web: StubWebServer
  auth: CollabAuth
  booted: Booted
}> {
  const boot = await bootServices(overrides)
  const connection: StubConnection = {
    authenticator: undefined,
    intercept: undefined,
    principalValue: undefined,
    registerAuthenticator(_owner, fn) {
      this.authenticator = fn
      return () => { this.authenticator = undefined }
    },
    principal() {
      return this.principalValue
    },
    rpc: {
      intercept(channel, matcher, handler, options) {
        void channel
        void options
        connection.intercept = { matcher, handler }
        return () => { connection.intercept = undefined }
      },
    },
  }
  const web: StubWebServer = { routes: [], register(route) { web.routes.push({ ...route } as StubWebServer['routes'][number]); return () => {} } }
  boot.ctx.provide('connection' as never, connection as never)
  boot.ctx.provide('webServer' as never, web as never)
  apply(boot.ctx, config)
  return { ctx: boot.ctx, connection, web, auth: boot.ctx.collabAuth, booted: boot }
}

describe('plugin wiring', () => {
  it('registers the cookie authenticator and resolves principals off the fence', async () => {
    const { connection, booted } = await bootPlugin()
    expect(connection.authenticator).toBeDefined()
    expect(connection.authenticator!({ headers: {} })).toBeUndefined()
    const token = booted.ctx.collabAuth.createSessionToken(UserId(booted.admin.userId))
    const principal = connection.authenticator!({ headers: { cookie: `dsh_collab_session=${token}` } }) as { userId: string; email: string }
    expect(principal).toMatchObject({ userId: booted.admin.userId, email: 'owen@example.com' })
  })

  it('registers the collab interceptor and dispatches under the gate principal', async () => {
    const { connection, booted } = await bootPlugin()
    expect(connection.intercept?.matcher('collab/workspace.list')).toBe(true)
    expect(connection.intercept?.matcher('session.create')).toBe(false)
    connection.principalValue = {
      userId: booted.admin.userId,
      email: booted.admin.email,
      name: booted.admin.name,
      globalRole: 'admin',
    }
    const interceptor = connection.intercept
    expect(interceptor).toBeDefined()
    const result = await interceptor!.handler('collab/workspace.list', {})
    expect(result).toMatchObject({ ok: true, value: [] })
    connection.principalValue = undefined
    const gate = await interceptor!.handler('collab/workspace.list', {})
    expectCollabError(gate as RpcResult<unknown>, 'collab-forbidden')
  })

  it('registers the login, callback, logout, and session exact routes', async () => {
    const { web } = await bootPlugin()
    const paths = web.routes.map(route => route.path)
    expect(paths).toEqual(expect.arrayContaining([COLLAB_AUTH_LOGIN_PATH, '/api/collab/auth/callback', COLLAB_AUTH_LOGOUT_PATH, COLLAB_AUTH_SESSION_PATH]))
  })

  it('signs the browser in end to end through the exact routes', async () => {
    const { web } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: `${COLLAB_AUTH_LOGIN_PATH}?redirectTo=%2Fapp`, headers: {} }, loginRes)
    await flush()
    expect(loginRes.statusCode).toBe(302)
    expect(loginRes.locationHeader).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=/)
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!

    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const callbackRes = fakeResponse()
    void callback.handler({ method: 'GET', url: `/api/collab/auth/callback?code=abc&state=${state}`, headers: {} }, callbackRes)
    await flush()
    expect(callbackRes.statusCode).toBe(302)
    expect(callbackRes.locationHeader).toBe('/app')
    expect(callbackRes.cookieHeader).toMatch(/^dsh_collab_session=/)

    const session = web.routes.find(route => route.path === COLLAB_AUTH_SESSION_PATH)!
    const cookie = callbackRes.cookieHeader.split(';')[0]!
    const probeRes = fakeResponse()
    void session.handler({ method: 'GET', url: COLLAB_AUTH_SESSION_PATH, headers: { cookie } }, probeRes)
    await flush()
    expect(probeRes.statusCode).toBe(200)
    expect(JSON.parse(probeRes.sent)).toMatchObject({ authenticated: true, principal: { email: 'owen@example.com' } })
    const signedOut = fakeResponse()
    void session.handler({ method: 'GET', url: COLLAB_AUTH_SESSION_PATH, headers: {} }, signedOut)
    await flush()
    expect(JSON.parse(signedOut.sent)).toEqual({ authenticated: false })

    const logout = web.routes.find(route => route.path === COLLAB_AUTH_LOGOUT_PATH)!
    const logoutRes = fakeResponse()
    void logout.handler({ method: 'POST', url: COLLAB_AUTH_LOGOUT_PATH, headers: {} }, logoutRes)
    expect(logoutRes.statusCode).toBe(204)
    expect(logoutRes.cookieHeader).toMatch(/^dsh_collab_session=;/)
    const wrongMethodRes = fakeResponse()
    await logout.handler({ method: 'GET', url: COLLAB_AUTH_LOGOUT_PATH, headers: {} }, wrongMethodRes)
    expect(wrongMethodRes.statusCode).toBe(405)
  })

  it('derives the OAuth redirect URI from the login request origin when unpinned', async () => {
    const { web, auth } = await bootPlugin({ derivedRedirect: true })
    expect(auth.redirectDependsOnRequest).toBe(true)
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({
      method: 'GET',
      url: COLLAB_AUTH_LOGIN_PATH,
      headers: { host: 'collab.example.com', 'x-forwarded-proto': 'https, http' },
    }, loginRes)
    await flush()
    expect(loginRes.statusCode).toBe(302)
    expect(new URL(loginRes.locationHeader).searchParams.get('redirect_uri'))
      .toBe('https://collab.example.com/api/collab/auth/callback')
  })

  it('falls back to plain HTTP (and a loopback default) without a forwarded scheme', async () => {
    const { web } = await bootPlugin({ derivedRedirect: true })
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const httpRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: { host: 'collab.example.com' } }, httpRes)
    await flush()
    expect(new URL(httpRes.locationHeader).searchParams.get('redirect_uri'))
      .toBe('http://collab.example.com/api/collab/auth/callback')

    const noHostRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, noHostRes)
    await flush()
    expect(new URL(noHostRes.locationHeader).searchParams.get('redirect_uri'))
      .toBe('http://localhost:3080/api/collab/auth/callback')
  })

  it('keeps the pinned redirect URI regardless of the login request origin', async () => {
    const { web } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({
      method: 'GET',
      url: COLLAB_AUTH_LOGIN_PATH,
      headers: { host: 'collab.example.com', 'x-forwarded-proto': 'https' },
    }, loginRes)
    await flush()
    expect(new URL(loginRes.locationHeader).searchParams.get('redirect_uri'))
      .toBe('http://localhost:3080/api/collab/auth/callback')
  })

  it('supports the urlencoded POST callback and refuses a failed exchange', async () => {
    const { web, booted } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, loginRes)
    await flush()
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!

    const postRes = fakeResponse()
    const postReq = new EventEmitter() as EventEmitter &
      { method: string; url: string; headers: Record<string, string>; readEntries?: boolean }
    postReq.method = 'POST'
    postReq.url = '/api/collab/auth/callback'
    postReq.headers = {}
    void callback.handler(postReq, postRes)
    queueMicrotask(() => {
      postReq.emit('data', `code=abc&state=${state}`)
      postReq.emit('end')
    })
    await flush()
    await flush()
    expect(postRes.statusCode).toBe(302)
    expect(postRes.cookieHeader).toMatch(/^dsh_collab_session=/)

    // A bogus state never completes: the callback refuses and clears the cookie.
    const failRes = fakeResponse()
    void callback.handler({ method: 'GET', url: '/api/collab/auth/callback?code=abc&state=bogus', headers: {} }, failRes)
    await flush()
    expect(failRes.statusCode).toBe(302)
    expect(failRes.locationHeader).toBe('/?collab=signin-failed')
    expect(failRes.cookieHeader).toMatch(/^dsh_collab_session=;/)
    await booted.dispose()
  })

  it('answers the login route only for GET', async () => {
    const { web } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'POST', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, res)
    expect(res.statusCode).toBe(405)
  })

  it('provides the operator git credential from config, pinned to its host', async () => {
    const { booted } = await bootPlugin({}, { gitToken: 'ghp_secret' })
    expect(booted.ctx.get('collabGitCloneAuth', false)).toEqual({
      host: 'github.com',
      username: 'x-access-token',
      token: 'ghp_secret',
    })
    const custom = await bootPlugin({}, { gitToken: 'ghp_secret', gitHost: 'gitlab.example.com', gitUsername: 'bot' })
    expect(custom.booted.ctx.get('collabGitCloneAuth', false)).toEqual({
      host: 'gitlab.example.com',
      username: 'bot',
      token: 'ghp_secret',
    })
    const absent = await bootPlugin({}, { cloneDir: '/clones' })
    expect(absent.booted.ctx.get('collabGitCloneAuth', false)).toBeUndefined()
  })

  it('forks a per-session branch in the repo-backed workspace each session opens in', async () => {
    const { booted } = await bootPlugin()
    const repo = makeGitRepo()
    try {
      const created = value(await call(booted, booted.admin, 'collab/workspace.create', { name: 'Product' })) as CollabWorkspaceView
      await booted.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath: repo })
      const emitSession = (id: string): void => {
        booted.ctx.events.emit('session/created', { id, header: { cwd: repo } })
      }
      emitSession('sess-1')
      await vi.waitFor(() => {
        expect(currentBranchOf(repo)).toBe('Product-sess-1')
      })
      // Re-attaching the same session stays on its own line (no second fork),
      // and a second session forks its own branch from there.
      emitSession('sess-1')
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(currentBranchOf(repo)).toBe('Product-sess-1')
      emitSession('sess-2')
      await vi.waitFor(() => {
        expect(currentBranchOf(repo)).toBe('Product-sess-2')
      })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('does not fork a branch for a session outside any repo-backed clone', async () => {
    const { booted } = await bootPlugin()
    const repo = makeGitRepo()
    try {
      const created = value(await call(booted, booted.admin, 'collab/workspace.create', { name: 'Product' })) as CollabWorkspaceView
      await booted.ctx.collabWorkspaces.settleClone(WorkspaceId(created.id), { kind: 'cloned', clonePath: repo })
      booted.ctx.events.emit('session/created', { id: 'sess-x', header: { cwd: '/unrelated/dir' } })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(currentBranchOf(repo)).not.toMatch(/sess-x/)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('logs a warning when the session-branch lookup itself fails', async () => {
    const { booted } = await bootPlugin()
    const warn = vi.spyOn(booted.ctx.logger, 'warn')
    // A non-Error throw (e.g. a hostile service) exercises the string fallback.
    vi.spyOn(booted.ctx.collabWorkspaces, 'workspaceHolding').mockImplementationOnce(() => {
      throw 'lookup exploded'
    })
    booted.ctx.events.emit('session/created', { id: 'sess-y', header: { cwd: '/anywhere' } })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to fork a session branch for \'sess-y\': lookup exploded'))
    })
  })

  it('logs a warning when the session-branch lookup fails with an Error', async () => {
    const { booted } = await bootPlugin()
    const warn = vi.spyOn(booted.ctx.logger, 'warn')
    vi.spyOn(booted.ctx.collabWorkspaces, 'workspaceHolding').mockImplementationOnce(() => {
      throw new Error('lookup exploded')
    })
    booted.ctx.events.emit('session/created', { id: 'sess-z', header: { cwd: '/anywhere' } })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to fork a session branch for \'sess-z\': lookup exploded'))
    })
  })
})

describe('additional dispatch wire paths', () => {
  it('folds a hostile non-Error service throw into collab-bad-request', async () => {
    const boot = await bootServices()
    const hostile = new Proxy({}, { get: () => { throw 'boom' } })
    const result = await dispatchCollabEndpoint(boot.ctx, boot.admin as never, 'collab/workspace.create', hostile)
    if (result.ok) throw new Error('expected collab-bad-request refusal')
    expect(result.error.message).toBe('collab: boom')
  })

  it('rejects non-string optional and global roles', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const badInviteRole = await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: 'a@b.c',
      role: 5,
    })
    expectCollabError(badInviteRole, 'collab-bad-request')
    const badGlobalRole = await call(boot, boot.admin, 'collab/users.setGlobalRole', {
      userId: boot.member.userId,
      role: 'owner',
    })
    expectCollabError(badGlobalRole, 'collab-bad-request')
  })

  it('enriches member views and falls back for unknown accounts', async () => {
    const boot = await bootServices()
    const ghost = { userId: 'ghost-1', email: 'ghost@example.com', globalRole: 'member' as const }
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: ghost.email,
    })) as { id: string }
    value(await call(boot, ghost, 'collab/workspace.join', { invitationId: invitation.id }))
    const members = value(await call(boot, boot.admin, 'collab/workspace.members', { workspaceId: created.id })) as Array<{ email: string; name: string }>
    expect(members).toContainEqual(expect.objectContaining({ userId: 'ghost-1', email: '', name: '', role: 'developer' }))
  })

  it('cars usedAt on consumed invitations and lastSeenAt on touched accounts', async () => {
    const boot = await bootServices()
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))
    const invites = value(await call(boot, boot.admin, 'collab/workspace.invitations', { workspaceId: created.id })) as Array<{ usedAt?: string }>
    expect(invites[0]!.usedAt).toBeTypeOf('string')
    await boot.ctx.collabUsers.touch(UserId(boot.admin.userId))
    await boot.ctx.collabUsers.touch(UserId(boot.admin.userId))
    const listed = value(await call(boot, boot.admin, 'collab/users.list', {})) as Array<{ id: string; lastSeenAt?: string }>
    expect(listed.find(entry => entry.id === boot.admin.userId)?.lastSeenAt).toBeTypeOf('string')
  })
})

describe('additional HTTP handler paths', () => {
  it('falls back to the root redirect and the fetch-header cookie read', async () => {
    const { connection, web, booted } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const bare = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, bare)
    await flush()
    expect(bare.locationHeader).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=/)
    const token = booted.ctx.collabAuth.createSessionToken(UserId(booted.admin.userId))
    const principal = connection.authenticator!({ headers: new Headers({ cookie: `dsh_collab_session=${token}` }) })
    expect(principal).toMatchObject({ userId: booted.admin.userId })
    const plain = connection.authenticator!({ headers: { cookie: `dsh_collab_session=${token}` } })
    expect(plain).toMatchObject({ userId: booted.admin.userId })
    const missing = connection.authenticator!({ headers: new Headers({}) })
    expect(missing).toBeUndefined()
  })

  it('answers an empty callback and refuses an oversized POST body', async () => {
    const { web } = await bootPlugin()
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const empty = fakeResponse()
    void callback.handler({ method: 'GET', headers: {} }, empty)
    await flush()
    expect(empty.statusCode).toBe(302)
    expect(empty.locationHeader).toBe('/?collab=signin-failed')

    const big = fakeResponse()
    const bigReq = new EventEmitter() as EventEmitter &
      { method: string; url?: string; headers: Record<string, string>; destroy: () => void }
    bigReq.method = 'POST'
    bigReq.url = '/api/collab/auth/callback'
    bigReq.headers = {}
    bigReq.destroy = () => undefined
    void callback.handler(bigReq, big)
    queueMicrotask(() => {
      bigReq.emit('data', 'x'.repeat(128 * 1024))
      bigReq.emit('end')
    })
    await flush()
    await flush()
    expect(big.statusCode).toBe(302)
  })

  it('coalesces duplicate form fields in the POST callback', async () => {
    const { web, booted } = await bootPlugin()
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, loginRes)
    await flush()
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!
    const res = fakeResponse()
    const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> }
    req.method = 'POST'
    req.url = '/api/collab/auth/callback'
    req.headers = {}
    void callback.handler(req, res)
    queueMicrotask(() => {
      req.emit('data', `code=abc&state=${state}&code=second`)
      req.emit('end')
    })
    await flush()
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.cookieHeader).toMatch(/^dsh_collab_session=/)
    await booted.dispose()
  })

  it('handles a request without a URL on the login route', async () => {
    const { web } = await bootPlugin()
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'GET', headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toMatch(/^https:\/\/accounts\.google\.test\/auth\?state=/)
  })

  it('directs a failed provider entry to the sign-in failure page', async () => {
    const loginFails: OidcGateway = {
      issuer: 'https://accounts.google.test',
      authorizationUrl: async () => { throw new Error('login down') },
      userFromCallback: async () => { throw new Error('unused') },
    }
    const { web } = await bootPlugin({ gateway: loginFails })
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toBe('/?collab=signin-failed')
  })

  it('logs a bare non-Error from a failed provider entry', async () => {
    const loginFailsBare: OidcGateway = {
      issuer: 'https://accounts.google.test',
      authorizationUrl: async () => { throw 'login down' },
      userFromCallback: async () => { throw new Error('unused') },
    }
    const { web } = await bootPlugin({ gateway: loginFailsBare })
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const res = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toBe('/?collab=signin-failed')
  })

  it('refuses a callback whose token exchange rejects with a bare value', async () => {
    const callbackFails: OidcGateway = {
      issuer: 'https://accounts.google.test',
      authorizationUrl: async (state, nonce) => `https://accounts.google.test/auth?state=${state}&nonce=${nonce}`,
      userFromCallback: async () => { throw 'network down' },
    }
    const { web } = await bootPlugin({ gateway: callbackFails })
    const login = web.routes.find(route => route.path === COLLAB_AUTH_LOGIN_PATH)!
    const loginRes = fakeResponse()
    void login.handler({ method: 'GET', url: COLLAB_AUTH_LOGIN_PATH, headers: {} }, loginRes)
    await flush()
    const state = new URL(loginRes.locationHeader).searchParams.get('state')!
    const callback = web.routes.find(route => route.path === '/api/collab/auth/callback')!
    const res = fakeResponse()
    void callback.handler({ method: 'GET', url: `/api/collab/auth/callback?code=abc&state=${state}`, headers: {} }, res)
    await flush()
    expect(res.statusCode).toBe(302)
    expect(res.locationHeader).toBe('/?collab=signin-failed')
    expect(res.cookieHeader).toMatch(/^dsh_collab_session=;/)
  })
})

describe('collab workspace access gate', () => {
  it('allows members, denies non-members and principals without a userId, and always allows outside the boundary', async () => {
    const boot = await bootServices()
    const gate = createCollabWorkspaceAccess(boot.ctx)
    const created = value(await call(boot, boot.admin, 'collab/workspace.create', { name: 'Team' })) as CollabWorkspaceView
    const dir = workspaceDataDir(boot.ctx.collabWorkspaces.root, created.id)
    const invitation = value(await call(boot, boot.admin, 'collab/workspace.invite', {
      workspaceId: created.id,
      email: boot.member.email,
    })) as { id: string }
    value(await call(boot, boot.member, 'collab/workspace.join', { invitationId: invitation.id }))

    // Every member of the collab workspace may see and use its data directory,
    // at the exact root and at any deeper path beneath it.
    expect(gate.allow(boot.admin, dir)).toBe(true)
    expect(gate.allow(boot.member, dir)).toBe(true)
    expect(gate.allow(boot.member, join(dir, 'session-1', 'messages.jsonl'))).toBe(true)
    // A principal that belongs to no collab workspace is denied inside the
    // boundary regardless of path depth, and a missing userId resolves to no.
    const stranger = { userId: 'no-such-user', email: 'ghost@example.com', globalRole: 'member' as const }
    expect(gate.allow(stranger, dir)).toBe(false)
    expect(gate.allow(stranger, join(dir, 'sub'))).toBe(false)
    const noUserId = { userId: undefined, email: 'ghost@example.com', globalRole: 'member' as const }
    expect(gate.allow(noUserId, dir)).toBe(false)
    // Paths outside the collab workspaces boundary are Host-owned and allowed
    // for every authenticated principal.
    expect(gate.allow(stranger, join(boot.root, 'plain-workspace'))).toBe(true)
    // The root is reported in canonical (realpath-resolved) form.
    expect(gate.collabRoot).toBe(realpathSync.native(boot.ctx.collabWorkspaces.root))
  })

  it('falls back to the raw root while it is not yet present on disk', () => {
    const absent = join(mkdtempSync(join(tmpdir(), 'dsh-collab-gate-')), 'absent')
    const gate = createCollabWorkspaceAccess({
      collabWorkspaces: { root: absent, memberOf: () => undefined, workspaceHolding: () => undefined },
    } as unknown as Context)
    expect(gate.collabRoot).toBe(absent)
    expect(gate.allow({ userId: 'u', email: 'e', globalRole: 'member' as const }, join(absent, 'workspaces', 'beta', 'f'))).toBe(false)
    expect(gate.allow({ userId: 'u', email: 'e', globalRole: 'member' as const }, join(absent, '..', 'elsewhere'))).toBe(true)
  })

  it('scopes a repo-backed workspace cloned outside the data root to its members', async () => {
    const boot = await bootServices()
    // A record whose clone lives under a separate clone root (as the settings-
    // configured clone directory would place it) resolves through the records,
    // not the default `<root>/workspaces` layout.
    const clonePath = join(boot.root, 'clones', 'repo-ws')
    await boot.ctx.collabWorkspaces.create('member', UserId(boot.member.userId), 'Product', {
      id: WorkspaceId('repo-ws'),
      repoUrl: 'https://github.com/example/product.git',
      clonePath,
    })
    const gate = createCollabWorkspaceAccess(boot.ctx)
    expect(gate.allow(boot.member, clonePath)).toBe(true)
    expect(gate.allow(boot.member, join(clonePath, 'src', 'index.ts'))).toBe(true)
    const stranger = { userId: 'no-such-user', email: 'ghost@example.com', globalRole: 'member' as const }
    expect(gate.allow(stranger, clonePath)).toBe(false)
    // Paths outside every collab clone stay Host-owned.
    expect(gate.allow(stranger, join(boot.root, 'plain-workspace'))).toBe(true)
  })
})
