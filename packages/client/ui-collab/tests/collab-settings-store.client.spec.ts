/**
 * CollabSettingsController: the clone-directory preference lifecycle over a
 * fake scope — persisted-value derivation, draft edits, set/unset writes, and
 * the memory/unavailable degradation — through the real store factory.
 */
import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollabSettingsValue } from '../src/client/collab-settings-store.ts'
import {
  CollabSettingsController,
  COLLAB_SETTINGS_INITIAL,
  createCollabSettingsStore,
  decodeCollabSettings,
} from '../src/client/collab-settings-store.ts'

interface FakeScope {
  scope: SettingsScope<CollabSettingsValue>
  /** Recorded writes as { kind, field, value }. */
  calls: Array<{ kind: 'set' | 'unset'; field: string; value: unknown }>
  /** Publish a new snapshot to the controller's subscription. */
  emit(patch: Partial<SettingsScopeSnapshot<CollabSettingsValue>> & { value?: CollabSettingsValue | undefined }): void
}

/** A controllable settings scope: writes update the snapshot and notify. */
function fakeScope(initial?: CollabSettingsValue, mode: 'host' | 'memory' = 'host'): FakeScope {
  const listeners = new Set<() => void>()
  const snapshot: SettingsScopeSnapshot<CollabSettingsValue> = {
    status: 'ready',
    value: initial,
    base: undefined,
    user: initial,
    revision: 1,
    writable: mode === 'host',
    mode,
  }
  const calls: Array<{ kind: 'set' | 'unset'; field: string; value: unknown }> = []
  const notify = (): void => { for (const listener of listeners) listener() }
  const scope: SettingsScope<CollabSettingsValue> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, value) => {
      calls.push({ kind: 'set', field, value })
      snapshot.value = { ...(snapshot.value ?? {}), [field]: value }
      snapshot.user = snapshot.value
      snapshot.revision = (snapshot.revision ?? 1) + 1
      notify()
    },
    unset: async (field) => {
      calls.push({ kind: 'unset', field, value: undefined })
      const next: CollabSettingsValue = {}
      for (const [key, stale] of Object.entries(snapshot.value ?? {})) {
        if (key !== field) (next as Record<string, unknown>)[key] = stale
      }
      snapshot.value = next
      snapshot.user = snapshot.value
      notify()
    },
  }
  return {
    scope,
    calls,
    emit: (patch) => {
      Object.assign(snapshot, patch, patch.value === undefined ? { value: undefined } : { value: patch.value })
      notify()
    },
  }
}

