# @deepseek-ai/dsh-collab-workspaces

English | [中文](README.zh.md)

Invite-only collab workspaces (`ctx.collabWorkspaces`): durable collaboration units with `admin`/`developer` members and pending invitations addressed to normalized emails, over one atomic `workspaces.json` document under the harness home. Anyone with the `workspace.create` permission mints a workspace and becomes its owner; everyone else joins only by consuming an invitation for their email.

## Storage

One JSON document `<root>/workspaces.json` (default `<harness home>/collab/workspaces.json`), validated by a zod schema at the storage boundary and written atomically with `0o600` permissions and a `0o700` parent. Same root as the user registry, so the two collab documents co-locate.

```ts
import type { WorkspaceId } from '@deepseek-ai/dsh-collab-workspaces'
import type { UserId } from '@deepseek-ai/dsh-collab-users'

interface WorkspaceRecord {
  id: WorkspaceId          // random UUID (or an explicit id supplied at bootstrap)
  name: string
  ownerId: UserId          // creator; always an admin member
  members: { userId: UserId; role: 'admin' | 'developer'; joinedAt: string }[]
  createdAt: string        // ISO-8601
  updatedAt: string
  repoUrl?: string         // git repository URL the workspace was bootstrapped from
  clonePath?: string       // absolute cloned-repository directory backing the workspace
}
```

A creator may bootstrap a workspace from a git repository. A provisioning bootstrap passes just `{ id, repoUrl }` to `create`, so the registry records no clone path yet and the member summaries carry `cloneState: 'cloning'`; the caller then settles the background result with `settleClone(id, { kind: 'cloned', clonePath })` (returns `'added'`, flipping the summary to `'ready'`), or `settleClone(id, { kind: 'failed' })` (`'removed'`, deleting the provisioning record). A caller that already produced the clone may pass `clonePath` at `create` to record it atomically with the record. Settling an already-settled or deleted record returns `'absent'`, which lets the caller drop an orphaned target directory. The registry never clones itself — the caller produces the clone and hands the record the facts — so a record never references a clone that was never created. `workspaceHolding(path)` resolves a Host-plane path beneath any recorded clone directory to its workspace, which is what lets the collab membership gate scope cloned working directories to members.

## Ownership and membership rules

- The **owner** creates the workspace, holds the `admin` role, and can never be demoted, removed, or leave — it must be deleted instead.
- **Invitations** are addressed to normalized emails (they survive a user identity change). An invite is pending, revoked, or consumed; a workspace refuses duplicate pending invites and invites to current members (the latter via the optional `collabUsers` registry).
- **Joining** consumes the invitation for the acting email and grants the invited role. The last-admin problem cannot arise: the owner is always an `admin`, so a workspace can never lose all administrators.

## API

```ts
import type { WorkspaceId, InvitationId, WorkspaceMember } from '@deepseek-ai/dsh-collab-workspaces'
import type { GlobalRole, WorkspaceRole } from '@deepseek-ai/dsh-collab-rbac'
import type { UserId } from '@deepseek-ai/dsh-collab-users'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
declare const memberGlobal: GlobalRole
declare const memberId: UserId
declare const actorWorkspaceRole: WorkspaceRole
declare const adminWorkspaceRole: WorkspaceRole
declare const email: string

const created = await ctx.collabWorkspaces.create(memberGlobal, memberId, 'docs') // needs workspace.create
const wsId: WorkspaceId = created.id
await ctx.collabWorkspaces.get(actorWorkspaceRole, memberId, wsId) // needs workspace.use
ctx.collabWorkspaces.listFor(memberId) // own membership summaries
ctx.collabWorkspaces.roleOf(wsId, memberId) // sync hot path
const invite: InvitationId = (await ctx.collabWorkspaces.invite(adminWorkspaceRole, wsId, memberId, email)).id // needs workspace.invite
ctx.collabWorkspaces.listPendingForEmail(email) // the pending invitations addressed to one email (the accept surface)
await ctx.collabWorkspaces.join(memberGlobal, memberId, email, invite) // needs workspace.join
await ctx.collabWorkspaces.revokeInvitation(adminWorkspaceRole, wsId, invite) // needs workspace.invite
await ctx.collabWorkspaces.leave(actorWorkspaceRole, memberId, wsId) // needs workspace.use
const members: WorkspaceMember[] = await ctx.collabWorkspaces.listMembers(adminWorkspaceRole, wsId) // needs workspace.members.read
await ctx.collabWorkspaces.setMemberRole(adminWorkspaceRole, wsId, memberId, 'developer') // needs workspace.members.manage
await ctx.collabWorkspaces.removeMember(adminWorkspaceRole, wsId, memberId) // needs workspace.members.manage
await ctx.collabWorkspaces.delete(adminWorkspaceRole, wsId) // needs workspace.delete
```


Every mutating method takes the acting roles explicitly and defers the decision to `dsh-collab-rbac` at the operation that makes it, so a member wielding a `developer` role cannot invite or administer.

## Optional user-registry coupling

The workspace registry reads identity facts (`id` ↔ `email`) from the optional sibling `collabUsers` service via `ctx.get`. With it mounted, inviting a current member is refused; standalone (no user registry), the registry still enforces invite-gating, email matching, and membership uniqueness structurally.

## Events

`collab/workspaces/changed` — emitted after every committed mutation with the frozen `{ workspaces, invitations }` snapshot. The invariant companion subscribes and fails loud on duplicate workspace or invitation ids, duplicate memberships, or an owner that is not an `admin` member.

## Composition

```yaml
- id: collab-workspaces
  name: '@deepseek-ai/dsh-collab-workspaces'
  config:
    dshHome: !!js dshHome
```

## Model Experience

None, as the workspace registry stores membership and invitations and registers nothing model-facing; collab surface consumers own any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **The workspace is a metadata unit, not yet a file boundary.** The registry models membership; mapping each workspace to its own `$DSH_HOME/collab/workspaces/<wsId>/` directory for session-log and file isolation is the collab assembly's job and is deferred to the collab-api host plugin.
- **Inviting a current member needs the user registry.** Without `collabUsers` mounted, membership-by-email cannot be filtered on invite (join still enforces it structurally); the collab bundle always mounts both.
- **No ownership transfer.** A workspace has one permanent owner; stepping down requires deleting the workspace.
