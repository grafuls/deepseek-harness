/**
 * Collab wire contract, browser half. The client calls the collab endpoints
 * through the shared Connection RPC channel (`/api`, the same envelope and
 * transport the rest of the GUI uses), and the collab API gateway's auth
 * fence enforces sign-in server-side. The `collab/*` endpoint names and
 * result fields are the browser half of the collab API gateway's dispatch
 * table (the host owns the same literals in `@deepseek-ai/dsh-collab-api`);
 * this package cannot import the host package, so the pairing is pinned by
 * both packages' tests.
 */

/**
 * Collab endpoints extend the shared envelope's error codes (collab-forbidden,
 * collab-not-found, collab-bad-request) as strings; the connection types the
 * envelope itself, so the channel carries a duck result whose error code is a
 * plain string. The connection's own RpcResult is assignable to this duck, so
 * wiring `rpc.call` in needs no cast.
 */
export interface CollabRpcResultOk<T> {
  ok: true
  value: T
}

/** An `ok:false` collab envelope: gateway error code plus message. */
export interface CollabRpcResultError {
  ok: false
  error: { code: string; message: string }
}

/** A collab workspace role. */
export type CollabRole = 'admin' | 'developer'

/** One workspace in the signed-in member's list. */
export interface CollabWorkspaceView {
  /** Opaque branded workspace id (string on the wire). */
  id: string
  /** Display name. */
  name: string
  /** Number of members (owner included). */
  memberCount: number
  /** Whether the signed-in user owns this workspace. */
  isOwner: boolean
  /** The signed-in user's role in this workspace. */
  role: CollabRole
  /** Creation timestamp (ISO 8601). */
  createdAt: string
}

/** One workspace member. */
export interface CollabMemberView {
  /** Opaque branded user id (string on the wire). */
  userId: string
  /** Account email; empty when the account is unknown to the registry. */
  email: string
  /** Account display name; empty when unknown. */
  name: string
  /** The member's role in the workspace. */
  role: CollabRole
  /** When the member joined (ISO 8601). */
  joinedAt: string
}

/** One workspace invitation, pending, revoked, or consumed. */
export interface CollabInvitationView {
  /** Opaque branded invitation id (string on the wire). */
  id: string
  /** The inviting workspace. */
  workspaceId: string
  /** The invited email address (normalized lowercase). */
  email: string
  /** The role the invite grants. */
  role: CollabRole
  /** The inviting user's id. */
  createdBy: string
  /** Invitation creation timestamp (ISO 8601). */
  createdAt: string
  /** Whether the invitation was revoked by an admin. */
  revoked: boolean
  /** When the invite was consumed (ISO 8601); present only once joined. */
  usedAt?: string
}

/** A pending invitation addressed to the signed-in user, for the accept surface. */
export interface CollabMyInvitationView {
  /** Opaque branded invitation id (string on the wire). */
  id: string
  /** The inviting workspace. */
  workspaceId: string
  /** The inviting workspace's display name. */
  workspaceName: string
  /** The role accepting grants. */
  role: CollabRole
  /** Invitation creation timestamp (ISO 8601). */
  createdAt: string
}

/** The workspaces overlay's availability verdict for the collab surface. */
export type CollabAvailability = 'checking' | 'ready' | 'hidden'

/** A collab workspace mounted as a real Host workspace over its data directory. */
export interface CollabMountedWorkspaceView {
  /** The Host workspace the collab workspace resolves to (path-stable: every member mounts the same one). */
  workspace: {
    /** Host workspace id (string on the wire). */
    workspaceId: string
    /** Canonical data directory of the collab workspace. */
    path: string
    /** Display title (the collab workspace name). */
    title: string
    /** Sessions accounted under this workspace, in manually owned order. */
    sessionIds: string[]
    /** Host record creation instant (ISO 8601). */
    createdAt: string
    /** Host record last-mutation instant (ISO 8601). */
    updatedAt: string
  }
  /** The collab workspace's reserved data directory (equals `workspace.path`). */
  dir: string
}

/** Verification that a collab RPC failed, carrying the gateway's wire code. */
export class CollabError extends Error {
  /**
   * Construct a collab wire failure.
   * @param code - the gateway error code (`collab-forbidden`, ...).
   * @param message - server-provided detail.
   */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CollabError'
  }
}

/** The Connection RPC caller's visible surface (a duck of ClientConnectionRpc). */
export interface CollabRpcChannel {
  /**
   * Issue one unary RPC over a registered Connection channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `collab/workspace.list`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the existing RPC success/error result.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<CollabRpcResultOk<unknown> | CollabRpcResultError>
}

/**
 * Browser caller for the collab `collab/*` endpoints over the shared
 * Connection RPC envelope. Every typed method folds the wire result: an
 * `ok:false` envelope becomes a {@link CollabError}; a transport failure
 * propagates as-is. The server fence is the enforcement point; this wrapper
 * only shapes the client's reads.
 */
export class CollabApi {
  /**
   * Wrap a Connection RPC caller with the collab endpoint surface.
   * @param call - the underlying Connection RPC `call` function.
   */
  constructor(private readonly call: CollabRpcChannel['call']) {}

