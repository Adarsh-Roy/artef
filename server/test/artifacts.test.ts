// Artifact CRUD and listing (spec §5.1). The recurring theme in here is that
// "you may not" and "it does not exist" are the same answer on the wire (§2.3),
// so most of these tests are about which of 404 / 403 / 422 comes back.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../src/app.js'
import { artifactGrants, artifacts, users } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { closeDb, makeMachineToken, makeUser, resetDb, testDeps } from './helpers.js'

const ORIGIN = 'https://artef.test'
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

type Visibility = 'private' | 'restricted' | 'workspace' | 'public'
type User = typeof users.$inferSelect

/** A route that throws, so the `onError` handler can be observed. Hono freezes
 *  its matcher on the first request, so it is registered before any test runs. */
function addProbe(app: Hono<AppEnv>): Hono<AppEnv> {
  app.get('/api/boom', () => {
    throw new Error('probe exploded')
  })
  return app
}

let deps: Awaited<ReturnType<typeof testDeps>>

beforeEach(async () => {
  deps = await testDeps()
  addProbe(deps.app)
  await resetDb(deps.pool)
})

afterAll(closeDb)

// --- request helpers ---------------------------------------------------------

function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return deps.app.request(path, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Session auth. Mutations need `Origin` too, or the CSRF check refuses them. */
const asUser = (cookie: string) => ({ Cookie: cookie, Origin: ORIGIN })

// --- row-level fixtures ------------------------------------------------------

async function makeArtifact(
  owner: User,
  opts: { name?: string | null; visibility?: Visibility; updatedAt?: Date } = {},
): Promise<typeof artifacts.$inferSelect> {
  const [row] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      name: opts.name ?? null,
      visibility: opts.visibility ?? 'private',
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
      ...(opts.updatedAt === undefined ? {} : { createdAt: opts.updatedAt, updatedAt: opts.updatedAt }),
    })
    .returning()
  return row
}

async function grantTo(artifactId: string, userId: string, role: 'viewer' | 'editor'): Promise<void> {
  await deps.db.insert(artifactGrants).values({ artifactId, userId, role })
}

type Page = { items: Array<Record<string, unknown>>; next_cursor: string | null }

