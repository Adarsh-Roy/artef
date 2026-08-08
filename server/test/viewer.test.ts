// The viewer half of the product (spec §2.3, §2.4, §5.7, §5.8): the shell page
// a person lands on, the sandboxed document it frames, and the short-lived
// token that is the only credential the document route accepts.
//
// Three rules run through the whole file:
//
//   - `/c/:id` never reads a cookie. A signed-in reader with no `?t=` gets the
//     same redirect a stranger gets, because the sandboxed frame that normally
//     asks for it sends no cookies at all (§2.4).
//   - "you may not" and "it is not there" are the same answer, byte for byte
//     (§2.3) — with one deliberate exception, the link-preview page (§5.8).
//   - artifact names are attacker-controlled, so every one of them leaves the
//     server escaped.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { artifacts, artifactGrants, users } from '../src/db/schema.js'
import { mintContentToken, sha256, verifyContentToken } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { esc } from '../src/viewer/shell.js'
import {
  closeDb,
  makeMachineToken,
  makeUser,
  pushHtml,
  resetDb,
  testDeps,
  TEST_SECRET,
  type TestDeps,
} from './helpers.js'

const HTML = '<!doctype html><h1>hello</h1>'
const XSS_NAME = '<script>alert(1)</script>'
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

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
  opts: { visibility?: Visibility; name?: string } = {},
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
      version: 0,
    })
    .returning()
  return row
}

/** An owner, their artifact with `HTML` already pushed, and a token to push more. */
async function published(opts: { visibility?: Visibility; name?: string } = {}) {
  const { user, cookie } = await makeUser(deps)
  const art = await makeArtifact(user, opts)
  const { header } = await makeMachineToken(deps, user.id)
  const res = await pushHtml(deps, header, art.id, HTML)
  expect(res.status).toBe(200)
  return { user, cookie, art, header }
}

const grantTo = (artifactId: string, userId: string, role: 'viewer' | 'editor') =>
  deps.db.insert(artifactGrants).values({ artifactId, userId, role })

const shell = (id: string, headers: Record<string, string> = {}) =>
  deps.app.request(`/a/${id}`, { headers })

const doc = (id: string, query = '', headers: Record<string, string> = {}) =>
  deps.app.request(`/c/${id}${query}`, { headers })

const tokenFor = (id: string, headers: Record<string, string> = {}) =>
  deps.app.request(`/api/artifacts/${id}/content-token`, { headers })

/** The `?t=` value out of the shell's iframe, HTML-unescaped and URL-decoded —
 *  exactly what a browser would send back. */
function frameToken(html: string): string {
  const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(html)
  expect(src).not.toBeNull()
  const url = new URL(src![1].replace(/&amp;/g, '&'), 'https://artef.test')
  return url.searchParams.get('t') ?? ''
}

// ---------------------------------------------------------------------------
// GET /a/:id — the shell page
// ---------------------------------------------------------------------------

