// Content-addressed assets (spec §5.4). The two halves of this feature answer
// to opposite rules, and that asymmetry is the whole design:
//
//   - `POST /api/assets` needs a real credential and writes into one workspace,
//     so an upload can be attributed, quota'd and cleaned up with its workspace.
//   - `GET /assets/:sha` needs no credential at all and looks up by hash alone.
//     Image requests come from inside the sandboxed frame, which sends no
//     cookies (§2.4), so a session is not available to check even in principle
//     — and the hash is its own capability: to name an asset you have to know
//     the SHA-256 of the bytes, which you only know if you already have them.
//
// The serve path is also the third route in the app that hands out bytes
// somebody else supplied, so its headers are the invariant (§2.2) and are
// asserted as exact strings here and again in invariant.test.ts.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { assets } from '../src/db/schema.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { ASSET_CSP } from '../src/lib/headers.js'
import {
  closeDb,
  makeMachineToken,
  makeUser,
  resetDb,
  testDeps,
  type TestDeps,
} from './helpers.js'

/** A real PNG header, so the bytes are at least the shape of the thing. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])
const PNG_SHA = sha256Hex(PNG)

/** An SVG that would run script if it were ever navigated to unsandboxed. */
const HOSTILE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><rect/></svg>',
)

/** The exact allowlist the CLI pins (spec §5.4, §6). */
const ALLOWED = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'font/woff',
  'font/woff2',
]

const SHA_OF_NOTHING = 'a'.repeat(64)

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

// --- fixtures ----------------------------------------------------------------

/** The upload exactly as the CLI shapes it (spec §5.4): `multipart/form-data`,
 *  one part named `file`, media type carried by the part's own Content-Type. */
async function upload(
  d: TestDeps,
  auth: Record<string, string>,
  bytes: Buffer,
  mediaType: string,
): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], 'asset', { type: mediaType }))
  return d.app.request('/api/assets', { method: 'POST', headers: auth, body: form })
}

/** An agent that may upload. */
async function agent(d: TestDeps = deps): Promise<{ header: { Authorization: string }; workspaceId: string }> {
  const { user } = await makeUser(d)
  const { header } = await makeMachineToken(d, user.id)
  return { header, workspaceId: user.workspaceId }
}

const rows = () => deps.db.select().from(assets)

// --- upload ------------------------------------------------------------------