  /**
   * Unfold one collab endpoint into a typed value.
   * @param endpoint - canonical `collab/<domain>.<action>` endpoint.
   * @param payload - raw wire payload.
   * @returns the endpoint result value.
   */
  private async request<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
    const result = await this.call('/api', endpoint, payload)
    if (!result.ok) throw new CollabError(result.error.code, result.error.message)
    return result.value as T
  }

  /**
   * Probe whether the collab surface is available and this browser is signed
   * in. Never rejects: any failure — a refused `/api` gate, a missing collab
   * surface, a network error — folds to `hidden`, which hides the workspaces
   * UI without weakening the server fence.
   * @returns the availability verdict.
   */
  async availability(): Promise<CollabAvailability> {
    try {
      await this.request<unknown>('collab/auth.status', {})
      return 'ready'
    } catch {
      return 'hidden'
    }
  }

  /**
   * List the workspaces the signed-in user belongs to.
   * @returns the member workspace list.
   */
  listWorkspaces(): Promise<CollabWorkspaceView[]> {
    return this.request('collab/workspace.list', {})
  }

  /**
   * Create a workspace; the caller becomes its owner and admin. An optional
   * repository URL bootstraps the workspace from a clone: the server clones
   * the repository into its clone directory and opens the clone as the
   * workspace.
   * @param name - workspace display name.
   * @param repoUrl - git repository URL to clone as the workspace; omit for a name-only workspace.
   * @returns the new workspace view.
   */
  createWorkspace(name: string, repoUrl?: string): Promise<CollabWorkspaceView> {
    return this.request('collab/workspace.create', {
      name,
      ...(repoUrl === undefined ? {} : { repoUrl }),
    })
  }

  /**
   * List the members of a workspace (developer roles may read members).
   * @param workspaceId - the target workspace.
   * @returns the member list.
   */
  members(workspaceId: string): Promise<CollabMemberView[]> {
    return this.request('collab/workspace.members', { workspaceId })
  }

  /**
   * List the invitations of a workspace, pending or otherwise.
   * @param workspaceId - the target workspace.
   * @returns every invitation for the workspace.
   */
  invitations(workspaceId: string): Promise<CollabInvitationView[]> {
    return this.request('collab/workspace.invitations', { workspaceId })
  }

  /**
   * List the pending invitations addressed to this browser's signed-in user.
   * @returns the accept-surface invitations for this user.
   */
  myInvitations(): Promise<CollabMyInvitationView[]> {
    return this.request('collab/workspace.myInvitations', {})
  }

  /**
   * Accept a pending invitation addressed to this browser's user and join its
   * workspace. The server matches the invitation to the caller's verified
   * email before joining.
   * @param invitationId - the invitation to consume.
   * @returns the joined workspace view.
   */
  join(invitationId: string): Promise<CollabWorkspaceView> {
    return this.request('collab/workspace.join', { invitationId })
  }

  /**
   * Mount a collab workspace as a real Host workspace over its reserved data
   * directory (member-gated). The Host registry resolves the same workspace
   * for every member, so sessions born inside it are shared.
   * @param workspaceId - the collab workspace to open.
   * @returns the mounted Host workspace plus the scoped data directory.
   */
  open(workspaceId: string): Promise<CollabMountedWorkspaceView> {
    return this.request('collab/workspace.open', { workspaceId })
  }

  /**
   * Invite a user by email (admin or the invite permission).
   * @param workspaceId - the target workspace.
   * @param email - the invitee's email address.
   * @param role - the role the invite grants; defaults to `developer`.
   * @returns the created invitation.
   */
  invite(workspaceId: string, email: string, role: CollabRole): Promise<CollabInvitationView> {
    return this.request('collab/workspace.invite', { workspaceId, email, role })
  }

  /**
   * Revoke a pending invitation (idempotent).
   * @param workspaceId - the target workspace.
   * @param invitationId - the invitation to revoke.
   * @returns the revoked invitation.
   */
  revokeInvitation(workspaceId: string, invitationId: string): Promise<CollabInvitationView> {
    return this.request('collab/workspace.revokeInvitation', { workspaceId, invitationId })
  }

  /**
   * Change a member's role (the workspace owner stays `admin`; the last
   * `admin` cannot be demoted).
   * @param workspaceId - the target workspace.
   * @param userId - the target member.
   * @param role - the role to assign.
   * @returns the updated membership.
   */
  setMemberRole(workspaceId: string, userId: string, role: CollabRole): Promise<CollabMemberView> {
    return this.request('collab/workspace.setMemberRole', { workspaceId, userId, role })
  }

  /**
   * Remove a member from a workspace; the owner cannot be removed.
   * @param workspaceId - the target workspace.
   * @param userId - the member to remove.
   * @returns resolves when the member is gone.
   */
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.request('collab/workspace.removeMember', { workspaceId, userId })
  }

  /**
   * Delete a workspace (admin only).
   * @param workspaceId - the workspace to delete.
   * @returns resolves when the workspace is gone.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.request('collab/workspace.delete', { workspaceId })
  }
}
