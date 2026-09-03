import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitCommandRunner } from '../src/clone.ts'
import { gitStateOf } from '../src/repo-state.ts'

/** Create a scratch git repository with one committed file, returning its path. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-state-'))
  const git = (args: string[]): string => String(execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }))
  git(['init', '-q'])
  git(['config', 'user.email', 'state-test@example.dev'])
  git(['config', 'user.name', 'state test'])
  writeFileSync(join(dir, 'file.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  return dir
}

const cleanup = (dir: string): void => { rmSync(dir, { recursive: true, force: true }) }

describe('gitStateOf', () => {
  it('reports a clean checkout with its branch and abbreviated HEAD', async () => {
    const dir = makeRepo()
    try {
      const state = await gitStateOf(dir)
      const branch = String(execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })).trim()
      const sha = String(execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { stdio: 'pipe' })).trim()
      expect(state).toEqual({ branch, sha, dirty: false })
    } finally { cleanup(dir) }
  })

  it('marks a working tree with modified or untracked files dirty', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'two\n')
      expect((await gitStateOf(dir))?.dirty).toBe(true)
      writeFileSync(join(dir, 'file.txt'), 'one\n')
      writeFileSync(join(dir, 'untracked.txt'), 'new\n')
      expect((await gitStateOf(dir))?.dirty).toBe(true)
    } finally { cleanup(dir) }
  })

  it('reports absence for a missing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-state-missing-'))
    try {
      expect(await gitStateOf(join(dir, 'nope'))).toBeUndefined()
    } finally { cleanup(dir) }
  })

  it('reports absence for a directory that is not a git checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-git-state-plain-'))
    try {
      expect(await gitStateOf(dir)).toBeUndefined()
    } finally { cleanup(dir) }
  })

  it('issues the three reads through the injected runner and absorbs a failing read', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const runner: GitCommandRunner = async (command, args) => {
      calls.push({ command, args })
      if (args.includes('status')) throw new Error('status exploded')
      return { stdout: 'branch\n', stderr: '' }
    }
    expect(await gitStateOf('/clone/path', runner)).toBeUndefined()
    expect(calls.map(call => call.args.join(' '))).toEqual([
      '-C /clone/path rev-parse --abbrev-ref HEAD',
      '-C /clone/path rev-parse --short HEAD',
      '-C /clone/path status --porcelain',
    ])
  })

  it('treats an unreadable HEAD as absent', async () => {
    const runner: GitCommandRunner = async () => ({ stdout: '', stderr: '' })
    expect(await gitStateOf('/clone/path', runner)).toBeUndefined()
  })
})
