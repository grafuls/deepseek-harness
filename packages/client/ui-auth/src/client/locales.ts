/** `collab.auth` namespace dictionaries: the sign-in gate copy. */

/** Dictionary namespace owned by ui-auth. */
export const NS = 'collab.auth'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  title: '登录以继续',
  hint: '此实例由 Google 账号授权。登录后可访问协作工作区。',
  signin: '使用 Google 登录',
  signinError: '登录失败：{error}',
}

/** English dictionary (same key set). */
export const en: Record<AuthKey, string> = {
  title: 'Sign in to continue',
  hint: 'This instance is authorized by Google accounts. Sign in to access collaborative workspaces.',
  signin: 'Sign in with Google',
  signinError: 'Sign-in failed: {error}',
}

/** Union of this namespace's dictionary keys. */
export type AuthKey = keyof typeof zh
