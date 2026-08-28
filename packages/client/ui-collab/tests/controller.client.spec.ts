/**
 * CollabWorkspacesController orchestration: availability probing, list and
 * detail loads, every mutation, and the fold of server codes into the
 * user-facing error banner. Runs against a recording fake RPC through the
 * real CollabApi.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CollabRpcResultError, CollabRpcResultOk } from '../src/client/contract.ts'
import { CollabApi, type CollabRpcChannel, type CollabInvitationView, type CollabMemberView, type CollabWorkspaceView } from '../src/client/contract.ts'
import { CollabWorkspacesController, type WorkspacePort } from '../src/client/controller.ts'
import { zh, type CollabKey } from '../src/client/locales.ts'
import { createCollabWorkspacesStore } from '../src/client/store.ts'

const WORKSPACE: CollabWorkspaceView = { id: 'w1', name: 'Alpha', memberCount: 2, isOwner: true, role: 'admin', createdAt: '2020-01-01T00:00:00.000Z' }
const MEMBER: CollabMemberView = { userId: 'u1', email: 'owen@example.com', name: 'Owen', role: 'admin', joinedAt: '2020-01-01T00:00:00.000Z' }
const INVITATION: CollabInvitationView = { id: 'i1', workspaceId: 'w1', email: 'lina@example.com', role: 'developer', createdBy: 'u1', createdAt: '2020-01-01T00:00:00.000Z', revoked: false }
const MOUNTED = {
  workspace: {
    workspaceId: 'h1',
    path: '/data/collab/workspaces/w1',
    title: 'Alpha',
    sessionIds: [] as string[],
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  },
  dir: '/data/collab/workspaces/w1',
}

function ok(value: unknown): CollabRpcResultOk<unknown> {
  return { ok: true, value }
}

function refusal(code: string): CollabRpcResultError {
  return { ok: false, error: { code, message: `boom: ${code}` } }
}

/** The controller consumes the locale translate; a zh-backed fake stands in for `ctx.locale.bind`. */
function zhTranslate(key: string, _params?: Record<string, unknown>): string {
  return zh[key as CollabKey] ?? key
}

