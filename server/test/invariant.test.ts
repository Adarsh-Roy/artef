// THE INVARIANT (spec §2.2). This file is the release gate.
//
// The whole isolation model rests on one response header. There is no second
// registrable domain to fall back on, so if `Content-Security-Policy: sandbox
// allow-scripts` ever stops travelling with artifact bytes — or ever grows an
// `allow-same-origin` token — an artifact's JavaScript runs on the real app
// origin with the reader's real session, and the ACL cheerfully agrees that it
// is them. A failure anywhere in this file is a release blocker, not a bug.
//
// It asserts four things:
//   1. the policy constants themselves are the policy §2.1 specifies;
//   2. every route that serves user-supplied bytes sends that policy;
//   3. `/c/:id` for a non-public artifact never returns bytes without a valid
//      content token (§2.4);
//   4. the list of byte-serving routes is exactly the list we have checked —
//      so adding a fourth one fails here until someone checks it too.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { artifacts } from '../src/db/schema.js'
import { mintContentToken, sha256 } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { ARTIFACT_CSP, ASSET_CSP } from '../src/lib/headers.js'
import { closeDb, makeMachineToken, makeUser, pushHtml, resetDb, testDeps, TEST_SECRET, type TestDeps } from './helpers.js'

const HTML = '<!doctype html><script>alert(document.cookie)</script>'

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

/** An artifact with real bytes in it, plus the ways in. */
async function seeded(visibility: 'private' | 'public' = 'private') {
  const { user, cookie } = await makeUser(deps)
  const [art] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: user.workspaceId,
      ownerId: user.id,
      visibility,
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
      version: 0,
    })
    .returning()
  const { header } = await makeMachineToken(deps, user.id)
  expect((await pushHtml(deps, header, art.id, HTML)).status).toBe(200)
  return { art, cookie, header }
}

// ---------------------------------------------------------------------------
// 1. The policy constants
// ---------------------------------------------------------------------------

describe('the sandbox policy', () => {
  it('sandboxes artifacts with allow-scripts and NEVER allow-same-origin', () => {
    expect(ARTIFACT_CSP).toMatch(/^sandbox allow-scripts; /)
    // The two tokens together cancel the sandbox out entirely (§2.1).
    expect(ARTIFACT_CSP).not.toContain('allow-same-origin')
    // Nothing else may be handed out either: no popups, no top navigation, no
    // forms, no same-site cookies.
    expect(/^sandbox ([a-z-]+)(;| )/.exec(ARTIFACT_CSP)?.[1]).toBe('allow-scripts')
  })

  it('leaves an artifact no way to send a byte anywhere', () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'")
    expect(ARTIFACT_CSP).toContain("connect-src 'none'")
    expect(ARTIFACT_CSP).toContain("form-action 'none'")
    expect(ARTIFACT_CSP).toContain("base-uri 'none'")
    expect(ARTIFACT_CSP).toContain("frame-ancestors 'self'")
    // Images and fonts may come from us or from a data: URI — never from a URL
    // whose query string could carry the document's contents out.
    expect(ARTIFACT_CSP).toContain("img-src 'self' data:")
  })

  it('sandboxes assets with no scripting at all', () => {
    expect(ASSET_CSP).toMatch(/^sandbox; /)
    expect(ASSET_CSP).not.toContain('allow-scripts')
    expect(ASSET_CSP).not.toContain('allow-same-origin')
  })
})

// ---------------------------------------------------------------------------
// 2. Every route that serves user-supplied bytes
// ---------------------------------------------------------------------------

describe('routes that serve user-supplied bytes', () => {
  it('/c/:id carries the full artifact header set', async () => {
    const { art } = await seeded()
    const t = mintContentToken(art.id, TEST_SECRET)

    const res = await deps.app.request(`/c/${art.id}?t=${encodeURIComponent(t)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)

    expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  })

  it('/c/:id carries it on a public serve and on the redirect too', async () => {
    const open = await seeded('public')
    const closed = await seeded()

    // Spec §2.2 is written as "every response from /c/:id", so the responses
    // that carry no bytes are held to it as well.
    for (const url of [`/c/${open.art.id}`, `/c/${closed.art.id}`, `/c/${closed.art.id}?t=bogus`]) {
      const res = await deps.app.request(url)
      expect(res.headers.get('Content-Security-Policy'), url).toBe(ARTIFACT_CSP)
      expect(res.headers.get('X-Content-Type-Options'), url).toBe('nosniff')
      expect(res.headers.get('Referrer-Policy'), url).toBe('no-referrer')
    }
  })

  it('GET /api/artifacts/:id/content is neutered: octet-stream + attachment + sandbox CSP', async () => {
    const { art, header } = await seeded()

    const res = await deps.app.request(`/api/artifacts/${art.id}/content`, { headers: header })
    expect(res.status).toBe(200)
    // Without these three a logged-in person clicking this link would run the
    // artifact's scripts on the real origin with their real session.
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="artifact.html"')
    expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  // TODO-Task-11: /assets/:sha does not exist yet. When it lands, un-skip this
  // and add 'GET /assets/:sha' to EXPECTED_BYTE_ROUTES below.
  it.skip('/assets/:sha carries the script-less sandbox CSP + nosniff', async () => {
    const res = await deps.app.request('/assets/' + 'a'.repeat(64))
    expect(res.headers.get('Content-Security-Policy')).toBe(ASSET_CSP)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

// ---------------------------------------------------------------------------
// 3. The token is the only credential (§2.4)
// ---------------------------------------------------------------------------

describe('/c/:id for a non-public artifact', () => {
  it('never serves bytes without a valid token', async () => {
    const { art, cookie, header } = await seeded()
    const expired = mintContentToken(art.id, TEST_SECRET, Date.now() - 180_000)
    const forged = `${Math.floor(Date.now() / 1000) + 600}.notasignature`
    const foreign = mintContentToken(art.id, 'a-different-secret-0123456789abcd')

    const attempts: Array<[string, Record<string, string>]> = [
      ['', {}],
      ['?t=', {}],
      ['?t=nonsense', {}],
      [`?t=${expired}`, {}],
      [`?t=${forged}`, {}],
      [`?t=${foreign}`, {}],
      // Neither credential the rest of the app accepts is a credential here.
      ['', { Cookie: cookie }],
      ['', header],
    ]

    for (const [query, headers] of attempts) {
      const res = await deps.app.request(`/c/${art.id}${query}`, { headers })
      expect(res.status, query).toBe(302)
      expect(res.headers.get('Location'), query).toBe(`/a/${art.id}`)
      expect(await res.text(), query).toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Nobody adds a fourth byte-serving route without reading this file
// ---------------------------------------------------------------------------

describe('the byte-serving route list', () => {
  // The viewer routes that hand out raw user bytes, and the whole list of them.
  // `/assets/:sha` joins this in Task 11. A HEAD never appears here: hono
  // answers HEAD from the GET handler on a parameterized path, so registering
  // one separately would be dead code.
  const EXPECTED_BYTE_ROUTES = ['GET /c/:id']

  it('is exactly the list this file has checked', () => {
    const byteRoutes = deps.app.routes
      .filter(r => /^\/(c|assets)\//.test(r.path))
      .map(r => `${r.method} ${r.path}`)

    expect(new Set(byteRoutes)).toEqual(new Set(EXPECTED_BYTE_ROUTES))
  })
})
