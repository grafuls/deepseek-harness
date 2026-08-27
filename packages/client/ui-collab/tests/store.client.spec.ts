/**
 * The collab workspaces store is a plain snapshot source built by the
 * factory: initial state, set, getSnapshot, and subscribe all behave as the
 * runtime contract promises, and each factory call yields a fresh identity
 * (no module-level handle).
 */
import { describe, expect, it } from 'vitest'
import { COLLAB_WORKSPACES_INITIAL, createCollabWorkspacesStore } from '../src/client/store.ts'

describe('collab workspaces store', () => {
  it('starts closed, probing, and empty', () => {
    const store = createCollabWorkspacesStore()
    expect(store.getSnapshot()).toEqual(COLLAB_WORKSPACES_INITIAL)
  })

  it('publishes new snapshots to subscribers on set', () => {
    const store = createCollabWorkspacesStore()
    const seen: unknown[] = []
    const unsubscribe = store.subscribe(() => { seen.push(store.getSnapshot()) })
    const opened = { ...store.getSnapshot(), open: true }
    store.set(opened)
    store.set({ ...opened, availability: 'ready' })
    unsubscribe()
    expect(seen).toEqual([opened, { ...opened, availability: 'ready' }])
    expect(store.getSnapshot().open).toBe(true)
  })

  it('creates an independent handle per call', () => {
    const first = createCollabWorkspacesStore()
    const second = createCollabWorkspacesStore()
    expect(first).not.toBe(second)
    first.set({ ...first.getSnapshot(), open: true })
    expect(first.getSnapshot().open).toBe(true)
    expect(second.getSnapshot().open).toBe(false)
  })
})
