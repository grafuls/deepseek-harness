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
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { CollabSection } from '../src/client/CollabSection.tsx'
import { NS } from '../src/client/locales.ts'
import type { CollabWorkspacesInjected } from '../src/client/WorkspacesPanel.tsx'
import { WorkspacesPanel } from '../src/client/WorkspacesPanel.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

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

async function bench() {
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
        'sidebar.workspaces.collab': { kind: 'single', scope: 'root' },
      },
    } as never,
    () => null,
  )
  const { seen, call } = stubRpc({
    'collab/auth.status': [{ ok: true, value: { authenticated: true } }],
    'collab/workspace.list': [{ ok: true, value: [] }, { ok: true, value: [] }],
    'collab/workspace.myInvitations': [{ ok: true, value: [] }, { ok: true, value: [] }],
  })
  // The plugin resolves ctx.connection from the service store.
  ctx.provide('connection', { rpc: { call } } as never)
  // The plugin resolves the runtime Workspace face used to switch into a
  // mounted collab workspace (never reached in these lanes).
  ctx.provide('workspaces', {
    list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
    startSession: vi.fn(),
  } as never)
  return { ctx, slots, seen, locale }
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
    { name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' }, 'sidebar.workspaces.collab': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
  return { ctx, slots }
}

describe('ui-collab client plugin', () => {
  it('mounts as an inert node plugin the Loader can instantiate', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('declares the slot, connection, workspace and locale services it binds', () => {
    expect(inject).toEqual(['slots', 'connection', 'workspaces', 'locale'])
  })

  it('registers the section and panel on their declared slots and tears both down', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('sidebar.workspaces.collab')).toHaveLength(1)
    expect(slots.entries('shell.overlay')).toHaveLength(1)
    expect(slots.entries('sidebar.workspaces.collab')[0]!.component).toBe(CollabSection)
    expect(slots.entries('shell.overlay')[0]!.component).toBe(WorkspacesPanel)
    await fiber.dispose()
    expect(slots.entries('sidebar.workspaces.collab')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('registers bilingual manager dictionaries on the standard locale seat', async () => {
    const { ctx, slots, locale } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    // Copy rides the standard locale seat, not the business face.
    expect(slots.entries('sidebar.workspaces.collab')[0]!.locale).toBe(NS)
    expect(slots.entries('shell.overlay')[0]!.locale).toBe(NS)
    const t = locale.bind(NS)
    expect(t('title')).toBe('协作工作区')
    expect(t('memberCount', { count: '3' })).toBe('3 名成员')
    locale.setLocale('en')
    expect(t('workspaces')).toBe('Workspaces')
    expect(t('memberCount', { count: '3' })).toBe('3 members')
  })

  it('probes availability into the shared store on mount', async () => {
    const { ctx, slots, seen } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    await new Promise(resolve => setImmediate(resolve))
    expect(seen).toEqual(['collab/auth.status', 'collab/workspace.list', 'collab/workspace.myInvitations'])
    const section = slots.entries('sidebar.workspaces.collab')[0]!
    const face = (section.inject as unknown as () => CollabWorkspacesInjected)()
    expect(face.hooks.collabWorkspaces.getSnapshot().availability).toBe('ready')
  })

  it('exposes actions that drive the shared store from the inject face', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    await new Promise(resolve => setImmediate(resolve))
    const entry = slots.entries('sidebar.workspaces.collab')[0]!
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
    face.actions.create('Beta')
    face.actions.invite('c@example.com', 'admin')
    face.actions.revokeInvitation('i1')
    face.actions.acceptInvitation('i1')
    face.actions.setMemberRole('u1', 'admin')
    face.actions.removeMember('u1')
    face.actions.openWorkspace('w1')
    face.actions.deleteSelected()
    await vi.waitFor(() => { expect(store.getSnapshot().working).toBe(false) })
  })

  it('keeps the surfaces hidden when the collab surface is absent', async () => {
    const { ctx, slots } = await benchHidden()
    const call = async (): Promise<RpcResult<unknown>> => { throw new Error('transport failure') }
    ctx.provide('connection', { rpc: { call } } as never)
    ctx.provide('workspaces', {
      list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
      startSession: vi.fn(),
    } as never)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await new Promise(resolve => setImmediate(resolve))
    const section = slots.entries('sidebar.workspaces.collab')[0]!
    const face = (section.inject as unknown as () => CollabWorkspacesInjected)()
    expect(face.hooks.collabWorkspaces.getSnapshot().availability).toBe('hidden')
  })
})
