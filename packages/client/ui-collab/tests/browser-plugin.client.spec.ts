// @vitest-environment jsdom
/**
 * ui-collab apply wiring against the real SlotRegistry and a stub Connection
 * RPC: both surfaces register only once their slot declarations are present
 * (the collab section under the Workspaces browsing region and the manager
 * overlay), the injected face carries the shared store plus collab actions,
 * the availability probe lands in the store, and fiber teardown unregisters
 * both entries and unbinds the shared handle.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsScope, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { CollabSettingsSection } from '../src/client/CollabSettingsSection.tsx'
import type { CollabSettingsInjected } from '../src/client/CollabSettingsSection.tsx'
import type { CollabSettingsValue } from '../src/client/collab-settings-store.ts'
import { CollabSection } from '../src/client/CollabSection.tsx'
import { NS } from '../src/client/locales.ts'
import type { CollabWorkspacesInjected } from '../src/client/WorkspacesPanel.tsx'
import { WorkspacesPanel } from '../src/client/WorkspacesPanel.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

/** The mount record `collab/workspace.open` returns for a host 'h1'. */
const MOUNTED = {
  workspace: {
    workspaceId: 'h1',
    path: '/data/collab/workspaces/w1',
    title: 'Alpha',
    sessionIds: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  },
  dir: '/data/collab/workspaces/w1',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A controlled Connection RPC stub recording calls. */
function stubRpc(script: Record<string, Array<RpcResult<unknown>>> = {}) {
  const seen: string[] = []
  const cursor = new Map<string, number>()
  const call = async (_channel: string, endpoint: string): Promise<RpcResult<unknown>> => {
    const key = endpoint
    seen.push(key)
    const queue = script[key]
    if (queue === undefined) throw new Error(`stub: no script for ${key}`)
    const index = cursor.get(key) ?? 0
    cursor.set(key, index + 1)
    return queue[index]!
  }
  return { seen, call }
}

async function bench(extraChildren: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  // The locale registry stands in for the locale plugin: browser-language
  // detection never runs in this lane, so state the asserted locale.
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    {
      name: 'root',
      children: {
        'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        ...extraChildren,
      },
    } as never,
    () => null,
  )
  const { seen, call } = stubRpc({
    'collab/auth.status': [{ ok: true, value: { authenticated: true } }],
    // One entry per refresh: the availability probe, then openPanel, openManager,
    // and a direct refresh() in the actions lane.
    'collab/workspace.list': [{ ok: true, value: [] }, { ok: true, value: [] }, { ok: true, value: [] }, { ok: true, value: [] }],
    'collab/workspace.myInvitations': [{ ok: true, value: [] }, { ok: true, value: [] }, { ok: true, value: [] }, { ok: true, value: [] }],
    'collab/workspace.delete': [{ ok: true, value: undefined }],
    // Rename resolves once then refuses: the dialog keeps failures open.
    'collab/workspace.rename': [
      { ok: true, value: { id: 'w1', name: 'Eng' } },
      { ok: false, error: { code: 'internal', message: 'nope', details: {} } },
    ],
    // openWorkspace's mount: the Host list already reflects it, so the switch
    // navigates synchronously and exercises the startSession port wrapper.
    'collab/workspace.open': [{ ok: true, value: MOUNTED }],
  })
  // The plugin resolves ctx.connection from the service store.
  ctx.provide('connection', { rpc: { call } } as never)
  // The plugin resolves the runtime Workspace face used to switch into a
  // mounted collab workspace, to reorder shared collab session accounts, and
  // to archive a collab session for every member.
  const startSession = vi.fn()
  const insertSessionBefore = vi.fn()
  const archiveSession = vi.fn(async () => { })
  ctx.provide('workspaces', {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'h1' }] }), subscribe: () => () => {} },
    startSession,
    insertSessionBefore,
    archiveSession,
  } as never)
  // The plugin resolves the runtime Session face used to open a session, to
  // rename one through its per-session binding, and to fork a child.
  const openSession = vi.fn()
  const binding = vi.fn()
  const fork = vi.fn()
  ctx.provide('sessions', { open: openSession, binding, fork } as never)
  return { ctx, slots, seen, locale, startSession, insertSessionBefore, archiveSession, openSession, binding, fork }
}

/** A bench context without the connection RPC, for the hidden-surface lane. */
async function benchHidden() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    { name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' }, 'sidebar.workspaces': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
  return { ctx, slots }
}

