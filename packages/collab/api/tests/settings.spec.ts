/**
 * Collab settings namespace: registration with the composition base layer and
 * the read helper's fallback ladder (absent provider, unset section, non-string
 * value, blank value, and a trimmed configured value).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  COLLAB_SETTINGS_NAMESPACE,
  installCollabSettings,
  readCloneDir,
} from '../src/settings.ts'

/** In-memory settings provider: the smallest real subclass of the Service Definition. */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

async function boot(options: { cloneDir?: string } = {}): Promise<Context> {
  const ctx = new Context()
  installCollabSettings(ctx, options)
  await ctx.plugin(MemorySettings).await()
  return ctx
}

describe('installCollabSettings', () => {
  it('registers the namespace with the composition cloneDir as the base layer', async () => {
    const ctx = await boot({ cloneDir: '/cfg/clones' })
    const namespaces = ctx.settings.describe().map(row => row.ns)
    expect(namespaces).toContain(COLLAB_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(COLLAB_SETTINGS_NAMESPACE)).toEqual({ cloneDir: '/cfg/clones' })
    // Fiber teardown runs the section disposer (the no-op onChange fallback).
    await ctx.fiber.dispose()
  })

  it('seeds the data-root default when cloneDir is omitted', async () => {
    const ctx = await boot()
    expect(ctx.settings.get(COLLAB_SETTINGS_NAMESPACE)).toEqual({ cloneDir: '' })
    await ctx.fiber.dispose()
  })
})

describe('readCloneDir', () => {
  it('returns the trimmed configured value when present', () => {
    const ctx = new Context()
    ctx.provide('settings', { get: () => ({ cloneDir: '  /cfg/clones  ' }) } as never)
    expect(readCloneDir(ctx)).toBe('/cfg/clones')
  })

  it('falls back to the data root when the value is absent, non-string, or blank', () => {
    expect(readCloneDir(new Context())).toBe('')
    const unset = new Context()
    unset.provide('settings', { get: () => undefined } as never)
    expect(readCloneDir(unset)).toBe('')
    const nonString = new Context()
    nonString.provide('settings', { get: () => ({ cloneDir: 42 }) } as never)
    expect(readCloneDir(nonString)).toBe('')
    const blank = new Context()
    blank.provide('settings', { get: () => ({ cloneDir: '   ' }) } as never)
    expect(readCloneDir(blank)).toBe('')
  })
})
