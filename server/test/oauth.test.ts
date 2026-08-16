// OAuth 2.1 for the MCP door (spec §7.0): discovery metadata, dynamic client
// registration, the consent page, the PKCE-bound code exchange, and rotation.
// The mechanics deliberately mirror cliauth.test.ts — one-time hashed codes,
// session-only approval, origin-checked POSTs — because the flow does.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { machineTokens, oauthRefreshTokens } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import { closeDb, makeMachineToken, makeUser, resetDb, testDeps } from './helpers.js'

const ORIGIN = 'https://artef.test'
const REDIRECT = 'https://client.example/callback'
const LOOPBACK = 'http://localhost:33418/callback'
const STATE = 'st-abcdefgh12345678'

let deps: Awaited<ReturnType<typeof testDeps>>

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

/** A verifier and its S256 challenge, fresh per call (RFC 7636). */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: sha256(verifier).toString('base64url') }
}

const register = (body: unknown) =>
  deps.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

async function registeredClient(uris: string[] = [REDIRECT], name = 'Claude Code'): Promise<string> {
  const res = await register({ redirect_uris: uris, client_name: name })
  expect(res.status).toBe(201)
  const { client_id } = (await res.json()) as { client_id: string }
  return client_id
}

function authorizeUrl(params: Record<string, string>): string {
  const defaults = { response_type: 'code', code_challenge_method: 'S256', state: STATE }
  return `/oauth/authorize?${new URLSearchParams({ ...defaults, ...params })}`
}

const approve = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  deps.app.request('/oauth/authorize/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  })

/** Runs the consent approval and hands back the code from the redirect. */
async function approvedCode(
  cookie: string,
  clientId: string,
  challenge: string,
  redirectUri = REDIRECT,
): Promise<string> {
  const res = await approve(
    {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state: STATE,
      decision: 'approve',
    },
    { Cookie: cookie, Origin: ORIGIN },
  )
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.href.startsWith(redirectUri)).toBe(true)
  expect(location.searchParams.get('state')).toBe(STATE)
  const code = location.searchParams.get('code')
  expect(code).toBeTruthy()
  return code!
}

const exchange = (fields: Record<string, string>) =>
  deps.app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })

/** The whole front half: register, approve, exchange. Returns the token set. */
async function tokenSet(cookie: string): Promise<{
  clientId: string
  access_token: string
  refresh_token: string
}> {
  const clientId = await registeredClient()
  const { verifier, challenge } = pkce()
  const code = await approvedCode(cookie, clientId, challenge)
  const res = await exchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { access_token: string; refresh_token: string }
  return { clientId, ...body }
}

describe('discovery metadata', () => {
  it('names the mcp resource and this server as its authorization server', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await deps.app.request(path)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        resource: 'https://artef.test/mcp',
        authorization_servers: ['https://artef.test'],
        bearer_methods_supported: ['header'],
      })
    }
  })

  it('advertises code + PKCE S256 + public clients, and the three endpoints', async () => {
    const res = await deps.app.request('/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.issuer).toBe('https://artef.test')
    expect(meta.authorization_endpoint).toBe('https://artef.test/oauth/authorize')
    expect(meta.token_endpoint).toBe('https://artef.test/oauth/token')
    expect(meta.registration_endpoint).toBe('https://artef.test/oauth/register')
    expect(meta.response_types_supported).toEqual(['code'])
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none'])
  })
})

