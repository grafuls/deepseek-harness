/**
 * CollabApi wire folding: each typed method posts over the shared `/api`
 * channel with the correct endpoint and payload, an `ok:false` envelope
 * becomes a CollabError carrying the gateway code, and the availability probe
 * folds every failure into `hidden` without rejecting.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CollabRpcResultError, CollabRpcResultOk } from '../src/client/contract.ts'
import { CollabApi, CollabError, type CollabRpcChannel } from '../src/client/contract.ts'

function ok(value: unknown): CollabRpcResultOk<unknown> {
  return { ok: true, value }
}

function refusal(code: string): CollabRpcResultError {
  return { ok: false, error: { code, message: `boom: ${code}` } }
}

/** A recording fake Connection RPC caller. */
function fakeCall(script: Array<{ endpoint: string; payload: unknown; result: CollabRpcResultOk<unknown> | CollabRpcResultError }>): {
  call: CollabRpcChannel['call']
  seen: Array<{ channel: string; endpoint: string; payload: unknown }>
} {
  const seen: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  let index = 0
  const call: CollabRpcChannel['call'] = (_channel, endpoint, payload) => {
    const step = script[index++]!
    expect(endpoint).toBe(step.endpoint)
    expect(payload).toEqual(step.payload)
    seen.push({ channel: _channel, endpoint, payload })
    return Promise.resolve(step.result)
  }
  return { call, seen }
}

describe('CollabApi', () => {
  it('lists and creates workspaces over the shared /api channel', async () => {
    const view = { id: 'w1', name: 'Alpha', memberCount: 1, isOwner: true, role: 'admin', createdAt: '2020-01-01T00:00:00.000Z' }
    const { call, seen } = fakeCall([
      { endpoint: 'collab/workspace.list', payload: {}, result: ok([view]) },
      { endpoint: 'collab/workspace.create', payload: { name: 'Alpha' }, result: ok(view) },
    ])
    const api = new CollabApi(call)
    await expect(api.listWorkspaces()).resolves.toEqual([view])
    await expect(api.createWorkspace('Alpha')).resolves.toEqual(view)
    expect(seen.map(entry => entry.channel)).toEqual(['/api', '/api'])
  })

  it('reads members, invitations, and sends the invite with the chosen role', async () => {
    const member = { userId: 'u1', email: 'owen@example.com', name: 'Owen', role: 'admin', joinedAt: '2020-01-01T00:00:00.000Z' }
    const invitation = { id: 'i1', workspaceId: 'w1', email: 'lina@example.com', role: 'developer', createdBy: 'u1', createdAt: '2020-01-01T00:00:00.000Z', revoked: false }
    const { call, seen } = fakeCall([
      { endpoint: 'collab/workspace.members', payload: { workspaceId: 'w1' }, result: ok([member]) },
      { endpoint: 'collab/workspace.invitations', payload: { workspaceId: 'w1' }, result: ok([invitation]) },
      { endpoint: 'collab/workspace.invite', payload: { workspaceId: 'w1', email: 'lina@example.com', role: 'admin' }, result: ok(invitation) },
    ])
    const api = new CollabApi(call)
    await expect(api.members('w1')).resolves.toEqual([member])
    await expect(api.invitations('w1')).resolves.toEqual([invitation])
    await expect(api.invite('w1', 'lina@example.com', 'admin')).resolves.toEqual(invitation)
    expect(seen[2]!.payload).toEqual({ workspaceId: 'w1', email: 'lina@example.com', role: 'admin' })
  })

  it('revokes invitations and changes roles', async () => {
    const revoked = { id: 'i1', workspaceId: 'w1', email: 'lina@example.com', role: 'developer', createdBy: 'u1', createdAt: '2020-01-01T00:00:00.000Z', revoked: true }
    const member = { userId: 'u2', email: 'lina@example.com', name: 'Lina', role: 'admin', joinedAt: '2020-01-01T00:00:00.000Z' }
    const { call } = fakeCall([
      { endpoint: 'collab/workspace.revokeInvitation', payload: { workspaceId: 'w1', invitationId: 'i1' }, result: ok(revoked) },
      { endpoint: 'collab/workspace.setMemberRole', payload: { workspaceId: 'w1', userId: 'u2', role: 'admin' }, result: ok(member) },
    ])
    const api = new CollabApi(call)
    await expect(api.revokeInvitation('w1', 'i1')).resolves.toEqual(revoked)
    await expect(api.setMemberRole('w1', 'u2', 'admin')).resolves.toEqual(member)
  })

  it('removes members and deletes workspaces', async () => {
    const { call } = fakeCall([
      { endpoint: 'collab/workspace.removeMember', payload: { workspaceId: 'w1', userId: 'u2' }, result: ok({ removed: 'u2' }) },
      { endpoint: 'collab/workspace.delete', payload: { workspaceId: 'w1' }, result: ok({ deleted: true }) },
    ])
    const api = new CollabApi(call)
    await expect(api.removeMember('w1', 'u2')).resolves.toBeUndefined()
    await expect(api.deleteWorkspace('w1')).resolves.toBeUndefined()
  })

  it('folds an ok:false envelope into a CollabError carrying the wire code', async () => {
    const failing = vi.fn<CollabRpcChannel['call']>(async () => refusal('collab-forbidden'))
    const api = new CollabApi(failing)
    await expect(api.listWorkspaces()).rejects.toSatisfy(
      (error: unknown) => error instanceof CollabError && error.code === 'collab-forbidden' && error.message === 'boom: collab-forbidden',
    )
  })

  it('folds a transport failure into CollabError propagation unchanged', async () => {
    const transport = new Error('transport failure for /api/collab: HTTP 401')
    const failing = vi.fn<CollabRpcChannel['call']>(async () => { throw transport })
    const api = new CollabApi(failing)
    await expect(api.listWorkspaces()).rejects.toBe(transport)
  })

  it('reports ready when the status probe answers', async () => {
    const { call } = fakeCall([{ endpoint: 'collab/auth.status', payload: {}, result: ok({ authenticated: true }) }])
    await expect(new CollabApi(call).availability()).resolves.toBe('ready')
  })

  it('folds a refused gate and a missing collab surface into hidden', async () => {
    const refused = vi.fn<CollabRpcChannel['call']>(async () => { throw new Error('transport failure for /api/collab/auth.status: HTTP 401') })
    const transport = vi.fn<CollabRpcChannel['call']>(async () => { throw new Error('network down') })
    const apiRefused = new CollabApi(refused)
    const apiTransport = new CollabApi(transport)
    await expect(apiRefused.availability()).resolves.toBe('hidden')
    await expect(apiTransport.availability()).resolves.toBe('hidden')
  })
})
