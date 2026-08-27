// @vitest-environment jsdom
/**
 * LoginGate rendering: the overlay's visibility contract per gate state and
 * the sign-in/error plumbing. Props are fed directly (hooks bound by the
 * renderer in production); no render machinery here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabGateState } from '../src/client/contract.ts'
import { LoginGate, type LoginGateProps } from '../src/client/LoginGate.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
})

function gate(state: CollabGateState): { useCollabGate: <S>(sel: (s: CollabGateState) => S) => S } {
  return { useCollabGate: sel => sel(state) }
}

/** An English-bound translate seat for direct rendering (the renderer binds it in production). */
const t: LoginGateProps['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

describe('LoginGate', () => {
  it('renders nothing once authenticated', () => {
    render(<LoginGate {...gate({ status: 'authenticated', authenticated: true, principalName: 'Owen' })} signIn={vi.fn()} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders nothing while the collab surface is absent', () => {
    render(<LoginGate {...gate({ status: 'absent', authenticated: false })} signIn={vi.fn()} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the signing backdrop while checking', () => {
    render(<LoginGate {...gate({ status: 'checking', authenticated: false })} signIn={vi.fn()} t={t} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Sign in to continue')).toBeTruthy()
  })

  it('shows the signing backdrop while unauthenticated and signs in on click', () => {
    const signIn = vi.fn()
    render(<LoginGate {...gate({ status: 'unauthenticated', authenticated: false })} signIn={signIn} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('surfaces a server-side sign-in refusal', () => {
    render(
      <LoginGate {...gate({ status: 'unauthenticated', authenticated: false })} signIn={vi.fn()} signInError="signin-failed" t={t} />,
    )
    expect(screen.getByText('Sign-in failed: signin-failed')).toBeTruthy()
  })

  it('omits the error notice without a refusal reason', () => {
    render(<LoginGate {...gate({ status: 'unauthenticated', authenticated: false })} signIn={vi.fn()} t={t} />)
    expect(screen.queryByText(/Sign-in failed/)).toBeNull()
  })
})
