import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../src/app.js'
import { machineTokens } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import { closeDb, makeMachineToken, makeUser, resetDb, testDeps } from './helpers.js'

const ORIGIN = 'https://artef.test'

/** Probe routes stand in for the artifact routes that do not exist yet, so the
 *  middleware can be observed on its own. Hono freezes its matcher on the first
 *  request, so they are registered before any test runs. */
function addProbes(app: Hono<AppEnv>): Hono<AppEnv> {
  app.get('/api/probe', c =>
    c.json({
      user: c.get('user'),
      authKind: c.get('authKind'),
      tokenScopeIds: c.get('tokenScopeIds'),
    }),
  )
  app.post('/api/probe', c => c.json({ authKind: c.get('authKind') }))
  return app
}

let deps: Awaited<ReturnType<typeof testDeps>>

beforeEach(async () => {
  deps = await testDeps()
  addProbes(deps.app)
  await resetDb(deps.pool)
})

afterAll(closeDb)

const get = (path: string, headers: Record<string, string> = {}) => deps.app.request(path, { headers })

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  deps.app.request(path, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const post = (path: string, headers: Record<string, string>, body?: unknown) =>
  send('POST', path, headers, body)

// ---------------------------------------------------------------------------
// Bearer middleware
// ---------------------------------------------------------------------------

describe('bearer middleware', () => {
  it('resolves the user for a valid token', async () => {
    const { user } = await makeUser(deps, { email: 'ada@example.com' })
    const { header } = await makeMachineToken(deps, user.id)

    const res = await get('/api/probe', header)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { id: string }; authKind: string; tokenScopeIds: null }
    expect(body.user.id).toBe(user.id)
    expect(body.authKind).toBe('bearer')
    expect(body.tokenScopeIds).toBeNull()
  })

  it('carries the token scope ids through to the request', async () => {
    const { user } = await makeUser(deps)
    const scopeIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const { header } = await makeMachineToken(deps, user.id, { scopeIds })

    const res = await get('/api/probe', header)
    expect((await res.json()).tokenScopeIds).toEqual(scopeIds)
  })

  it('401s an unknown token', async () => {
    const res = await get('/api/probe', { Authorization: 'Bearer art_live_nosuchtoken' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid token' })
  })

  it('401s an expired token', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id, { expiresAt: new Date(Date.now() - 1000) })
    const res = await get('/api/probe', header)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid token' })
  })

  it('accepts a token whose expiry is still ahead', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id, { expiresAt: new Date(Date.now() + 60_000) })
    expect((await get('/api/probe', header)).status).toBe(200)
  })

  it('401s a token that has been deleted', async () => {
    const { user } = await makeUser(deps)
    const { header, row } = await makeMachineToken(deps, user.id)
    await deps.db.delete(machineTokens).where(eq(machineTokens.id, row.id))

    const res = await get('/api/probe', header)
    expect(res.status).toBe(401)
  })

  it('ignores an Authorization header that is not a bearer token', async () => {
    const { cookie } = await makeUser(deps)
    const res = await get('/api/probe', { Cookie: cookie, Authorization: 'Basic dXNlcjpwYXNz' })
    expect(res.status).toBe(200)
    expect((await res.json()).authKind).toBe('session')
  })

  it('leaves an unauthenticated request anonymous', async () => {
    const res = await get('/api/probe')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: null, authKind: null, tokenScopeIds: null })
  })

  // The header is an explicit credential; the cookie may just be along for the
  // ride. Whoever presented the token is who the request is from.
  it('prefers the token over a session cookie sent alongside it', async () => {
    const { cookie } = await makeUser(deps)
    const { user: agent } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, agent.id)

    const res = await get('/api/probe', { Cookie: cookie, ...header })
    const body = (await res.json()) as { user: { id: string }; authKind: string }
    expect(body.user.id).toBe(agent.id)
    expect(body.authKind).toBe('bearer')
  })

  // Mount ordering: the bearer middleware has to run before the origin check,
  // or a token-authed mutation would look like a cookie-authed one and be
  // refused for having no Origin header (spec §2.2).
  it('exempts a token-authed mutation from the origin check', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id)

    const res = await post('/api/probe', header)
    expect(res.status).toBe(200)
    expect((await res.json()).authKind).toBe('bearer')
  })

  it('rejects a bad token before the origin check can pass it through', async () => {
    const res = await post('/api/probe', { Authorization: 'Bearer art_live_nope' })
    expect(res.status).toBe(401)
  })

  describe('last_used_at', () => {
    const lastUsed = async (id: string) => {
      const [row] = await deps.db.select().from(machineTokens).where(eq(machineTokens.id, id))
      return row.lastUsedAt
    }

    it('records the first use', async () => {
      const { user } = await makeUser(deps)
      const { header, row } = await makeMachineToken(deps, user.id)
      expect(row.lastUsedAt).toBeNull()

      await get('/api/probe', header)
      expect((await lastUsed(row.id))!.getTime()).toBeGreaterThan(Date.now() - 10_000)
    })

    // One write per request per token would double the cost of every agent
    // call, for a timestamp nobody reads at that resolution.
    it('does not write again within the minute', async () => {
      const { user } = await makeUser(deps)
      const { header, row } = await makeMachineToken(deps, user.id)

      await get('/api/probe', header)
      const first = await lastUsed(row.id)
      await get('/api/probe', header)
      expect((await lastUsed(row.id))!.getTime()).toBe(first!.getTime())
    })

    it('writes again once the stamp is over a minute old', async () => {
      const { user } = await makeUser(deps)
      const { header, row } = await makeMachineToken(deps, user.id)
      const stale = new Date(Date.now() - 5 * 60_000)
      await deps.db.update(machineTokens).set({ lastUsedAt: stale }).where(eq(machineTokens.id, row.id))

      await get('/api/probe', header)
      expect((await lastUsed(row.id))!.getTime()).toBeGreaterThan(stale.getTime())
    })
  })
})

