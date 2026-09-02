/**
 * `workspace` namespace dictionaries: the pick/add flow (the sidebar browsing
 * region that used to share this namespace was removed). Runtime failure
 * messages (wire error strings) pass through untranslated by policy.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'menu.addWorkspace': '添加工作区…',
  'picker.loading': '正在加载工作区…',
  'folderError.title': '无法打开文件夹',
  'folderError.retry': '重新选择',
} satisfies Record<string, string>

/** The workspace namespace key union. */
export type WorkspaceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'menu.addWorkspace': 'Add workspace…',
  'picker.loading': 'Loading workspaces…',
  'folderError.title': 'Couldn’t open folder',
  'folderError.retry': 'Choose again',
} satisfies Record<WorkspaceKey, string>