describe('GET /a/:id', () => {
  it('frames the document in a sandboxed iframe carrying a working token', async () => {
    const { art, cookie } = await published({ name: 'Q3 infra report' })

    const res = await shell(art.id, { Cookie: cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)

    const body = await res.text()
    expect(body).toContain('sandbox="allow-scripts"')
    expect(body).toContain(`/c/${art.id}?t=`)
    expect(body).toContain('id="share-root"')
    expect(body).toContain('Q3 infra report')

    // The page is not cached: it embeds a credential.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')

    const t = frameToken(body)
    expect(verifyContentToken(t, art.id, TEST_SECRET)).toBe(true)

    // And the token actually works on the route it was minted for.
    const framed = await doc(art.id, `?t=${encodeURIComponent(t)}`)
    expect(framed.status).toBe(200)
    expect(await framed.text()).toBe(HTML)
  })

  it('serves a grantee on a restricted artifact', async () => {
    const { art } = await published({ visibility: 'restricted' })
    const other = await makeUser(deps)
    await grantTo(art.id, other.user.id, 'viewer')

    const res = await shell(art.id, { Cookie: other.cookie })
    expect(res.status).toBe(200)
    expect(verifyContentToken(frameToken(await res.text()), art.id, TEST_SECRET)).toBe(true)
  })

  it('frames a public artifact for an anonymous reader with a version, not a token', async () => {
    const { art } = await published({ visibility: 'public' })

    const res = await shell(art.id)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`/c/${art.id}?v=1`)
    expect(body).not.toContain('?t=')
  })

  it('escapes an artifact name that is an XSS attempt, in the page and the OG tag', async () => {
    const { art, cookie } = await published({ name: XSS_NAME })

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toContain(esc(XSS_NAME))
    expect(body).not.toContain(XSS_NAME)
    expect(body).toContain(`<meta property="og:title" content="${esc(XSS_NAME)}">`)
    // The only script on the page is ours.
    expect(body).not.toContain('alert(1)</script>')
  })

  it('shows Share to the owner and to an admin, and to nobody else', async () => {
    const { art, user, cookie } = await published({ visibility: 'workspace' })
    const admin = await makeUser(deps, { isAdmin: true })
    const peer = await makeUser(deps)
    expect(admin.workspace.id).toBe(user.workspaceId)

    expect(await (await shell(art.id, { Cookie: cookie })).text()).toContain('id="share-button"')
    expect(await (await shell(art.id, { Cookie: admin.cookie })).text()).toContain('id="share-button"')

    const seenByPeer = await (await shell(art.id, { Cookie: peer.cookie })).text()
    expect(seenByPeer).not.toContain('id="share-button"')
    // The mount point is always there; Task 9 fills it.
    expect(seenByPeer).toContain('id="share-root"')
  })

  it('offers logout to a signed-in reader and sign-in to an anonymous one', async () => {
    const { art, cookie } = await published({ visibility: 'public' })

    const signedIn = await (await shell(art.id, { Cookie: cookie })).text()
    expect(signedIn).toContain('<form class="logout" method="post" action="/auth/logout">')
    expect(signedIn).not.toContain('/auth/login')

    const anonymous = await (await shell(art.id)).text()
    expect(anonymous).toContain(`/auth/login?next=${encodeURIComponent(`/a/${art.id}`)}`)
    expect(anonymous).not.toContain('action="/auth/logout"')
  })

  it('gives an unauthenticated reader the name and a login prompt when LINK_PREVIEW=name', async () => {
    const { art } = await published({ name: XSS_NAME, visibility: 'workspace' })

    const res = await shell(art.id)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`<meta property="og:title" content="${esc(XSS_NAME)}">`)
    expect(body).toContain(`https://artef.test/a/${art.id}`)
    expect(body).toContain(`/auth/login?next=${encodeURIComponent(`/a/${art.id}`)}`)
    // No content and no way to reach it: the preview leaks the name, nothing else.
    expect(body).not.toContain('iframe')
    expect(body).not.toContain('/c/')
    expect(body).not.toContain(XSS_NAME)
  })

  it('does not authenticate a bearer token: an agent sees what an anonymous reader sees', async () => {
    const { art, header } = await published({ name: 'agent eyes only', visibility: 'workspace' })

    // Bearer auth is scoped to /api (§5), so a stale Authorization header lying
    // around in a client cannot change what this route decides.
    const res = await shell(art.id, header)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('iframe')
  })

  it('titles an unnamed document rather than leaving the tab blank', async () => {
    const { art, cookie } = await published()

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toContain('<title>Artef document</title>')
    expect(body).toContain('<meta property="og:title" content="Artef document">')
  })

  it('is 404 to an unauthenticated reader when LINK_PREVIEW=none', async () => {
    const quiet = await testDeps({ linkPreview: 'none' })
    const { user } = await makeUser(quiet)
    const [art] = await quiet.db
      .insert(artifacts)
      .values({
        workspaceId: user.workspaceId,
        ownerId: user.id,
        name: 'secret plans',
        visibility: 'workspace',
        contentHash: sha256(''),
        body: gzipBuf(''),
        bodyBytes: 0,
        version: 0,
      })
      .returning()

    const res = await quiet.app.request(`/a/${art.id}`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('secret plans')
  })

  it('answers a reader with no access exactly as it answers an unknown id', async () => {
    const { art } = await published({ name: 'private plans' })
    const stranger = await makeUser(deps)

    const refused = await shell(art.id, { Cookie: stranger.cookie })
    const unknown = await shell(UNKNOWN_ID, { Cookie: stranger.cookie })
    const garbage = await shell('not-a-uuid', { Cookie: stranger.cookie })

    expect(refused.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(garbage.status).toBe(404)

    const body = await refused.text()
    expect(body).toBe(await unknown.text())
    expect(body).toBe(await garbage.text())
    expect(body).not.toContain('private plans')
  })
})

// ---------------------------------------------------------------------------
// GET /c/:id — the document itself
// ---------------------------------------------------------------------------

describe('GET /c/:id', () => {
  it('serves the document to a valid token as html', async () => {
    const { art } = await published()
    const t = mintContentToken(art.id, TEST_SECRET)

    const res = await doc(art.id, `?t=${encodeURIComponent(t)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe(HTML)
  })

  it('serves the stored gzip to a client that takes it', async () => {
    const { art } = await published()
    const t = mintContentToken(art.id, TEST_SECRET)

    const res = await doc(art.id, `?t=${encodeURIComponent(t)}`, { 'Accept-Encoding': 'gzip' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(HTML)
  })

  it('serves a public artifact with no token at all', async () => {
    const { art } = await published({ visibility: 'public' })

    const res = await doc(art.id)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
  })

  it('serves a version-0 artifact as an empty document, not an error', async () => {
    const { user } = await makeUser(deps)
    const art = await makeArtifact(user)
    const t = mintContentToken(art.id, TEST_SECRET)

    const res = await doc(art.id, `?t=${encodeURIComponent(t)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('redirects to the shell without a token, with garbage, and with an expired one', async () => {
    const { art } = await published()
    const stale = mintContentToken(art.id, TEST_SECRET, Date.now() - 180_000)
    const other = await published()
    const wrongArtifact = mintContentToken(other.art.id, TEST_SECRET)

    for (const query of ['', '?t=', '?t=nonsense', `?t=${stale}`, `?t=${wrongArtifact}`]) {
      const res = await doc(art.id, query)
      expect(res.status, query).toBe(302)
      expect(res.headers.get('Location')).toBe(`/a/${art.id}`)
      expect(await res.text()).toBe('')
    }
  })

  it('ignores the session cookie: a signed-in owner with no token is still redirected', async () => {
    const { art, cookie } = await published()

    const res = await doc(art.id, '', { Cookie: cookie })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/a/${art.id}`)
    expect(await res.text()).toBe('')
  })

  it('redirects rather than 404s for an unknown id, so existence never leaks', async () => {
    const res = await doc(UNKNOWN_ID)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/a/${UNKNOWN_ID}`)
  })
})

// ---------------------------------------------------------------------------
// GET /api/artifacts/:id/content-token
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:id/content-token', () => {
  it('mints a token a session holder can use on /c/:id', async () => {
    const { art, cookie } = await published()

    const res = await tokenFor(art.id, { Cookie: cookie })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { t: string; ttl_seconds: number }
    expect(body.ttl_seconds).toBe(120)
    expect(verifyContentToken(body.t, art.id, TEST_SECRET)).toBe(true)
    expect(res.headers.get('Cache-Control')).toBe('no-store')

    const served = await doc(art.id, `?t=${encodeURIComponent(body.t)}`)
    expect(served.status).toBe(200)
  })

  it('mints for an agent on a bearer token too', async () => {
    const { art, header } = await published()

    const res = await tokenFor(art.id, header)
    expect(res.status).toBe(200)
    const { t } = (await res.json()) as { t: string }
    expect(verifyContentToken(t, art.id, TEST_SECRET)).toBe(true)
  })

  it('is 404 for a stranger, an anonymous caller, an unknown id and an out-of-scope token', async () => {
    const { art, user } = await published()
    const stranger = await makeUser(deps)

    expect((await tokenFor(art.id, { Cookie: stranger.cookie })).status).toBe(404)
    expect((await tokenFor(art.id)).status).toBe(404)
    expect((await tokenFor(UNKNOWN_ID, { Cookie: stranger.cookie })).status).toBe(404)

    const hidden = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [hidden.id] })
    expect((await tokenFor(art.id, header)).status).toBe(404)
    expect((await tokenFor(hidden.id, header)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// GET /:id — the short URL people actually paste
// ---------------------------------------------------------------------------

describe('GET /:id', () => {
  it('redirects a uuid to its shell page permanently', async () => {
    const { art } = await published()

    const res = await deps.app.request(`/${art.id}`)
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe(`/a/${art.id}`)
  })

  it('redirects without looking the artifact up, so it leaks nothing', async () => {
    const res = await deps.app.request(`/${UNKNOWN_ID}`)
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe(`/a/${UNKNOWN_ID}`)
  })

  it('leaves everything else alone', async () => {
    expect((await deps.app.request('/nonsense')).status).toBe(404)
    // The routes that share the shape still answer for themselves.
    expect((await deps.app.request('/_health')).status).toBe(200)
  })
})
