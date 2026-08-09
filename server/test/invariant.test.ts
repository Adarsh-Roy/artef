// THE INVARIANT (spec §2.2). This file is the release gate.
//
// The whole isolation model rests on one response header. There is no second
// registrable domain to fall back on, so if `Content-Security-Policy: sandbox
// allow-scripts` ever stops travelling with artifact bytes — or ever grows an
// `allow-same-origin` token — an artifact's JavaScript runs on the real app
// origin with the reader's real session, and the ACL cheerfully agrees that it
// is them. A failure anywhere in this file is a release blocker, not a bug.
//
// It asserts five things:
//   1. the policy constants themselves are the policy §2.1 specifies;
//   2. every route that serves user-supplied bytes sends that policy;
//   3. `/c/:id` for a non-public artifact never returns bytes without a valid
//      content token (§2.4);
//   4. the list of byte-serving routes is exactly the list we have checked —
//      so adding a fourth one fails here until someone checks it too;
//   5. the whole route table is the table we have classified — so a route added
//      anywhere in the app fails here until someone decides which list it
//      belongs on.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { artifacts } from '../src/db/schema.js'
import { mintContentToken, sha256, sha256Hex } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { ARTIFACT_CSP, ASSET_CSP } from '../src/lib/headers.js'
import { closeDb, makeMachineToken, makeUser, pushHtml, resetDb, testDeps, TEST_SECRET, type TestDeps } from './helpers.js'