describe('CollabSettingsController', () => {
  it('derives the persisted clone directory into the store and draft', () => {
    const fake = fakeScope({ cloneDir: '/data/clones' })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', cloneDir: '/data/clones', draft: '/data/clones', saved: false })
    controller.disconnect()
  })

  it('derives an absent section as the empty (data-root) default', () => {
    const fake = fakeScope(undefined)
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', cloneDir: '', draft: '' })
    controller.disconnect()
  })

  it('keeps an in-flight draft untouched by a scope re-answer', () => {
    const fake = fakeScope({ cloneDir: '/data/a' })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    controller.setDraft('/data/b')
    fake.emit({ value: { cloneDir: '/data/a2' } })
    expect(store.getSnapshot().draft).toBe('/data/b')
    expect(store.getSnapshot().cloneDir).toBe('/data/a2')
    controller.disconnect()
  })

  it('writes the drafted clone directory on save', async () => {
    const fake = fakeScope({ cloneDir: '/data/a' })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    controller.setDraft('  /data/b  ')
    await expect(controller.save()).resolves.toBe(true)
    // Save persists both fields: the directory write plus a no-op depth unset
    // (the draft is untouched at its data-root default).
    expect(fake.calls).toEqual([
      { kind: 'set', field: 'cloneDir', value: '/data/b' },
      { kind: 'unset', field: 'cloneDepth', value: undefined },
    ])
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', cloneDir: '/data/b', draft: '  /data/b  ', saved: true })
    controller.disconnect()
  })

  it('clears the field to re-inherit the composition default when the draft is empty', async () => {
    const fake = fakeScope({ cloneDir: '/data/a' })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    controller.setDraft('')
    await expect(controller.save()).resolves.toBe(true)
    expect(fake.calls).toEqual([
      { kind: 'unset', field: 'cloneDir', value: undefined },
      { kind: 'unset', field: 'cloneDepth', value: undefined },
    ])
    expect(store.getSnapshot().cloneDir).toBe('')
    controller.disconnect()
  })

  it('reports an unsuccessful save when the namespace is memory-scoped and unreachable', async () => {
    const fake = fakeScope({ cloneDir: '/data/a' }, 'memory')
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    controller.setDraft('/data/b')
    await expect(controller.save()).resolves.toBe(false)
    expect(store.getSnapshot().status).toBe('unavailable')
    controller.disconnect()
  })

  it('reports an unsuccessful save when the write does not settle to the draft', async () => {
    // A scope whose writes never reflect back: the save must not claim success.
    const listeners = new Set<() => void>()
    const snapshot: SettingsScopeSnapshot<CollabSettingsValue> = {
      status: 'ready',
      value: { cloneDir: '/stuck' },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host',
    }
    const scope: SettingsScope<CollabSettingsValue> = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async () => {},
      unset: async () => {},
    }
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(scope, store)
    controller.setDraft('/data/b')
    await expect(controller.save()).resolves.toBe(false)
    expect(store.getSnapshot().cloneDir).toBe('/stuck')
  })

  it('reports unavailable for memory-mode and unavailable scopes', () => {
    const memory = fakeScope({ cloneDir: '/local' }, 'memory')
    const memoryStore = createCollabSettingsStore()
    const memoryController = new CollabSettingsController(memory.scope, memoryStore)
    expect(memoryStore.getSnapshot()).toMatchObject({ status: 'unavailable' })
    memoryController.disconnect()

    const unavailable = fakeScope(undefined)
    unavailable.emit({ status: 'unavailable', value: undefined })
    const unavailableStore = createCollabSettingsStore()
    const unavailableController = new CollabSettingsController(unavailable.scope, unavailableStore)
    expect(unavailableStore.getSnapshot()).toMatchObject({ status: 'unavailable' })
    unavailableController.disconnect()
  })

  it('reports loading while the scope has not answered', () => {
    const fake = fakeScope(undefined)
    fake.emit({ status: 'loading', value: undefined })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    expect(store.getSnapshot()).toMatchObject({ status: 'loading' })
    controller.disconnect()
  })

  it('derives the persisted clone depth into the store and draft', () => {
    const fake = fakeScope({ cloneDir: '/data/clones', cloneDepth: 7 })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    expect(store.getSnapshot()).toMatchObject({ cloneDepth: 7, depthDraft: '7', saved: false })
    controller.disconnect()
  })

  it('re-seeds an untouched depth draft when the persisted value changes externally', () => {
    const fake = fakeScope({ cloneDepth: 4 })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    fake.emit({ value: { cloneDepth: 9 } })
    expect(store.getSnapshot()).toMatchObject({ cloneDepth: 9, depthDraft: '9' })
    controller.disconnect()
  })

  it('degrades a non-positive or non-integer depth to full history', () => {
    const fake = fakeScope({ cloneDepth: -2 })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    expect(store.getSnapshot()).toMatchObject({ cloneDepth: 0, depthDraft: '' })
    controller.disconnect()
    const fractional = fakeScope({ cloneDepth: 2.5 })
    const fractionalStore = createCollabSettingsStore()
    const fractionalController = new CollabSettingsController(fractional.scope, fractionalStore)
    expect(fractionalStore.getSnapshot()).toMatchObject({ cloneDepth: 0, depthDraft: '' })
    fractionalController.disconnect()
  })

  it('writes the drafted clone depth on save', async () => {
    const fake = fakeScope({ cloneDir: '/data/a', cloneDepth: 2 })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    controller.setDraftDepth('5')
    await expect(controller.save()).resolves.toBe(true)
    expect(fake.calls).toEqual([
      { kind: 'set', field: 'cloneDir', value: '/data/a' },
      { kind: 'set', field: 'cloneDepth', value: 5 },
    ])
    expect(store.getSnapshot()).toMatchObject({ cloneDepth: 5, depthDraft: '5', saved: true })
    controller.disconnect()
  })

  it('clears the depth to re-inherit a full-history clone when the draft is empty', async () => {
    const fake = fakeScope({ cloneDepth: 4 })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    controller.setDraftDepth('')
    await expect(controller.save()).resolves.toBe(true)
    expect(fake.calls).toEqual([
      { kind: 'unset', field: 'cloneDir', value: undefined },
      { kind: 'unset', field: 'cloneDepth', value: undefined },
    ])
    expect(store.getSnapshot()).toMatchObject({ cloneDepth: 0, depthDraft: '' })
    controller.disconnect()
  })

  it('stops following the scope on disconnect', () => {
    const fake = fakeScope({ cloneDir: '/data/a' })
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(fake.scope, store)
    controller.disconnect()
    fake.emit({ value: { cloneDir: '/data/b' } })
    expect(store.getSnapshot().cloneDir).toBe('/data/a')
  })
})

describe('decodeCollabSettings', () => {
  it('narrows object sections and rejects others', () => {
    expect(decodeCollabSettings({ cloneDir: '/a' })).toEqual({ cloneDir: '/a' })
    expect(decodeCollabSettings('nope')).toBeUndefined()
    expect(decodeCollabSettings([1])).toBeUndefined()
    expect(decodeCollabSettings(null)).toBeUndefined()
  })
})

describe('createCollabSettingsStore initial snapshot', () => {
  it('starts paused before the first scope answer', () => {
    const store = createCollabSettingsStore()
    expect(store.getSnapshot()).toEqual(COLLAB_SETTINGS_INITIAL)
  })
})
