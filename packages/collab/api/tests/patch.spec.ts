import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitCommandRunner } from '../src/clone.ts'
import { CollabPatchBaseError, diffWorkspaceBranch } from '../src/patch.ts'

/** Run `git` in `dir`, throwing on a non-zero exit (fixture setup). */
function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * A seed repo pushed into a bare remote, from which `work` is cloned, so the
 * clone carries a real `origin/HEAD` (the mainline branch) and a writable
 * local-transport origin. The caller removes the whole temp root.
 */
async function makeTrackedRemote(): Promise<{ root: string; bare: string; work: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patch-'))
  const bare = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: ['ignore', 'pipe', 'pipe'] })
  git(seed, ['config', 'user.name', 'Seed'])
  git(seed, ['config', 'user.email', 'seed@example.com'])
  writeFileSync(join(seed, 'file.txt'), 'one\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'seed'])
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

/** A fake runner answering from a command table and recording every argv. */
function fakeRunner(table: Record<string, string>): { runner: GitCommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: GitCommandRunner = async (_command, args, _signal) => {
    calls.push([...args])
    const key = args.slice(2).join(' ')
    return { stdout: table[key] ?? '', stderr: '' }
  }
  return { runner, calls }
}

describe('diffWorkspaceBranch over a real local-transport remote', () => {
  it('produces the branch diff against the mainline base', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'feature'])
      writeFileSync(join(fixture.work, 'file.txt'), 'one\ntwo\n')
      git(fixture.work, ['add', '.'])
      git(fixture.work, ['commit', '-m', 'add two'])
      const result = await diffWorkspaceBranch(fixture.work, 'feature')
      expect(result.branch).toBe('feature')
      expect(result.base).toBe('main')
      expect(result.filename).toBe('feature.patch')
      expect(result.patch).toContain('diff --git a/file.txt b/file.txt')
      expect(result.patch).toContain('+two')
    } finally { await removeFixture(fixture) }
  })

  it('sanitizes a forward-slash branch into a single-file patch name', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'topic/thing'])
      const result = await diffWorkspaceBranch(fixture.work, 'topic/thing')
      expect(result.filename).toBe('topic-thing.patch')
    } finally { await removeFixture(fixture) }
  })

  it('emits an empty patch for a branch with no divergence from the base', async () => {
    const fixture = await makeTrackedRemote()
    try {
      git(fixture.work, ['switch', '-c', 'same'])
      const result = await diffWorkspaceBranch(fixture.work, 'same')
      expect(result.patch).toBe('')
      expect(result.filename).toBe('same.patch')
    } finally { await removeFixture(fixture) }
  })

  it('includes the working-tree diff when the branch is the clone checkout', async () => {
    const fixture = await makeTrackedRemote()
    try {
      // A session holding the checkout has its work as uncommitted edits.
      git(fixture.work, ['switch', '-c', 'working'])
      writeFileSync(join(fixture.work, 'file.txt'), 'one\ntwo\n')
      const result = await diffWorkspaceBranch(fixture.work, 'working')
      expect(result.patch).toContain('diff --git a/file.txt b/file.txt')
      expect(result.patch).toContain('+two')
    } finally { await removeFixture(fixture) }
  })

  it('does not leak the working-tree diff onto a non-checkout branch', async () => {
    const fixture = await makeTrackedRemote()
    try {
      // The checkout holds uncommitted edits on `active`, but the request is
      // for a different branch, so those edits must not appear in its patch.
      git(fixture.work, ['switch', '-c', 'active'])
      writeFileSync(join(fixture.work, 'file.txt'), 'one\ntwo\n')
      git(fixture.work, ['branch', 'inactive'])
      const result = await diffWorkspaceBranch(fixture.work, 'inactive')
      expect(result.patch).toBe('')
    } finally { await removeFixture(fixture) }
  })
})

describe('diffWorkspaceBranch with a fake runner', () => {
  it('defaults to the real git runner and passes the three-dot diff spec', async () => {
    const { runner, calls } = fakeRunner({ 'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main' })
    const result = await diffWorkspaceBranch('/clone', 'feature', runner)
    expect(result.base).toBe('main')
    expect(result.branch).toBe('feature')
    expect(calls).toContainEqual(['-C', '/clone', 'diff', '--no-ext-diff', '--no-color', '--binary', 'refs/remotes/origin/main...feature'])
  })

  it('raises CollabPatchBaseError when origin/HEAD does not resolve', async () => {
    const { runner } = fakeRunner({})
    await expect(diffWorkspaceBranch('/clone', 'feature', runner)).rejects.toBeInstanceOf(CollabPatchBaseError)
  })
})