const HTML = '<!doctype html><script>alert(document.cookie)</script>'
/** An asset that is a scriptable document: navigate to it unsandboxed and the
 *  handler runs on our origin. This is why `/assets/:sha` exists in this file. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"/>'

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

/** An asset in the store, and the path it is served from (spec §5.4). */
async function uploadAsset(bytes: string, mediaType: string): Promise<string> {
  const { user } = await makeUser(deps)
  const { header } = await makeMachineToken(deps, user.id)

  const form = new FormData()
  form.append('file', new File([new Uint8Array(Buffer.from(bytes))], 'asset', { type: mediaType }))
  const res = await deps.app.request('/api/assets', { method: 'POST', headers: header, body: form })
  expect(res.status).toBe(201)

  return `/assets/${sha256Hex(bytes)}`
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
    // that carry no bytes are held to it as well. HEAD is in here because hono
    // answers it from the GET handler by re-dispatching and dropping the body —
    // if that ever stopped copying the headers across, a HEAD would be an
    // unsandboxed response from this route.
    const urls = [`/c/${open.art.id}`, `/c/${closed.art.id}`, `/c/${closed.art.id}?t=bogus`]
    for (const method of ['GET', 'HEAD']) {
      for (const url of urls) {
        const where = `${method} ${url}`
        const res = await deps.app.request(url, { method })
        expect(res.headers.get('Content-Security-Policy'), where).toBe(ARTIFACT_CSP)
        expect(res.headers.get('X-Content-Type-Options'), where).toBe('nosniff')
        expect(res.headers.get('Referrer-Policy'), where).toBe('no-referrer')
        // Artifact bytes must not sit in a shared cache, and the shell's
        // reload-on-update has to actually refetch (§2.1).
        expect(res.headers.get('Cache-Control'), where).toBe('private, no-store')
      }
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

  it('/assets/:sha carries the script-less sandbox CSP + nosniff', async () => {
    const path = await uploadAsset(SVG, 'image/svg+xml')

    // No credential of any kind: this route is unauthenticated by design
    // (§5.4), which is exactly why its headers carry the whole weight.
    const res = await deps.app.request(path)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SVG)

    // The literal string as well as the constant: a change to ASSET_CSP that
    // slipped `allow-scripts` in would otherwise agree with itself.
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    )
    expect(res.headers.get('Content-Security-Policy')).toBe(ASSET_CSP)
    expect(res.headers.get('Content-Security-Policy')).not.toContain('allow-scripts')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
    // The URL is the hash of the bytes, so the bytes behind it cannot change.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
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
// 4. Nobody adds a byte-serving route without reading this file
// ---------------------------------------------------------------------------

describe('the byte-serving route list', () => {
  // The viewer routes that hand out raw user bytes, and the whole list of them.
  // A HEAD never appears here: hono answers HEAD from the GET handler, so
  // registering one separately would be dead code.
  const EXPECTED_BYTE_ROUTES = ['GET /c/:id', 'GET /assets/:sha']

  it('is exactly the list this file has checked', () => {
    const byteRoutes = deps.app.routes
      .filter(r => /^\/(c|assets)\//.test(r.path))
      .map(r => `${r.method} ${r.path}`)

    expect(new Set(byteRoutes)).toEqual(new Set(EXPECTED_BYTE_ROUTES))
  })
})

// ---------------------------------------------------------------------------
// 5. Nobody adds *any* route without reading this file
// ---------------------------------------------------------------------------

describe('the whole route table', () => {
  /**
   * Every method+path pair the app registers, middleware included, deduped and
   * sorted. This is a snapshot on purpose and it is meant to be annoying:
   * §4 above only notices a new route under `/c/` or `/assets/`, which is no
   * help at all against a byte-serving route mounted somewhere new.
   *
   * **Adding a route? Decide whether it serves user bytes. If yes it needs the
   * sandbox headers (§2.2) and an entry in EXPECTED_BYTE_ROUTES above. Either
   * way, update this snapshot.**
   *
   * Two things this list reflects rather than dictates. Hono registers one
   * entry per handler, so a route with middleware in front of it appears once
   * after deduping. And `/auth/:provider` is built from configured providers —
   * this is the default test config, which has Google alone.
   */
  const EXPECTED_ROUTES = [
    'ALL /*',
    'ALL /api/*',
    'ALL /api/artifacts/:id',
    'ALL /api/artifacts/:id/*',
    'ALL /auth/logout',
    'ALL /cli/auth/approve',
    'DELETE /api/artifacts/:id',
    'DELETE /api/artifacts/:id/grants/:user_id',
    'DELETE /api/tokens/:id',
    'GET /:id',
    'GET /_health',
    'GET /a/:id',
    'GET /api/artifacts',
    'GET /api/artifacts/:id',
    'GET /api/artifacts/:id/content',
    'GET /api/artifacts/:id/content-token',
    'GET /api/artifacts/:id/events',
    'GET /api/artifacts/:id/grants',
    'GET /api/tokens',
    'GET /assets/:sha',
    'GET /auth/google',
    'GET /auth/google/callback',
    'GET /auth/login',
    'GET /auth/logout',
    'GET /c/:id',
    // The `artef login` flow (§7.2). Server-rendered pages and a JSON exchange;
    // nothing here serves user bytes, so none of it belongs in the byte-route
    // list above.
    'GET /cli/auth',
    'GET /cli/auth/manual',
    'HEAD /api/artifacts/:id/content',
    // The MCP front door (§7.0). One entry, because the bearer middleware and
    // the handler are both registered on the same exact path.
    //
    // **It does not serve user bytes and so is not in the byte-route list.**
    // Everything that crosses it is JSON-RPC: an agent's tool call in, a JSON
    // envelope out. `get_content` does hand back a document, but as a JSON
    // string inside a tool result with `Content-Type: application/json` — never
    // as a `text/html` response a browser would render, which is the only thing
    // the sandbox CSP exists to stop. The tools reach the stored bytes by
    // calling this app's own `/api` routes, which carry the sandbox headers
    // themselves and are checked above.
    'ALL /mcp',
    'PATCH /api/artifacts/:id',
    'POST /api/artifacts',
    'POST /api/artifacts/:id/grants',
    'POST /api/assets',
    'POST /api/tokens',
    'POST /auth/logout',
    'POST /cli/auth/approve',
    'POST /cli/auth/exchange',
    'PUT /api/artifacts/:id/content',
  ]

  it('is exactly the table this file has classified', () => {
    const registered = [...new Set(deps.app.routes.map(r => `${r.method} ${r.path}`))].sort()
    expect(registered).toEqual([...EXPECTED_ROUTES].sort())
  })
})
