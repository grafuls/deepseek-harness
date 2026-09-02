import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspacePickerInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  ctx.provide('workspaces', { create } as never)
  const locale = new LocaleRuntime(ctx)
  // These specs assert the shipped Chinese copy. There is no jsdom `window`
  // in this lane, so browser-language detection never runs and the locale
  // comes from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, create }
}

type HoleName = 'conversation.hero.workspace'

/** Declare the picker hole with a single root registration ('root' is a single slot). */
function declare(slots: SlotRegistry, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }]))
  return slots.register({ name: 'root', children } as never, () => null)
}

describe('ui-workspace apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'workspaces', 'locale'])
  })

  it('registers the picker for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'conversation.hero.workspace')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
    // Copy rides the standard locale seat: the entry declares the namespace
    // and apply registered both dictionaries.
    expect(before.slots.entries('conversation.hero.workspace')[0]!.locale).toBe('workspace')
    expect(before.locale.bind('workspace')('menu.addWorkspace')).toBe('添加工作区…')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'conversation.hero.workspace')
    await Promise.resolve()
    expect(after.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
  })

  it('routes picker creation to the service', async () => {
    const b = await bench()
    declare(b.slots, 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    await picker.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/project' })
  })

  it('declares the directory-flow child hole and reports its occupancy', async () => {
    const b = await bench()
    declare(b.slots, 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Registration declared the child hole (declaration = render authorization).
    expect(b.slots.spec('conversation.hero.workspace.directoryFlow')).toMatchObject({ kind: 'single' })

    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    // A flow occupant flips the surface, and the source notifies.
    const notified = vi.fn()
    const unsubscribe = picker.hooks.directoryFlow.subscribe(notified)
    const dispose = b.slots.register({ name: 'conversation.hero.workspace.directoryFlow' } as never, () => null)
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(true)
    await Promise.resolve()
    expect(notified).toHaveBeenCalled()
    dispose()
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    unsubscribe()
  })

  it('unregisters every entry on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'conversation.hero.workspace')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
  })
})
