/**
 * The collab settings namespace: the per-instance clone-directory preference
 * the GUI's Collaborative Workspaces section renders. Registered by the collab
 * API assembly while a settings provider is mounted; the dispatch reads the
 * resolved section at create time, so a committed change applies to the next
 * workspace creation without a restart.
 * @module @deepseek-ai/dsh-collab-api/src/settings (internal)
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { GitCloneCredentials } from './clone.ts'

/** The settings namespace owning collab instance tuning. */
export const COLLAB_SETTINGS_NAMESPACE = settingsNamespace('collab')

/** The resolved collab settings section the dispatch reads and the GUI renders. */
export interface CollabSettingsSection {
  /** Default directory for cloning repositories that back new workspaces; empty uses the collab data root. */
  cloneDir: string
}

/** Namespace schema: one string preferd with an empty default (the collab data root). */
export const COLLAB_SETTINGS_SCHEMA: z<CollabSettingsSection> = z.object({
  cloneDir: z.string().default(''),
})

/**
 * Register the collab settings namespace while a settings provider is mounted,
 * using the composition `cloneDir` as the base layer so an operator default is
 * editable but not required. Dispatch reads the resolved section directly, so a
 * committed change applies to the next workspace creation without a restart.
 * @param ctx - the collab API plugin context.
 * @param config - the composition config (its `cloneDir` becomes the base layer).
 */
export function installCollabSettings(ctx: Context, config: { cloneDir?: string }): void {
  installSettingsSection(ctx, COLLAB_SETTINGS_NAMESPACE, COLLAB_SETTINGS_SCHEMA, {
    cloneDir: config.cloneDir ?? '',
  }, {
    // Every read happens at dispatch time through the settings provider.
    setSource: () => {},
    onChange: () => {},
  })
}

/**
 * Read the configured clone-directory preference, falling back to the collab
 * data root's `workspaces` layout when unset (`''` from the schema default).
 * @param ctx - the collab API plugin context.
 * @returns the effective default clone directory.
 */
export function readCloneDir(ctx: Context): string {
  const settings = ctx.get(
    'settings',
    false,
  ) as { get(ns: string): { cloneDir?: unknown } | undefined } | undefined
  const configured = settings?.get(String(COLLAB_SETTINGS_NAMESPACE))?.cloneDir
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  return explicit === '' ? '' : explicit
}

/**
 * Derive the server git clone credential from the collab API operator config:
 * a basic-auth pair pinned to one host, or undefined when no token is
 * configured (public repositories then clone unauthenticated). The host
 * defaults to `github.com`; the username defaults to `x-access-token`, which
 * GitHub accepts alongside a personal access token.
 * @param config - the collab API plugin config.
 * @returns the pinned git credential, or undefined without a configured token.
 */
export function cloneAuthFromConfig(config: {
  gitHost?: string
  gitUsername?: string
  gitToken?: string
}): GitCloneCredentials | undefined {
  const token = config.gitToken?.trim() ?? ''
  if (token === '') return undefined
  const host = config.gitHost ?? ''
  const username = config.gitUsername ?? ''
  return {
    host: host.trim() === '' ? 'github.com' : host.trim().toLowerCase(),
    username: username.trim() === '' ? 'x-access-token' : username,
    token,
  }
}
