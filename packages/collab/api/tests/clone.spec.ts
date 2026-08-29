/**
 * cloneRepository and cloneFailureMessage: the no-shell git clone runner's
 * success, failure-cleanup, and diagnostic-folding behavior, against an
 * injected fake command runner so no network is involved. The production
 * runner the dispatch uses (`gitCloneRunner`) is additionally probed with a
 * real local `git` over `file://` URLs: a fast success and a fast, clean
 * failure — never a credential prompt, which the runner is hardened against.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { CLONE_REPO_PREFIX_MAX, cloneDirectoryName, cloneFailureMessage, cloneRepository, gitCloneRunner } from '../src/clone.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

/**
 * Create a one-commit source repository for file-backed clone probes and
 * return its absolute path (git is a declared harness dependency).
 */
async function makeSourceRepo(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'readme.md'), 'hello')
  const run = (args: string[]): string => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  run(['init', '-q'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'dsh test'])
  run(['add', 'readme.md'])
  run(['commit', '-q', '-m', 'init'])
  return source
}

describe('cloneRepository', () => {
  it('runs `git clone` into the target and leaves a pre-existing target alone on success', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    await mkdir(target, { recursive: true })
    const runner = vi.fn<NativeCommandRunner>(async () => ({ stdout: '', stderr: '' }))
    await cloneRepository('https://github.com/example/product.git', target, runner)
    expect(runner).toHaveBeenCalledWith(
      'git',
      ['clone', 'https://github.com/example/product.git', target],
      expect.any(AbortSignal),
    )
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  it('removes a partial target when the clone fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    await mkdir(target, { recursive: true })
    const runner: NativeCommandRunner = async () => {
      throw Object.assign(new Error('git: failure'), { stderr: 'fatal: repository not found' })
    }
    await expect(cloneRepository('https://github.com/example/no.git', target, runner)).rejects.toThrow()
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clones a local repository through the production runner', async () => {
    const source = await makeSourceRepo()
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    await cloneRepository(`file://${source}`, target)
    expect((await stat(join(target, 'readme.md'))).isFile()).toBe(true)
  })

  it('fails fast through the production runner and cleans the partial target', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    await expect(cloneRepository(`file://${join(root, 'missing')}`, target)).rejects.toThrow()
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('gitCloneRunner', () => {
  it('captures stdout and resolves on a zero exit', async () => {
    const { stdout } = await gitCloneRunner('echo', ['hello'], AbortSignal.timeout(5_000))
    expect(stdout.trim()).toBe('hello')
  })

  it('rejects with the spawn error when the command cannot launch', async () => {
    await expect(
      gitCloneRunner('dsh-collab-definitely-not-a-command', [], AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects with a signal reference when the child is killed', async () => {
    await expect(
      gitCloneRunner(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], AbortSignal.timeout(5_000)),
    ).rejects.toThrow(/git clone exited with code a signal/)
  })
})

describe('cloneFailureMessage', () => {
  it('prefers the process stderr and trims it', () => {
    expect(cloneFailureMessage('https://github.com/example/no.git', {
      stderr: '  fatal: could not read Username  ',
    })).toBe("failed to clone 'https://github.com/example/no.git': fatal: could not read Username")
  })

  it('falls back to the error message and then to a generic line', () => {
    expect(cloneFailureMessage('https://github.com/example/no.git', new Error('boom')))
      .toBe("failed to clone 'https://github.com/example/no.git': boom")
    expect(cloneFailureMessage('https://github.com/example/no.git', { stderr: 42 }))
      .toBe("failed to clone 'https://github.com/example/no.git': git clone failed")
  })
})

describe('cloneDirectoryName', () => {
  it('prefixes the sanitized repository name onto the workspace id', () => {
    expect(cloneDirectoryName('w1', 'https://github.com/example/product.git')).toBe('product-w1')
    // scp-like forms and query/fragment suffixes resolve to the same name.
    expect(cloneDirectoryName('w1', 'git@github.com:example/product.git')).toBe('product-w1')
    expect(cloneDirectoryName('w1', 'https://github.com/example/product.git?ref=main#go')).toBe('product-w1')
  })

  it('keeps a recognizable host prefix when the URL has no repo segment', () => {
    expect(cloneDirectoryName('w1', 'https://github.com/')).toBe('github.com-w1')
  })

  it('falls back to the workspace id when no name can be derived', () => {
    expect(cloneDirectoryName('w1', 'https://example.com/org/.git')).toBe('w1')
    expect(cloneDirectoryName('w1', '   ')).toBe('w1')
  })

  it('folds unsafe characters and trims leading/trailing dots and dashes', () => {
    expect(cloneDirectoryName('w1', 'ssh://git@example.com:2222/org/My Repo!!.git')).toBe('My-Repo-w1')
    expect(cloneDirectoryName('w1', 'https://example.com/org/..hidden..')).toBe('hidden-w1')
  })

  it('caps an over-long repository name against the filesystem limit', () => {
    const long = `https://example.com/org/${'a'.repeat(200)}.git`
    expect(cloneDirectoryName('w1', long)).toBe(`${'a'.repeat(CLONE_REPO_PREFIX_MAX)}-w1`)
  })
})
