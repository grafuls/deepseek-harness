// @vitest-environment node
/**
 * Collab session-order derivation (`nextCollabSessionOrder`): the browsing
 * region's base-account plus activity-promotion discipline for one collab
 * workspace, where the shared Host account is the order source of truth.
 * Covers both order modes, first observation, no-op advances, promotion with
 * interleave, the refreshed baseline (one promotion per advance), and the
 * recency tie-break.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { nextCollabSessionOrder } from '../src/client/collab-order.ts'

const sid = (id: string) => id as SessionId

function summary(id: string, updatedAt: number): SessionSummary {
  return {
    id: sid(id), displayTitle: id, running: false, blank: false, updatedAt,
  } as SessionSummary
}

function byIdOf(...items: SessionSummary[]): Record<SessionId, SessionSummary> {
  return Object.fromEntries(items.map(item => [item.id, item])) as Record<SessionId, SessionSummary>
}

const EMPTY: Readonly<Record<string, number>> = {}

describe('nextCollabSessionOrder', () => {
  it('keeps the shared account order verbatim under manual order', () => {
    const byId = byIdOf(summary('a', 3), summary('b', 5), summary('c', 1))
    const { order, observedUpdatedAt } = nextCollabSessionOrder([sid('a'), sid('b'), sid('c')], byId, EMPTY, 'manual')
    expect(order).toEqual([sid('a'), sid('b'), sid('c')])
    // The manual pass still records the observation baseline for a later switch.
    expect(observedUpdatedAt).toEqual({ a: 3, b: 5, c: 1 })
  })

  it('renders every first-observed session newest-first under updated order', () => {
    const byId = byIdOf(summary('a', 3), summary('b', 5), summary('c', 1))
    const { order } = nextCollabSessionOrder([sid('a'), sid('b'), sid('c')], byId, EMPTY, 'updated')
    // First sight has no baseline, so all sessions promote into a recency sort.
    expect(order).toEqual([sid('b'), sid('a'), sid('c')])
  })

  it('keeps account position when no session advanced since the baseline', () => {
    const byId = byIdOf(summary('a', 3), summary('b', 5), summary('c', 1))
    const { order } = nextCollabSessionOrder([sid('b'), sid('a'), sid('c')], byId, { a: 3, b: 5, c: 1 }, 'updated')
    expect(order).toEqual([sid('b'), sid('a'), sid('c')])
  })

  it('promotes only an advanced session ahead of the unchanged account order', () => {
    const byId = byIdOf(summary('a', 7), summary('b', 5), summary('c', 1))
    const { order } = nextCollabSessionOrder([sid('b'), sid('a'), sid('c')], byId, { a: 3, b: 5, c: 1 }, 'updated')
    // 'a' advanced 3 → 7 and leads; 'b' and 'c' keep their account positions.
    expect(order).toEqual([sid('a'), sid('b'), sid('c')])
  })

  it('returns the refreshed baseline so an advance promotes exactly once', () => {
    const byId = byIdOf(summary('a', 7), summary('b', 5))
    const first = nextCollabSessionOrder([sid('a'), sid('b')], byId, { a: 3, b: 5 }, 'updated')
    expect(first.order).toEqual([sid('a'), sid('b')])
    // The second pass observes the promoted baseline: no further promotion.
    expect(first.observedUpdatedAt).toEqual({ a: 7, b: 5 })
    const second = nextCollabSessionOrder([sid('a'), sid('b')], byId, first.observedUpdatedAt, 'updated')
    expect(second.order).toEqual([sid('a'), sid('b')])
    expect(second.observedUpdatedAt.a).toBe(7)
  })

  it('sorts advanced sessions newest-first with a stable id tie-break', () => {
    const byId = byIdOf(summary('adv1', 9), summary('adv2', 9), summary('rest', 1))
    const { order } = nextCollabSessionOrder([sid('rest'), sid('adv2'), sid('adv1')], byId, {
      adv1: 4, adv2: 4, rest: 1,
    }, 'updated')
    // Both advanced tie on recency; ids stay in ascending order.
    expect(order).toEqual([sid('adv1'), sid('adv2'), sid('rest')])
  })

  it('records observations only for sessions the store has pulled', () => {
    // The caller filters the mount account to present sessions; the helper
    // never promotes an absent id and simply skips it in the observation map.
    const byId = byIdOf(summary('a', 5), summary('c', 1))
    const { order, observedUpdatedAt } = nextCollabSessionOrder([sid('a'), sid('ghost'), sid('c')], byId, EMPTY, 'manual')
    expect(order).toEqual([sid('a'), sid('ghost'), sid('c')])
    expect(observedUpdatedAt.ghost).toBeUndefined()
  })

  it('keeps an unpulled session at its account position under updated order', () => {
    // The promote filter sees no summary and leaves the id in the rest block.
    const byId = byIdOf(summary('a', 5), summary('c', 1))
    const { order, observedUpdatedAt } = nextCollabSessionOrder([sid('a'), sid('ghost'), sid('c')], byId, { a: 1 }, 'updated')
    expect(order).toEqual([sid('a'), sid('c'), sid('ghost')])
    expect(observedUpdatedAt.ghost).toBeUndefined()
  })

  it('orders equal recency ties by descending session id too', () => {
    const byId = byIdOf(summary('a', 9), summary('b', 9))
    const { order } = nextCollabSessionOrder([sid('a'), sid('b')], byId, { a: 1, b: 1 }, 'updated')
    expect(order).toEqual([sid('a'), sid('b')])
  })
})
