/**
 * Session push copy, shared by the collab section's push dialog. Pulled out of
 * the workspaces manager when branch push moved from the workspace detail to
 * the session row menu, so both surfaces (if a second one ever appears) render
 * the dry-run and outcome copy from one seat.
 */

import type { CollabPushView } from './contract.ts'
import type { CollabRowTranslate } from './collab-rows.ts'

/**
 * Push-result copy per the push outcome kind: moved the remote, already
 * current there, or a dry-run that touched nothing.
 * @param t - the `collab.ui` translate seat.
 * @param pushResult - the push outcome to describe.
 * @returns the localized one-line outcome.
 */
export function pushOutcomeCopy(t: CollabRowTranslate, pushResult: CollabPushView): string {
  if (pushResult.pushed) return t('pushedOk', { branch: pushResult.branch, sha: pushResult.remoteSha ?? pushResult.localSha })
  if (pushResult.upToDate) return t('pushedUpToDate', { branch: pushResult.branch })
  return t('pushPreviewOnly')
}

/**
 * Confirmation-row copy: the branch label before a preview, the up-to-date
 * notice, or the count preview once the dry run has answered.
 * @param t - the `collab.ui` translate seat.
 * @param preview - the dry-run outcome, or undefined while it loads.
 * @param branch - the branch being pushed (the label when no preview yet).
 * @returns the localized confirmation-line copy.
 */
export function pushPreviewCopy(t: CollabRowTranslate, preview: CollabPushView | undefined, branch: string): string {
  if (preview === undefined) return t('pushConfirm', { branch: branch === '' ? t('currentBranch') : branch })
  if (preview.upToDate) return t('pushUpToDate', { branch: preview.branch })
  return t('pushPreview', {
    branch: preview.branch,
    base: preview.base,
    ahead: String(preview.ahead ?? 0),
    behind: String(preview.behind ?? 0),
  })
}
