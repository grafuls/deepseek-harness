import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitCommandRunner } from '../src/clone.ts'
import {
  CollabCredentialUnavailableError,
  CollabPushRejectedError,
  pushLinks,
  pushWorkspaceBranch,
  resolvePushState,
} from '../src/push.ts'

/** Run one `git` command and return trimmed stdout, or false on non-zero exit. */
function gitOut(dir: string, args: string[]): string | false {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  } catch {
    return false
  }
}

/** Like {@link gitOut} but throws instead of folding a git failure into false. */
function mustOut(dir: string, args: string[]): string {
  const out = gitOut(dir, args)
  if (out === false) throw new Error(`git ${args.join(' ')} failed`)
  return out
}

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Create and commit one file in `dir` on the given branch name. */
function initRepo(dir: string, branch: string): void {
  execFileSync('git', ['init', '-b', branch, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  git(dir, ['config', 'user.name', 'Tester'])
  git(dir, ['config', 'user.email', 'tester@example.com'])
  writeFileSync(join(dir, 'file.txt'), 'one\n')
  git(dir, ['add', 'file.txt'])
  git(dir, ['commit', '-m', 'seed'])
}

/**
 * A seed repo pushed into a bare remote, from which `work` is cloned, so the
 * clone carries a real `origin/HEAD` (the mainline branch) and a writable
 * local-transport origin. The whole fixture lives under one temp root that the
 * caller removes with {@link removeFixture}.
 */
async function makeTrackedRemote(): Promise<{ root: string; bare: string; work: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-push-'))
  const bare = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: ['ignore', 'pipe', 'pipe'] })
  initRepo(seed, 'main')
  git(seed, ['remote', 'add', 'origin', bare])
  git(seed, ['push', '-u', 'origin', 'main'])
  execFileSync('git', ['clone', bare, work], { stdio: ['ignore', 'pipe', 'pipe'] })
  git(work, ['config', 'user.name', 'Worker'])
  git(work, ['config', 'user.email', 'worker@example.com'])
  return { root, bare, work }
}

function removeFixture(fixture: { root: string }): Promise<void> {
  return rm(fixture.root, { recursive: true, force: true })
}

/**
 * A fake runner that answers git calls from a command table and records every
 * argv plus the push/fetch env, so the credential, fetch, and identity
 * plumbing is assertable. Keys are the argv after `-C <path>` joined with
 * spaces (`remote get-url origin`, `rev-parse refs/remotes/origin/topic`, …);
 * `merge-base` resolves unless the `reject-ff` flag is set, and a missing key
 * answers empty stdout.
 */
function fakeRunner(table: Record<string, string>, rejectFf = false): {
  runner: GitCommandRunner
  calls: string[][]
  envOf: () => NodeJS.ProcessEnv | undefined
} {
  const calls: string[][] = []
  let env: NodeJS.ProcessEnv | undefined
  let revCount = 0
  const runner: GitCommandRunner = async (_command, args, _signal, extraEnv) => {
    calls.push([...args])
    const key = args.slice(2).join(' ')
    if (key === 'push origin topic:refs/heads/topic') {
      env = extraEnv
      return { stdout: '', stderr: '' }
    }
    if (key === 'fetch origin topic') {
      return { stdout: '', stderr: '' }
    }
    if (key.startsWith('rev-list --count')) {
      revCount += 1
      return { stdout: revCount === 1 ? table['rev-ahead'] ?? '1' : table['rev-behind'] ?? '0', stderr: '' }
    }
    if (key.startsWith('merge-base --is-ancestor')) {
      if (rejectFf) throw new Error('not-an-ancestor')
      return { stdout: '', stderr: '' }
    }
    if (key === 'symbolic-ref --short refs/remotes/origin/HEAD' && table['symbolic-ref-throw'] === '1') {
      throw new Error('no origin HEAD')
    }
    return { stdout: table[key] ?? '', stderr: '' }
  }
  return { runner, calls, envOf: () => env }
}

