/**
 * Browser-side patch download for a collab session. The controller resolves the
 * diff text; the presentation layer owns the DOM side effect of turning it into
 * a downloadable file the member can apply locally with `git apply`.
 * @module @deepseek-ai/dsh-client-ui-collab/src/client/patch-download (internal)
 */

import type { CollabPatchView } from './contract.ts'

/**
 * Trigger a browser download of a diff patch as a file named by the view. The
 * patch text is wrapped in a Blob, an anchor is clicked through, and the object
 * URL is released so long-lived open sessions do not leak it.
 * @param view - the branch diff to save, with its suggested filename.
 */
export function downloadPatchFile(view: CollabPatchView): void {
  const blob = new Blob([view.patch], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = view.filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
