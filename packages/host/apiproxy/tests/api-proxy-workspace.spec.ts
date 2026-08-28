import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { HostFrame, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`workspace-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextHostFrame(
  stream: AsyncIterator<RpcRequest<HostFrame>>,
): Promise<RpcRequest<HostFrame>> {
  const next = await stream.next()
  if (next.done === true) throw new Error('Host stream ended before the expected increment')
  return next.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services. */
async function harness(
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-'))),
  picker: DirectoryPickerCapability = { kind: 'native', pick: async () => null },
  extras: {
    openPath?: (path: string, signal: AbortSignal) => Promise<void>
    canOpenPath?: () => boolean
  } = {},
) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  // Structural picker fake: the gateway only reads capability(); a stable
  // object per harness mirrors the seam's stability contract.
  ctx.provide('directoryPicker', { capability: () => picker } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
    ...extras.openPath === undefined ? {} : { openPath: extras.openPath },
    ...extras.canOpenPath === undefined ? {} : { canOpenPath: extras.canOpenPath },
  })
  return { api, ctx, storageDomain, root }
}

/** Stage one directory under the harness root for path adoption. */
function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path)
  return path
}

describe('host.pickDirectory', () => {
  it('returns a selected path or explicit cancellation from the native capability', async () => {
    const selected = await harness(undefined, { kind: 'native', pick: async () => '/tmp/project' })
    expect((await selected.api.host.pickDirectory(request({}), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { path: '/tmp/project' } })

    const cancelled = await harness(undefined, { kind: 'native', pick: async () => null })
    expect((await cancelled.api.host.pickDirectory(request({}), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { path: null } })
  })

  it('propagates abort into the native capability as a cancelled RPC error', async () => {
    const { api } = await harness(undefined, {
      kind: 'native',
      pick: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = api.host.pickDirectory(request({}), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('folds a non-abort native-chooser failure into an internal error', async () => {
    const { api } = await harness(undefined, { kind: 'native', pick: async () => { throw new Error('no chooser installed') } })
    const response = await api.host.pickDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('refuses the native RPC under a browse composition', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    const response = await api.host.pickDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'directory-picker-unavailable', details: { capability: 'browse' } },
    })
  })
})

/** Canned browse capability: one listing, one created path, typed failures on demand. */
const BROWSE_STUB: DirectoryPickerCapability = {
  kind: 'browse',
  list: async (path) => {
    if (path === '/denied') throw new DirectoryPickerError('directory-unreadable', '/denied', 'cannot list /denied')
    const target = path ?? '/home/user'
    return {
      path: target,
      home: '/home/user',
      crumbs: [{ name: '/', path: '/', hidden: false }],
      entries: [{ name: 'projects', path: `${target}/projects`, hidden: false }],
      truncated: false,
    }
  },
  createDirectory: async (path, name) => {
    if (name === 'taken') throw new DirectoryPickerError('directory-exists', `${path}/${name}`, 'already exists')
    if (name === 'unwritable') throw new Error('disk detached')
    return `${path}/${name}`
  },
}

describe('host.listDirectory / host.createDirectory', () => {
  it('serves listings and creation through the browse capability, defaulting to home', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    const home = await api.host.listDirectory(request({}), new AbortController().signal)
    expect(home.result).toMatchObject({ ok: true, value: { path: '/home/user', home: '/home/user' } })
    const listed = await api.host.listDirectory(request({ path: '/home/user/projects' }), new AbortController().signal)
    expect(listed.result).toMatchObject({ ok: true, value: { path: '/home/user/projects' } })
    const created = await api.host.createDirectory(request({ path: '/home/user', name: 'fresh' }))
    expect(created.result).toEqual({ ok: true, value: { path: '/home/user/fresh' } })
  })

  it('maps typed picker failures onto the wire error codes and folds unknown throws to internal', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    expect((await api.host.listDirectory(request({ path: '/denied' }), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'directory-unreadable', details: { path: '/denied' } },
    })
    expect((await api.host.createDirectory(request({ path: '/home/user', name: 'taken' }))).result).toMatchObject({
      ok: false, error: { code: 'directory-exists' },
    })
    expect((await api.host.createDirectory(request({ path: '/home/user', name: 'unwritable' }))).result).toMatchObject({
      ok: false, error: { code: 'internal' },
    })
  })

  it('reports an aborted listing as cancelled, like the other signal-following RPCs', async () => {
    const { api } = await harness(undefined, {
      kind: 'browse',
      list: (_path, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('scan aborted')) }, { once: true })
      }),
      createDirectory: async () => '/never',
    })
    const abort = new AbortController()
    const pending = api.host.listDirectory(request({}), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('refuses the browse RPCs under a native composition', async () => {
    const { api } = await harness()
    expect((await api.host.listDirectory(request({}), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'directory-picker-unavailable', details: { capability: 'native' } },
    })
    expect((await api.host.createDirectory(request({ path: '/x', name: 'y' }))).result).toMatchObject({
      ok: false, error: { code: 'directory-picker-unavailable', details: { capability: 'native' } },
    })
  })
})

describe('host.openPath', () => {
  it('describes whether this deployment can reach a user-visible native desktop', async () => {
    const visible = await harness(undefined, undefined, { canOpenPath: () => true })
    const headless = await harness(undefined, undefined, { canOpenPath: () => false })
    expect(expectOk(await visible.api.host.describe(request({}))).canOpenPath).toBe(true)
    expect(expectOk(await headless.api.host.describe(request({}))).canOpenPath).toBe(false)
    expect(expectOk(await visible.api.host.describe(request({}))).home).toBe(homedir())
  })

  it('opens through the injected native boundary', async () => {
    const opened: string[] = []
    const { api } = await harness(undefined, undefined, {
      openPath: async (path) => { opened.push(path) },
    })
    expect((await api.host.openPath(request({ path: '/tmp/a.txt' }), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual(['/tmp/a.txt'])
  })

  it('propagates abort into the native boundary as a cancelled RPC error', async () => {
    const { api } = await harness(undefined, undefined, {
      openPath: (_path, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = api.host.openPath(request({ path: '/tmp/a.txt' }), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})

describe('workspace.create', () => {
  it('serializes concurrent creates of one path into a single registration', async () => {
    const { api, root } = await harness()
    const target = stageDir(root, 'alpha')
    const responses = await Promise.all([
      api.workspace.create(request({ path: target })),
      api.workspace.create(request({ path: target })),
    ])
    const values = responses.map(response => expectOk(response))
    const created = values.find(value => value.created)
    const resolved = values.find(value => !value.created)

    expect(created).toMatchObject({ workspace: { path: target, title: 'alpha' } })
    expect(resolved?.workspace.workspaceId).toBe(created?.workspace.workspaceId)
    expect(expectOk(await api.workspace.list(request({}))).items).toHaveLength(1)
  })

  it('adopts only existing directories', async () => {
    const { api, root } = await harness()
    const existing = stageDir(root, 'existing')
    const first = expectOk(await api.workspace.create(request({ path: existing })))
    const repeated = expectOk(await api.workspace.create(request({ path: existing })))
    expect(first).toMatchObject({ created: true, workspace: { path: existing, title: 'existing' } })
    expect(repeated).toMatchObject({ created: false, workspace: { workspaceId: first.workspace.workspaceId } })

    expectOk(await api.workspace.rename(request({
      workspaceId: first.workspace.workspaceId,
      title: 'renamed-existing',
    })))
    const reopened = expectOk(await api.workspace.create(request({ path: existing })))
    expect(reopened.workspace.title).toBe('renamed-existing')

    const missing = join(root, 'missing')
    const missingResult = await api.workspace.create(request({ path: missing }))
    expect(missingResult.result).toMatchObject({ ok: false, error: { code: 'workspace-invalid-path' } })
    expect(existsSync(missing)).toBe(false)
  })

  it('adopts different paths that derive the same Workspace title', async () => {
    const { api, root } = await harness()
    const first = join(root, 'one', 'project')
    const second = join(root, 'two', 'project')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const firstResult = expectOk(await api.workspace.create(request({ path: first })))
    const secondResult = expectOk(await api.workspace.create(request({ path: second })))
    expect(firstResult).toMatchObject({
      created: true,
      workspace: { path: first, title: 'project' },
    })
    expect(secondResult).toMatchObject({
      created: true,
      workspace: { path: second, title: 'project' },
    })
    expect(secondResult.workspace.workspaceId).not.toBe(firstResult.workspace.workspaceId)
    expect(expectOk(await api.workspace.list(request({}))).items.map(workspace => workspace.path))
      .toEqual([second, first])
  })
})

describe('workspace.insertBefore', () => {
  it('commits the complete order, streams one order frame, and maps unknown ids', async () => {
    const { api, ctx, root } = await harness()
    const first = expectOk(await api.workspace.create(request({ path: stageDir(root, 'first') }))).workspace
    const second = expectOk(await api.workspace.create(request({ path: stageDir(root, 'second') }))).workspace
    const third = expectOk(await api.workspace.create(request({ path: stageDir(root, 'third') }))).workspace

    const abort = new AbortController()
    const listWorkspaces = vi.spyOn(ctx.workspaceRegistry, 'list')
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    const changed = nextHostFrame(stream)
    const reordered = expectOk(await api.workspace.insertBefore(request({
      workspaceId: first.workspaceId,
      beforeWorkspaceId: second.workspaceId,
    })))
    expect(reordered.workspaceIds).toEqual([third.workspaceId, first.workspaceId, second.workspaceId])
    expect(await changed).toMatchObject({
      payload: {
        type: 'host/workspace-order-changed',
        workspaceIds: [third.workspaceId, first.workspaceId, second.workspaceId],
      },
    })
    expect(expectOk(await api.workspace.list(request({}))).items.map(item => item.workspaceId))
      .toEqual(reordered.workspaceIds)

    const missingSource = await api.workspace.insertBefore(request({
      workspaceId: 'missing' as WorkspaceId,
    }))
    expect(missingSource.result).toMatchObject({
      ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'missing' } },
    })
    const missingAnchor = await api.workspace.insertBefore(request({
      workspaceId: first.workspaceId,
      beforeWorkspaceId: 'missing-anchor' as WorkspaceId,
    }))
    expect(missingAnchor.result).toMatchObject({
      ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'missing-anchor' } },
    })
    abort.abort()
  })
})

describe('session creation and Workspace membership', () => {
  it('attaches a preallocated idempotent session while cwd-only sessions stay ungrouped', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    const sessionId = SessionId('session-workspace-preallocated')

    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(ctx.agents.list().filter(agent => agent.id === sessionId)).toHaveLength(1)

    const ungrouped = SessionId('session-cwd-only')
    expectOk(await api.sessions.create(request({ cwd: workspace.path, sessionId: ungrouped })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(ungrouped)

    const conflict = await api.sessions.create(request({ cwd: join(workspace.path, 'other'), sessionId }))
    expect(conflict.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { sessionId, existingCwd: workspace.path } },
    })
    const missing = await api.sessions.create(request({
      workspaceId: 'missing-workspace' as WorkspaceId,
      sessionId: SessionId('session-missing-workspace'),
    }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })
  })

  it('retains a published session when attachment fails and repairs it on retry', async () => {
    const { api, ctx, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    const workspace = ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('workspace missing from registry')
    vi.spyOn(workspace, 'attachSession').mockRejectedValueOnce(new Error('simulated write failure'))
    const sessionId = SessionId('session-attach-retry')

    const failed = await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId }))
    expect(failed.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-attach-failed', details: { sessionId, workspaceId: created.workspaceId } },
    })
    expect(ctx.agents.get(sessionId)).toBeDefined()

    expectOk(await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
  })
})

describe('Host Workspace increments', () => {
  it('projects subagent origin in attached summaries and creation increments', async () => {
    const { api, ctx } = await harness()
    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const pending = nextHostFrame(stream)
    const childId = SessionId('session-subagent-child')

    ctx.sessions.create(childId, {
      meta: {
        cwd: '/tmp',
        parentSession: SessionId('session-parent'),
        origin: 'subagent',
      },
    })

    expect(await pending).toMatchObject({
      payload: {
        type: 'host/session-added',
        sessionId: childId,
        parentSessionId: 'session-parent',
        origin: 'subagent',
      },
    })
    expect(expectOk(await api.sessions.list(request({}))).items).toContainEqual(
      expect.objectContaining({ sessionId: childId, origin: 'subagent' }),
    )
    abort.abort()
  })

  it('streams committed Workspace and Session increments after empty baselines', async () => {
    const { api, root } = await harness()
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items).toEqual([])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const workspaceIncrement = nextHostFrame(stream)
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    expect(await workspaceIncrement).toMatchObject({
      payload: { type: 'host/workspace-changed', workspace: { workspaceId: workspace.workspaceId } },
    })

    const sessionId = SessionId('session-streamed-workspace')
    const pending = nextHostFrame(stream)
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    const increments: HostFrame[] = []
    increments.push((await pending).payload)
    while (increments.length < 2) {
      const next = await stream.next()
      if (next.done === true) throw new Error('Host stream ended before both increments')
      increments.push(next.value.payload)
    }
    expect(increments.find(increment => increment.type === 'host/session-added')).toMatchObject({
      // A just-created session has no events: the frame constantly carries blank:true.
      type: 'host/session-added', sessionId, blank: true, cwd: workspace.path,
    })
    const workspaceChanged = increments.find(
      (increment): increment is Extract<HostFrame, { type: 'host/workspace-changed' }> =>
        increment.type === 'host/workspace-changed',
    )
    expect(workspaceChanged?.workspace.sessionIds).toEqual([sessionId])
    abort.abort()
  })

  it('does not publish a Workspace whose registry-order commit fails', async () => {
    const { api, storageDomain, root } = await harness()
    const domain = storageDomain.get('workspace')
    if (domain === undefined) throw new Error('workspace domain is not open')
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('simulated registry order failure'))
    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const next = stream.next()

    const failed = await api.workspace.create(request({ path: stageDir(root, 'ghost') }))
    expect(failed.result.ok).toBe(false)
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    abort.abort()
    expect(await next).toMatchObject({ done: true })
  })

  it('deletes the registration, keeps its session and folder, and streams one removal', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'delete-me') }))).workspace
    const sessionId = SessionId('session-kept-after-workspace-delete')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const removed = nextHostFrame(stream)
    expectOk(await api.workspace.delete(request({ workspaceId: workspace.workspaceId })))
    expect(await removed).toMatchObject({
      payload: { type: 'host/workspace-removed', workspaceId: workspace.workspaceId },
    })
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(sessionId)
    expect(ctx.agents.get(sessionId)).toBeDefined()
    expect(existsSync(workspace.path)).toBe(true)

    const missing = await api.workspace.delete(request({ workspaceId: workspace.workspaceId }))
    expect(missing.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-not-found', details: { workspaceId: workspace.workspaceId } },
    })

    const reregistered = expectOk(await api.workspace.create(request({ path: workspace.path }))).workspace
    expect(reregistered.workspaceId).not.toBe(workspace.workspaceId)
    expect(reregistered.path).toBe(workspace.path)
    expect(reregistered.sessionIds).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(sessionId)
    abort.abort()
  })

  it('archives a session into the global set, keeps its accounting, and streams the set once', async () => {
    const { api, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'archive-home') }))).workspace
    const sessionId = SessionId('session-to-archive')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).archivedSessionIds).toEqual([])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const changed = nextHostFrame(stream)
    expect(expectOk(await api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])
    expect(await changed).toMatchObject({
      payload: { type: 'host/archived-sessions-changed', archivedSessionIds: [sessionId] },
    })

    // Accounting and the session itself are untouched; list re-baselines the set.
    const listed = expectOk(await api.workspace.list(request({})))
    expect(listed.archivedSessionIds).toEqual([sessionId])
    expect(listed.items[0]?.sessionIds).toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(sessionId)

    // The idempotent repeat emits no second frame: the next observed frame is
    // the workspace-changed of a later attach, not another archive snapshot.
    const after = nextHostFrame(stream)
    expect(expectOk(await api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])
    const otherSession = SessionId('session-after-archive')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId: otherSession })))
    expect((await after).payload.type).not.toBe('host/archived-sessions-changed')

    const missing = await api.workspace.archiveSession(request({ sessionId: SessionId('session-ghost') }))
    expect(missing.result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found', details: { sessionId: 'session-ghost' } },
    })
    abort.abort()
  })
})

/**
 * Frame collector over a push iterator. It keeps at most one in-flight
 * `stream.next()` alive across calls: an idle window that yields no frame
 * retains the pending read (never orphaned) so the next call reuses the same
 * iterator and no queued frame is silently lost.
 */
function frameCollector<T>(stream: AsyncIterator<RpcRequest<T>>) {
  let inflight: Promise<IteratorResult<RpcRequest<T>>> | undefined
  const take = async (idleMs: number): Promise<T | undefined> => {
    const current = inflight ?? (inflight = stream.next())
    const raced = await Promise.race([
      current.then(value => ({ value })),
      new Promise<{ idle: true }>(resolve => setTimeout(() => { resolve({ idle: true }) }, idleMs)),
    ])
    if ('idle' in raced) return undefined
    inflight = undefined
    if (raced.value.done === true) return undefined
    return raced.value.value.payload
  }
  /** Read up to `limit` frames, returning after an idle window when fewer arrive. */
  return async (limit: number, idleMs = 80): Promise<T[]> => {
    const frames: T[] = []
    for (let i = 0; i < limit; i++) {
      const frame = await take(idleMs)
      if (frame === undefined) break
      frames.push(frame)
    }
    return frames
  }
}

/**
 * The collab overlay staged over the Host plane: a membership gate plus a
 * connection carrying a switchable principal, mirroring what dsh-collab-api
 * provides to the real transport (the reactor keeps the principal in async
 * context; here a mutable service seam stands in for it).
 */
async function collabHarness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-collab-')))
  const collabRoot = stageDir(root, 'collab')
  mkdirSync(join(collabRoot, 'workspaces'), { recursive: true })
  const membership = new Map<string, Set<string>>()
  const principal: { current: unknown } = { current: undefined }
  const collabAccess = {
    collabRoot,
    allow(actor: unknown, path: string): boolean {
      const prefix = `${collabRoot}${sep}workspaces${sep}`
      if (!path.startsWith(prefix)) return true
      const wsId = path.slice(prefix.length).split(sep)[0] ?? ''
      const userId = (actor as { userId?: string } | undefined)?.userId
      if (userId === undefined) return false
      return membership.get(wsId)?.has(userId) ?? false
    },
  }
  // The gate lands after `createApiProxy` ran: the proxy reads both services
  // from the live store on every decision, so this late provide (the real
  // profile patch appends the collab row after the api-gateway row) must
  // still take effect.
  const host = await harness(root)
  const { api, ctx } = host
  ctx.provide('connection', { principal: () => principal.current } as never)
  ctx.provide('collabWorkspaceAccess', collabAccess as never)
  const withPrincipal = <T>(userId: string, run: () => T): T => {
    const previous = principal.current
    principal.current = { userId }
    try {
      return run()
    } finally {
      principal.current = previous
    }
  }
  const member = (wsId: string, ...users: string[]): void => {
    const usersSet = membership.get(wsId) ?? new Set<string>()
    for (const user of users) usersSet.add(user)
    membership.set(wsId, usersSet)
  }
  const stageCollab = (wsId: string): string => {
    const path = join(collabRoot, 'workspaces', wsId)
    mkdirSync(path, { recursive: true })
    return path
  }
  return { api, ctx, root, withPrincipal, member, stageCollab, collabRoot }
}

const sessionInFiber = (ctx: Context, sessionId: SessionId, cwd: string | undefined) =>
  ctx.plugin(Object.assign(
    (inner: Context) => {
      inner.sessions.create(sessionId, { meta: cwd === undefined ? {} : { cwd } })
    },
    { inject: ['sessions'] },
  ))

describe('collab workspace gating (multi-user host plane)', () => {
  it('serves collab-rooted workspaces only to their members', async () => {
    const h = await collabHarness()
    h.member('alpha', 'owen', 'lina')
    h.member('beta', 'owen')
    const base = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: stageDir(h.root, 'base') })))).workspace
    const alpha = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('alpha') })))).workspace
    const beta = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('beta') })))).workspace

    const lina = expectOk(await h.withPrincipal('lina', () => h.api.workspace.list(request({}))))
    expect(lina.items.map(workspace => workspace.workspaceId)).toEqual(expect.arrayContaining([
      base.workspaceId, alpha.workspaceId,
    ]))
    expect(lina.items.map(workspace => workspace.workspaceId)).not.toContain(beta.workspaceId)

    const owen = expectOk(await h.withPrincipal('owen', () => h.api.workspace.list(request({}))))
    expect(owen.items.map(workspace => workspace.workspaceId)).toEqual(expect.arrayContaining([
      base.workspaceId, alpha.workspaceId, beta.workspaceId,
    ]))
  })

  it('refuses a non-member every workspace target and session entry point', async () => {
    const h = await collabHarness()
    h.member('alpha', 'owen', 'lina')
    h.member('beta', 'owen')
    await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('alpha') })))
    const beta = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('beta') })))).workspace

    const byId = await h.withPrincipal('lina', () =>
      h.api.sessions.create(request({ workspaceId: beta.workspaceId, sessionId: SessionId('lina-to-beta') })))
    expect(byId.result).toMatchObject({
      ok: false, error: { code: 'workspace-forbidden', details: { workspaceId: beta.workspaceId } },
    })
    const byCwd = await h.withPrincipal('lina', () =>
      h.api.sessions.create(request({ cwd: beta.path, sessionId: SessionId('lina-to-beta-cwd') })))
    expect(byCwd.result).toMatchObject({
      ok: false, error: { code: 'workspace-forbidden', details: { workspaceId: 'beta' } },
    })
    const mount = await h.withPrincipal('lina', () =>
      h.api.workspace.create(request({ path: beta.path })))
    expect(mount.result).toMatchObject({
      ok: false, error: { code: 'workspace-forbidden', details: { workspaceId: 'beta' } },
    })
    const rename = await h.withPrincipal('lina', () =>
      h.api.workspace.rename(request({ workspaceId: beta.workspaceId, title: 'grabbed' })))
    expect(rename.result).toMatchObject({ ok: false, error: { code: 'workspace-forbidden' } })
    const del = await h.withPrincipal('lina', () =>
      h.api.workspace.delete(request({ workspaceId: beta.workspaceId })))
    expect(del.result).toMatchObject({ ok: false, error: { code: 'workspace-forbidden' } })
    const order = await h.withPrincipal('lina', () =>
      h.api.workspace.insertBefore(request({ workspaceId: beta.workspaceId })))
    expect(order.result).toMatchObject({ ok: false, error: { code: 'workspace-forbidden' } })
    const move = await h.withPrincipal('lina', () =>
      h.api.workspace.insertSessionBefore(request({
        workspaceId: beta.workspaceId,
        sessionId: SessionId('move-source'),
        beforeSessionId: SessionId('move-anchor'),
      })))
    expect(move.result).toMatchObject({ ok: false, error: { code: 'workspace-forbidden' } })

    const allowed = expectOk(await h.withPrincipal('owen', () =>
      h.api.sessions.create(request({ workspaceId: beta.workspaceId, sessionId: SessionId('owen-in-beta') }))))
    expect(allowed.sessionId).toBe('owen-in-beta')
  })

  it('scopes session enumeration and archived accounting to members', async () => {
    const h = await collabHarness()
    h.member('alpha', 'owen', 'lina')
    h.member('beta', 'owen')
    const alpha = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('alpha') })))).workspace
    const beta = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('beta') })))).workspace
    const linaSession = SessionId('lina-in-alpha')
    const owenSession = SessionId('owen-in-beta')
    await h.withPrincipal('lina', () =>
      h.api.sessions.create(request({ workspaceId: alpha.workspaceId, sessionId: linaSession })))
    await h.withPrincipal('owen', () =>
      h.api.sessions.create(request({ workspaceId: beta.workspaceId, sessionId: owenSession })))
    // A cwd-less session has no working directory; the gate grants it (no collab
    // boundary applies) rather than hiding an ordinary host session.
    const cwdlessFiber = await sessionInFiber(h.ctx, SessionId('session-cwd-less'), undefined)
    const linaList = expectOk(await h.withPrincipal('lina', () => h.api.sessions.list(request({}))))
    const listed = linaList.items.map(item => item.sessionId)
    expect(listed).toContain(linaSession)
    expect(listed).not.toContain(owenSession)
    expect(listed).toContain('session-cwd-less')

    // Archived ids resolve cwd through the attached session store.
    await h.withPrincipal('owen', () =>
      h.api.workspace.archiveSession(request({ sessionId: owenSession })))
    await h.withPrincipal('lina', () =>
      h.api.workspace.archiveSession(request({ sessionId: linaSession })))
    const linaArchived = expectOk(await h.withPrincipal('lina', () => h.api.workspace.list(request({}))))
    expect(linaArchived.archivedSessionIds).toContain(linaSession)
    expect(linaArchived.archivedSessionIds).not.toContain(owenSession)
    const owenArchived = expectOk(await h.withPrincipal('owen', () => h.api.workspace.list(request({}))))
    expect(owenArchived.archivedSessionIds).toContain(owenSession)
    await cwdlessFiber.dispose()
  })

  it('scopes the host stream to the connection collab visibility', async () => {
    const h = await collabHarness()
    h.member('alpha', 'owen', 'lina')
    h.member('beta', 'owen')
    h.member('gamma', 'owen')
    await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: stageDir(h.root, 'base') })))
    const alpha = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('alpha') })))).workspace
    const beta = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('beta') })))).workspace

    const abort = new AbortController()
    const stream = h.withPrincipal('lina', () =>
      h.api.events.host(request({}), abort.signal))[Symbol.asyncIterator]()
    const read = frameCollector(stream)

    // A collab workspace mounted after the stream opened for a non-member is
    // never framed; a plain host workspace at the same time IS.
    await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('gamma') })))
    expect((await read(1)).filter(frame =>
      frame.type === 'host/workspace-changed' && frame.workspace.workspaceId === 'gamma' as WorkspaceId))
      .toEqual([])
    const base2 = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: stageDir(h.root, 'base-2') })))).workspace
    expect((await read(2)).some(frame =>
      frame.type === 'host/workspace-changed' && frame.workspace.workspaceId === base2.workspaceId)).toBe(true)

    // A reorder among the viewer's visible workspaces emits a scoped order frame.
    const base = expectOk(await h.api.workspace.list(request({})))
      .items.find(item => item.title === 'base')
    expect(base).toBeDefined()
    expectOk(await h.withPrincipal('lina', () =>
      h.api.workspace.insertBefore(request({
        workspaceId: base!.workspaceId,
        beforeWorkspaceId: alpha.workspaceId,
      }))))
    const orderFrame = (await read(2)).find(frame => frame.type === 'host/workspace-order-changed')
    expect(orderFrame).toBeDefined()
    const orderedIds = (orderFrame as { workspaceIds: WorkspaceId[] }).workspaceIds
    expect(orderedIds).toContain(alpha.workspaceId)
    expect(orderedIds).toContain(base!.workspaceId)
    expect(orderedIds).not.toContain(beta.workspaceId)
    expect(orderedIds).not.toContain('gamma' as WorkspaceId)
    expect(orderedIds.indexOf(base!.workspaceId)).toBeLessThan(orderedIds.indexOf(alpha.workspaceId))

    // Session increments: the hidden collab session is skipped, the visible one framed.
    await h.withPrincipal('owen', () =>
      h.api.sessions.create(request({ workspaceId: beta.workspaceId, sessionId: SessionId('owen-hidden-beta') })))
    await h.withPrincipal('lina', () =>
      h.api.sessions.create(request({ workspaceId: alpha.workspaceId, sessionId: SessionId('lina-visible-alpha') })))
    const sessionFrames = await read(3)
    expect(sessionFrames.some(frame =>
      frame.type === 'host/session-added' && frame.sessionId === 'lina-visible-alpha'
      && frame.blank && frame.cwd === alpha.path)).toBe(true)
    expect(sessionFrames.filter(frame =>
      frame.type === 'host/session-added' && frame.sessionId === 'owen-hidden-beta')).toEqual([])

    // Status and error frames follow the same visibility rule.
    const hiddenAgent = h.ctx.agents.get(SessionId('owen-hidden-beta'))
    const visibleAgent = h.ctx.agents.get(SessionId('lina-visible-alpha'))
    expect(hiddenAgent).toBeDefined()
    expect(visibleAgent).toBeDefined()
    h.ctx.emit('agent/status', { agent: hiddenAgent!, status: 'running' })
    h.ctx.emit('agent/error', { agent: hiddenAgent!, turn: 0, step: 0, error: new Error('boom') })
    h.ctx.emit('agent/status', { agent: visibleAgent!, status: 'running' })
    h.ctx.emit('agent/error', { agent: visibleAgent!, turn: 0, step: 0, error: new Error('visible boom') })
    const statusFrames = await read(2)
    expect(statusFrames.some(frame =>
      frame.type === 'host/session-status' && frame.sessionId === 'lina-visible-alpha' && frame.running)).toBe(true)
    expect(statusFrames.some(frame =>
      frame.type === 'host/agent-error' && frame.sessionId === 'lina-visible-alpha')).toBe(true)
    expect(statusFrames.filter(frame =>
      (frame.type === 'host/session-status' || frame.type === 'host/agent-error')
      && frame.sessionId === 'owen-hidden-beta')).toEqual([])

    abort.abort()
  })

  it('scopes the mux stream conversation frames to the connection collab visibility', async () => {
    const h = await collabHarness()
    h.member('alpha', 'owen', 'lina')
    h.member('beta', 'owen')
    const alpha = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('alpha') })))).workspace
    const beta = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('beta') })))).workspace

    // Hidden session exists before the stream opens: the baseline subscribe
    // frame for it is withheld, and its live events never reach the viewer.
    await h.withPrincipal('owen', () =>
      h.api.sessions.create(request({ workspaceId: beta.workspaceId, sessionId: SessionId('owen-hidden-beta') })))
    await h.withPrincipal('lina', () =>
      h.api.sessions.create(request({ workspaceId: alpha.workspaceId, sessionId: SessionId('lina-visible-alpha') })))
    const abort = new AbortController()
    const stream = h.withPrincipal('lina', () =>
      h.api.events.mux(request({}), abort.signal))[Symbol.asyncIterator]()
    const read = frameCollector(stream)
    const baseline = await read(2)
    expect(baseline.some(frame =>
      frame.type === 'session/subscribed' && frame.sessionId === 'lina-visible-alpha')).toBe(true)
    expect(baseline.filter(frame =>
      frame.type === 'session/subscribed' && frame.sessionId === 'owen-hidden-beta')).toEqual([])

    const hiddenAgent = h.ctx.agents.get(SessionId('owen-hidden-beta'))
    const visibleAgent = h.ctx.agents.get(SessionId('lina-visible-alpha'))
    expect(hiddenAgent).toBeDefined()
    expect(visibleAgent).toBeDefined()
    hiddenAgent!.session.append('turn/start', { turn: 1 })
    visibleAgent!.session.append('turn/start', { turn: 1 })
    const events = await read(2)
    expect(events.some(frame =>
      frame.type === 'session/event' && frame.sessionId === 'lina-visible-alpha')).toBe(true)
    expect(events.filter(frame =>
      frame.type === 'session/event' && frame.sessionId === 'owen-hidden-beta')).toEqual([])

    // A session born after the stream opened gets a subscribe frame only when
    // its viewer may see it.
    await h.withPrincipal('owen', () =>
      h.api.sessions.create(request({ workspaceId: beta.workspaceId, sessionId: SessionId('owen-late-beta') })))
    await h.withPrincipal('lina', () =>
      h.api.sessions.create(request({ workspaceId: alpha.workspaceId, sessionId: SessionId('lina-late-alpha') })))
    const late = await read(2)
    expect(late.some(frame =>
      frame.type === 'session/subscribed' && frame.sessionId === 'lina-late-alpha')).toBe(true)
    expect(late.filter(frame =>
      frame.type === 'session/subscribed' && frame.sessionId === 'owen-late-beta')).toEqual([])
    abort.abort()
  })

  it('leaves the host plane un-scoped when no principal is resolved', async () => {
    const h = await collabHarness()
    h.member('beta', 'owen')
    const beta = expectOk(await h.withPrincipal('owen', () =>
      h.api.workspace.create(request({ path: h.stageCollab('beta') })))).workspace
    // No withPrincipal wrapper: the connection resolves no principal, which is
    // the single-user posture this overlay never co-exists with.
    const list = expectOk(await h.api.workspace.list(request({})))
    expect(list.items.map(workspace => workspace.workspaceId)).toContain(beta.workspaceId)
  })
})
