/**
 * Pure row-modeling helpers for the collab section's rows, mirroring the local
 * Workspaces browsing region (ui-workspace rows/rows.tsx + tree.ts): compact
 * relative time, creation-time copy, and the session status set rendered by
 * the status dot and the hover card. Kept side-effect free and translate-seated
 * so the row components stay presentational and the branch surfaces are
 * directly unit-testable.
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollabKey } from './locales.ts'

/** The `collab.ui` translate seat the rows consume. */
export type CollabRowTranslate = TranslateNS<'collab.ui'>

/** Compact relative-time bucket for a session row's trailing time cell. */
export interface CollabRelativeTime {
  /** Localized bucket key suffix; 'now' renders the bare now string. */
  unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  /** Bucket magnitude for the distance template. */
  n: number
}

/**
 * Collapse an epoch-ms age into a localized distance bucket. Newer-than-a-minute
 * is 'now'; then minutes, hours, days, months, and years, floor-divided.
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the row's trailing time bucket and magnitude.
 */
export function relativeTime(updatedAt: number, now: number): CollabRelativeTime {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

/** Locale key for each non-now distance bucket. */
const TIME_KEY: Record<Exclude<CollabRelativeTime['unit'], 'now'>, CollabKey> = {
  minutes: 'timeMinutes',
  hours: 'timeHours',
  days: 'timeDays',
  months: 'timeMonths',
  years: 'timeYears',
}

/**
 * The session row's trailing compact time ("now"/"5min"/"3h" style).
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms.
 * @param t - the `collab.ui` translate seat.
 * @returns the localized distance label.
 */
export function timeLabel(updatedAt: number, now: number, t: CollabRowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('timeNow') : t(TIME_KEY[unit], { n })
}

/**
 * The hover-card time line: the same distance wrapped in the ago template
 * ("5min ago"), with the now bucket bare (a trailing "now ago" reads badly).
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms.
 * @param t - the `collab.ui` translate seat.
 * @returns the hover distance label.
 */
export function hoverTimeLabel(updatedAt: number, now: number, t: CollabRowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('timeNow') : t('timeAgo', { t: t(TIME_KEY[unit], { n }) })
}

/**
 * Absolute creation-time line through the dictionary's date template (the
 * message clock pattern): `toLocaleString` would follow the browser language,
 * not the app locale, and produce mixed-language text after a switch.
 * @param createdAt - epoch ms of the workspace's creation.
 * @param t - the `collab.ui` translate seat.
 * @returns the localized creation line.
 */
export function createdLabel(createdAt: number, t: CollabRowTranslate): string {
  const d = new Date(createdAt)
  const pad2 = (v: number): string => String(v).padStart(2, '0')
  const date = t('dateYmd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return t('hoverCreated', { time: `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` })
}

/** One status dot presentation: the StateDot tone plus its screen-reader label. */
export interface CollabSessionStatus {
  state: StateDotState
  label: string
}

/**
 * The status set a collab session row renders: a pending user interaction
 * outranks live activity, which outranks the finished-unviewed reminder, and
 * an idle session shows the idle tone. Shared sessions carry no subagent
 * counts on their summary, so descendant activity is not distinguished here.
 * @param summary - the session summary to model.
 * @param t - the `collab.ui` translate seat.
 * @returns the ordered statuses, newest-meaning first.
 */
export function collabSessionStatuses(
  summary: Pick<SessionSummary, 'pendingInteraction' | 'running' | 'completed'>,
  t: CollabRowTranslate,
): readonly [CollabSessionStatus, ...CollabSessionStatus[]] {
  const pending = summary.pendingInteraction === 'approval'
    ? { state: 'warning' as const, label: t('statusWaitingApproval') }
    : summary.pendingInteraction === 'plan-review'
      ? { state: 'warning' as const, label: t('statusPlanReview') }
      : summary.pendingInteraction === 'question'
        ? { state: 'warning' as const, label: t('statusWaitingAnswer') }
        : undefined
  if (pending !== undefined) return [pending]
  if (summary.running) return [{ state: 'ongoing', label: t('statusRunning') }]
  if (summary.completed === true) return [{ state: 'done', label: t('statusCompleted') }]
  return [{ state: 'done', label: t('statusIdle') }]
}

/**
 * The row display title: blank rows show the localized New Session label,
 * matching the browsing region's placeholder rule.
 * @param summary - the session summary to label.
 * @param t - the `collab.ui` translate seat.
 * @returns the display title.
 */
export function collabSessionTitle(summary: SessionSummary, t: CollabRowTranslate): string {
  return summary.blank ? t('newSession') : summary.displayTitle
}