describe('POST /api/assets', () => {
  it('stores the bytes and answers with their hash', async () => {
    const { header, workspaceId } = await agent()

    const res = await upload(deps, header, PNG, 'image/png')
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      sha256: PNG_SHA,
      url: `/assets/${PNG_SHA}`,
      byte_size: PNG.length,
    })

    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0].workspaceId).toBe(workspaceId)
    expect(stored[0].sha256.toString('hex')).toBe(PNG_SHA)
    expect(stored[0].mediaType).toBe('image/png')
    expect(stored[0].byteSize).toBe(PNG.length)
    // Uncompressed: media formats are already compressed, so a second pass buys
    // nothing and would only cost CPU on every serve (§6).
    expect(stored[0].body.equals(PNG)).toBe(true)
  })

  it('takes a browser session as well as a machine token', async () => {
    const { cookie } = await makeUser(deps)

    const res = await upload(
      deps,
      { Cookie: cookie, Origin: deps.cfg.url },
      PNG,
      'image/png',
    )
    expect(res.status).toBe(201)
    expect((await rows())).toHaveLength(1)
  })

  it('refuses an upload from nobody', async () => {
    const res = await upload(deps, {}, PNG, 'image/png')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: expect.any(String) })
    expect(await rows()).toHaveLength(0)
  })

  it('lets a scoped token upload — the push it is scoped for extracts assets', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id, {
      scopeIds: ['00000000-0000-4000-8000-000000000000'],
    })

    expect((await upload(deps, header, PNG, 'image/png')).status).toBe(201)
  })

  it('answers the same 201 for bytes it already holds, and stores one row', async () => {
    const { header } = await agent()

    const first = await upload(deps, header, PNG, 'image/png')
    const second = await upload(deps, header, PNG, 'image/png')

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(await second.json()).toEqual(await first.json())
    expect(await rows()).toHaveLength(1)
  })

  it('keeps a row per workspace for the same bytes', async () => {
    const a = await agent()
    const b = await agent(await testDeps({ allowedDomains: ['other.test'] }))

    expect((await upload(deps, a.header, PNG, 'image/png')).status).toBe(201)
    expect((await upload(deps, b.header, PNG, 'image/png')).status).toBe(201)

    const stored = await rows()
    expect(stored).toHaveLength(2)
    expect(stored.map(r => r.workspaceId).sort()).toEqual([a.workspaceId, b.workspaceId].sort())
    expect(new Set(stored.map(r => r.sha256.toString('hex')))).toEqual(new Set([PNG_SHA]))
  })

  it('accepts every media type on the allowlist', async () => {
    const { header } = await agent()

    for (const [i, mediaType] of ALLOWED.entries()) {
      // Distinct bytes per type, so each one is its own row.
      const bytes = Buffer.from(`asset-${i}`)
      const res = await upload(deps, header, bytes, mediaType)
      expect(res.status, mediaType).toBe(201)
      expect((await res.json()).sha256, mediaType).toBe(sha256Hex(bytes))
    }

    const stored = await rows()
    expect(new Set(stored.map(r => r.mediaType))).toEqual(new Set(ALLOWED))
  })

  it('reads the media type off the part and drops its parameters', async () => {
    const { header } = await agent()

    expect((await upload(deps, header, HOSTILE_SVG, 'image/svg+xml; charset=utf-8')).status).toBe(201)
    expect((await rows())[0].mediaType).toBe('image/svg+xml')
  })

  it('refuses anything else with 415', async () => {
    const { header } = await agent()

    for (const mediaType of [
      'text/html',
      'text/plain',
      'application/pdf',
      'application/octet-stream',
      'application/javascript',
      // Close enough to be a typo, still not on the list.
      'image/svg',
      'font/ttf',
      '',
    ]) {
      const res = await upload(deps, header, PNG, mediaType)
      expect(res.status, mediaType).toBe(415)
      expect(await res.json(), mediaType).toEqual({ error: expect.any(String) })
    }

    expect(await rows()).toHaveLength(0)
  })

  it('refuses a body that is over the size cap with 413', async () => {
    const small = await testDeps({ maxArtifactBytes: 64 })
    const { user } = await makeUser(small)
    const { header } = await makeMachineToken(small, user.id)

    // Exactly at the cap is fine; the byte after it is not.
    expect((await upload(small, header, Buffer.alloc(64, 1), 'image/png')).status).toBe(201)

    const res = await upload(small, header, Buffer.alloc(65, 2), 'image/png')
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: expect.any(String), max_bytes: 64 })
    expect(await rows()).toHaveLength(1)
  })

  it('refuses a request whose `file` part is missing or is not a file', async () => {
    const { header } = await agent()

    const misnamed = new FormData()
    misnamed.append('image', new File([PNG], 'asset', { type: 'image/png' }))

    const notAFile = new FormData()
    notAFile.append('file', 'the bytes, honest')

    for (const form of [misnamed, notAFile, new FormData()]) {
      const res = await deps.app.request('/api/assets', {
        method: 'POST',
        headers: header,
        body: form,
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: expect.any(String) })
    }

    expect(await rows()).toHaveLength(0)
  })

  it('refuses a body that is not multipart at all', async () => {
    const { header } = await agent()

    const res = await deps.app.request('/api/assets', {
      method: 'POST',
      headers: { ...header, 'Content-Type': 'application/json' },
      body: '{"file":"nope"}',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: expect.any(String) })
    expect(await rows()).toHaveLength(0)
  })

  it('refuses a POST whose Content-Length exceeds the cap before parsing the body', async () => {
    const small = await testDeps({ maxArtifactBytes: 64 })
    const { user } = await makeUser(small)
    const { header } = await makeMachineToken(small, user.id)

    // Past the cap plus the multipart slack, and not multipart at all. Without
    // the Content-Length pre-check formData() would throw and answer 400; the
    // pre-check refuses it as 413 before the body is parsed. In production the
    // HTTP layer supplies Content-Length from the wire; the in-process test
    // client only carries it when set explicitly.
    const body = new Uint8Array(Buffer.alloc(1024 * 1024 + 200, 1))
    const res = await small.app.request('/api/assets', {
      method: 'POST',
      headers: {
        ...header,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
      },
      body,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: expect.any(String), max_bytes: 64 })
    expect(await rows()).toHaveLength(0)
  })
})

