/**
 * Collab workspaces shared store, browser half. One snapshot store, created
 * by the plugin body and shared between the footer trigger and the overlay
 * panel, carries the panel's interaction state (open/closed, availability,
 * list, selection, detail) plus the error banner. The controller owns the
 * async RPC orchestration; the store itself is a plain snapshot source.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollabAvailability, CollabInvitationView, CollabMemberView, CollabRole, CollabWorkspaceView } from './contract.ts'

/** The workspaces manager's serializable snapshot. */
export interface CollabWorkspacesState {
  /** Whether the overlay panel is open. */
  open: boolean
  /** Collab surface verdict: checking on mount, then ready or hidden. */
  availability: CollabAvailability
  /** The signed-in member's workspace list. */
  workspaces: CollabWorkspaceView[]
  /** The selected workspace id, absent before a selection. */
  selectedId: string | undefined
  /** The signed-in user's role in the selected workspace (admin actions gate on it). */
  myRole: CollabRole | undefined
  /** Members of the selected workspace. */
  members: CollabMemberView[]
  /** Invitations of the selected workspace. */
  invitations: CollabInvitationView[]
  /** True while a workspace mutation is in flight. */
  working: boolean
  /** Last user-facing failure, absent when the panel is healthy. */
  error: string | undefined
}

/** The initial snapshot before the first availability probe settles. */
export const COLLAB_WORKSPACES_INITIAL: CollabWorkspacesState = {
  open: false,
  availability: 'checking',
  workspaces: [],
  selectedId: undefined,
  myRole: undefined,
  members: [],
  invitations: [],
  working: false,
  error: undefined,
}

/**
 * Create the workspaces store handle. The plugin body builds one handle and
 * shares it with the trigger and panel registrations; tests may call `.create()`
 * directly. No module handle is kept, so the store identity never pins across
 * plugin reloads.
 * @returns the snapshot store handle.
 */
export function createCollabWorkspacesStore(): SnapshotStore<CollabWorkspacesState> {
  return createSnapshotStore(COLLAB_WORKSPACES_INITIAL)
}