/** A second checkout of the bare remote that pushes a divergent same-named branch. */
async function pushDivergent(bare: string): Promise<string> {
  const other = `${bare}.other`
  execFileSync('git', ['clone', bare, other], { stdio: ['ignore', 'pipe', 'pipe'] })
  git(other, ['config', 'user.name', 'Other'])
  git(other, ['config', 'user.email', 'other@example.com'])
  git(other, ['switch', '-c', 'feature-c'])
  git(other, ['commit', '--allow-empty', '-m', 'moved'])
  git(other, ['push', '-u', 'origin', 'feature-c'])
  return mustOut(other, ['rev-parse', 'HEAD'])
}

describe('pushLinks', () => {
  it('builds compare and PR links for an HTTPS origin with a known base', () => {
    expect(pushLinks('https://github.com/acme/repo.git', 'main', 'feature/x')).toEqual({
      compareUrl: 'https://github.com/acme/repo/compare/main...feature/x',
      prUrl: 'https://github.com/acme/repo/pull/new/feature/x',
    })
  })

  it('returns no links for a non-HTTPS origin', () => {
    expect(pushLinks('ssh://git@github.com/acme/repo.git', 'main', 'fix')).toEqual({})
  })

  it('returns no links when the base is unknown', () => {
    expect(pushLinks('https://github.com/acme/repo.git', '', 'fix')).toEqual({})
  })

  it('returns no links for an unparsable origin', () => {
    expect(pushLinks('not a url at all', 'main', 'fix')).toEqual({})
  })
})

describe('pushWorkspaceBranch over a real local-transport remote', () => {
  it('first-pushes a new session branch (no upstream yet)', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'feature-a'])
      const localSha = mustOut(fixture.work, ['rev-parse', 'HEAD'])
      const result = await pushWorkspaceBranch(fixture.work, 'feature-a')
      expect(result).toEqual(expect.objectContaining({
        pushed: true,
        upToDate: false,
        branch: 'feature-a',
        base: 'main',
        localSha,
        remoteSha: localSha,
      }))
      expect(result.remote).toBe(fixture.bare)
      // A local-transport origin has no https links.
      expect('compareUrl' in result).toBe(false)
      expect(gitOut(fixture.bare, ['rev-parse', 'refs/heads/feature-a'])).toBe(localSha)
    } finally { await removeFixture(fixture) }
  })

  it('fast-forwards an already-pushed branch and reports ahead/behind', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'feature-b'])
      await pushWorkspaceBranch(fixture.work, 'feature-b')
      git(fixture.work, ['commit', '--allow-empty', '-m', 'second'])
      const tip = mustOut(fixture.work, ['rev-parse', 'HEAD'])
      const result = await pushWorkspaceBranch(fixture.work, 'feature-b')
      expect(result).toEqual(expect.objectContaining({ pushed: true, upToDate: false, branch: 'feature-b', ahead: 1, behind: 0 }))
      expect(result.remoteSha).toBe(tip)
      expect(gitOut(fixture.bare, ['rev-parse', 'refs/heads/feature-b'])).toBe(tip)
    } finally { await removeFixture(fixture) }
  })

  it('reports an already up-to-date branch without pushing', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'done'])
      await pushWorkspaceBranch(fixture.work, 'done')
      const tip = mustOut(fixture.work, ['rev-parse', 'HEAD'])
      const result = await pushWorkspaceBranch(fixture.work, 'done')
      expect(result).toEqual(expect.objectContaining({ pushed: false, upToDate: true, localSha: tip, remoteSha: tip }))
      expect(result.ahead).toBe(0)
    } finally { await removeFixture(fixture) }
  })

  it('dry-run reports the resolution without touching the remote', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'planned'])
      const tip = mustOut(fixture.work, ['rev-parse', 'HEAD'])
      const result = await pushWorkspaceBranch(fixture.work, 'planned', { dryRun: true })
      expect(result).toEqual(expect.objectContaining({ pushed: false, upToDate: false, branch: 'planned', localSha: tip, remoteSha: undefined }))
      expect(gitOut(fixture.bare, ['rev-parse', 'refs/heads/planned'])).toBe(false)
    } finally { await removeFixture(fixture) }
  })

  it('refuses a push when the remote branch moved off the local base', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'feature-c'])
      await pushWorkspaceBranch(fixture.work, 'feature-c')
      const moved = await pushDivergent(fixture.bare)
      git(fixture.work, ['commit', '--allow-empty', '-m', 'divergent'])
      const diverged = mustOut(fixture.work, ['rev-parse', 'HEAD'])
      const rejected = await pushWorkspaceBranch(fixture.work, 'feature-c').then(
        () => null,
        (caught: unknown) => caught,
      )
      expect(rejected).toBeInstanceOf(CollabPushRejectedError)
      expect(rejected).toMatchObject({ remoteSha: moved })
      expect(moved).not.toBe(diverged)
      // The remote stayed at the other clone's commit, untouched by the refusal.
      expect(gitOut(fixture.bare, ['rev-parse', 'refs/heads/feature-c'])).toBe(moved)
    } finally { await removeFixture(fixture) }
  })

  it('asserts the collab user identity into the clone before a real push', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'attributed'])
      await pushWorkspaceBranch(fixture.work, 'attributed', { identity: { name: 'Ada Lovelace', email: 'ada@example.com' } })
      expect(gitOut(fixture.work, ['config', 'user.name'])).toBe('Ada Lovelace')
      expect(gitOut(fixture.work, ['config', 'user.email'])).toBe('ada@example.com')
    } finally { await removeFixture(fixture) }
  })

  it('leaves the clone identity untouched when no identity is provided', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'anon'])
      const before = gitOut(fixture.work, ['config', 'user.name'])
      await pushWorkspaceBranch(fixture.work, 'anon', { identity: {} })
      expect(gitOut(fixture.work, ['config', 'user.name'])).toBe(before)
    } finally { await removeFixture(fixture) }
  })
})