async function list(cookie: string, query = ''): Promise<Page> {
  const res = await deps.app.request(`/api/artifacts${query}`, { headers: { Cookie: cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as Page
}

const idsOf = (page: Page): string[] => page.items.map(i => i.id as string)

// ---------------------------------------------------------------------------
// POST /api/artifacts
// ---------------------------------------------------------------------------

describe('POST /api/artifacts', () => {
  it('creates an empty artifact at version 0', async () => {
    const { user, cookie } = await makeUser(deps)

    const res = await send('POST', '/api/artifacts', asUser(cookie), { name: 'Q3 report' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>

    expect(body.name).toBe('Q3 report')
    expect(body.visibility).toBe('private')
    expect(body.version).toBe(0)
    expect(body.url).toBe(`${deps.cfg.url}/a/${body.id as string}`)
    expect(typeof body.created_at).toBe('string')
    expect(typeof body.updated_at).toBe('string')

    // The stored row is a real, empty, version-0 document — not a placeholder.
    const [row] = await deps.db.select().from(artifacts).where(eq(artifacts.id, body.id as string))
    expect(row.ownerId).toBe(user.id)
    expect(row.workspaceId).toBe(user.workspaceId)
    expect(row.version).toBe(0)
    expect(row.bodyBytes).toBe(0)
    expect(row.contentHash.toString('hex')).toBe(EMPTY_SHA256)
    expect(row.body.equals(gzipBuf(''))).toBe(true)
  })

  it('defaults name to null and visibility to private', async () => {
    const { cookie } = await makeUser(deps)
    const res = await send('POST', '/api/artifacts', asUser(cookie), {})
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBeNull()
    expect(body.visibility).toBe('private')
  })

  it('accepts an explicit visibility', async () => {
    const { cookie } = await makeUser(deps)
    const res = await send('POST', '/api/artifacts', asUser(cookie), { visibility: 'workspace' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { visibility: string }).visibility).toBe('workspace')
  })

  it('refuses an unknown visibility with 422', async () => {
    const { cookie } = await makeUser(deps)
    const res = await send('POST', '/api/artifacts', asUser(cookie), { visibility: 'everyone' })
    expect(res.status).toBe(422)
    expect((await res.json()) as { error: string }).toHaveProperty('error')
  })

  it('refuses a scoped machine token with 403', async () => {
    const { user } = await makeUser(deps)
    const scope = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [scope.id] })

    const res = await send('POST', '/api/artifacts', header, { name: 'nope' })
    expect(res.status).toBe(403)

    // Nothing was written: the scoped token still owns exactly one artifact.
    const rows = await deps.db.select({ id: artifacts.id }).from(artifacts)
    expect(rows).toHaveLength(1)
  })

  it('accepts an unscoped machine token', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id)
    const res = await send('POST', '/api/artifacts', header, { name: 'from an agent' })
    expect(res.status).toBe(201)
  })

  it('refuses an anonymous caller with 401', async () => {
    const res = await send('POST', '/api/artifacts', { Origin: ORIGIN }, {})
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// GET /api/artifacts/:id
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:id', () => {
  it('returns metadata for the owner and never the body', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user, { name: 'notes' })

    const res = await deps.app.request(`/api/artifacts/${art.id}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(body).toEqual({
      id: art.id,
      name: 'notes',
      visibility: 'private',
      version: 0,
      body_bytes: 0,
      content_hash: EMPTY_SHA256,
      owner_id: user.id,
      created_at: art.createdAt.toISOString(),
      updated_at: art.updatedAt.toISOString(),
    })
    expect(body).not.toHaveProperty('body')
  })

  it("answers 404 — not 403 — for someone else's private artifact", async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps)
    const art = await makeArtifact(owner)

    const res = await deps.app.request(`/api/artifacts/${art.id}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(404)
  })

  it('answers 404 across workspaces even for workspace visibility', async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps, { domain: 'other.test' })
    const art = await makeArtifact(owner, { visibility: 'workspace' })

    const res = await deps.app.request(`/api/artifacts/${art.id}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(404)
  })

  it('lets a workspace colleague read a workspace-visible artifact', async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'workspace' })

    const res = await deps.app.request(`/api/artifacts/${art.id}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })

  it('lets a grantee read a restricted artifact', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: mate, cookie } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'restricted' })
    await grantTo(art.id, mate.id, 'viewer')

    const res = await deps.app.request(`/api/artifacts/${art.id}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })

  it('serves a public artifact to an anonymous caller', async () => {
    const { user: owner } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'public' })

    const res = await deps.app.request(`/api/artifacts/${art.id}`)
    expect(res.status).toBe(200)
  })

  it('answers 404 for an id that is not a uuid', async () => {
    const { cookie } = await makeUser(deps)
    const res = await deps.app.request('/api/artifacts/not-a-uuid', { headers: { Cookie: cookie } })
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toHaveProperty('error')
  })

  it('answers 404 for an artifact outside a scoped token', async () => {
    const { user } = await makeUser(deps)
    const inScope = await makeArtifact(user)
    const outOfScope = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [inScope.id] })

    expect((await deps.app.request(`/api/artifacts/${inScope.id}`, { headers: header })).status).toBe(200)
    expect((await deps.app.request(`/api/artifacts/${outOfScope.id}`, { headers: header })).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/artifacts/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/artifacts/:id', () => {
  it('renames for the owner', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user, { name: 'old' })

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { name: 'new' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('new')

    const [row] = await deps.db.select().from(artifacts).where(eq(artifacts.id, art.id))
    expect(row.name).toBe('new')
  })

  it('lets an editor grantee rename', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: mate, cookie } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'restricted' })
    await grantTo(art.id, mate.id, 'editor')

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { name: 'theirs' })
    expect(res.status).toBe(200)
  })

  it('lets an editor grantee rename a public artifact (§4.2: grants survive publishing)', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: mate, cookie } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'public' })
    await grantTo(art.id, mate.id, 'editor')

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { name: 'still mine to edit' })
    expect(res.status).toBe(200)
  })

  it('refuses a rename by a viewer grantee with 403', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: mate, cookie } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'restricted' })
    await grantTo(art.id, mate.id, 'viewer')

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { name: 'nope' })
    expect(res.status).toBe(403)
  })

  it('refuses a visibility change by an editor grantee with 403', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: mate, cookie } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'restricted' })
    await grantTo(art.id, mate.id, 'editor')

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { visibility: 'public' })
    expect(res.status).toBe(403)

    const [row] = await deps.db.select().from(artifacts).where(eq(artifacts.id, art.id))
    expect(row.visibility).toBe('restricted')
  })

  it('lets the owner change visibility', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { visibility: 'workspace' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { visibility: string }).visibility).toBe('workspace')
  })

  it('lets a workspace admin change visibility', async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps, { isAdmin: true })
    const art = await makeArtifact(owner)

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { visibility: 'workspace' })
    expect(res.status).toBe(200)
  })

  it('answers 404 when the caller cannot even see the artifact', async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps)
    const art = await makeArtifact(owner)

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { name: 'nope' })
    expect(res.status).toBe(404)
  })

  it('refuses an unknown visibility with 422', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { visibility: 'everyone' })
    expect(res.status).toBe(422)
  })

  it('refuses a patch that changes nothing with 400', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), {})
    expect(res.status).toBe(400)
  })

  it('bumps updated_at so the list order reflects the rename', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user, { updatedAt: new Date('2020-01-01T00:00:00Z') })

    const res = await send('PATCH', `/api/artifacts/${art.id}`, asUser(cookie), { name: 'touched' })
    const body = (await res.json()) as { updated_at: string }
    expect(new Date(body.updated_at).getTime()).toBeGreaterThan(art.updatedAt.getTime())
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/artifacts/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/artifacts/:id', () => {
  it('deletes for the owner, after which the artifact is gone', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const res = await send('DELETE', `/api/artifacts/${art.id}`, asUser(cookie))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    const after = await deps.app.request(`/api/artifacts/${art.id}`, { headers: { Cookie: cookie } })
    expect(after.status).toBe(404)
  })

  it('lets a workspace admin delete', async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps, { isAdmin: true })
    const art = await makeArtifact(owner)

    const res = await send('DELETE', `/api/artifacts/${art.id}`, asUser(cookie))
    expect(res.status).toBe(204)
  })

  it('refuses an editor grantee with 403', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: mate, cookie } = await makeUser(deps)
    const art = await makeArtifact(owner, { visibility: 'restricted' })
    await grantTo(art.id, mate.id, 'editor')

    const res = await send('DELETE', `/api/artifacts/${art.id}`, asUser(cookie))
    expect(res.status).toBe(403)

    const rows = await deps.db.select({ id: artifacts.id }).from(artifacts)
    expect(rows).toHaveLength(1)
  })

  it("answers 404 for someone else's private artifact", async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps)
    const art = await makeArtifact(owner)

    const res = await send('DELETE', `/api/artifacts/${art.id}`, asUser(cookie))
    expect(res.status).toBe(404)
  })

  it('refuses an admin from another workspace deleting a public artifact', async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps, { domain: 'other.test', isAdmin: true })
    const art = await makeArtifact(owner, { visibility: 'public' })

    const res = await send('DELETE', `/api/artifacts/${art.id}`, asUser(cookie))
    expect(res.status).toBe(403)

    const rows = await deps.db.select({ id: artifacts.id }).from(artifacts)
    expect(rows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// GET /api/artifacts
// ---------------------------------------------------------------------------

describe('GET /api/artifacts', () => {
  it('shows own private, workspace-visible and granted artifacts but not others private', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: me, cookie } = await makeUser(deps)

    const mine = await makeArtifact(me, { name: 'mine' })
    const shared = await makeArtifact(owner, { name: 'shared', visibility: 'workspace' })
    const published = await makeArtifact(owner, { name: 'published', visibility: 'public' })
    const granted = await makeArtifact(owner, { name: 'granted', visibility: 'restricted' })
    await grantTo(granted.id, me.id, 'viewer')
    const hidden = await makeArtifact(owner, { name: 'hidden' })
    const ungranted = await makeArtifact(owner, { name: 'ungranted', visibility: 'restricted' })

    const ids = idsOf(await list(cookie))
    expect(ids.sort()).toEqual([mine.id, shared.id, published.id, granted.id].sort())
    expect(ids).not.toContain(hidden.id)
    expect(ids).not.toContain(ungranted.id)
  })

  it('never leaks another workspace', async () => {
    const { user: stranger } = await makeUser(deps, { domain: 'other.test' })
    const { cookie } = await makeUser(deps)
    await makeArtifact(stranger, { visibility: 'public' })

    expect(idsOf(await list(cookie))).toEqual([])
  })

  it('shows a workspace admin everything in their workspace', async () => {
    const { user: owner } = await makeUser(deps)
    const { cookie } = await makeUser(deps, { isAdmin: true })
    const secret = await makeArtifact(owner)

    expect(idsOf(await list(cookie))).toContain(secret.id)
  })

  it('narrows to owned artifacts with mine=true', async () => {
    const { user: owner } = await makeUser(deps)
    const { user: me, cookie } = await makeUser(deps)
    const mine = await makeArtifact(me)
    const theirs = await makeArtifact(owner, { visibility: 'workspace' })

    const ids = idsOf(await list(cookie, '?mine=true'))
    expect(ids).toEqual([mine.id])
    expect(ids).not.toContain(theirs.id)
  })

  it('orders by updated_at descending', async () => {
    const { user, cookie } = await makeUser(deps)
    const oldest = await makeArtifact(user, { updatedAt: new Date('2024-01-01T00:00:00Z') })
    const newest = await makeArtifact(user, { updatedAt: new Date('2024-03-01T00:00:00Z') })
    const middle = await makeArtifact(user, { updatedAt: new Date('2024-02-01T00:00:00Z') })

    expect(idsOf(await list(cookie))).toEqual([newest.id, middle.id, oldest.id])
  })

  it('breaks ties on id descending so a page boundary cannot repeat or skip a row', async () => {
    const { user, cookie } = await makeUser(deps)
    const at = new Date('2024-01-01T00:00:00Z')
    const all = [await makeArtifact(user, { updatedAt: at }), await makeArtifact(user, { updatedAt: at }), await makeArtifact(user, { updatedAt: at })]
    const expected = all.map(a => a.id).sort().reverse()

    const first = await list(cookie, '?limit=2')
    expect(idsOf(first)).toEqual(expected.slice(0, 2))
    const second = await list(cookie, `?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)
    expect(idsOf(second)).toEqual(expected.slice(2))
  })

  it('paginates with a cursor', async () => {
    const { user, cookie } = await makeUser(deps)
    const a = await makeArtifact(user, { updatedAt: new Date('2024-01-01T00:00:00Z') })
    const b = await makeArtifact(user, { updatedAt: new Date('2024-02-01T00:00:00Z') })
    const c = await makeArtifact(user, { updatedAt: new Date('2024-03-01T00:00:00Z') })

    const first = await list(cookie, '?limit=2')
    expect(idsOf(first)).toEqual([c.id, b.id])
    expect(typeof first.next_cursor).toBe('string')

    const second = await list(cookie, `?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)
    expect(idsOf(second)).toEqual([a.id])
    expect(second.next_cursor).toBeNull()
  })

  it('returns a null cursor when the last page is exactly full', async () => {
    const { user, cookie } = await makeUser(deps)
    await makeArtifact(user, { updatedAt: new Date('2024-01-01T00:00:00Z') })
    await makeArtifact(user, { updatedAt: new Date('2024-02-01T00:00:00Z') })

    const page = await list(cookie, '?limit=2')
    expect(page.items).toHaveLength(2)
    expect(page.next_cursor).toBeNull()
  })

  it('rejects a malformed cursor with 400', async () => {
    const { cookie } = await makeUser(deps)
    const res = await deps.app.request('/api/artifacts?cursor=garbage', { headers: { Cookie: cookie } })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toHaveProperty('error')
  })

  it('caps limit at 200', async () => {
    const { user, cookie } = await makeUser(deps)
    await makeArtifact(user)

    const res = await deps.app.request('/api/artifacts?limit=5000', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    // The cap is not observable through the row count with one row, so this
    // asserts the request is served rather than refused, and the SQL is valid.
    expect(((await res.json()) as Page).items).toHaveLength(1)
  })

  it('never includes the body in a list item', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user, { name: 'doc' })

    const res = await deps.app.request('/api/artifacts', { headers: { Cookie: cookie } })
    const raw = await res.text()
    expect(raw).not.toContain('"body"')

    const page = JSON.parse(raw) as Page
    expect(Object.keys(page.items[0]).sort()).toEqual(
      ['content_hash', 'body_bytes', 'created_at', 'id', 'name', 'owner_id', 'updated_at', 'version', 'visibility'].sort(),
    )
    expect(page.items[0].id).toBe(art.id)
  })

  it('returns an empty page for a user with nothing', async () => {
    const { cookie } = await makeUser(deps)
    const page = await list(cookie)
    expect(page).toEqual({ items: [], next_cursor: null })
  })

  it('refuses an anonymous caller with 401', async () => {
    const res = await deps.app.request('/api/artifacts')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Unexpected failures
// ---------------------------------------------------------------------------

describe('onError', () => {
  it('answers a thrown error with a JSON 500', async () => {
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      const res = await deps.app.request('/api/boom')
      expect(res.status).toBe(500)
      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(await res.json()).toEqual({ error: 'internal error' })
    } finally {
      console.error = original
    }
    // The real error is logged, so the operator can still see what broke.
    expect(errors).toHaveLength(1)
  })
})
