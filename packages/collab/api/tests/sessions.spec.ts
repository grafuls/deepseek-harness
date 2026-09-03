import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceId, type WorkspaceRecord } from '@deepseek-ai/dsh-collab-workspaces'
import { describe, expect, it } from 'vitest'
import type { GitCommandRunner } from '../src/clone.ts'
import type { CollabWorkspacesForksLike } from '../src/sessions.ts'
import { forkCollabSessionBranch, forkSessionBranch, sessionBranchName } from '../src/sessions.ts'

/** Create a scratch git repository with one committed file, returning its path. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-session-branch-'))
  const git = (args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }) }
  git(['init', '-q'])
  git(['config', 'user.email', 'branch-test@example.dev'])
  git(['config', 'user.name', 'branch test'])
  writeFileSync(join(dir, 'file.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  return dir
}

/** Read the current branch of a checkout. */
function currentBranch(dir: string): string {
  return String(execFileSync('git', ['-C', dir, 'branch', '--show-current'], { stdio: 'pipe' })).trim()
}

describe('sessionBranchName', () => {
  it('joins the sanitized workspace name and session id', () => {
    expect(sessionBranchName('Product Team', 'sess-1')).toBe('Product-Team-sess-1')
    expect(sessionBranchName('A/B:repo', 'a1b2')).toBe('A-B-repo-a1b2')
  })

  it('falls back to a fixed word for empty or punctuation-only components', () => {
    expect(sessionBranchName('  ..-- ', '')).toBe('workspace-session')
    expect(sessionBranchName('Alpha', '---')).toBe('Alpha-session')
  })
})

describe('forkSessionBranch', () => {
  it('creates the session branch from HEAD and re-switches to the same line on re-attach', async () => {
    const dir = makeRepo()
    try {
      // First attach: the branch is created and checked out.
      expect(await forkSessionBranch(dir, 'Product-sess-1')).toBe('Product-sess-1')
      expect(currentBranch(dir)).toBe('Product-sess-1')
      // A commit lands on the session's own line.
      writeFileSync(join(dir, 'file.txt'), 'two\n')
      execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' })
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'work'], { stdio: 'pipe' })
      // Re-attach of the SAME session must not fork a second branch or reset
      // the line: the existing branch is switched back onto as-is.
      expect(await forkSessionBranch(dir, 'Product-sess-1')).toBe('Product-sess-1')
      expect(currentBranch(dir)).toBe('Product-sess-1')
      const onLine = String(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'Product-sess-1'], { stdio: 'pipe' })).trim()
      expect(onLine).toBe('2')
      // The mainline branch is untouched by the fork.
      const heads = String(execFileSync('git', ['-C', dir, 'branch'], { stdio: 'pipe' }))
      expect(heads).toContain('Product-sess-1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reports absence for a directory that is not a git checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-session-branch-plain-'))
    try {
      expect(await forkSessionBranch(dir, 'Product-sess-1')).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('uses the injected runner and reports absence when both moves fail', async () => {
    const calls: string[][] = []
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args])
      throw new Error('switch exploded')
    }
    expect(await forkSessionBranch('/clone/path', 'Product-sess-2', runner)).toBeUndefined()
    expect(calls).toEqual([
      ['-C', '/clone/path', 'switch', '-c', 'Product-sess-2'],
      ['-C', '/clone/path', 'switch', 'Product-sess-2'],
    ])
  })
})

describe('forkCollabSessionBranch', () => {
  /** A word-built workspaces seat: one record whose clone contains `base`. */
  function seat(overrides: { name: string; clonePath?: string; repoUrl?: string } | undefined): CollabWorkspacesForksLike {
    const id = WorkspaceId('ws-1')
    const record: WorkspaceRecord | undefined = overrides === undefined ? undefined : {
      id,
      name: overrides.name,
      ownerId: 'owner-1' as never,
      members: [],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      ...(overrides.clonePath === undefined ? {} : { clonePath: overrides.clonePath }),
      ...(overrides.repoUrl === undefined ? {} : { repoUrl: overrides.repoUrl }),
    }
    const self: CollabWorkspacesForksLike = {
      workspaceHolding: (path: string) => (record?.clonePath !== undefined && path.startsWith(record.clonePath) ? id : undefined),
      findById: (wanted: WorkspaceId) => (wanted === id ? record : undefined),
    }
    return self
  }

  it('forks the session branch in the settled clone that contains the working directory', async () => {
    const dir = makeRepo()
    try {
      const workspaces = seat({ name: 'Product', clonePath: dir, repoUrl: 'https://github.com/x/product.git' })
      const branch = await forkCollabSessionBranch(workspaces, { id: 'sess-9', header: { cwd: dir } })
      expect(branch).toBe('Product-sess-9')
      expect(currentBranch(dir)).toBe('Product-sess-9')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('silently skips a session outside a repo-backed workspace', async () => {
    const dir = makeRepo()
    try {
      const workspaces = seat({ name: 'Product', clonePath: join(dir, 'clone'), repoUrl: 'https://github.com/x/product.git' })
      expect(await forkCollabSessionBranch(workspaces, { id: 'sess-10', header: { cwd: '/unrelated/path' } })).toBeUndefined()
      expect(await forkCollabSessionBranch(workspaces, { id: 'sess-11', header: {} })).toBeUndefined()
      expect(await forkCollabSessionBranch(workspaces, { id: 'sess-12', header: { cwd: '   ' } })).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('silently skips a provisioning workspace and a name-only workspace', async () => {
    const dir = makeRepo()
    try {
      const cloning = seat({ name: 'Pending', repoUrl: 'https://github.com/x/pending.git' })
      expect(await forkCollabSessionBranch(cloning, { id: 'sess-13', header: { cwd: join(dir, 'x') } })).toBeUndefined()
      // A name-only workspace has no recorded clone, so holding never matches.
      expect(await forkCollabSessionBranch(cloning, { id: 'sess-14', header: { cwd: dir } })).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('silently skips when the holding workspace cannot be read back', async () => {
    const workspaces = seat({ name: 'Product', clonePath: '/clone/x', repoUrl: 'https://github.com/x/product.git' })
    const missing = { ...workspaces, findById: () => undefined }
    expect(await forkCollabSessionBranch(missing, { id: 'sess-15', header: { cwd: '/clone/x/sub' } })).toBeUndefined()
  })
})
