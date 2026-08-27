// @vitest-environment jsdom
/**
 * LoginGate rendering: the overlay's visibility contract per gate state and
 * the sign-in/error plumbing. Props are fed directly (hooks bound by the
 * renderer in production); no render machinery here.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollabGateState } from '../src/client/contract.ts'
import { LoginGate } from '../src/client/LoginGate.tsx'

afterEach(() => {
  cleanup()
})

function gate(state: CollabGateState): { useCollabGate: <S>(sel: (s: CollabGateState) => S) => S } {
  return { useCollabGate: sel => sel(state) }
}

describe('LoginGate', () => {
  it('renders nothing once authenticated', () => {
    render(<LoginGate {...gate({ status: 'authenticated', authenticated: true, principalName: 'Owen' })} signIn={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders nothing while the collab surface is absent', () => {
    render(<LoginGate {...gate({ status: 'absent', authenticated: false })} signIn={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the signing backdrop while checking', () => {
    render(<LoginGate {...gate({ status: 'checking', authenticated: false })} signIn={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('登录以继续')).toBeTruthy()
  })

  it('shows the signing backdrop while unauthenticated and signs in on click', () => {
    const signIn = vi.fn()
    render(<LoginGate {...gate({ status: 'unauthenticated', authenticated: false })} signIn={signIn} />)
    fireEvent.click(screen.getByRole('button', { name: '使用 Google 登录' }))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('surfaces a server-side sign-in refusal', () => {
    render(
      <LoginGate {...gate({ status: 'unauthenticated', authenticated: false })} signIn={vi.fn()} signInError="signin-failed" />,
    )
    expect(screen.getByText('登录失败：signin-failed')).toBeTruthy()
  })

  it('omits the error notice without a refusal reason', () => {
    render(<LoginGate {...gate({ status: 'unauthenticated', authenticated: false })} signIn={vi.fn()} />)
    expect(screen.queryByText(/登录失败/)).toBeNull()
  })
})
