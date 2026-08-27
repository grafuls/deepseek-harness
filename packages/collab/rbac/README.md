# @deepseek-ai/dsh-collab-rbac

English | [中文](README.zh.md)

Role-based access control policy for the multi-user collab layer: two independent role planes and the pure decision "may this role perform this action?" The package owns the policy only; every enforcement boundary lives at the caller's call site.

## Roles

Two planes mirror the product's two trust scopes:

- Instance plane (`GlobalRole`: `admin` | `member`) — `admin` adds instance-wide user management (`users.read`, `users.manage`) to everything a `member` holds; `member` holds `users.self`, `workspace.create`, and `workspace.join`.
- Workspace plane (`WorkspaceRole`: `admin` | `developer`) — `admin` adds workspace management (`workspace.delete`, `workspace.invite`, `workspace.manage`, `workspace.members.manage`) to everything a `developer` holds; `developer` holds `workspace.use` and `workspace.members.read`.

The permission maps are exported (`GLOBAL_ROLE_PERMISSIONS`, `WORKSPACE_ROLE_PERMISSIONS`) so a role change updates one table and every consumer observes it.

## API

```ts
import RbacService, { hasGlobalPermission, authorizeWorkspace } from '@deepseek-ai/dsh-collab-rbac'

hasGlobalPermission('member', 'users.manage') // false
authorizeWorkspace('developer', 'workspace.invite') // throws CollabForbiddenError
```

- `hasGlobalPermission(role, permission)` / `hasWorkspacePermission(role, permission)` — pure booleans.
- `authorizeGlobal(role, permission)` / `authorizeWorkspace(role, permission)` — throw [`CollabForbiddenError`](#collabforbiddenerror) on denial.
- `RbacService` (mounted as `ctx.rbac`) — the same decisions as a Cordis service, so collab consumers inject one name and can swap implementations.

## Composition

```yaml
- id: collab-rbac
  name: '@deepseek-ai/dsh-collab-rbac'
```

Injects nothing; instantiate `RbacService` and name its row `collab-rbac` to expose `ctx.rbac`.

## CollabForbiddenError

Carries the denied `action` and the `role` that attempted it; the message embeds neither, so the error is safe to surface.

## Model Experience

None, as the policy registers no prompt, tool schema, or model-visible state; enforcement call sites own any model-visible effect.

#### KV Cache effect

The package contributes nothing to model requests, so it cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **Boundary enforcement is the caller's job** — this package decides, it does not mediate; a service that imports the helpers and forgets to authorize stays open, so the collab API gateway is the single gate that must not be bypassed.
- **Roles are static unions** — custom roles or per-resource grants are out of scope; a deployment that needs them extends the union and the permission maps.
