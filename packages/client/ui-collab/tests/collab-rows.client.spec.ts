// @vitest-environment node
/**
 * Pure row-modeling helpers (collab-rows.ts): the relative-time bucket
 * boundaries, the row/created/hover time labels through the dictionary, the
 * session status ladder, and the blank-row title rule. These formatting
 * surfaces are translate-seated, so they are unit-tested here with a matched
 * dictionary rather than exercised through rendered rows.
 */
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { en } from '../src/client/locales.ts'
import {
  collabSessionStatuses,
  collabSessionTitle,
  createdLabel,
  hoverTimeLabel,
  relativeTime,
  timeLabel,
  type CollabRowTranslate,
} from '../src/client/collab-rows.ts'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const t: CollabRowTranslate = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (
      name in params ? String(params[name]) : match))
}

const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1' as SessionSummary['id'],
  displayTitle: 'Plotting',
  running: false,
  blank: false,
  updatedAt: 0,
  ...overrides,
})

describe('relativeTime', () => {
  it('buckets an age under a minute as now', () => {
    expect(relativeTime(9_999, 10_000).unit).toBe('now')
  })

  it('buckets minutes, hours, days, months, and years with floor magnitudes', () => {
    expect(relativeTime(10_000 - 2 * MIN, 10_000)).toEqual({ unit: 'minutes', n: 2 })
    expect(relativeTime(10_000 - 3 * HOUR, 10_000)).toEqual({ unit: 'hours', n: 3 })
    expect(relativeTime(10_000 - 4 * DAY, 10_000)).toEqual({ unit: 'days', n: 4 })
    expect(relativeTime(10_000 - 5 * 30 * DAY, 10_000)).toEqual({ unit: 'months', n: 5 })
    expect(relativeTime(10_000 - 6 * 365 * DAY, 10_000)).toEqual({ unit: 'years', n: 6 })
  })

  it('clamps boundary ages into the next bucket', () => {
    // Exactly an hour is no longer "minutes".
    expect(relativeTime(10_000 - HOUR, 10_000).unit).toBe('hours')
    // Exactly thirty days is no longer "days".
    expect(relativeTime(10_000 - 30 * DAY, 10_000).unit).toBe('months')
    // Exactly a year is no longer "months".
    expect(relativeTime(10_000 - 365 * DAY, 10_000).unit).toBe('years')
  })

  it('clamps a future timestamp to now', () => {
    expect(relativeTime(10_000 + 5 * MIN, 10_000).unit).toBe('now')
  })
})

describe('timeLabel', () => {
  it('renders the bare now string for the now bucket', () => {
    expect(timeLabel(10_000, 10_000, t)).toBe('now')
  })

  it('renders a localized distance for a concrete bucket', () => {
    expect(timeLabel(10_000 - 5 * MIN, 10_000, t)).toBe('5min')
    expect(timeLabel(10_000 - 2 * DAY, 10_000, t)).toBe('2d')
  })
})

describe('hoverTimeLabel', () => {
  it('keeps the now bucket bare', () => {
    expect(hoverTimeLabel(10_000, 10_000, t)).toBe('now')
  })

  it('wraps a distance bucket in the ago template', () => {
    expect(hoverTimeLabel(10_000 - 3 * HOUR, 10_000, t)).toBe('3h ago')
  })
})

describe('createdLabel', () => {
  it('formats the absolute date and time through the dictionary', () => {
    // 2021-02-03 04:05 UTC — local browser time applies, so only the date.y-m-d
    // pattern and the zero-padded clock are pinned.
    const label = createdLabel(Date.UTC(2021, 1, 3, 4, 5), t)
    expect(label).toContain('Created')
    expect(label).toMatch(/\d{2}:\d{2}$/)
  })
})

describe('collabSessionStatuses', () => {
  it.each([
    ['approval', 'Waiting for approval'],
    ['plan-review', 'Plan awaiting review'],
    ['question', 'Waiting for answer'],
  ] as const)('ranks a pending %s interaction above activity', (kind, label) => {
    const [status] = collabSessionStatuses(summary({ pendingInteraction: kind, running: true }), t)
    expect(status.state).toBe('warning')
    expect(status.label).toBe(label)
  })

  it('renders running for live activity without a wait', () => {
    const [status] = collabSessionStatuses(summary({ running: true }), t)
    expect(status).toEqual({ state: 'ongoing', label: 'Running' })
  })

  it('renders the completed reminder for finished unopened sessions', () => {
    const [status] = collabSessionStatuses(summary({ completed: true }), t)
    expect(status).toEqual({ state: 'done', label: 'Completed' })
  })

  it('falls back to the idle tone', () => {
    const [status] = collabSessionStatuses(summary(), t)
    expect(status).toEqual({ state: 'done', label: 'Idle' })
  })
})

describe('collabSessionTitle', () => {
  it('labels a blank row with New Session', () => {
    expect(collabSessionTitle(summary({ blank: true }), t)).toBe('New Session')
  })

  it('uses the durable display title otherwise', () => {
    expect(collabSessionTitle(summary(), t)).toBe('Plotting')
  })
})
