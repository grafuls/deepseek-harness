// @vitest-environment jsdom
/**
 * CollabSettingsSection rendering (the Collaborative Workspaces settings
 * page): the ready form with save/reset over a real controller and scope, the
 * unavailable notice, and the loading placeholder. Props are fed directly
 * (hooks bound by the renderer in production); no render machinery here.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { CollabSettingsSection, type CollabSettingsSectionProps } from '../src/client/CollabSettingsSection.tsx'
import type { CollabSettingsValue } from '../src/client/collab-settings-store.ts'
import {
  CollabSettingsController,
  createCollabSettingsStore,
} from '../src/client/collab-settings-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

/** An English-bound translate seat for direct rendering (the renderer binds it in production). */
const t: CollabSettingsSectionProps['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** A controllable scope: writes update the snapshot and notify the controller. */
function scopeWith(
  value: CollabSettingsValue | undefined,
): { scope: SettingsScope<CollabSettingsValue>; calls: Array<{ field: string; value: unknown }> } {
  const calls: Array<{ field: string; value: unknown }> = []
  const listeners = new Set<() => void>()
  const snapshot: SettingsScopeSnapshot<CollabSettingsValue> = {
    status: 'ready',
    value,
    base: undefined,
    user: value,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async (field, next) => {
        calls.push({ field, value: next })
        snapshot.value = { ...(snapshot.value ?? {}), [field]: next }
        notify()
      },
      unset: async (field) => {
        calls.push({ field, value: undefined })
        const next: CollabSettingsValue = {}
        for (const [key, stale] of Object.entries(snapshot.value ?? {})) {
          if (key !== field) (next as Record<string, unknown>)[key] = stale
        }
        snapshot.value = next
        notify()
      },
    },
    calls,
  }
}

/** A scope whose writes block on the gate until released, for in-flight-save lanes. */
function heldScope(): { scope: SettingsScope<CollabSettingsValue>; calls: Array<{ field: string; value: unknown }>; release: () => void } {
  let resolve!: () => void
  const gate = new Promise<void>((res) => { resolve = res })
  const calls: Array<{ field: string; value: unknown }> = []
  const listeners = new Set<() => void>()
  const snapshot: SettingsScopeSnapshot<CollabSettingsValue> = { status: 'ready', value: { cloneDir: '/data/clones' }, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async (field, value) => {
        calls.push({ field, value })
        await gate
        snapshot.value = { ...(snapshot.value ?? {}), [field]: value }
        notify()
      },
      unset: async () => { await gate },
    },
    calls,
    release: () => { resolve() },
  }
}

function ready(overrides: Partial<Record<'cloneDir' | 'draft', string>> = {}) {
  const scope = scopeWith({ cloneDir: '/data/clones' })
  const store = createCollabSettingsStore()
  const controller = new CollabSettingsController(scope.scope, store)
  const snapshot = store.getSnapshot()
  store.set({ ...snapshot, ...overrides })
  return { controller, store, calls: scope.calls }
}

describe('CollabSettingsSection', () => {
  it('shows the clone-directory form seeded with the persisted value', () => {
    const { controller, store } = ready()
    const { rerender } = render(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('/data/clones')
    expect(screen.getByText('Save').getAttribute('disabled')).not.toBeNull()
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    expect(screen.getByText('Default clone directory')).toBeTruthy()
  })

  it('enables Save once the draft differs and clears saved feedback on edits', () => {
    const { controller, store } = ready()
    const { rerender } = render(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/data/other' } })
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    expect(screen.getByText('Save').getAttribute('disabled')).toBeNull()
    expect(screen.getByText('Reset').getAttribute('disabled')).toBeNull()
  })

  it('saves the draft through the controller and shows the confirmation', async () => {
    const { controller, store, calls } = ready()
    const { rerender } = render(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/data/other' } })
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.click(screen.getByText('Save'))
    await Promise.resolve()
    await Promise.resolve()
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    expect(calls).toEqual([{ field: 'cloneDir', value: '/data/other' }])
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('resets the draft to the persisted value and disables the actions', () => {
    const { controller, store } = ready()
    const { rerender } = render(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/data/other' } })
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.click(screen.getByText('Reset'))
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('/data/clones')
    expect(screen.getByText('Save').getAttribute('disabled')).not.toBeNull()
  })

  it('saves from the Enter key only in a dirty un-busy form', async () => {
    const holder = heldScope()
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(holder.scope, store)
    const { rerender } = render(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    const input = screen.getByRole('textbox')
    // Clean form: Enter short-circuits before any write.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(holder.calls).toEqual([])
    // Non-Enter key: the condition's first term is false.
    fireEvent.change(input, { target: { value: '/data/other' } })
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.keyDown(input, { key: 'x' })
    expect(holder.calls).toEqual([])
    // Dirty + idle + Enter: the write goes through.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(holder.calls).toEqual([{ field: 'cloneDir', value: '/data/other' }])
    holder.release()
    await waitFor(() => { expect(screen.getByRole('textbox')).toBeTruthy() })
  })

  it('ignores Enter while a save is in flight', async () => {
    const holder = heldScope()
    const store = createCollabSettingsStore()
    const controller = new CollabSettingsController(holder.scope, store)
    const { rerender } = render(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/data/other' } })
    rerender(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => { expect(screen.getByText('Saving…')).toBeTruthy() })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    // The first save is still pending; the Enter does not queue a second one.
    expect(holder.calls).toHaveLength(1)
    holder.release()
    await waitFor(() => { expect(screen.getByText('Save')).toBeTruthy() })
  })

  it('renders the unavailable notice when the namespace is unreachable', () => {
    const scope = scopeWith(undefined)
    const controller = new CollabSettingsController(scope.scope, createCollabSettingsStore())
    const store = createCollabSettingsStore()
    store.set({ ...store.getSnapshot(), status: 'unavailable' })
    render(<CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />)
    expect(screen.getByText('Collaborative workspace settings are unavailable')).toBeTruthy()
  })

  it('renders nothing while the scope has not answered', () => {
    const scope = scopeWith(undefined)
    const controller = new CollabSettingsController(scope.scope, createCollabSettingsStore())
    const store = createCollabSettingsStore()
    store.set({ ...store.getSnapshot(), status: 'loading' })
    const { container } = render(
      <CollabSettingsSection useCollabSettings={sel => sel(store.getSnapshot())} controller={controller} t={t} />,
    )
    expect(container.childNodes).toHaveLength(0)
  })
})
