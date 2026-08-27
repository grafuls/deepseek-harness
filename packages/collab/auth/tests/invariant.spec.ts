import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AuthInvariant from '@deepseek-ai/dsh-collab-auth/invariant'

describe('invariant companion', () => {
  it('registers a justified empty installer and returns a disposer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const dispose = await AuthInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
    await ctx.fiber.dispose()
  })
})
