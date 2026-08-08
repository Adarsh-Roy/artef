// The content protocol (spec §5.2) — the hot path, and the one the CLI is
// already built against, so these tests are mostly about exact wire shapes:
// which header, which status, which JSON key. Three themes recur:
//
//   - a push that does not change the hash is never a write (§3.2);
//   - bytes only ever leave the server under the sandbox CSP (§2.2);
//   - "you may not" and "it is not there" are the same answer (§2.3).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { gunzipSync } from 'node:zlib'
import pg from 'pg'
import { asc, eq } from 'drizzle-orm'
import { artifactGrants, artifacts, artifactVersions, users } from '../src/db/schema.js'
import { sha256, sha256Hex } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { ARTIFACT_CSP } from '../src/lib/headers.js'
import {
  closeDb,
  makeMachineToken,
  makeUser,
  pushHtml,
  resetDb,
  testDeps,
  TEST_DATABASE_URL,
  type TestDeps,
} from './helpers.js'

const ORIGIN = 'https://artef.test'
const EMPTY_SHA256 = sha256Hex('')
const HTML = '<!doctype html><h1>hello</h1>'

type Visibility = 'private' | 'restricted' | 'workspace' | 'public'
type User = typeof users.$inferSelect

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

// --- fixtures ----------------------------------------------------------------

async function makeArtifact(
  owner: User,
  opts: { visibility?: Visibility } = {},
): Promise<typeof artifacts.$inferSelect> {
  const [row] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      visibility: opts.visibility ?? 'private',
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
      version: 0,
    })
    .returning()
  return row
}

/** An owner, their artifact, and an unscoped machine token to push with. */
async function ownedArtifact(opts: { visibility?: Visibility } = {}) {
  const { user, cookie } = await makeUser(deps)
  const art = await makeArtifact(user, opts)
  const { header } = await makeMachineToken(deps, user.id)
  return { user, cookie, art, header }
}

const grantTo = (artifactId: string, userId: string, role: 'viewer' | 'editor') =>
  deps.db.insert(artifactGrants).values({ artifactId, userId, role })

const contentPath = (id: string) => `/api/artifacts/${id}/content`

const head = (id: string, headers: Record<string, string> = {}) =>
  deps.app.request(contentPath(id), { method: 'HEAD', headers })

const get = (id: string, headers: Record<string, string> = {}) =>
  deps.app.request(contentPath(id), { headers })

/** The stored row, read straight from the table — what "no write happened"
 *  is actually asserted against. */
async function stored(id: string) {
  const [row] = await deps.db.select().from(artifacts).where(eq(artifacts.id, id))
  return row
}

const versionRows = (id: string) =>
  deps.db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, id))
    .orderBy(asc(artifactVersions.version))

// ---------------------------------------------------------------------------
// PUT — the write path
// ---------------------------------------------------------------------------

