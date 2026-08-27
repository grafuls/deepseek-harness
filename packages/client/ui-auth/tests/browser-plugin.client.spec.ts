// @vitest-environment jsdom
/**
 * ui-auth apply wiring against the real SlotRegistry: the gate registers as
 * the shell-overlay entry only once the layout declares it, the injected face
 * carries the gate store plus OIDC start plumbing, probes land in the store,
 * the sign-in action navigates the browser to the OIDC start URL, and fiber
 * teardown unregisters the entry and detaches the focus re-probe.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginGate, type CollabGateInjected } from '../src/client/LoginGate.tsx'
import { NS } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const realLocation = window.location

afterEach(async () => {
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true })
  vi.unstubAllGlobals()
})

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
    { name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
  return { ctx, slots, locale }
}

/** A minimal jsdom location substitute whose assign is an observable mock. */
type FakeLocation = Pick<Location, 'origin' | 'pathname' | 'search'> & { assign: ReturnType<typeof vi.fn> }

function fakeLocation(search: string = '?ref=1'): FakeLocation {
  return {
    origin: 'http://localhost:3080',
    pathname: '/agents/work',
    search,
    assign: vi.fn(),
  }
}

describe('ui-auth client plugin', () => {
  it('mounts as an inert node plugin the Loader can instantiate', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('declares the slot and locale services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the gate into the declared shell overlay and tears it down', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('shell.overlay')).toHaveLength(1)
    const entry = slots.entries('shell.overlay')[0]!
    expect(entry.component).toBe(LoginGate)
    await fiber.dispose()
    expect(slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('registers bilingual gate dictionaries that ride the standard locale seat', async () => {
    const { ctx, slots, locale } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    // Copy rides the standard locale seat, not the business face.
    expect(slots.entries('shell.overlay')[0]!.locale).toBe(NS)
    const t = locale.bind(NS)
    expect(t('title')).toBe('登录以继续')
    locale.setLocale('en')
    expect(t('title')).toBe('Sign in to continue')
    expect(t('signinError', { error: 'signin-failed' })).toBe('Sign-in failed: signin-failed')
  })

  it('walks a probe from checking to the wire verdict in the gate store', async () => {
    Object.defineProperty(window, 'location', { value: fakeLocation(), configurable: true })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ authenticated: false }),
    })))
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('shell.overlay')[0]!
    const face = (entry.inject as unknown as () => CollabGateInjected)()
    expect(face.hooks.collabGate.getSnapshot().authenticated).toBe(false)
    await new Promise(resolve => setImmediate(resolve))
    expect(face.hooks.collabGate.getSnapshot()).toEqual({ status: 'unauthenticated', authenticated: false })
    // A returned focus re-probes into the freshest verdict.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ authenticated: true, principal: { name: 'Owen' } }),
    })))
    window.dispatchEvent(new Event('focus'))
    await new Promise(resolve => setImmediate(resolve))
    expect(face.hooks.collabGate.getSnapshot()).toEqual({ status: 'authenticated', authenticated: true, principalName: 'Owen' })
  })

  it('navigates the browser to the OIDC start URL on sign-in', async () => {
    const location = fakeLocation()
    const { assign } = location
    Object.defineProperty(window, 'location', { value: location, configurable: true })
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('shell.overlay')[0]!
    const face = (entry.inject as unknown as () => CollabGateInjected)()
    face.signIn()
    expect(assign).toHaveBeenCalledWith(
      'http://localhost:3080/api/collab/auth/login?redirectTo=%2Fagents%2Fwork%3Fref%3D1')
  })

  it('reads the sign-in refusal reason from the current search', async () => {
    Object.defineProperty(window, 'location', {
      value: fakeLocation('?collab=signin-failed'),
      configurable: true,
    })
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('shell.overlay')[0]!
    const face = (entry.inject as unknown as () => CollabGateInjected)()
    expect(face.signInError).toBe('signin-failed')
  })

  it('omits the refusal notice without a bounced search', async () => {
    Object.defineProperty(window, 'location', { value: fakeLocation(), configurable: true })
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('shell.overlay')[0]!
    const face = (entry.inject as unknown as () => CollabGateInjected)()
    expect(face.signInError).toBeUndefined()
  })
})
