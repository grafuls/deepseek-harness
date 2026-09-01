// @vitest-environment jsdom
/**
 * SignOutControl rendering: the footer action's visibility contract per gate
 * state and its wide-row / rail circle forms, with the sign-out click
 * plumbing. Props are fed directly (hooks bound by the renderer in
 * production); no render machinery here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabGateState } from '../src/client/contract.ts'
import { en } from '../src/client/locales.ts'
import { SignOutControl, type SignOutControlProps } from '../src/client/SignOutControl.tsx'

afterEach(() => {
  cleanup()
})

function hooks(state: CollabGateState): { useCollabGate: <S>(sel: (s: CollabGateState) => S) => S } {
  return { useCollabGate: sel => sel(state) }
}

/** An English-bound translate seat for direct rendering (the renderer binds it in production). */
const t: SignOutControlProps['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

function props(state: CollabGateState, overrides: Partial<SignOutControlProps> = {}) {
  return {
    wide: true,
    signOut: vi.fn(),
    ...hooks(state),
    t,
    ...overrides,
  } as SignOutControlProps
}

describe('SignOutControl', () => {
  it('renders nothing while unauthenticated', () => {
    render(<SignOutControl {...props({ status: 'unauthenticated', authenticated: false })} />)
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
  })

  it('renders nothing while the collab surface is absent', () => {
    render(<SignOutControl {...props({ status: 'absent', authenticated: false })} />)
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
  })

  it('renders nothing while the session probe is still checking', () => {
    render(<SignOutControl {...props({ status: 'checking', authenticated: false })} />)
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
  })

  it('renders a labeled sign-out row in the wide column and signs out on click', () => {
    const signOut = vi.fn()
    render(
      <SignOutControl
        {...props({ status: 'authenticated', authenticated: true, principalName: 'Owen' }, { signOut })}
      />,
    )
    const button = screen.getByRole('button', { name: 'Sign out' })
    expect(screen.getByText('Sign out')).toBeTruthy()
    fireEvent.click(button)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('renders an icon-only circle in the collapsed rail with an accessible name', () => {
    const signOut = vi.fn()
    render(
      <SignOutControl
        {...props({ status: 'authenticated', authenticated: true, principalName: 'Owen' }, { wide: false, signOut })}
      />,
    )
    const button = screen.getByRole('button', { name: 'Sign out' })
    fireEvent.click(button)
    expect(signOut).toHaveBeenCalledTimes(1)
  })
})