describe('pushWorkspaceBranch credential and runner plumbing', () => {
  it('sends the credential only to its pinned host and cleans the temp config after', async () => {
    const { runner, calls, envOf } = fakeRunner({
      'remote get-url origin': 'https://github.com/acme/repo.git',
      'rev-parse refs/heads/topic': 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead',
      'ls-remote origin refs/heads/topic': 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0\trefs/heads/topic',
      'rev-parse refs/remotes/origin/topic': 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0',
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    })
    const result = await pushWorkspaceBranch('/clone', 'topic', {
      runner,
      credentials: { host: 'github.com', username: 'machine', token: 'ghp_secret' },
      identity: { name: 'Ada', email: 'ada@example.com' },
    })
    expect(result).toEqual(expect.objectContaining({
      pushed: true,
      branch: 'topic',
      base: 'main',
      compareUrl: 'https://github.com/acme/repo/compare/main...topic',
      prUrl: 'https://github.com/acme/repo/pull/new/topic',
    }))
    expect(calls.some(args => args.includes('config') && args.includes('user.name') && args.includes('Ada'))).toBe(true)
    expect(calls.some(args => args.includes('config') && args.includes('user.email') && args.includes('ada@example.com'))).toBe(true)
    // The fetch and the push both ran under the host-scoped credential config.
    expect(calls.some(args => args[2] === 'fetch')).toBe(true)
    const env = envOf()
    expect(env?.GIT_CONFIG_GLOBAL).toBeDefined()
    // The temporary host-scoped credential config lived only for the invocation.
    expect(existsSync(env?.GIT_CONFIG_GLOBAL ?? '')).toBe(false)
  })

  it('refuses an HTTPS origin with no matching server credential', async () => {
    const { runner } = fakeRunner({
      'remote get-url origin': 'https://gitlab.example.com/acme/repo.git',
      'rev-parse refs/heads/topic': 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead',
    })
    const error = await pushWorkspaceBranch('/clone', 'topic', { runner }).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(CollabCredentialUnavailableError)
    expect(error).toMatchObject({ host: 'gitlab.example.com' })
  })

  it('refuses an HTTPS origin whose credential is pinned to another host', async () => {
    const { runner } = fakeRunner({
      'remote get-url origin': 'https://github.com/acme/repo.git',
      'rev-parse refs/heads/topic': 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead',
    })
    await expect(
      pushWorkspaceBranch('/clone', 'topic', { runner, credentials: { host: 'gitlab.example.com', username: 'm', token: 't' } }),
    ).rejects.toBeInstanceOf(CollabCredentialUnavailableError)
  })

  it('omits the compare links when the clone cannot name its mainline branch', async () => {
    const { runner } = fakeRunner({
      'remote get-url origin': 'https://github.com/acme/repo.git',
      'rev-parse refs/heads/topic': 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead',
      'ls-remote origin refs/heads/topic': 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0\trefs/heads/topic',
      'rev-parse refs/remotes/origin/topic': 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0',
      'symbolic-ref-throw': '1',
    })
    const result = await pushWorkspaceBranch('/clone', 'topic', {
      runner,
      credentials: { host: 'github.com', username: 'm', token: 't' },
    })
    expect(result.base).toBe('')
    expect('compareUrl' in result).toBe(false)
    expect(result.pushed).toBe(true)
  })

  it('throws the git diagnostic when the push itself fails, then recovers', async () => {
    let failPush = true
    const { runner, calls } = fakeRunner({
      'remote get-url origin': 'https://github.com/acme/repo.git',
      'rev-parse refs/heads/topic': 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead',
      'ls-remote origin refs/heads/topic': 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0\trefs/heads/topic',
      'rev-parse refs/remotes/origin/topic': 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0',
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    })
    const throwing: GitCommandRunner = async (_command, args, signal, extraEnv) => {
      if (args[2] === 'push' && failPush) throw new Error('remote hung up unexpectedly')
      return runner(_command, args, signal, extraEnv)
    }
    await expect(
      pushWorkspaceBranch('/clone', 'topic', { runner: throwing, credentials: { host: 'github.com', username: 'm', token: 't' } }),
    ).rejects.toThrow('remote hung up unexpectedly')
    failPush = false
    const second = await pushWorkspaceBranch('/clone', 'topic', { runner: throwing, credentials: { host: 'github.com', username: 'm', token: 't' } })
    expect(second.pushed).toBe(true)
    expect(calls.some(args => args[2] === 'push')).toBe(true)
  })
  it('treats a vanishing remote tip as a never-pushed branch', async () => {
    // ls-remote advertises the branch but the post-fetch local rev-parse comes
    // back empty (the branch vanished on the remote); the push proceeds as if
    // it had no upstream.
    const { runner } = fakeRunner({
      'remote get-url origin': 'https://github.com/acme/repo.git',
      'rev-parse refs/heads/topic': 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead',
      'ls-remote origin refs/heads/topic': 'f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0\trefs/heads/topic',
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    })
    const result = await pushWorkspaceBranch('/clone', 'topic', {
      runner,
      credentials: { host: 'github.com', username: 'm', token: 't' },
    })
    expect(result).toEqual(expect.objectContaining({ pushed: true, remoteSha: 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead', ahead: undefined, behind: undefined }))
  })

  it('honours a caller cancellation signal across the whole push', async () => {
    const controller = new AbortController()
    const { runner } = fakeRunner({
      'remote get-url origin': 'https://github.com/acme/repo.git',
      'rev-parse refs/heads/topic': 'g2deadbeefg2deadbeefg2deadbeefg2deadbeefg2dead',
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    })
    const result = await pushWorkspaceBranch('/clone', 'topic', {
      runner,
      signal: controller.signal,
      credentials: { host: 'github.com', username: 'm', token: 't' },
    })
    expect(result.pushed).toBe(true)
  })
})

describe('resolvePushState', () => {
  it('reads the live remote tip and mainline branch for an already-pushed branch', async () => {
    const fixture = await makeTrackedRemote()
    try {
      const state = await resolvePushState(fixture.work, 'main')
      const tip = mustOut(fixture.work, ['rev-parse', 'refs/heads/main'])
      expect(state).toEqual(expect.objectContaining({ base: 'main', remoteSha: tip, ahead: 0, behind: 0 }))
      expect(state.remote).toBe(fixture.bare)
    } finally { await removeFixture(fixture) }
  })

  it('leaves ahead/behind undefined when the branch has no upstream yet', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'fresh'])
      const state = await resolvePushState(fixture.work, 'fresh')
      expect(state).toEqual(expect.objectContaining({ base: 'main', remoteSha: undefined, ahead: undefined, behind: undefined }))
    } finally { await removeFixture(fixture) }
  })
})