describe('dynamic client registration', () => {
  it('registers https and loopback redirect uris and returns a client_id', async () => {
    const res = await register({ redirect_uris: [REDIRECT, LOOPBACK], client_name: 'Claude Code' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.client_id).toBe('string')
    expect(body.redirect_uris).toEqual([REDIRECT, LOOPBACK])
    expect(body.token_endpoint_auth_method).toBe('none')
  })

  it.each([
    ['a non-loopback http uri', { redirect_uris: ['http://evil.example/cb'] }],
    ['an empty list', { redirect_uris: [] }],
    ['a missing list', {} as Record<string, unknown>],
    ['a non-url entry', { redirect_uris: ['not a url'] }],
    ['a non-string entry', { redirect_uris: [42] }],
  ])('refuses %s', async (_name, body) => {
    const res = await register(body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri')
  })
})

describe('the consent page', () => {
  it('sends a signed-out person to login and back', async () => {
    const clientId = await registeredClient()
    const { challenge } = pkce()
    const res = await deps.app.request(
      authorizeUrl({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge }),
    )
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location.startsWith('/auth/login?next=')).toBe(true)
    expect(decodeURIComponent(location)).toContain('/oauth/authorize')
  })

  it('shows the client name and carries the request into the form', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { challenge } = pkce()
    const res = await deps.app.request(
      authorizeUrl({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge }),
      { headers: { Cookie: cookie } },
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Claude Code')
    expect(html).toContain(challenge)
    expect(html).toContain('value="approve"')
    expect(html).toContain('value="deny"')
  })

  it.each([
    ['an unknown client', { client_id: '00000000-0000-4000-8000-000000000000' }],
    ['a malformed client id', { client_id: 'not-a-uuid' }],
  ])('refuses %s on the page, never by redirect', async (_name, params) => {
    const { cookie } = await makeUser(deps)
    const { challenge } = pkce()
    const res = await deps.app.request(
      authorizeUrl({ redirect_uri: REDIRECT, code_challenge: challenge, ...params }),
      { headers: { Cookie: cookie } },
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('refuses a redirect_uri the client never registered, never by redirect', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { challenge } = pkce()
    const res = await deps.app.request(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: 'https://elsewhere.example/cb',
        code_challenge: challenge,
      }),
      { headers: { Cookie: cookie } },
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it.each([
    ['a wrong response_type', { response_type: 'token' }, 'unsupported_response_type'],
    ['a missing code_challenge', { code_challenge: '' }, 'invalid_request'],
    ['a plain challenge method', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['a foreign resource', { resource: 'https://other.example/mcp' }, 'invalid_request'],
  ])('reports %s to the validated redirect_uri', async (_name, params, error) => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { challenge } = pkce()
    const res = await deps.app.request(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        ...params,
      }),
      { headers: { Cookie: cookie } },
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(REDIRECT)
    expect(location.searchParams.get('error')).toBe(error)
    expect(location.searchParams.get('state')).toBe(STATE)
  })

  it('accepts both spellings of this server as the resource', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    for (const resource of ['https://artef.test', 'https://artef.test/mcp']) {
      const { challenge } = pkce()
      const res = await deps.app.request(
        authorizeUrl({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, resource }),
        { headers: { Cookie: cookie } },
      )
      expect(res.status).toBe(200)
    }
  })
})

describe('approval', () => {
  it('requires a session — a bearer token must not approve its own successor', async () => {
    const { user } = await makeUser(deps)
    const clientId = await registeredClient()
    const { challenge } = pkce()
    const { header } = await makeMachineToken(deps, user.id)
    const res = await approve(
      {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        decision: 'approve',
      },
      { ...header, Origin: ORIGIN },
    )
    expect(res.status).toBe(401)
  })

  it('refuses a cross-site approval', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { challenge } = pkce()
    const res = await approve(
      { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, decision: 'approve' },
      { Cookie: cookie, Origin: 'https://evil.example' },
    )
    expect(res.status).toBe(403)
  })

  it('reports a denial to the client without minting anything', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { challenge } = pkce()
    const res = await approve(
      { client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: STATE, decision: 'deny' },
      { Cookie: cookie, Origin: ORIGIN },
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('code')).toBeNull()
  })
})

