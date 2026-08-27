/** `collab.ui` namespace dictionaries: the workspaces trigger and manager copy. */

/** Dictionary namespace owned by ui-collab. */
export const NS = 'collab.ui'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  workspaces: '工作台',
  title: '协作工作区',
  close: '关闭',
  empty: '还没有工作区',
  members: '成员',
  invitations: '邀请',
  roleAdmin: '管理员',
  roleDeveloper: '开发者',
  memberCount: '{count} 名成员',
  workspaceName: '工作区名称',
  create: '创建',
  newWorkspace: '＋ 新建工作区',
  inviteMember: '＋ 邀请成员',
  invite: '邀请',
  invitationsForMe: '给我的邀请',
  accept: '接受',
  open: '打开',
  makeAdmin: '设为管理员',
  makeDeveloper: '设为开发者',
  revoke: '撤销',
  remove: '移除',
  deleteWorkspace: '删除工作区',
}

/** English dictionary (same key set). */
export const en: Record<CollabKey, string> = {
  workspaces: 'Workspaces',
  title: 'Collaborative workspaces',
  close: 'Close',
  empty: 'No workspaces yet',
  members: 'Members',
  invitations: 'Invitations',
  roleAdmin: 'Admin',
  roleDeveloper: 'Developer',
  memberCount: '{count} members',
  workspaceName: 'Workspace name',
  create: 'Create',
  newWorkspace: '＋ New workspace',
  inviteMember: '＋ Invite member',
  invite: 'Invite',
  invitationsForMe: 'Invitations for you',
  accept: 'Accept',
  open: 'Open',
  makeAdmin: 'Make admin',
  makeDeveloper: 'Make developer',
  revoke: 'Revoke',
  remove: 'Remove',
  deleteWorkspace: 'Delete workspace',
}

/** Union of this namespace's dictionary keys. */
export type CollabKey = keyof typeof zh