/** One scripted call fake: each endpoint replays its response queue in order. */
/** A controllable runtime Workspace port: an items list the test can mutate and a startSession spy. */
function workspacePort(items: Array<{ workspaceId: string }> = []): {
  port: WorkspacePort
  list: Array<{ workspaceId: string }>
  push: (workspaceId: string) => void
  startSession: ReturnType<typeof vi.fn>
} {
  const list = items
  const listeners = new Set<() => void>()
  const push = (workspaceId: string): void => {
    list.push({ workspaceId })
    for (const listener of listeners) listener()
  }
  const startSession = vi.fn()
  const port = {
    list: {
      getSnapshot: () => ({ items: list }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    startSession,
  }
  return { port, list, push, startSession }
}

function harness(
  script: Record<string, Array<CollabRpcResultOk<unknown> | CollabRpcResultError>> = {},
  items: Array<{ workspaceId: string }> = [],
): {
  store: ReturnType<typeof createCollabWorkspacesStore>
  controller: CollabWorkspacesController
  seen: string[]
  push: (workspaceId: string) => void
  startSession: ReturnType<typeof vi.fn>
} {
  const seen: string[] = []
  const cursor = new Map<string, number>()
  const call: CollabRpcChannel['call'] = async (_channel, endpoint) => {
    const key = endpoint
    seen.push(key)
    const queue = script[key]
    if (queue === undefined) throw new Error(`fake: no script for ${key}`)
    const index = cursor.get(key) ?? 0
    cursor.set(key, index + 1)
    return queue[index]!
  }
  const api = new CollabApi(call)
  const store = createCollabWorkspacesStore()
  const { port, push, startSession } = workspacePort(items)
  const controller = new CollabWorkspacesController(api, store, port, zhTranslate)
  return { store, controller, seen, push, startSession }
}

/** Seed a selection so detail paths have a target (store is plain data). */
function selected(): ReturnType<typeof createCollabWorkspacesStore> {
  const store = createCollabWorkspacesStore()
  store.set({ ...store.getSnapshot(), selectedId: 'w1', myRole: 'admin', workspaces: [WORKSPACE] })
  return store
}

describe('CollabWorkspacesController', () => {
  it('opens and closes the panel purely in the store', () => {
    const { store, controller } = harness()
    controller.openPanel()
    expect(store.getSnapshot().open).toBe(true)
    controller.closePanel()
    expect(store.getSnapshot().open).toBe(false)
    expect(store.getSnapshot().error).toBeUndefined()
  })

  it('opens the panel onto a workspace detail', async () => {
    const { store, controller } = harness({
      'collab/workspace.members': [ok([MEMBER])],
      'collab/workspace.invitations': [ok([INVITATION])],
    })
    controller.openManager('w1')
    expect(store.getSnapshot().open).toBe(true)
    await vi.waitFor(() => { expect(store.getSnapshot().members).toEqual([MEMBER]) })
    expect(store.getSnapshot().selectedId).toBe('w1')
    expect(store.getSnapshot().invitations).toEqual([INVITATION])
  })

  it('mounts a collab workspace and switches the GUI into it', async () => {
    const { store, controller, startSession } = harness(
      { 'collab/workspace.open': [ok(MOUNTED)] },
      [{ workspaceId: 'h1' }],
    )
    await expect(controller.openWorkspace('w1')).resolves.toBe(true)
    expect(startSession).toHaveBeenCalledWith('h1')
    expect(store.getSnapshot().working).toBe(false)
    expect(store.getSnapshot().error).toBeUndefined()
  })

  it('switches in once the mounted workspace appears in the list echo', async () => {
    const { controller, startSession, push } = harness({ 'collab/workspace.open': [ok(MOUNTED)] })
    const opening = controller.openWorkspace('w1')
    // Let the mount resolve and the bounded list wait install its listener,
    // then announce unrelated echoes (falsy branch) before the matching one.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    push('other-ws')
    push('h1')
    await expect(opening).resolves.toBe(true)
    expect(startSession).toHaveBeenCalledWith('h1')
  })

  it('still reports a mount when the list echo lags past the bound', async () => {
    vi.useFakeTimers()
    try {
      const { controller, startSession } = harness({ 'collab/workspace.open': [ok(MOUNTED)] })
      const opening = controller.openWorkspace('w1')
      await vi.advanceTimersByTimeAsync(1600)
      await expect(opening).resolves.toBe(true)
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('folds an open failure into the banner', async () => {
    const { store, controller, startSession } = harness({
      'collab/workspace.open': [refusal('collab-forbidden')],
    })
    await expect(controller.openWorkspace('w1')).resolves.toBe(false)
    expect(startSession).not.toHaveBeenCalled()
    expect(store.getSnapshot().error).toBe('没有权限执行此操作')
    expect(store.getSnapshot().working).toBe(false)
  })

  it('probes ready and loads the workspace list', async () => {
    const { store, controller, seen } = harness({
      'collab/auth.status': [ok({ authenticated: true })],
      'collab/workspace.list': [ok([WORKSPACE])],
      'collab/workspace.myInvitations': [ok([])],
    })
    await expect(controller.refreshAvailability()).resolves.toBe('ready')
    expect(store.getSnapshot().availability).toBe('ready')
    expect(store.getSnapshot().workspaces).toEqual([WORKSPACE])
    expect(store.getSnapshot().invitationsForMe).toEqual([])
    expect(seen).toEqual(['collab/auth.status', 'collab/workspace.list', 'collab/workspace.myInvitations'])
  })

  it('probes hidden without touching the list', async () => {
    const { store, seen } = harness()
    const api = new CollabApi(async () => { throw new Error('transport failure') })
    const hiddenStore = createCollabWorkspacesStore()
    const hidden = new CollabWorkspacesController(api, hiddenStore, workspacePort().port, zhTranslate)
    await expect(hidden.refreshAvailability()).resolves.toBe('hidden')
    expect(store.getSnapshot().availability).toBe('checking')
    expect(hiddenStore.getSnapshot().availability).toBe('hidden')
    expect(seen).toEqual([])
  })

  it('selects a workspace and loads its members and invitations', async () => {
    const { store, controller } = harness({
      'collab/workspace.members': [ok([MEMBER])],
      'collab/workspace.invitations': [ok([INVITATION])],
    })
    store.set({ ...store.getSnapshot(), workspaces: [WORKSPACE] })
    await expect(controller.select('w1')).resolves.toBe('w1')
    const after = store.getSnapshot()
    expect(after.myRole).toBe('admin')
    expect(after.members).toEqual([MEMBER])
    expect(after.invitations).toEqual([INVITATION])
    expect(after.working).toBe(false)
  })

  it('clears the selection without detail loads', async () => {
    const { store, controller, seen } = harness()
    store.set({ ...store.getSnapshot(), selectedId: 'w1', members: [MEMBER] })
    await expect(controller.select(undefined)).resolves.toBeUndefined()
    expect(store.getSnapshot().selectedId).toBeUndefined()
    expect(store.getSnapshot().members).toEqual([])
    expect(seen).toEqual([])
  })

  it('refreshes and keeps a still-present selection', async () => {
    const { store, controller } = harness({
      'collab/auth.status': [ok({ authenticated: true })],
      'collab/workspace.list': [ok([WORKSPACE]), ok([WORKSPACE])],
      'collab/workspace.myInvitations': [ok([]), ok([])],
      'collab/workspace.members': [ok([MEMBER])],
      'collab/workspace.invitations': [ok([INVITATION])],
    })
    await controller.refreshAvailability()
    await controller.select('w1')
    await controller.refresh()
    const after = store.getSnapshot()
    expect(after.selectedId).toBe('w1')
    expect(after.members).toEqual([MEMBER])
    expect(after.invitations).toEqual([INVITATION])
  })

  it('drops a vanished selection on refresh', async () => {
    const { store, controller } = harness({
      'collab/auth.status': [ok({ authenticated: true })],
      'collab/workspace.list': [ok([WORKSPACE]), ok([])],
      'collab/workspace.myInvitations': [ok([]), ok([])],
      'collab/workspace.members': [ok([MEMBER])],
      'collab/workspace.invitations': [ok([INVITATION])],
    })
    await controller.refreshAvailability()
    await controller.select('w1')
    await controller.refresh()
    const after = store.getSnapshot()
    expect(after.workspaces).toEqual([])
    expect(after.selectedId).toBeUndefined()
    expect(after.members).toEqual([])
    expect(after.invitations).toEqual([])
  })

  it('loads the pending invitations addressed to the user into the store', async () => {
    const mine = { id: 'i1', workspaceId: 'w1', workspaceName: 'Alpha', role: 'admin', createdAt: '2020-01-01T00:00:00.000Z' }
    const { store, controller } = harness({
      'collab/auth.status': [ok({ authenticated: true })],
      'collab/workspace.list': [ok([])],
      'collab/workspace.myInvitations': [ok([mine])],
    })
    await controller.refreshAvailability()
    expect(store.getSnapshot().invitationsForMe).toEqual([mine])
  })

  it('accepts a pending invitation, joins, and opens the joined workspace', async () => {
    const { store, controller, seen } = harness({
      'collab/workspace.join': [ok(WORKSPACE)],
      'collab/workspace.list': [ok([WORKSPACE])],
      'collab/workspace.myInvitations': [ok([])],
      'collab/workspace.members': [ok([MEMBER])],
      'collab/workspace.invitations': [ok([INVITATION])],
    })
    await expect(controller.acceptInvitation('i1')).resolves.toEqual(WORKSPACE)
    const after = store.getSnapshot()
    expect(after.workspaces).toEqual([WORKSPACE])
    expect(after.selectedId).toBe('w1')
    expect(after.myRole).toBe('admin')
    expect(after.members).toEqual([MEMBER])
    expect(after.invitations).toEqual([INVITATION])
    expect(after.working).toBe(false)
    expect(after.invitationsForMe).toEqual([])
    expect(seen).toEqual([
      'collab/workspace.join',
      'collab/workspace.list',
      'collab/workspace.myInvitations',
      'collab/workspace.members',
      'collab/workspace.invitations',
    ])
  })

  it('folds a join refusal for an acceptance into the general banner', async () => {
    const { store, controller } = harness({ 'collab/workspace.join': [refusal('collab-forbidden')] })
    await expect(controller.acceptInvitation('i1')).resolves.toBeUndefined()
    const after = store.getSnapshot()
    expect(after.error).toBe('没有权限执行此操作')
    expect(after.working).toBe(false)
  })

  it('creates a workspace, trims its name, and selects it', async () => {
    const created = { ...WORKSPACE, name: 'Beta' }
    const { store, controller, seen } = harness({
      'collab/workspace.create': [ok(created)],
      'collab/workspace.members': [ok([{ ...MEMBER }])],
      'collab/workspace.invitations': [ok([])],
    })
    await expect(controller.create('  Beta  ')).resolves.toBe('w1')
    expect(seen[0]).toBe('collab/workspace.create')
    expect(store.getSnapshot().workspaces[0]!.name).toBe('Beta')
    expect(store.getSnapshot().selectedId).toBe('w1')
  })

  it('refuses a blank workspace name without any RPC', async () => {
    const { store, controller, seen } = harness()
    await expect(controller.create('   ')).resolves.toBeUndefined()
    expect(store.getSnapshot().error).toBe('请输入工作区名称')
    expect(seen).toEqual([])
  })

  it('invites, revokes, changes roles, and removes members against the selection', async () => {
    const revoked = { ...INVITATION, revoked: true }
    const { store, controller, seen } = harness({
      'collab/workspace.invite': [ok(INVITATION)],
      'collab/workspace.revokeInvitation': [ok(revoked)],
      'collab/workspace.setMemberRole': [ok({ ...MEMBER, role: 'developer' as const })],
      'collab/workspace.removeMember': [ok({ removed: MEMBER.userId })],
    })
    const otherMember: typeof MEMBER = { ...MEMBER, userId: 'u2', email: 'lina@example.com', name: 'Lina', role: 'developer' }
    const otherInvitation: typeof INVITATION = { ...INVITATION, id: 'i2', email: 'carol@example.com', role: 'admin' }
    store.set({ ...selected().getSnapshot(), members: [MEMBER, otherMember], invitations: [otherInvitation] })
    await expect(controller.invite('lina@example.com', 'developer')).resolves.toEqual(INVITATION)
    await expect(controller.revokeInvitation('i1')).resolves.toEqual(revoked)
    await expect(controller.setMemberRole(MEMBER.userId, 'developer')).resolves.toMatchObject({ role: 'developer' })
    await expect(controller.removeMember(MEMBER.userId)).resolves.toBe(true)
    const after = store.getSnapshot()
    expect(after.invitations.map(invitation => invitation.revoked)).toEqual([false, true])
    expect(after.members.map(member => member.userId)).toEqual(['u2'])
    expect(after.members[0]!.role).toBe('developer')
    expect(after.working).toBe(false)
    expect(seen).toEqual([
      'collab/workspace.invite',
      'collab/workspace.revokeInvitation',
      'collab/workspace.setMemberRole',
      'collab/workspace.removeMember',
    ])
  })

  it('deletes the selected workspace and clears the panel detail', async () => {
    const { store, controller } = harness({ 'collab/workspace.delete': [ok({ deleted: true })] })
    store.set({ ...selected().getSnapshot() })
    await expect(controller.deleteSelected()).resolves.toBe(true)
    const after = store.getSnapshot()
    expect(after.workspaces).toEqual([])
    expect(after.selectedId).toBeUndefined()
    expect(after.myRole).toBeUndefined()
    expect(after.members).toEqual([])
    // Deleting with no selection is a no-op.
    const noop = new CollabWorkspacesController(
      new CollabApi(async () => ok({})),
      createCollabWorkspacesStore(),
      workspacePort().port,
      zhTranslate,
    )
    expect(await noop.deleteSelected()).toBe(false)
  })

  it('a no-target mutation is a safe no-op', async () => {
    const { store, controller, seen } = harness()
    await expect(controller.invite('lina@example.com', 'developer')).resolves.toBeUndefined()
    await expect(controller.revokeInvitation('i1')).resolves.toBeUndefined()
    await expect(controller.setMemberRole('u1', 'admin')).resolves.toBeUndefined()
    await expect(controller.removeMember('u1')).resolves.toBe(false)
    await expect(controller.deleteSelected()).resolves.toBe(false)
    expect(store.getSnapshot().working).toBe(false)
    expect(seen).toEqual([])
  })

  it('maps each wire code to its muted banner and clears working', async () => {
    const cases: Array<{ code: string; expected: string }> = [
      { code: 'collab-forbidden', expected: '没有权限执行此操作' },
      { code: 'collab-not-found', expected: '工作区不存在或已被删除' },
      { code: 'collab-bad-request', expected: '请求无效，请检查输入' },
      { code: 'collab-unknown', expected: '操作失败，请重试' },
    ]
    for (const { code, expected } of cases) {
      const { store, controller } = harness({ 'collab/workspace.invite': [refusal(code)] })
      store.set({ ...selected().getSnapshot() })
      await controller.invite('x@example.com', 'admin')
      const after = store.getSnapshot()
      expect(after.error, code).toBe(expected)
      expect(after.working, code).toBe(false)
    }
  })

  it('folds revoke, create, and delete failures into their banners', async () => {
    const revoke = harness({ 'collab/workspace.revokeInvitation': [refusal('collab-forbidden')] })
    revoke.store.set({ ...selected().getSnapshot(), invitations: [INVITATION] })
    await revoke.controller.revokeInvitation('i1')
    expect(revoke.store.getSnapshot().error).toBe('没有权限执行此操作')

    const createFail = harness({ 'collab/workspace.create': [refusal('collab-bad-request')] })
    await createFail.controller.create('Beta')
    expect(createFail.store.getSnapshot().error).toBe('请求无效，请检查输入')

    const removeTransient = harness({ 'collab/workspace.removeMember': [refusal('collab-unknown')] })
    removeTransient.store.set({ ...selected().getSnapshot() })
    await removeTransient.controller.removeMember('u1')
    expect(removeTransient.store.getSnapshot().error).toBe('操作失败，请重试')
  })

  it('folds a delete refusal into the general banner', async () => {
    const { store, controller } = harness({ 'collab/workspace.delete': [refusal('collab-forbidden')] })
    store.set({ ...selected().getSnapshot() })
    await expect(controller.deleteSelected()).resolves.toBe(false)
    const after = store.getSnapshot()
    expect(after.error).toBe('没有权限执行此操作')
    expect(after.working).toBe(false)
    expect(after.selectedId).toBe('w1')
  })

  it('folds a setMemberRole refusal into the muted banner', async () => {
    const { store, controller } = harness({ 'collab/workspace.setMemberRole': [refusal('collab-forbidden')] })
    store.set({ ...selected().getSnapshot() })
    await expect(controller.setMemberRole('u1', 'admin')).resolves.toBeUndefined()
    const after = store.getSnapshot()
    expect(after.error).toBe('没有权限执行此操作')
    expect(after.working).toBe(false)
  })

  it('folds a refusal while selecting into the banner', async () => {
    const { store, controller } = harness({
      'collab/workspace.members': [refusal('collab-not-found')],
      'collab/workspace.invitations': [refusal('collab-not-found')],
    })
    store.set({ ...selected().getSnapshot() })
    await expect(controller.select('w1')).resolves.toBe('w1')
    const after = store.getSnapshot()
    expect(after.error).toBe('工作区不存在或已被删除')
    expect(after.working).toBe(false)
  })

  it('folds a transport failure into the connection banner', async () => {
    const { store } = harness()
    const api = new CollabApi(async () => { throw new Error('network down') })
    const failingStore = createCollabWorkspacesStore()
    failingStore.set({ ...selected().getSnapshot() })
    const failing = new CollabWorkspacesController(api, failingStore, workspacePort().port, zhTranslate)
    await failing.removeMember('u1')
    expect(failingStore.getSnapshot().error).toBe('连接服务失败，请重试')
    expect(failingStore.getSnapshot().working).toBe(false)
    expect(store.getSnapshot().error).toBeUndefined()
  })
})