// --- serving -----------------------------------------------------------------

describe('GET /assets/:sha', () => {
  it('serves the bytes to a caller carrying no credential at all', async () => {
    const { header } = await agent()
    expect((await upload(deps, header, PNG, 'image/png')).status).toBe(201)

    const res = await deps.app.request(`/assets/${PNG_SHA}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)

    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Security-Policy')).toBe(ASSET_CSP)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    // The URL is the hash of the bytes, so what is behind it can never change.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    // Stored uncompressed and served as-is.
    expect(res.headers.get('Content-Encoding')).toBe(null)
  })

  it('reads no session — a cookie changes nothing about the answer', async () => {
    const { header } = await agent()
    await upload(deps, header, PNG, 'image/png')

    // A stranger's session, and a cookie that is not a session at all.
    const { cookie } = await makeUser(deps, { domain: 'other.test' })
    const credentials: Array<Record<string, string>> = [
      {},
      { Cookie: cookie },
      { Cookie: '__Host-session=garbage' },
    ]
    for (const headers of credentials) {
      const res = await deps.app.request(`/assets/${PNG_SHA}`, { headers })
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    }
  })

  it('serves an asset uploaded by another workspace — the hash is the whole key', async () => {
    const other = await testDeps({ allowedDomains: ['other.test'] })
    const { user } = await makeUser(other)
    const { header } = await makeMachineToken(other, user.id)
    expect((await upload(other, header, PNG, 'image/png')).status).toBe(201)

    // A different app object, so nothing but the row is shared.
    const res = await deps.app.request(`/assets/${PNG_SHA}`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('serves a scriptable SVG under a sandbox with no scripting in it', async () => {
    const { header } = await agent()
    const sha = sha256Hex(HOSTILE_SVG)
    expect((await upload(deps, header, HOSTILE_SVG, 'image/svg+xml')).status).toBe(201)

    const res = await deps.app.request(`/assets/${sha}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    )
    expect(res.headers.get('Content-Security-Policy')).not.toContain('allow-scripts')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('answers a HEAD with the same headers and no body', async () => {
    const { header } = await agent()
    await upload(deps, header, PNG, 'image/png')

    const res = await deps.app.request(`/assets/${PNG_SHA}`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Security-Policy')).toBe(ASSET_CSP)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await res.text()).toBe('')
  })

  it('404s for a hash it does not hold', async () => {
    const res = await deps.app.request(`/assets/${SHA_OF_NOTHING}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('404s for anything that is not 64 lowercase hex, in the same words', async () => {
    const { header } = await agent()
    await upload(deps, header, PNG, 'image/png')

    for (const sha of [
      PNG_SHA.toUpperCase(),
      PNG_SHA.slice(0, 63),
      `${PNG_SHA}a`,
      `${PNG_SHA.slice(0, 63)}g`,
      '',
      'not-a-hash',
      `${PNG_SHA}/extra`,
      // `$` in a JavaScript regex matches before a trailing newline, so a
      // 64-hex sha with `%0A` glued on is the one shape a naive `^…$` test
      // waves through.
      `${PNG_SHA}%0A`,
    ]) {
      const res = await deps.app.request(`/assets/${sha}`)
      expect(res.status, sha).toBe(404)
      expect(await res.json(), sha).toEqual({ error: 'not found' })
    }
  })
})
