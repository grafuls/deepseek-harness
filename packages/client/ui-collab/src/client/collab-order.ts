/**
 * Collab session-order derivation: the browsing region's order discipline
 * ported to a collab workspace. The shared Host session account (the export
 * `sessionIds` order) is the order source of truth — there is no per-machine
 * manual copy, because the order is shared across members and drags persist it
 * server-side. Under `updated` a session whose update advanced over the
 * previous observation (or is first observed) leads newest-first and the rest
 * keep account position, so a member's drag is never silently undone by a
 * full recency sort; under `manual` the account order shows verbatim.
 */

import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollabOrderBy } from './store.ts'

/** The account order plus the observed-update timestamps for the next pass. */
export interface CollabSessionOrder {
  order: readonly SessionId[]
  observedUpdatedAt: Readonly<Record<string, number>>
}

/**
 * Newest update first with stable Session identity as the tie-break.
 * The comparator only sees sessions the caller established as present (the
 * promotion filter below drops absent ids), so both summaries resolve.
 * @param a - first session id.
 * @param b - second session id.
 * @param byId - session summaries by id.
 * @returns negative when `a` is older, positive when newer, id-ordered on ties.
 */
function compareSessionRecency(
  a: SessionId,
  b: SessionId,
  byId: Readonly<Record<SessionId, SessionSummary>>,
): number {
  const aUpdatedAt = byId[a]!.updatedAt
  const bUpdatedAt = byId[b]!.updatedAt
  if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt - aUpdatedAt
  return a < b ? -1 : 1
}

/** Record each present session's current update time for the next pass. */
function observe(
  sessionIds: readonly SessionId[],
  byId: Readonly<Record<SessionId, SessionSummary>>,
): Record<string, number> {
  const observed: Record<string, number> = {}
  for (const id of sessionIds) {
    const session = byId[id]
    if (session !== undefined) observed[id as string] = session.updatedAt
  }
  return observed
}

/**
 * Derive one collab workspace's displayed session order. The caller supplies
 * the account's present session ids (mount order, filtered to sessions the
 * store has pulled) and the previously observed update times; the returned
 * `observedUpdatedAt` is what the caller records for the next pass, so a
 * promoted session's new timestamp becomes its baseline and it needs another
 * advance to lead again (mirrors the browsing region's activity-promotion
 * policy).
 * @param sessionIds - the shared account order, in mount order.
 * @param byId - session summaries by id.
 * @param observedUpdatedAt - update times observed on the previous pass.
 * @param orderBy - the collab list order mode.
 * @returns the displayed order and refreshed observation map.
 */
export function nextCollabSessionOrder(
  sessionIds: readonly SessionId[],
  byId: Readonly<Record<SessionId, SessionSummary>>,
  observedUpdatedAt: Readonly<Record<string, number>>,
  orderBy: CollabOrderBy,
): CollabSessionOrder {
  const observed = observe(sessionIds, byId)
  if (orderBy !== 'updated') return { order: [...sessionIds], observedUpdatedAt: observed }
  const promoted = sessionIds
    .filter(id => {
      // If the store has not pulled the session yet, it stays at its account
      // position (the caller usually filters these up front anyway).
      const updatedAt = byId[id]?.updatedAt
      return updatedAt !== undefined && updatedAt > (observedUpdatedAt[id as string] ?? Number.NEGATIVE_INFINITY)
    })
    .sort((a, b) => compareSessionRecency(a, b, byId))
  if (promoted.length === 0) return { order: [...sessionIds], observedUpdatedAt: observed }
  if (promoted.length === sessionIds.length) return { order: promoted, observedUpdatedAt: observed }
  const promotedSet = new Set(promoted)
  return {
    order: [...promoted, ...sessionIds.filter(id => !promotedSet.has(id))],
    observedUpdatedAt: observed,
  }
}
