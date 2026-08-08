// The browser half of `artef login` (spec §7.2). The CLI opens /cli/auth in a
// browser, the person approves, and the CLI ends up holding a machine token —
// without that token ever appearing in a URL, browser history or a proxy log.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { cliAuthCodes, machineTokens } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import { closeDb, makeUser, resetDb, testDeps } from './helpers.js'

const ORIGIN = 'https://artef.test'
const STATE = 'abcdefghijklmnop1234' // 20 chars, inside the 16..128 the flow allows
const PORT = '4242'

let deps: Awaited<ReturnType<typeof testDeps>>

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

const get = (path: string, headers: Record<string, string> = {}) =>
  deps.app.request(path, { headers })

const approve = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  deps.app.request('/cli/auth/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  })

const exchange = (body: unknown) =>
  deps.app.request('/cli/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** Approves the loopback flow and hands back the one-time code the CLI would
 *  have read off its /callback request. */
async function approvedCode(cookie: string, port = PORT, state = STATE): Promise<string> {
  const res = await approve({ port, state }, { Cookie: cookie, Origin: ORIGIN })
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  return location.searchParams.get('code')!
}

const tokens = () => deps.db.select().from(machineTokens)
const codes = () => deps.db.select().from(cliAuthCodes)

/** Whether a plaintext token actually authenticates as an agent. */
async function authenticates(token: string): Promise<boolean> {
  const res = await get('/api/artifacts', { Authorization: `Bearer ${token}` })
  return res.status === 200
}

// ---------------------------------------------------------------------------
// GET /cli/auth — the confirmation page
// ---------------------------------------------------------------------------

describe('GET /cli/auth', () => {
  it('sends a signed-out visitor to log in and come back', async () => {
    const res = await get(`/cli/auth?port=${PORT}&state=${STATE}`)
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location.startsWith('/auth/login?next=')).toBe(true)
    // The whole original URL, query and all, so the CLI's port and state
    // survive the round trip through the identity provider.
    const next = new URL(location, ORIGIN).searchParams.get('next')
    expect(next).toBe(`/cli/auth?port=${PORT}&state=${STATE}`)
    expect(await codes()).toHaveLength(0)
  })

  it('asks the signed-in user to authorize the CLI', async () => {
    const { cookie } = await makeUser(deps)
    const res = await get(`/cli/auth?port=${PORT}&state=${STATE}`, { Cookie: cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const html = await res.text()
    expect(html).toContain('Authorize the artef CLI on this machine?')
    expect(html).toContain('action="/cli/auth/approve"')
    expect(html).toContain('method="post"')
    // The port and state ride the form, so approving is a plain POST.
    expect(html).toContain(`name="port" value="${PORT}"`)
    expect(html).toContain(`name="state" value="${STATE}"`)
    // The way out for someone whose browser cannot reach their own machine.
    expect(html).toContain('/cli/auth/manual')
    // Nothing is minted by looking at the page.
    expect(await tokens()).toHaveLength(0)
    expect(await codes()).toHaveLength(0)
  })

  it('400s a port outside the unprivileged range, or one that is not a number', async () => {
    const { cookie } = await makeUser(deps)
    for (const port of ['80', '1023', '65536', '99999', 'abc', '', '-1', '4242.5', ' 4242']) {
      const res = await get(`/cli/auth?port=${encodeURIComponent(port)}&state=${STATE}`, {
        Cookie: cookie,
      })
      expect(res.status, `port=${port}`).toBe(400)
    }
    const missing = await get(`/cli/auth?state=${STATE}`, { Cookie: cookie })
    expect(missing.status).toBe(400)
  })

  it('400s a state that is too short, too long or not url-safe', async () => {
    const { cookie } = await makeUser(deps)
    for (const state of ['short', 'a'.repeat(15), 'a'.repeat(129), 'has spaces here!!', 'ok/../nope1234']) {
      const res = await get(`/cli/auth?port=${PORT}&state=${encodeURIComponent(state)}`, {
        Cookie: cookie,
      })
      expect(res.status, `state=${state}`).toBe(400)
    }
    const missing = await get(`/cli/auth?port=${PORT}`, { Cookie: cookie })
    expect(missing.status).toBe(400)
  })

  it('accepts a state at both ends of the allowed length', async () => {
    const { cookie } = await makeUser(deps)
    for (const state of ['a'.repeat(16), 'a'.repeat(128), 'A-Za-z0-9_-abcdefgh']) {
      const res = await get(`/cli/auth?port=${PORT}&state=${state}`, { Cookie: cookie })
      expect(res.status, `state=${state}`).toBe(200)
    }
  })
})

// ---------------------------------------------------------------------------
// POST /cli/auth/approve — the loopback redirect
// ---------------------------------------------------------------------------

describe('POST /cli/auth/approve', () => {
  it('redirects to the loopback with a one-time code, never the token', async () => {
    const { user, workspace, cookie } = await makeUser(deps)

    const res = await approve({ port: PORT, state: STATE }, { Cookie: cookie, Origin: ORIGIN })
    expect(res.status).toBe(302)

    const location = res.headers.get('location')!
    // The host is ours to decide, not the caller's: only the port varies.
    expect(location.startsWith(`http://127.0.0.1:${PORT}/callback?`)).toBe(true)
    const url = new URL(location)
    expect(url.searchParams.get('state')).toBe(STATE)
    const code = url.searchParams.get('code')!
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/)
    // The whole point of the code: no long-lived credential in browser history.
    expect(location).not.toContain('art_live_')

    const [row] = await codes()
    expect(Buffer.from(row.codeHash).equals(sha256(code))).toBe(true)
    expect(row.userId).toBe(user.id)
    expect(row.workspaceId).toBe(workspace.id)
    expect(row.name).toBe('cli')
    expect(row.token.startsWith('art_live_')).toBe(true)
    expect(row.prefix).toBe(row.token.slice(0, 12))
    // Short enough that an unexchanged code is dead before anyone finds it.
    const ttlMs = row.expiresAt.getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(60_000)
  })

  it('mints nothing usable until the code is exchanged', async () => {
    const { cookie } = await makeUser(deps)
    await approvedCode(cookie)

    // An approval nobody collected leaves no credential behind.
    expect(await tokens()).toHaveLength(0)
    const [row] = await codes()
    expect(await authenticates(row.token)).toBe(false)
  })

  it('403s without an Origin header, and with the wrong one', async () => {
    const { cookie } = await makeUser(deps)
    const cases: Record<string, string>[] = [
      { Cookie: cookie },
      { Cookie: cookie, Origin: 'https://evil.test' },
    ]
    for (const headers of cases) {
      const res = await approve({ port: PORT, state: STATE }, headers)
      expect(res.status).toBe(403)
    }
    expect(await codes()).toHaveLength(0)
    expect(await tokens()).toHaveLength(0)
  })

  it('401s without a session', async () => {
    const res = await approve({ port: PORT, state: STATE }, { Origin: ORIGIN })
    expect(res.status).toBe(401)
    expect(await codes()).toHaveLength(0)
  })

  it('400s a bad port or state and writes nothing', async () => {
    const { cookie } = await makeUser(deps)
    const bad: Record<string, string>[] = [
      { port: '80', state: STATE },
      { port: '70000', state: STATE },
      { port: 'abc', state: STATE },
      { state: STATE },
      { port: PORT, state: 'short' },
      { port: PORT, state: 'not url safe!' },
      { port: PORT },
    ]
    for (const fields of bad) {
      const res = await approve(fields, { Cookie: cookie, Origin: ORIGIN })
      expect(res.status, JSON.stringify(fields)).toBe(400)
    }
    expect(await codes()).toHaveLength(0)
    expect(await tokens()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// POST /cli/auth/exchange — the CLI collects its token
// ---------------------------------------------------------------------------

describe('POST /cli/auth/exchange', () => {
  it('trades the code for a token that authenticates', async () => {
    const { user, workspace, cookie } = await makeUser(deps)
    const code = await approvedCode(cookie)

    const res = await exchange({ code })
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    expect(token.startsWith('art_live_')).toBe(true)
    expect(await authenticates(token)).toBe(true)

    const rows = await tokens()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('cli')
    expect(rows[0].userId).toBe(user.id)
    expect(rows[0].workspaceId).toBe(workspace.id)
    expect(rows[0].scopeIds).toBeNull()
    expect(rows[0].expiresAt).toBeNull()
    // Only the hash is kept, exactly as `POST /api/tokens` does.
    expect(Buffer.from(rows[0].tokenHash).equals(sha256(token))).toBe(true)
    expect(JSON.stringify(rows[0])).not.toContain(token)
    // The plaintext leaves the database the moment it is handed over.
    expect(await codes()).toHaveLength(0)
  })

  it('needs no credential of its own — the code is the credential', async () => {
    const { cookie } = await makeUser(deps)
    const code = await approvedCode(cookie)
    // No cookie, no Origin, no bearer: the CLI has none of them yet.
    const res = await deps.app.request('/cli/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(res.status).toBe(200)
  })

  it('spends the code once and only once', async () => {
    const { cookie } = await makeUser(deps)
    const code = await approvedCode(cookie)

    expect((await exchange({ code })).status).toBe(200)
    const second = await exchange({ code })
    expect(second.status).toBe(400)
    expect(await second.json()).toEqual({ error: 'invalid or expired code' })
    // The replay minted nothing.
    expect(await tokens()).toHaveLength(1)
  })

  it('lets exactly one of two simultaneous exchanges win', async () => {
    const { cookie } = await makeUser(deps)
    const code = await approvedCode(cookie)

    const [a, b] = await Promise.all([exchange({ code }), exchange({ code })])
    expect([a.status, b.status].sort()).toEqual([200, 400])
    expect(await tokens()).toHaveLength(1)
  })

  it('400s an expired code and mints nothing', async () => {
    const { cookie } = await makeUser(deps)
    const code = await approvedCode(cookie)
    await deps.db
      .update(cliAuthCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(cliAuthCodes.codeHash, sha256(code)))

    const res = await exchange({ code })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid or expired code' })
    expect(await tokens()).toHaveLength(0)
  })

  it('400s a code nobody issued, in any shape', async () => {
    for (const body of [{ code: 'a'.repeat(32) }, { code: '' }, { code: 42 }, {}, [], 'not json']) {
      const res = await exchange(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error).toBeTruthy()
    }
    expect(await tokens()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The headers around a page whose button hands out a credential
// ---------------------------------------------------------------------------

describe('cli auth page headers', () => {
  it('refuses to be framed, and refuses to be cached', async () => {
    const { cookie } = await makeUser(deps)
    const pages = [
      await get(`/cli/auth?port=${PORT}&state=${STATE}`, { Cookie: cookie }),
      await get(`/cli/auth/manual?state=${STATE}`, { Cookie: cookie }),
      await approve({ manual: '1' }, { Cookie: cookie, Origin: ORIGIN }),
    ]
    for (const res of pages) {
      const csp = res.headers.get('Content-Security-Policy')!
      // Clicking Authorize mints a long-lived credential, so no other site may
      // put this page in a frame and aim a click at that button.
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("default-src 'none'")
      // The approve page carries the token itself; the others carry a form that
      // mints one. None of it belongs in a cache on a shared machine.
      expect(res.headers.get('Cache-Control')).toBe('private, no-store')
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    }
  })

  // The loopback callback URL carries the one-time code. Without this the
  // listener — and anything the CLI's callback page loads — would be told which
  // artef server the person just signed in to.
  it('sends no referrer with the redirect to the loopback', async () => {
    const { cookie } = await makeUser(deps)
    const res = await approve({ port: PORT, state: STATE }, { Cookie: cookie, Origin: ORIGIN })
    expect(res.status).toBe(302)
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('400s a form body that is not a form', async () => {
    const { cookie } = await makeUser(deps)
    const res = await deps.app.request('/cli/auth/approve', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: PORT, state: STATE }),
    })
    expect(res.status).toBe(400)
    expect(await codes()).toHaveLength(0)
    expect(await tokens()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The manual variant, for a browser that cannot reach the CLI's machine
// ---------------------------------------------------------------------------

describe('/cli/auth/manual', () => {
  it('sends a signed-out visitor to log in and come back', async () => {
    const res = await get(`/cli/auth/manual?state=${STATE}`)
    expect(res.status).toBe(302)
    const next = new URL(res.headers.get('location')!, ORIGIN).searchParams.get('next')
    expect(next).toBe(`/cli/auth/manual?state=${STATE}`)
  })

  it('asks for the same confirmation, with no port in sight', async () => {
    const { cookie } = await makeUser(deps)
    const res = await get(`/cli/auth/manual?state=${STATE}`, { Cookie: cookie })
    expect(res.status).toBe(200)

    const html = await res.text()
    expect(html).toContain('Authorize the artef CLI on this machine?')
    expect(html).toContain('action="/cli/auth/approve"')
    expect(html).toContain('name="manual" value="1"')
    expect(await tokens()).toHaveLength(0)
  })

  it('400s a malformed state', async () => {
    const { cookie } = await makeUser(deps)
    const res = await get('/cli/auth/manual?state=short', { Cookie: cookie })
    expect(res.status).toBe(400)
  })

  it('works with no state at all — nothing redirects, so there is nothing to match', async () => {
    const { cookie } = await makeUser(deps)
    expect((await get('/cli/auth/manual', { Cookie: cookie })).status).toBe(200)
  })

  it('shows the token on the page for copy-paste', async () => {
    const { user, cookie } = await makeUser(deps)

    const res = await approve({ manual: '1' }, { Cookie: cookie, Origin: ORIGIN })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('art_live_')

    const token = /art_live_[A-Za-z0-9_-]+/.exec(html)![0]
    expect(await authenticates(token)).toBe(true)

    const rows = await tokens()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('cli')
    expect(rows[0].userId).toBe(user.id)
    expect(Buffer.from(rows[0].tokenHash).equals(sha256(token))).toBe(true)
    // The manual path hands the token over on the spot, so there is no code.
    expect(await codes()).toHaveLength(0)
  })

  it('needs a session and an Origin like every other approval', async () => {
    const { cookie } = await makeUser(deps)
    expect((await approve({ manual: '1' }, { Origin: ORIGIN })).status).toBe(401)
    expect((await approve({ manual: '1' }, { Cookie: cookie })).status).toBe(403)
    expect(await tokens()).toHaveLength(0)
  })
})