describe('ui-collab client plugin', () => {
  it('mounts as an inert node plugin the Loader can instantiate', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('declares the slot, connection, workspace, session and locale services it binds', () => {
    expect(inject).toEqual(['slots', 'connection', 'workspaces', 'sessions', 'locale'])
  })

  it('registers the section and panel on their declared slots and tears both down', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entries('shell.overlay')).toHaveLength(1)
    expect(slots.entries('sidebar.workspaces')[0]!.component).toBe(CollabSection)
    expect(slots.entries('shell.overlay')[0]!.component).toBe(WorkspacesPanel)
    await fiber.dispose()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('registers the collab settings section on the settings surface and tears it down', async () => {
    const { ctx, slots } = await bench({ 'settings.section': { kind: 'list', scope: 'root' } })
    expect(slots.entries('settings.section')).toHaveLength(0)
    const snapshot = { status: 'ready' as const, value: { cloneDir: '/clones' } as CollabSettingsValue, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' as const }
    const listeners = new Set<() => void>()
    const scope: SettingsScope<CollabSettingsValue> = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: async () => {},
      unset: async () => {},
    }
    const bind = vi.fn((spec: { namespace: string; decode: unknown }) => {
      void spec
      return scope
    })
    ctx.provide('settingsScope', { bind } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(bind).toHaveBeenCalledTimes(1)
    const spec = bind.mock.calls[0]![0]
    expect(spec.namespace).toBe('collab')
    expect(typeof spec.decode).toBe('function')
    expect(listeners.size).toBe(1)
    const entries = slots.entries('settings.section')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.component).toBe(CollabSettingsSection)
    expect(entries[0]!.locale).toBe(NS)
    // The nav label thunk and the inject face are read at render time by the
    // settings shell; resolve them here to prove the section carries them.
    expect(resolveSlotLabel(entries[0]!.options.label)).toBe('协作工作区')
    const face = (entries[0]!.inject as unknown as () => CollabSettingsInjected)()
    expect(face.hooks.collabSettings.getSnapshot()).toMatchObject({ status: 'ready', cloneDir: '/clones' })
    await fiber.dispose()
    // Fiber teardown unregisters the section and disconnects the scope.
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(listeners.size).toBe(0)
  })

  it('registers bilingual manager dictionaries on the standard locale seat', async () => {
    const { ctx, slots, locale } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Copy rides the standard locale seat, not the business face.
    expect(slots.entries('sidebar.workspaces')[0]!.locale).toBe(NS)
    expect(slots.entries('shell.overlay')[0]!.locale).toBe(NS)
    const t = locale.bind(NS)
    expect(t('title')).toBe('工作区')
    expect(t('memberCount', { count: '3' })).toBe('3 名成员')
    locale.setLocale('en')
    expect(t('workspaces')).toBe('Workspaces')
    expect(t('memberCount', { count: '3' })).toBe('3 members')
    await fiber.dispose()
  })

  it('probes availability into the shared store on mount', async () => {
    const { ctx, slots, seen } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await new Promise(resolve => setImmediate(resolve))
    expect(seen).toEqual(['collab/auth.status', 'collab/workspace.list', 'collab/workspace.myInvitations'])
    const section = slots.entries('sidebar.workspaces')[0]!
    const face = (section.inject as unknown as () => CollabWorkspacesInjected)()
    expect(face.hooks.collabWorkspaces.getSnapshot().availability).toBe('ready')
    await fiber.dispose()
  })

  it('exposes actions that drive the shared store from the inject face', async () => {
    const { ctx, slots, startSession, insertSessionBefore } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await new Promise(resolve => setImmediate(resolve))
    const entry = slots.entries('sidebar.workspaces')[0]!
    const face = (entry.inject as unknown as () => CollabWorkspacesInjected)()
    const store = face.hooks.collabWorkspaces
    face.actions.openPanel()
    expect(store.getSnapshot().open).toBe(true)
    face.actions.closePanel()
    expect(store.getSnapshot().open).toBe(false)
    // openManager opens the panel and loads the workspace detail. The stubbed
    // detail endpoint is missing, so the load folds into an error banner, but
    // the open side of the action is observable synchronously.
    face.actions.openManager('w1')
    expect(store.getSnapshot().open).toBe(true)
    // refresh() succeeds against the second list entry; the remaining actions
    // hit missing stub scripts and fold into error banners, still covering
    // the arrows.
    face.actions.refresh()
    await vi.waitFor(() => { expect(store.getSnapshot().workspaces).toEqual([]) })
    face.actions.select('w1')
    await vi.waitFor(() => { expect(store.getSnapshot().error).toBeDefined() })
    void face.actions.create('Beta')
    face.actions.invite('c@example.com', 'admin')
    face.actions.revokeInvitation('i1')
    face.actions.acceptInvitation('i1')
    face.actions.setMemberRole('u1', 'admin')
    face.actions.removeMember('u1')
    // Opening a mounted collab workspace switches the runtime into the shared
    // Host workspace through the port wrapper.
    face.actions.openWorkspace('w1')
    await vi.waitFor(() => { expect(startSession).toHaveBeenCalledWith('h1') })
    // Reordering a collab session routes through the runtime Workspace port,
    // with and without an anchor (append).
    face.actions.reorderSession('h1', 's2', 's4')
    face.actions.reorderSession('h1', 's2')
    await vi.waitFor(() => {
      expect(insertSessionBefore).toHaveBeenCalledWith('h1', 's2', 's4')
      expect(insertSessionBefore).toHaveBeenCalledWith('h1', 's2', undefined)
    })
    // mountAll materializes collab workspaces in the background (here: none);
    // open routes a session into the runtime Session face.
    const sessions = ctx.get('sessions') as unknown as { open: ReturnType<typeof vi.fn> }
    face.actions.mountAll()
    face.actions.open('s1' as SessionId)
    expect(sessions.open).toHaveBeenCalledWith('s1')
    // delete removes the workspace record by id through the collab endpoint.
    face.actions.delete('w1')
    await vi.waitFor(() => { expect(store.getSnapshot().working).toBe(false) })
    face.actions.setGroupBy('flat')
    face.actions.setOrderBy('manual')
    expect(store.getSnapshot().groupBy).toBe('flat')
    expect(store.getSnapshot().orderBy).toBe('manual')
    face.actions.deleteSelected()
    await vi.waitFor(() => { expect(store.getSnapshot().working).toBe(false) })
    await fiber.dispose()
  })

  it('routes session row verbs through the runtime session and workspace faces', async () => {
    const { ctx, slots, binding, fork, openSession, archiveSession, seen } = await bench()
    // Rename hops the list binding to the per-session rename verb.
    const rename = vi.fn<(title: string) => Promise<RpcResult<{ title: string; seq: number }>>>(async () => ({ ok: true as const, value: { title: 'x', seq: 1 } }))
    binding.mockReturnValue({ session: { rename } })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await new Promise(resolve => setImmediate(resolve))
    const entry = slots.entries('sidebar.workspaces')[0]!
    const face = (entry.inject as unknown as () => CollabWorkspacesInjected)()
    // A bound session renames through its own face.
    await face.actions.renameSession('s1' as SessionId, 'Research log')
    expect(binding).toHaveBeenCalledWith('s1')
    expect(rename).toHaveBeenCalledWith('Research log')
    // An unbound session rejects so the dialog keeps its error.
    binding.mockReturnValue(undefined)
    await expect(face.actions.renameSession('s2' as SessionId, 'x')).rejects.toThrow('unknown session "s2"')
    // A host-side rename failure propagates its message.
    rename.mockResolvedValue({ ok: false as const, error: { code: 'internal', message: 'denied', details: {} } })
    binding.mockReturnValue({ session: { rename } })
    await expect(face.actions.renameSession('s3' as SessionId, 'x')).rejects.toThrow('denied')
    // Fork opens the resulting child; a rejected fork keeps the selection.
    fork.mockResolvedValue('child1')
    face.actions.forkSession('s1' as SessionId)
    await vi.waitFor(() => { expect(openSession).toHaveBeenCalledWith('child1') })
    fork.mockRejectedValue(new Error('nope'))
    face.actions.forkSession('s1' as SessionId)
    await vi.waitFor(() => { expect(fork).toHaveBeenCalledTimes(2) })
    expect(openSession).toHaveBeenCalledTimes(1)
    // Archive routes to the registry-global archive; rejection propagates.
    face.actions.archiveSession('s1' as SessionId)
    await vi.waitFor(() => { expect(archiveSession).toHaveBeenCalledWith('s1') })
    archiveSession.mockRejectedValue(new Error('denied'))
    await expect(face.actions.archiveSession('s1' as SessionId)).rejects.toThrow('denied')
    // Workspace rename routes to the collab RPC; a wire refusal propagates so
    // the dialog stays open with the host message.
    await face.actions.renameWorkspace('w1', 'Eng')
    expect(seen).toContain('collab/workspace.rename')
    await expect(face.actions.renameWorkspace('w1', 'Eng')).rejects.toThrow('nope')
    await fiber.dispose()
  })

  it('keeps the surfaces hidden when the collab surface is absent', async () => {
    const { ctx, slots } = await benchHidden()
    const call = async (): Promise<RpcResult<unknown>> => { throw new Error('transport failure') }
    ctx.provide('connection', { rpc: { call } } as never)
    ctx.provide('workspaces', {
      list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
      startSession: vi.fn(),
    } as never)
    ctx.provide('sessions', { open: vi.fn() } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await new Promise(resolve => setImmediate(resolve))
    const section = slots.entries('sidebar.workspaces')[0]!
    const face = (section.inject as unknown as () => CollabWorkspacesInjected)()
    expect(face.hooks.collabWorkspaces.getSnapshot().availability).toBe('hidden')
    await fiber.dispose()
  })
})