describe('PUT /api/artifacts/:id/content', () => {
  it('stores the document, bumps the version and reports the change', async () => {
    const { art, header } = await ownedArtifact()

    const res = await pushHtml(deps, header, art.id, HTML)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1, changed: true })

    const row = await stored(art.id)
    expect(row.version).toBe(1)
    expect(row.bodyBytes).toBe(Buffer.byteLength(HTML))
    expect(row.contentHash.toString('hex')).toBe(sha256Hex(HTML))
    // Stored gzipped, and re-gzipped by us rather than trusting the client's
    // framing — the bytes on disk are this server's own canonical encoding.
    expect(gunzipSync(row.body).toString()).toBe(HTML)
    expect(row.body.equals(gzipBuf(HTML))).toBe(true)
    expect(row.updatedAt.getTime()).toBeGreaterThan(art.updatedAt.getTime() - 1)
  })

  it('accepts a session push carrying an Origin', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const res = await pushHtml(deps, { Cookie: cookie, Origin: ORIGIN }, art.id, HTML)
    expect(res.status).toBe(200)
    expect((await stored(art.id)).version).toBe(1)
  })

  it('answers 304 and writes nothing when If-None-Match holds the stored hash', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)
    const before = await stored(art.id)

    const res = await pushHtml(deps, header, art.id, HTML)
    expect(res.status).toBe(304)

    const after = await stored(art.id)
    expect(after.version).toBe(1)
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(await versionRows(art.id)).toHaveLength(0)
  })

  it('accepts a bare, unquoted If-None-Match', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const res = await pushHtml(deps, header, art.id, HTML, { 'If-None-Match': sha256Hex(HTML) })
    expect(res.status).toBe(304)
    expect((await stored(art.id)).version).toBe(1)
  })

  it('answers 304 for identical content even with no If-None-Match at all', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const res = await pushHtml(deps, header, art.id, HTML, { 'If-None-Match': '' })
    expect(res.status).toBe(304)
    expect((await stored(art.id)).version).toBe(1)
  })

  it('writes when If-None-Match names a hash the server does not hold', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const next = '<p>second</p>'
    const res = await pushHtml(deps, header, art.id, next, { 'If-None-Match': `"${EMPTY_SHA256}"` })
    expect(res.status).toBe(200)
    expect((await stored(art.id)).contentHash.toString('hex')).toBe(sha256Hex(next))
  })

  it('refuses a stale X-Base-Version with 409 and the current version and hash', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)
    await pushHtml(deps, header, art.id, '<p>v2</p>')

    const res = await pushHtml(deps, header, art.id, '<p>v3</p>', { 'X-Base-Version': '1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ version: 2, hash: sha256Hex('<p>v2</p>') })

    const row = await stored(art.id)
    expect(row.version).toBe(2)
    expect(row.contentHash.toString('hex')).toBe(sha256Hex('<p>v2</p>'))
  })

  it('writes when X-Base-Version matches the current version', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const res = await pushHtml(deps, header, art.id, '<p>v2</p>', { 'X-Base-Version': '1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 2, changed: true })
  })

  it('answers 304, not 409, when the content is unchanged and the base is stale', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    // The document on the server is already the document being pushed, so
    // there is nothing to conflict about: a daemon that lost track of the
    // version number must not be told to re-resolve a write it does not need.
    const res = await pushHtml(deps, header, art.id, HTML, { 'X-Base-Version': '0' })
    expect(res.status).toBe(304)
    expect((await stored(art.id)).version).toBe(1)
  })

  it('refuses a non-integer X-Base-Version with 400', async () => {
    const { art, header } = await ownedArtifact()
    const res = await pushHtml(deps, header, art.id, HTML, { 'X-Base-Version': 'latest' })
    expect(res.status).toBe(400)
    expect(await res.json()).toHaveProperty('error')
    expect((await stored(art.id)).version).toBe(0)
  })

  it('refuses every other spelling of a number too', async () => {
    const { art, header } = await ownedArtifact()

    // `Number()` reads all of these, which is exactly why the header is matched
    // against digits instead: a version is written the one way or not at all.
    for (const raw of ['1e2', '0x10', '1.0', '+1', '-1', ' 1 2', 'Infinity']) {
      const res = await pushHtml(deps, header, art.id, HTML, { 'X-Base-Version': raw })
      expect(res.status, raw).toBe(400)
    }
    expect((await stored(art.id)).version).toBe(0)
  })

  it('refuses a body that is not gzipped with 415', async () => {
    const { art, header } = await ownedArtifact()
    const res = await pushHtml(deps, header, art.id, HTML, { 'Content-Encoding': 'identity' })
    expect(res.status).toBe(415)
    expect(await res.json()).toHaveProperty('error')
    expect((await stored(art.id)).version).toBe(0)
  })

  it('refuses a body with no Content-Encoding at all with 415', async () => {
    const { art, header } = await ownedArtifact()
    const res = await pushHtml(deps, header, art.id, HTML, { 'Content-Encoding': '' })
    expect(res.status).toBe(415)
  })

  it('refuses a corrupt gzip body with 400 rather than a 500', async () => {
    const { art, header } = await ownedArtifact()
    const res = await deps.app.request(contentPath(art.id), {
      method: 'PUT',
      headers: { ...header, 'Content-Encoding': 'gzip' },
      body: new Uint8Array(Buffer.from('this is not gzip')),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toHaveProperty('error')
  })

  it('refuses a document over MAX_ARTIFACT_BYTES with 413 and the limit', async () => {
    const { art, header } = await ownedArtifact()

    const res = await pushHtml(deps, header, art.id, 'a'.repeat(11 * 1024 * 1024))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: expect.any(String),
      max_bytes: deps.cfg.maxArtifactBytes,
    })
    expect((await stored(art.id)).version).toBe(0)
  })

  it('refuses a PUT whose Content-Length exceeds the cap before reading the body', async () => {
    const small = await testDeps({ maxArtifactBytes: 64 })
    const { user } = await makeUser(small)
    const art = await makeArtifact(user)
    const { header } = await makeMachineToken(small, user.id)

    // Larger than the cap and deliberately not valid gzip. Without the
    // Content-Length pre-check the server would buffer it and answer 400 (bad
    // gzip); the pre-check refuses it as 413 before the body is read at all.
    // In production the HTTP layer supplies Content-Length from the wire; the
    // in-process test client only carries it when set explicitly.
    const body = new Uint8Array(Buffer.alloc(200, 1))
    const res = await small.app.request(contentPath(art.id), {
      method: 'PUT',
      headers: { ...header, 'Content-Encoding': 'gzip', 'Content-Length': String(body.length) },
      body,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: expect.any(String), max_bytes: 64 })
    expect((await stored(art.id)).version).toBe(0)
  })

  it('lets a user with an editor grant push', async () => {
    const { art } = await ownedArtifact({ visibility: 'restricted' })
    const other = await makeUser(deps)
    await grantTo(art.id, other.user.id, 'editor')

    const res = await pushHtml(deps, { Cookie: other.cookie, Origin: ORIGIN }, art.id, HTML)
    expect(res.status).toBe(200)
  })

  it('refuses a viewer with 403 — they can already see the artifact', async () => {
    const { art } = await ownedArtifact({ visibility: 'restricted' })
    const other = await makeUser(deps)
    await grantTo(art.id, other.user.id, 'viewer')

    const res = await pushHtml(deps, { Cookie: other.cookie, Origin: ORIGIN }, art.id, HTML)
    expect(res.status).toBe(403)
    expect((await stored(art.id)).version).toBe(0)
  })

  it('refuses someone with no access at all with 404', async () => {
    const { art } = await ownedArtifact()
    const other = await makeUser(deps)

    const res = await pushHtml(deps, { Cookie: other.cookie, Origin: ORIGIN }, art.id, HTML)
    expect(res.status).toBe(404)
  })

  it('refuses an anonymous push with 401', async () => {
    const { art } = await ownedArtifact({ visibility: 'public' })
    const res = await pushHtml(deps, { Origin: ORIGIN }, art.id, HTML)
    expect(res.status).toBe(401)
  })

  it('answers 404 for an artifact that does not exist', async () => {
    const { header } = await ownedArtifact()
    const res = await pushHtml(deps, header, '00000000-0000-4000-8000-000000000000', HTML)
    expect(res.status).toBe(404)
    expect(await res.json()).toHaveProperty('error')
  })

  it('refuses a scoped token pushing outside its scope with 404', async () => {
    const { user } = await makeUser(deps)
    const inScope = await makeArtifact(user)
    const hidden = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [inScope.id] })

    expect((await pushHtml(deps, header, hidden.id, HTML)).status).toBe(404)
    expect((await pushHtml(deps, header, inScope.id, HTML)).status).toBe(200)
  })

  it('fires a NOTIFY on artifact_updated when it commits', async () => {
    const { art, header } = await ownedArtifact()

    const listener = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await listener.connect()
    try {
      const received = new Promise<string>(resolve => {
        listener.on('notification', msg => resolve(msg.payload ?? ''))
      })
      await listener.query('LISTEN artifact_updated')

      const res = await pushHtml(deps, header, art.id, HTML)
      expect(res.status).toBe(200)

      const payload = JSON.parse(await received) as Record<string, unknown>
      expect(payload).toEqual({ artifactId: art.id, version: 1, hash: sha256Hex(HTML) })
    } finally {
      await listener.end()
    }
  })
})

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

