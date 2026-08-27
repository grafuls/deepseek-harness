// WorkspacesTrigger: the sidebar foot action that opens the collab workspaces
// manager. Registered into ui-sidebar's `sidebar.footer.action` list; it
// renders nothing while the collab surface is absent, so a single-user web
// install's foot is unchanged.

import type { ReactNode } from 'react'
import type { WorkspacesPanelProps } from './WorkspacesPanel.tsx'

/** Composed trigger props (hooks bound, plain members passed through). */
export type WorkspacesTriggerProps = WorkspacesPanelProps

/**
 * Render the workspaces foot action while the collab surface is ready.
 * @param props - the workspaces store hook plus the collab actions.
 * @returns the trigger button, or null when no collab surface applies.
 */
export function WorkspacesTrigger({ useCollabWorkspaces, actions }: WorkspacesTriggerProps): ReactNode {
  const state = useCollabWorkspaces(current => current)
  if (state.availability !== 'ready') return null
  return (
    <button type="button" onClick={state.open ? actions.closePanel : actions.openPanel}>工作台</button>
  )
}