describe('the exchange', () => {
  it('trades an approved code for a working access token and a refresh token', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { verifier, challenge } = pkce()
    const code = await approvedCode(cookie, clientId, challenge)

    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBe(7 * 24 * 60 * 60)
    expect(String(body.access_token).startsWith('art_live_')).toBe(true)
    expect(String(body.refresh_token).startsWith('art_refresh_')).toBe(true)

    // The minted credential is an ordinary machine token: the API takes it.
    const list = await deps.app.request('/api/artifacts', {
      headers: { Authorization: `Bearer ${body.access_token}` },
    })
    expect(list.status).toBe(200)

    // And it appears in the person's token list under the client's name.
    const tokens = await deps.app.request('/api/tokens', { headers: { Cookie: cookie } })
    const names = ((await tokens.json()) as { name: string }[]).map(t => t.name)
    expect(names).toContain('mcp: Claude Code')
  })

  it('burns the code on a wrong verifier — the right one cannot follow', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { verifier, challenge } = pkce()
    const code = await approvedCode(cookie, clientId, challenge)

    const wrong = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce().verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant')

    const retry = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    })
    expect(((await retry.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('spends a code exactly once', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { verifier, challenge } = pkce()
    const code = await approvedCode(cookie, clientId, challenge)
    const fields = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    }
    expect((await exchange(fields)).status).toBe(200)
    expect((await exchange(fields)).status).toBe(400)
  })

  it('refuses an expired code', async () => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient()
    const { verifier, challenge } = pkce()
    const code = await approvedCode(cookie, clientId, challenge)

    // A second app over the same database, with its clock a minute+ ahead.
    const late = await testDeps({}, { now: () => Date.now() + 61_000 })
    const res = await late.app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      }).toString(),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it.each([
    ['a mismatched redirect_uri', { redirect_uri: LOOPBACK }],
    ['a mismatched client', { client_id: '00000000-0000-4000-8000-000000000000' }],
  ])('refuses %s', async (_name, override) => {
    const { cookie } = await makeUser(deps)
    const clientId = await registeredClient([REDIRECT, LOOPBACK])
    const { verifier, challenge } = pkce()
    const code = await approvedCode(cookie, clientId, challenge)
    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      ...override,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('names the grant types it does not speak', async () => {
    const res = await exchange({ grant_type: 'client_credentials' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type')
  })

  it('refuses a structurally bad verifier as a bad request', async () => {
    const res = await exchange({
      grant_type: 'authorization_code',
      code: 'whatever',
      code_verifier: 'too-short',
      client_id: '00000000-0000-4000-8000-000000000000',
      redirect_uri: REDIRECT,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request')
  })
})

describe('refresh', () => {
  it('rotates: new pair works, old access token and old refresh token die', async () => {
    const { cookie } = await makeUser(deps)
    const first = await tokenSet(cookie)

    const res = await exchange({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    })
    expect(res.status).toBe(200)
    const second = (await res.json()) as { access_token: string; refresh_token: string }
    expect(second.access_token).not.toBe(first.access_token)

    // New access token works; the one it replaced is gone from the table.
    const ok = await deps.app.request('/api/artifacts', {
      headers: { Authorization: `Bearer ${second.access_token}` },
    })
    expect(ok.status).toBe(200)
    const dead = await deps.app.request('/api/artifacts', {
      headers: { Authorization: `Bearer ${first.access_token}` },
    })
    expect(dead.status).toBe(401)

    // The spent refresh token is dead too — rotation, not reuse.
    const reuse = await exchange({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: first.clientId,
    })
    expect(reuse.status).toBe(400)
  })

  it('dies with the access token: revoking in the token list disconnects the client', async () => {
    const { cookie } = await makeUser(deps)
    const { clientId, refresh_token } = await tokenSet(cookie)

    const list = await deps.app.request('/api/tokens', { headers: { Cookie: cookie } })
    const minted = ((await list.json()) as { id: string; name: string }[]).find(
      t => t.name === 'mcp: Claude Code',
    )
    expect(minted).toBeDefined()
    const del = await deps.app.request(`/api/tokens/${minted!.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: ORIGIN },
    })
    expect(del.status).toBe(204)

    // The cascade took the refresh row with it, so the client cannot quietly
    // mint its way back in.
    const rows = await deps.db.select().from(oauthRefreshTokens)
    expect(rows).toHaveLength(0)
    const res = await exchange({ grant_type: 'refresh_token', refresh_token, client_id: clientId })
    expect(res.status).toBe(400)
  })

  it('refuses another client presenting a stolen refresh token', async () => {
    const { cookie } = await makeUser(deps)
    const { refresh_token } = await tokenSet(cookie)
    const other = await registeredClient([REDIRECT], 'Impostor')
    const res = await exchange({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: other,
    })
    expect(res.status).toBe(400)
  })
})

describe('the 401 breadcrumb', () => {
  const CHALLENGE =
    'Bearer resource_metadata="https://artef.test/.well-known/oauth-protected-resource/mcp"'

  it('is on /mcp with no credential', async () => {
    const res = await deps.app.request('/mcp', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE)
  })

  it('is on /mcp with a dead token', async () => {
    const res = await deps.app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer art_live_nonsense' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE)
  })

  it('stays off the REST API, whose 401 shape predates it', async () => {
    const res = await deps.app.request('/api/artifacts', {
      headers: { Authorization: 'Bearer art_live_nonsense' },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })
})

describe('an expiring access token', () => {
  it('is refused by the API once its time passes', async () => {
    const { cookie, user } = await makeUser(deps)
    const { access_token } = await tokenSet(cookie)
    // Age the row directly: the bearer middleware reads expires_at against
    // the real clock.
    await deps.db
      .update(machineTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(machineTokens.userId, user.id))
    const res = await deps.app.request('/api/artifacts', {
      headers: { Authorization: `Bearer ${access_token}` },
    })
    expect(res.status).toBe(401)
  })
})