// ---------------------------------------------------------------------------
// POST /api/tokens
// ---------------------------------------------------------------------------

describe('POST /api/tokens', () => {
  it('mints a token, returns it once, and stores only its hash', async () => {
    const { user, workspace, cookie } = await makeUser(deps)

    const res = await post('/api/tokens', { Cookie: cookie, Origin: ORIGIN }, { name: 'laptop' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; token: string; prefix: string }
    expect(body.token.startsWith('art_live_')).toBe(true)
    expect(body.prefix).toBe(body.token.slice(0, 12))

    const [row] = await deps.db.select().from(machineTokens).where(eq(machineTokens.id, body.id))
    expect(row.name).toBe('laptop')
    expect(row.userId).toBe(user.id)
    expect(row.workspaceId).toBe(workspace.id)
    expect(row.prefix).toBe(body.prefix)
    expect(row.scopeIds).toBeNull()
    expect(row.expiresAt).toBeNull()
    expect(row.lastUsedAt).toBeNull()
    // Only the hash is kept: the plaintext cannot be recovered from the row.
    expect(Buffer.from(row.tokenHash).equals(sha256(body.token))).toBe(true)
    expect(JSON.stringify(row)).not.toContain(body.token)
  })

  it('mints a token that authenticates', async () => {
    const { user, cookie } = await makeUser(deps)
    const res = await post('/api/tokens', { Cookie: cookie, Origin: ORIGIN }, { name: 'laptop' })
    const { token } = (await res.json()) as { token: string }

    const probe = await get('/api/probe', { Authorization: `Bearer ${token}` })
    expect(probe.status).toBe(200)
    expect((await probe.json()).user.id).toBe(user.id)
  })

  it('mints two different tokens for two requests', async () => {
    const { cookie } = await makeUser(deps)
    const one = await (await post('/api/tokens', { Cookie: cookie, Origin: ORIGIN }, { name: 'a' })).json()
    const two = await (await post('/api/tokens', { Cookie: cookie, Origin: ORIGIN }, { name: 'b' })).json()
    expect(one.token).not.toBe(two.token)
  })

  it('stores scope ids and an expiry when they are given', async () => {
    const { cookie } = await makeUser(deps)
    const scopeIds = ['33333333-3333-4333-8333-333333333333']
    const expiresAt = new Date(Date.now() + 86_400_000)

    const res = await post(
      '/api/tokens',
      { Cookie: cookie, Origin: ORIGIN },
      { name: 'scoped', scope_ids: scopeIds, expires_at: expiresAt.toISOString() },
    )
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }

    const [row] = await deps.db.select().from(machineTokens).where(eq(machineTokens.id, id))
    expect(row.scopeIds).toEqual(scopeIds)
    expect(row.expiresAt!.getTime()).toBe(expiresAt.getTime())
  })

  it('401s without a session', async () => {
    const res = await post('/api/tokens', { Origin: ORIGIN }, { name: 'laptop' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBeTruthy()
    expect(await deps.db.select().from(machineTokens)).toHaveLength(0)
  })

  // A leaked machine token must not be a way to mint more machine tokens
  // (spec §5.6): tokens come from a browser session only.
  it('401s a bearer-authenticated request', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id)

    const res = await post('/api/tokens', header, { name: 'child' })
    expect(res.status).toBe(401)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(1)
  })

  it('403s a session-authed request from another origin', async () => {
    const { cookie } = await makeUser(deps)
    const res = await post('/api/tokens', { Cookie: cookie, Origin: 'https://evil.test' }, { name: 'x' })
    expect(res.status).toBe(403)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(0)
  })

  it('400s bad input and writes nothing', async () => {
    const { cookie } = await makeUser(deps)
    const headers = { Cookie: cookie, Origin: ORIGIN }
    const cases: unknown[] = [
      {},
      { name: '   ' },
      { name: 42 },
      { name: 'x'.repeat(201) },
      { name: 'x', scope_ids: [] },
      { name: 'x', scope_ids: ['not-a-uuid'] },
      { name: 'x', scope_ids: 'one-id' },
      { name: 'x', expires_at: 'whenever' },
      { name: 'x', expires_at: new Date(Date.now() - 1000).toISOString() },
      'not an object',
    ]
    for (const body of cases) {
      const res = await post('/api/tokens', headers, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error).toBeTruthy()
    }

    const malformed = await deps.app.request('/api/tokens', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    expect(malformed.status).toBe(400)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/tokens
// ---------------------------------------------------------------------------

describe('GET /api/tokens', () => {
  it('lists the caller’s own tokens without ever repeating the secret', async () => {
    const { user, cookie } = await makeUser(deps)
    const expiresAt = new Date(Date.now() + 86_400_000)
    const mine = await makeMachineToken(deps, user.id, { name: 'laptop', expiresAt })

    const res = await get('/api/tokens', { Cookie: cookie })
    expect(res.status).toBe(200)
    const list = (await res.json()) as Record<string, unknown>[]
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      id: mine.row.id,
      name: 'laptop',
      prefix: mine.row.prefix,
      scope_ids: null,
      expires_at: expiresAt.toISOString(),
      last_used_at: null,
      created_at: mine.row.createdAt.toISOString(),
    })
    expect(JSON.stringify(list)).not.toContain(mine.token)
  })

  it('never shows another user’s tokens', async () => {
    const { user, cookie } = await makeUser(deps)
    const { user: other } = await makeUser(deps)
    await makeMachineToken(deps, user.id, { name: 'mine' })
    await makeMachineToken(deps, other.id, { name: 'theirs' })

    const list = (await (await get('/api/tokens', { Cookie: cookie })).json()) as { name: string }[]
    expect(list.map(t => t.name)).toEqual(['mine'])
  })

  it('shows an admin only their own tokens, not the whole workspace', async () => {
    const { user: admin, cookie } = await makeUser(deps, { isAdmin: true })
    const { user: other } = await makeUser(deps)
    await makeMachineToken(deps, admin.id, { name: 'mine' })
    await makeMachineToken(deps, other.id, { name: 'theirs' })

    const list = (await (await get('/api/tokens', { Cookie: cookie })).json()) as { name: string }[]
    expect(list.map(t => t.name)).toEqual(['mine'])
  })

  it('reports the scope ids and last use it has', async () => {
    const { user, cookie } = await makeUser(deps)
    const scopeIds = ['44444444-4444-4444-8444-444444444444']
    const { header, row } = await makeMachineToken(deps, user.id, { scopeIds })
    await get('/api/probe', header)

    const list = (await (await get('/api/tokens', { Cookie: cookie })).json()) as {
      id: string
      scope_ids: string[]
      last_used_at: string
    }[]
    const entry = list.find(t => t.id === row.id)!
    expect(entry.scope_ids).toEqual(scopeIds)
    expect(Date.parse(entry.last_used_at)).toBeGreaterThan(Date.now() - 10_000)
  })

  it('returns an empty list when there are none', async () => {
    const { cookie } = await makeUser(deps)
    expect(await (await get('/api/tokens', { Cookie: cookie })).json()).toEqual([])
  })

  it('401s without a session', async () => {
    expect((await get('/api/tokens')).status).toBe(401)
  })

  it('401s a bearer-authenticated request', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id)
    const res = await get('/api/tokens', header)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/tokens/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/tokens/:id', () => {
  const del = (id: string, headers: Record<string, string>) =>
    send('DELETE', `/api/tokens/${id}`, headers)

  it('revokes the caller’s own token', async () => {
    const { user, cookie } = await makeUser(deps)
    const { header, row } = await makeMachineToken(deps, user.id)

    const res = await del(row.id, { Cookie: cookie, Origin: ORIGIN })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(await deps.db.select().from(machineTokens)).toHaveLength(0)
    // The revoked token stops working immediately.
    expect((await get('/api/probe', header)).status).toBe(401)
  })

  it('404s another user’s token and leaves it alone', async () => {
    const { cookie } = await makeUser(deps)
    const { user: other } = await makeUser(deps)
    const { row } = await makeMachineToken(deps, other.id)

    const res = await del(row.id, { Cookie: cookie, Origin: ORIGIN })
    expect(res.status).toBe(404)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(1)
  })

  it('lets a workspace admin revoke someone else’s token', async () => {
    const { cookie } = await makeUser(deps, { isAdmin: true })
    const { user: other } = await makeUser(deps)
    const { row } = await makeMachineToken(deps, other.id)

    const res = await del(row.id, { Cookie: cookie, Origin: ORIGIN })
    expect(res.status).toBe(204)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(0)
  })

  it('does not let an admin reach into another workspace', async () => {
    const { cookie } = await makeUser(deps, { isAdmin: true })
    const { user: outsider } = await makeUser(deps, { domain: 'other.test' })
    const { row } = await makeMachineToken(deps, outsider.id)

    const res = await del(row.id, { Cookie: cookie, Origin: ORIGIN })
    expect(res.status).toBe(404)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(1)
  })

  it('404s an id that does not exist, in any shape', async () => {
    const { cookie } = await makeUser(deps)
    for (const id of ['55555555-5555-4555-8555-555555555555', 'not-a-uuid', '1']) {
      const res = await del(id, { Cookie: cookie, Origin: ORIGIN })
      expect(res.status, id).toBe(404)
      expect((await res.json()).error).toBeTruthy()
    }
  })

  it('401s without a session', async () => {
    const { user } = await makeUser(deps)
    const { row } = await makeMachineToken(deps, user.id)
    expect((await del(row.id, { Origin: ORIGIN })).status).toBe(401)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(1)
  })

  it('401s a bearer-authenticated request, even for its own token', async () => {
    const { user } = await makeUser(deps)
    const { header, row } = await makeMachineToken(deps, user.id)

    const res = await del(row.id, header)
    expect(res.status).toBe(401)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(1)
  })

  it('403s a session-authed request from another origin', async () => {
    const { user, cookie } = await makeUser(deps)
    const { row } = await makeMachineToken(deps, user.id)

    const res = await del(row.id, { Cookie: cookie, Origin: 'https://evil.test' })
    expect(res.status).toBe(403)
    expect(await deps.db.select().from(machineTokens)).toHaveLength(1)
  })
})
