// @vitest-environment node
/**
 * Pure drag order math for the collab session rows: `commitCollabSessionDrag`
 * resolves a drop into the shared Host account move (anchor before/after,
 * append, no-op skips, unknown targets) and `buildRowDragProps` lays out the
 * per-row drag lifecycle (idle no-ops, start, hover markers, the drop/drag-end
 * commit paths, and the one-shot drop guard). Both are exported from
 * CollabSection so their branches are covered directly instead of only through
 * pointer choreography in the component spec.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  buildRowDragProps, commitCollabSessionDrag, type CollabDragState,
} from '../src/client/CollabSection.tsx'

const sid = (id: string) => id as SessionId

function drag(source: string, overId: string | null, half?: 'before' | 'after'): CollabDragState {
  return {
    workspaceId: 'w1',
    sessionId: sid(source),
    over: overId === null ? null : { id: sid(overId), half: (half ?? 'before') as 'before' | 'after' },
  }
}

function committed(): { current: boolean } {
  return { current: false }
}

describe('commitCollabSessionDrag', () => {
  it('moves a session before a target it currently follows', () => {
    const reorder = vi.fn()
    commitCollabSessionDrag(drag('c', 'b', 'before'), { id: sid('b'), half: 'before' }, [sid('a'), sid('b'), sid('c')] as const, reorder)
    expect(reorder).toHaveBeenCalledExactlyOnceWith('c', 'b')
  })

  it('moves a session after a middle target by anchoring on its successor', () => {
    const reorder = vi.fn()
    commitCollabSessionDrag(drag('a', 'b', 'after'), { id: sid('b'), half: 'after' }, [sid('a'), sid('b'), sid('c')] as const, reorder)
    expect(reorder).toHaveBeenCalledExactlyOnceWith('a', 'c')
  })

  it('appends a session dropped on the trailing row half', () => {
    const reorder = vi.fn()
    commitCollabSessionDrag(drag('b', 'c', 'after'), { id: sid('c'), half: 'after' }, [sid('a'), sid('b'), sid('c')] as const, reorder)
    expect(reorder).toHaveBeenCalledExactlyOnceWith('b', undefined)
  })

  it('skips a drop on the session itself', () => {
    const reorder = vi.fn()
    commitCollabSessionDrag(drag('a', 'a', 'before'), { id: sid('a'), half: 'before' }, [sid('a'), sid('b')] as const, reorder)
    expect(reorder).not.toHaveBeenCalled()
  })

  it('skips a drop one slot below the source (no movement)', () => {
    const reorder = vi.fn()
    commitCollabSessionDrag(drag('a', 'b', 'before'), { id: sid('b'), half: 'before' }, [sid('a'), sid('b')] as const, reorder)
    expect(reorder).not.toHaveBeenCalled()
  })

  it('skips a drop on the trailing half of the session itself', () => {
    const reorder = vi.fn()
    commitCollabSessionDrag(drag('b', 'b', 'after'), { id: sid('b'), half: 'after' }, [sid('a'), sid('b')] as const, reorder)
    expect(reorder).not.toHaveBeenCalled()
  })

  it('ignores a target outside the account order', () => {
    const reorder = vi.fn()
    commitCollabSessionDrag(drag('a', 'zzz', 'before'), { id: sid('zzz'), half: 'before' }, [sid('a'), sid('b')] as const, reorder)
    expect(reorder).not.toHaveBeenCalled()
  })
})

describe('buildRowDragProps', () => {
  it('stays inert while no drag is in flight', () => {
    const next = vi.fn()
    const commit = vi.fn()
    const dropCommitted = committed()
    const props = buildRowDragProps(null, 'w1', sid('a'), commit, next, dropCommitted)
    expect(props.active).toBe(false)
    expect(props.marker).toBeNull()
    props.hover('before')
    props.drop('before')
    expect(commit).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    props.end()
    expect(next).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('starts a drag from an idle row', () => {
    const next = vi.fn()
    const dropCommitted = committed()
    const props = buildRowDragProps(null, 'w1', sid('a'), vi.fn(), next, dropCommitted)
    props.start()
    expect(next).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'w1', sessionId: sid('a'), over: null })
  })

  it('marks the hovered row of the dragged workspace and stays inert elsewhere', () => {
    const committedGuard = committed()
    const next = vi.fn()
    const props = buildRowDragProps(drag('a', 'a', 'after'), 'w1', sid('a'), vi.fn(), next, committedGuard)
    expect(props.active).toBe(true)
    expect(props.marker).toBe('after')
    props.hover('before')
    expect(next).toHaveBeenCalledExactlyOnceWith({ ...drag('a', 'a', 'after'), over: { id: sid('a'), half: 'before' } })
    const rowForeign = buildRowDragProps(drag('a', null, 'before'), 'w2', sid('x'), vi.fn(), vi.fn(), committed())
    expect(rowForeign.active).toBe(false)
    expect(rowForeign.marker).toBeNull()
  })

  it('reports hover on the dragged row even before a marker is set', () => {
    const next = vi.fn()
    const props = buildRowDragProps(drag('a', null, 'before'), 'w1', sid('a'), vi.fn(), next, committed())
    props.hover('before')
    expect(next).toHaveBeenCalledExactlyOnceWith({ ...drag('a', null, 'before'), over: { id: sid('a'), half: 'before' } })
  })

  it('commits once on drop and guards the trailing drag-end', () => {
    const commit = vi.fn()
    const next = vi.fn()
    const dropCommitted = committed()
    const source = drag('a', null, 'before')
    const props = buildRowDragProps(source, 'w1', sid('b'), commit, next, dropCommitted)
    props.drop('before')
    expect(commit).toHaveBeenCalledExactlyOnceWith(source, { id: sid('b'), half: 'before' })
    expect(dropCommitted.current).toBe(true)
    props.drop('after')
    expect(commit).toHaveBeenCalledTimes(1)
    props.end()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('commits the last marker on drag end without a drop', () => {
    const commit = vi.fn()
    const next = vi.fn()
    const source = drag('a', 'b', 'after')
    const props = buildRowDragProps(source, 'w1', sid('a'), commit, next, committed())
    props.end()
    expect(commit).toHaveBeenCalledExactlyOnceWith(source, { id: sid('b'), half: 'after' })
  })

  it('clears the drag on drag end before any marker', () => {
    const commit = vi.fn()
    const next = vi.fn()
    const props = buildRowDragProps(drag('a', null, 'before'), 'w1', sid('a'), commit, next, committed())
    props.end()
    expect(commit).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledExactlyOnceWith(null)
  })
})
