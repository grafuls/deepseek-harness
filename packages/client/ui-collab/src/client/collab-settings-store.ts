/**
 * Collaborative-workspaces settings state: the clone-directory preference in
 * the `collab` settings namespace (registered by the collab API host plugin),
 * derived through one bound scope plus the section's own interaction state
 * (draft text, save feedback). Writing an empty draft clears the field, so the
 * namespace re-inherits the composition default (the collab data root).
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** The settings namespace the collab host plugin registers (the clone directory). */
export const COLLAB_SETTINGS_NAMESPACE = 'collab'

/**
 * One wire section of the `collab` namespace as the settings section reads it.
 * A non-object section reads as empty, so a malformed durable value degrades to
 * the default instead of leaving the scope on a stale value.
 */
export interface CollabSettingsValue {
  /** Default directory for cloning repositories that back new workspaces; empty uses the collab data root. */
  cloneDir?: string
  /** Optional shallow-clone depth for repository bootstraps; absent clones full history. */
  cloneDepth?: number
}

/**
 * Narrow one wire section to {@link CollabSettingsValue}, or undefined when
 * the value is not an object (the scope keeps its last accepted snapshot).
 * @param section - the raw wire section.
 * @returns the collab settings value, or undefined for non-object sections.
 */
export function decodeCollabSettings(section: unknown): CollabSettingsValue | undefined {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section
    : undefined
}

/** The section's serializable snapshot the section component renders. */
export interface CollabSettingsState {
  /** Scope phase: loading until the first answer, then ready, unavailable, or error. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Persisted clone directory (`''` means the collab data root). */
  cloneDir: string
  /** Current clone-directory input text, including unsaved edits. */
  draft: string
  /** Persisted shallow-clone depth (`0` means full history). */
  cloneDepth: number
  /** Current clone-depth input text (`''` means full history). */
  depthDraft: string
  /** True right after a successful save, until a draft changes again. */
  saved: boolean
}

/** The initial snapshot before the first scope answer. */
export const COLLAB_SETTINGS_INITIAL: CollabSettingsState = {
  status: 'loading',
  cloneDir: '',
  draft: '',
  cloneDepth: 0,
  depthDraft: '',
  saved: false,
}

/**
 * Create the collab settings snapshot-store handle. The plugin body builds one
 * handle and shares it with the settings section; tests may call `.create()`
 * directly. No module handle is kept, so the store identity never pins across
 * plugin reloads.
 * @returns the snapshot store handle.
 */
export function createCollabSettingsStore(): SnapshotStore<CollabSettingsState> {
  return createSnapshotStore(COLLAB_SETTINGS_INITIAL)
}

/**
 * Drive the collab settings store over one bound scope: publish the persisted
 * clone directory and the write lifecycle, keeping the draft input
 * synchronized until the user edits it.
 */
export class CollabSettingsController {
  private readonly following: () => void

  /**
   * Create the controller and begin following the bound scope.
   * @param scope - the `collab` settings scope bound by the plugin body.
   * @param store - the shared settings snapshot store.
   */
  constructor(
    private readonly scope: SettingsScope<CollabSettingsValue>,
    private readonly store: SnapshotStore<CollabSettingsState>,
  ) {
    this.following = this.scope.subscribe(() => { this.derive() })
    this.derive()
  }

  /**
   * Reflect the scope's current answer into the store, keeping the draft input
   * untouched while the user is editing it.
   */
  private derive(): void {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.mode === 'memory' || snapshot.status === 'unavailable') {
      this.store.set({ ...COLLAB_SETTINGS_INITIAL, status: 'unavailable' })
      return
    }
    if (snapshot.status === 'loading') {
      this.store.set({ ...COLLAB_SETTINGS_INITIAL, status: 'loading' })
      return
    }
    const cloneDir = snapshot.value?.cloneDir ?? ''
    const depth = snapshot.value?.cloneDepth
    const cloneDepth = typeof depth === 'number' && Number.isInteger(depth) && depth >= 1 ? depth : 0
    this.store.update((state) => {
      // Re-seed a draft only while it still mirrors the previous persisted value
      // (or on first derivation), never when the user edited or cleared it:
      // an empty draft means "use the default", not "no draft yet".
      const previousDir = state.cloneDir
      const previousDepth = state.cloneDepth === 0 ? '' : String(state.cloneDepth)
      const persisted = cloneDepth === 0 ? '' : String(cloneDepth)
      state.status = 'ready'
      state.cloneDir = cloneDir
      state.cloneDepth = cloneDepth
      state.saved = false
      if (state.draft === previousDir) state.draft = cloneDir
      if (state.depthDraft === previousDepth) state.depthDraft = persisted
    })
  }

  /**
   * Update the input draft and mark the section dirty.
   * @param draft - the raw input text.
   */
  setDraft(draft: string): void {
    this.store.update((state) => {
      state.draft = draft
      state.saved = false
    })
  }

  /**
   * Update the clone-depth input draft and mark the section dirty.
   * @param depth - the raw input text (`''` means full history).
   */
  setDraftDepth(depth: string): void {
    this.store.update((state) => {
      state.depthDraft = depth
      state.saved = false
    })
  }

  /**
   * Persist the current draft as the clone directory, or clear the field when
   * empty (so the field re-inherits the composition default). Success is
   * judged against the state the write left behind, exactly like the scope's
   * own recovery contract.
   * @returns whether the persisted value now matches the drafted value.
   */
  async save(): Promise<boolean> {
    const draft = this.store.getSnapshot().draft.trim()
    const depthDraft = this.store.getSnapshot().depthDraft.trim()
    this.store.update((state) => { state.saved = false })
    if (draft === '') await this.scope.unset('cloneDir')
    else await this.scope.set('cloneDir', draft)
    if (depthDraft === '') await this.scope.unset('cloneDepth')
    else await this.scope.set('cloneDepth', Number(depthDraft))
    this.derive()
    const current = this.store.getSnapshot()
    const persisted = depthDraft === '' ? 0 : Number(depthDraft)
    if (current.status === 'ready' && current.cloneDir === draft && current.cloneDepth === persisted) {
      this.store.update((state) => { state.saved = true })
      return true
    }
    return false
  }

  /** Stop following the scope. */
  disconnect(): void {
    this.following()
  }
}
