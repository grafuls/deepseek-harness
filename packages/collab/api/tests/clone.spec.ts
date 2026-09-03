/**
 * cloneRepository and the no-shell git clone runner: the
 * success, failure-cleanup, and diagnostic-folding behavior, against an
 * injected fake command runner so no network is involved. The production
 * runner the dispatch uses (`gitCloneRunner`) is additionally probed with a
 * real local `git` over `file://` URLs: a fast success and a fast, clean
 * failure — never a credential prompt, which the runner is hardened against.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import {
  CLONE_REPO_PREFIX_MAX,
  cloneDirectoryName,
  cloneRepository,
  gitCloneRunner,
  repoHostOf,
} from '../src/clone.ts'

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
  it('runs `git clone` into the target and leaves a pre-existing target alone on success', async () => {    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    await mkdir(target, { recursive: true })
    const runner = vi.fn<NativeCommandRunner>(async () => ({ stdout: '', stderr: '' }))
    await cloneRepository('https://github.com/example/product.git', target, runner)
    expect(runner).toHaveBeenCalledWith(
      'git',
      ['clone', 'https://github.com/example/product.git', target],
      expect.any(AbortSignal),
      undefined,
    )
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  it('passes the configured depth as `--depth` for a shallow clone', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    await mkdir(target, { recursive: true })
    const runner = vi.fn<NativeCommandRunner>(async () => ({ stdout: '', stderr: '' }))
    await cloneRepository('https://github.com/example/product.git', target, runner, undefined, undefined, 5)
    expect(runner).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth', '5', 'https://github.com/example/product.git', target],
      expect.any(AbortSignal),
      undefined,
    )
  })

  it('runs a full clone for an unset or invalid depth', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    await mkdir(target, { recursive: true })
    const runner = vi.fn<NativeCommandRunner>(async () => ({ stdout: '', stderr: '' }))
    await cloneRepository('https://github.com/example/product.git', target, runner, undefined, undefined, 0)
    expect(runner).toHaveBeenCalledWith(
      'git',
      ['clone', 'https://github.com/example/product.git', target],
      expect.any(AbortSignal),
      undefined,
    )
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

describe('cloneRepository credentials', () => {
  it('passes a host-scoped Authorization config through env for a matching host and cleans it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    const contents: string[] = []
    let configPath: string | undefined
    const runner = async (
      _command: string,
      _args: readonly string[],
      _signal: AbortSignal,
      env?: NodeJS.ProcessEnv,
    ): Promise<{ stdout: string; stderr: string }> => {
      configPath = env?.GIT_CONFIG_GLOBAL
      contents.push(await readFile(configPath!, 'utf8'))
      return { stdout: '', stderr: '' }
    }
    await cloneRepository('https://github.com/grafuls/private.git', target, runner, {
      host: 'github.com',
      username: 'x-access-token',
      token: 'ghp_secret',
    })
    expect(configPath).toContain('dsh-collab-git-')
    const basic = Buffer.from('x-access-token:ghp_secret', 'utf8').toString('base64')
    expect(contents[0]).toContain('[http "https://github.com/"]')
    expect(contents[0]).toContain(`extraheader = AUTHORIZATION: basic ${basic}`)
    // The temporary credential directory never outlives the clone.
    await expect(stat(configPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clones without credentials on a host mismatch or when none are configured', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    const envs: Array<NodeJS.ProcessEnv | undefined> = []
    const runner = async (
      _command: string,
      _args: readonly string[],
      _signal: AbortSignal,
      env?: NodeJS.ProcessEnv,
    ): Promise<{ stdout: string; stderr: string }> => {
      envs.push(env)
      return { stdout: '', stderr: '' }
    }
    const githubCredential = { host: 'github.com', username: 'x-access-token', token: 'ghp_secret' }
    await cloneRepository('https://gitlab.com/example/other.git', target, runner, githubCredential)
    expect(envs[0]).toBeUndefined()
    await cloneRepository('https://github.com/example/public.git', target, runner)
    expect(envs[1]).toBeUndefined()
  })

  it('cleans the temporary credential config when the clone fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-collab-clone-'))
    const target = join(root, 'repo')
    let configPath: string | undefined
    const runner = async (
      _command: string,
      _args: readonly string[],
      _signal: AbortSignal,
      env?: NodeJS.ProcessEnv,
    ): Promise<{ stdout: string; stderr: string }> => {
      configPath = env?.GIT_CONFIG_GLOBAL
      throw Object.assign(new Error('git: denied'), { stderr: 'fatal: could not read Username' })
    }
    await expect(cloneRepository('https://github.com/grafuls/private.git', target, runner, {
      host: 'github.com',
      username: 'x-access-token',
      token: 'ghp_secret',
    })).rejects.toThrow()
    await expect(stat(configPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('repoHostOf', () => {
  it('resolves the HTTPS host and ignores non-HTTPS or unparsable URLs', () => {
    expect(repoHostOf('https://github.com/grafuls/deepseek-harness.git')).toBe('github.com')
    expect(repoHostOf('git@github.com:grafuls/deepseek-harness.git')).toBe('')
    expect(repoHostOf('ssh://git@github.com/grafuls/deepseek-harness')).toBe('')
    expect(repoHostOf('file:///tmp/repo')).toBe('')
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