describe('version history', () => {
  it('keeps the newest MAX_VERSIONS and never stores the version-0 placeholder', async () => {
    const capped = await testDeps({ maxVersions: 3 })
    const { user } = await makeUser(capped)
    const [art] = await capped.db
      .insert(artifacts)
      .values({
        workspaceId: user.workspaceId,
        ownerId: user.id,
        contentHash: sha256(''),
        body: gzipBuf(''),
        bodyBytes: 0,
        version: 0,
      })
      .returning()
    const { header } = await makeMachineToken(capped, user.id)

    for (let n = 1; n <= 5; n++) {
      const res = await pushHtml(capped, header, art.id, `<p>v${n}</p>`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ version: n, changed: true })
    }

    const rows = await capped.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, art.id))
      .orderBy(asc(artifactVersions.version))

    // v0 was an empty placeholder, never history; v5 is live on the artifact
    // row, so the archive is exactly the three versions in between.
    expect(rows.map(r => r.version)).toEqual([2, 3, 4])
    for (const row of rows) {
      expect(row.contentHash.toString('hex')).toBe(sha256Hex(`<p>v${row.version}</p>`))
      expect(gunzipSync(row.body).toString()).toBe(`<p>v${row.version}</p>`)
    }

    const [live] = await capped.db.select().from(artifacts).where(eq(artifacts.id, art.id))
    expect(live.version).toBe(5)
    expect(gunzipSync(live.body).toString()).toBe('<p>v5</p>')
  })

  it('archives the first real version but not the empty one', async () => {
    const { art, header } = await ownedArtifact()

    await pushHtml(deps, header, art.id, '<p>v1</p>')
    expect(await versionRows(art.id)).toHaveLength(0)

    await pushHtml(deps, header, art.id, '<p>v2</p>')
    const rows = await versionRows(art.id)
    expect(rows.map(r => r.version)).toEqual([1])
    expect(gunzipSync(rows[0].body).toString()).toBe('<p>v1</p>')
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('allows 60 writes a minute and refuses the 61st', async () => {
    let now = 1_700_000_000_000
    const limited = await testDeps({}, { now: () => now })
    const { user } = await makeUser(limited)
    const [art] = await limited.db
      .insert(artifacts)
      .values({
        workspaceId: user.workspaceId,
        ownerId: user.id,
        contentHash: sha256(''),
        body: gzipBuf(''),
        bodyBytes: 0,
        version: 0,
      })
      .returning()
    const { header } = await makeMachineToken(limited, user.id)

    for (let n = 1; n <= 60; n++) {
      now += 100
      const res = await pushHtml(limited, header, art.id, `<p>${n}</p>`)
      expect(res.status).toBe(200)
    }

    const refused = await pushHtml(limited, header, art.id, '<p>61</p>')
    expect(refused.status).toBe(429)
    expect(await refused.json()).toHaveProperty('error')

    // The window slides: once the first 60 are more than a minute old, the
    // caller is welcome again.
    now += 60_000
    const later = await pushHtml(limited, header, art.id, '<p>61</p>')
    expect(later.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// HEAD — what the CLI asks before it uploads
// ---------------------------------------------------------------------------

describe('HEAD /api/artifacts/:id/content', () => {
  it('reports the hash, the version and the uncompressed size', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const res = await head(art.id, header)
    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe(`"${sha256Hex(HTML)}"`)
    expect(res.headers.get('X-Artef-Version')).toBe('1')
    expect(res.headers.get('Content-Length')).toBe(String(Buffer.byteLength(HTML)))
    expect(await res.text()).toBe('')
  })

  it('answers for a version-0 artifact with the empty hash', async () => {
    const { art, header } = await ownedArtifact()
    const res = await head(art.id, header)
    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe(`"${EMPTY_SHA256}"`)
    expect(res.headers.get('X-Artef-Version')).toBe('0')
    expect(res.headers.get('Content-Length')).toBe('0')
  })

  it('is 404 for a stranger and for a scoped token out of scope', async () => {
    const { art } = await ownedArtifact()
    const other = await makeUser(deps)
    expect((await head(art.id, { Cookie: other.cookie })).status).toBe(404)

    const { user } = await makeUser(deps)
    const inScope = await makeArtifact(user)
    const hidden = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [inScope.id] })
    expect((await head(hidden.id, header)).status).toBe(404)
    expect((await head(inScope.id, header)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// GET — agents reading back
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:id/content', () => {
  it('serves the stored gzip under the sandbox CSP', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const res = await get(art.id, { ...header, 'Accept-Encoding': 'gzip, deflate' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="artifact.html"')
    expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('ETag')).toBe(`"${sha256Hex(HTML)}"`)

    const raw = Buffer.from(await res.arrayBuffer())
    expect(gunzipSync(raw).toString()).toBe(HTML)
  })

  it('decompresses for a client that did not ask for gzip', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const res = await get(art.id, header)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    expect(await res.text()).toBe(HTML)
  })

  it('treats gzip;q=0 as a refusal of gzip', async () => {
    const { art, header } = await ownedArtifact()
    await pushHtml(deps, header, art.id, HTML)

    const res = await get(art.id, { ...header, 'Accept-Encoding': 'gzip;q=0, identity' })
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(await res.text()).toBe(HTML)
  })

  it('serves a version-0 artifact as an empty document, not an error', async () => {
    const { art, header } = await ownedArtifact()
    const res = await get(art.id, header)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('serves a public artifact to an anonymous caller', async () => {
    const { art, header } = await ownedArtifact({ visibility: 'public' })
    await pushHtml(deps, header, art.id, HTML)

    const res = await get(art.id)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
  })

  it('is 404 for a stranger, an unknown id and an unparseable id', async () => {
    const { art } = await ownedArtifact()
    const other = await makeUser(deps)

    expect((await get(art.id, { Cookie: other.cookie })).status).toBe(404)
    expect((await get('00000000-0000-4000-8000-000000000000', { Cookie: other.cookie })).status).toBe(404)

    const res = await get('not-a-uuid', { Cookie: other.cookie })
    expect(res.status).toBe(404)
    expect(await res.json()).toHaveProperty('error')
  })

  it('is 404 for a scoped token out of scope', async () => {
    const { user } = await makeUser(deps)
    const inScope = await makeArtifact(user)
    const hidden = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [inScope.id] })

    expect((await get(hidden.id, header)).status).toBe(404)
    expect((await get(inScope.id, header)).status).toBe(200)
  })
})
