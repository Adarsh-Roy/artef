import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type { Hono } from 'hono'
import { serializeSigned } from 'hono/utils/cookie'
import { eq } from 'drizzle-orm'

// Only the two calls that would hit the network are faked; PKCE, state, URL
// building and response parsing all run for real against a real
// `Configuration` object built from hand-written server metadata.
vi.mock('openid-client', async importOriginal => {
  const actual = await importOriginal<typeof import('openid-client')>()
  return {
    ...actual,
    discovery: vi.fn(async (server: URL, clientId: string, secret?: string) => {
      const { origin } = server
      return new actual.Configuration(
        {
          issuer: server.href,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
        },
        clientId,
        secret,
      )
    }),
    authorizationCodeGrant: vi.fn(),
  }
})

import * as oidcLib from 'openid-client'
import { AuthError, sanitizeNext, upsertUserFromClaims } from '../src/auth/oidc.js'
import { buildSessionCookie, SESSION_COOKIE } from '../src/auth/session.js'
import { signSession } from '../src/lib/crypto.js'
import { users, workspaces } from '../src/db/schema.js'
import type { AppEnv, Deps } from '../src/app.js'
import { createApp } from '../src/app.js'
import { closeDb, makeUser, resetDb, sessionCookie, testConfig, testDeps } from './helpers.js'

const GOOGLE_ISS = 'https://accounts.google.com'

const googleClaims = (over: Record<string, unknown> = {}) => ({
  iss: GOOGLE_ISS,
  email: 'ada@example.com',
  email_verified: true,
  name: 'Ada Lovelace',
  hd: 'example.com',
  ...over,
})

/** Probe routes let the middleware be observed before any real route exists.
 *  Hono freezes its matcher on the first request, so these are registered up
 *  front, in beforeEach, rather than inside individual tests. */
function addProbes(app: Hono<AppEnv>): Hono<AppEnv> {
  app.get('/probe', c =>
    c.json({
      user: c.get('user'),
      authKind: c.get('authKind'),
      tokenScopeIds: c.get('tokenScopeIds'),
    }),
  )
  app.get('/api/probe', c => c.json({ ok: true }))
  app.post('/api/probe', c => c.json({ ok: true }))
  return app
}

/** Turns a response's Set-Cookie headers into a `Cookie:` request header. */
function replayCookies(res: Response): string {
  return res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .filter(c => !c.endsWith('='))
    .join('; ')
}

let deps: Awaited<ReturnType<typeof testDeps>>

beforeEach(async () => {
  vi.clearAllMocks()
  deps = await testDeps()
  addProbes(deps.app)
  await resetDb(deps.pool)
})

afterAll(closeDb)

describe('upsertUserFromClaims — who is allowed in', () => {
  it('refuses an email the provider has not verified', async () => {
    await expect(upsertUserFromClaims(deps, googleClaims({ email_verified: false }))).rejects.toThrow(
      new AuthError('unverified-email'),
    )
    await expect(upsertUserFromClaims(deps, googleClaims({ email_verified: undefined }))).rejects.toMatchObject(
      { code: 'unverified-email' },
    )
  })

  // Spec §4.3 rule 3: a personal account can put anything in the address, so a
  // Google login without `hd` proves nothing about the domain.
  it('refuses a Google login with no hd claim, however the address looks', async () => {
    await expect(
      upsertUserFromClaims(deps, googleClaims({ hd: undefined, email: 'ada@example.com' })),
    ).rejects.toMatchObject({ code: 'missing-hd' })
  })

  it('trusts the hd claim over the email domain', async () => {
    const { user, workspace } = await upsertResult(
      deps,
      googleClaims({ email: 'ada@vanity.test', hd: 'example.com' }),
    )
    expect(workspace.domain).toBe('example.com')
    expect(user.email).toBe('ada@vanity.test')
  })

  it('refuses a consumer domain in the hd claim', async () => {
    await expect(upsertUserFromClaims(deps, googleClaims({ hd: 'gmail.com' }))).rejects.toMatchObject({
      code: 'consumer-domain',
    })
  })

  it('refuses a consumer email domain from a non-Google issuer', async () => {
    await expect(
      upsertUserFromClaims(deps, {
        iss: 'https://sso.example.com',
        email: 'ada@yahoo.com',
        email_verified: true,
      }),
    ).rejects.toMatchObject({ code: 'consumer-domain' })
  })

  it('takes the domain from the email for a non-Google issuer', async () => {
    const { workspace } = await upsertResult(deps, {
      iss: 'https://sso.example.com',
      email: 'Ada@EXAMPLE.com',
      email_verified: true,
    })
    expect(workspace.domain).toBe('example.com')
  })

  it('refuses a domain that is not in ALLOWED_DOMAINS', async () => {
    await expect(
      upsertUserFromClaims(deps, googleClaims({ email: 'ada@other.test', hd: 'other.test' })),
    ).rejects.toMatchObject({ code: 'domain-not-allowed' })
  })

  it('maps a subsidiary domain onto the parent workspace', async () => {
    const mapped = await depsWith({ workspaceDomainMap: { 'sub.example.com': 'example.com' } })
    const { workspace } = await upsertResult(
      mapped,
      googleClaims({ email: 'ada@sub.example.com', hd: 'sub.example.com' }),
    )
    expect(workspace.domain).toBe('example.com')
  })

  // The consumer blocklist is applied to the claim, before the map, or a
  // mapping entry would become a way to smuggle gmail.com logins into a real
  // workspace — every Gmail user on earth would be a colleague (§4.3).
  it('refuses a consumer domain even when the map points it at an allowed domain', async () => {
    const mapped = await depsWith({ workspaceDomainMap: { 'gmail.com': 'example.com' } })
    await expect(upsertUserFromClaims(mapped, googleClaims({ hd: 'gmail.com' }))).rejects.toMatchObject({
      code: 'consumer-domain',
    })
    const rows = await mapped.db.select().from(users)
    expect(rows).toHaveLength(0)
  })

  it('refuses a mapping target that is not allowed', async () => {
    const mapped = await depsWith({ workspaceDomainMap: { 'sub.example.com': 'nope.test' } })
    await expect(
      upsertUserFromClaims(mapped, googleClaims({ email: 'ada@sub.example.com', hd: 'sub.example.com' })),
    ).rejects.toMatchObject({ code: 'domain-not-allowed' })
  })

  it('creates nothing when a login is refused', async () => {
    await expect(upsertUserFromClaims(deps, googleClaims({ hd: 'other.test' }))).rejects.toThrow(AuthError)
    expect(await deps.db.select().from(workspaces)).toHaveLength(0)
    expect(await deps.db.select().from(users)).toHaveLength(0)
  })
})

describe('upsertUserFromClaims — users and admin bootstrap', () => {
  it('creates the workspace and makes the first user its admin', async () => {
    const user = await upsertUserFromClaims(deps, googleClaims())
    expect(user.isAdmin).toBe(true)
    expect(user.name).toBe('Ada Lovelace')
    expect(user.lastSeenAt).toBeInstanceOf(Date)
    expect(await deps.db.select().from(workspaces)).toHaveLength(1)
  })

  it('does not make the second user an admin', async () => {
    await upsertUserFromClaims(deps, googleClaims())
    const second = await upsertUserFromClaims(deps, googleClaims({ email: 'grace@example.com' }))
    expect(second.isAdmin).toBe(false)
  })

  it('forces admin for addresses in ADMIN_EMAILS', async () => {
    const withAdmins = await depsWith({ adminEmails: ['grace@example.com'] })
    await upsertUserFromClaims(withAdmins, googleClaims())
    const second = await upsertUserFromClaims(withAdmins, googleClaims({ email: 'grace@example.com' }))
    expect(second.isAdmin).toBe(true)
  })

  // ADMIN_EMAILS is the recovery path when the first-login lottery picks the
  // wrong person (§4.2), so it has to promote users who already exist.
  it('promotes an existing non-admin user listed in ADMIN_EMAILS', async () => {
    await upsertUserFromClaims(deps, googleClaims())
    const before = await upsertUserFromClaims(deps, googleClaims({ email: 'grace@example.com' }))
    expect(before.isAdmin).toBe(false)

    const withAdmins = await depsWith({ adminEmails: ['grace@example.com'] })
    const after = await upsertUserFromClaims(withAdmins, googleClaims({ email: 'grace@example.com' }))
    expect(after.isAdmin).toBe(true)
    expect(after.id).toBe(before.id)
  })

  it('never demotes an admin on a later login', async () => {
    const first = await upsertUserFromClaims(deps, googleClaims())
    const again = await upsertUserFromClaims(deps, googleClaims())
    expect(again.id).toBe(first.id)
    expect(again.isAdmin).toBe(true)
  })

  it('updates name and lastSeenAt on a repeat login without duplicating the user', async () => {
    const first = await upsertUserFromClaims(deps, googleClaims())
    const again = await upsertUserFromClaims(deps, googleClaims({ name: 'A. Lovelace' }))
    expect(again.id).toBe(first.id)
    expect(again.name).toBe('A. Lovelace')
    expect(again.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt!.getTime())
    expect(await deps.db.select().from(users)).toHaveLength(1)
  })

  it('matches an existing user case-insensitively', async () => {
    const first = await upsertUserFromClaims(deps, googleClaims({ email: 'ada@example.com' }))
    const again = await upsertUserFromClaims(deps, googleClaims({ email: 'ADA@example.com' }))
    expect(again.id).toBe(first.id)
    expect(await deps.db.select().from(users)).toHaveLength(1)
  })
})

describe('session middleware', () => {
  it('leaves the user null when no cookie is sent', async () => {
    const res = await deps.app.request('/probe')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: null, authKind: null, tokenScopeIds: null })
  })

  it('leaves the user null for a malformed cookie', async () => {
    for (const value of ['', 'nodot', 'a.b.c', '!!!.!!!']) {
      const res = await deps.app.request('/probe', {
        headers: { Cookie: `${SESSION_COOKIE}=${value}` },
      })
      expect(res.status).toBe(200)
      expect((await res.json()).user).toBeNull()
    }
  })

  it('leaves the user null for a cookie signed with another secret', async () => {
    const { user } = await makeUser(deps)
    const forged = signSession(
      { uid: user.id, exp: Math.floor(Date.now() / 1000) + 60 },
      'a-completely-different-secret-key',
    )
    const res = await deps.app.request('/probe', {
      headers: { Cookie: `${SESSION_COOKIE}=${forged}` },
    })
    expect((await res.json()).user).toBeNull()
  })

  it('leaves the user null for an expired cookie', async () => {
    const { user } = await makeUser(deps)
    const stale = signSession({ uid: user.id, exp: Math.floor(Date.now() / 1000) - 1 }, deps.cfg.secretKey)
    const res = await deps.app.request('/probe', {
      headers: { Cookie: `${SESSION_COOKIE}=${stale}` },
    })
    expect((await res.json()).user).toBeNull()
  })

  it('leaves the user null when the signed user no longer exists', async () => {
    const { user } = await makeUser(deps)
    await deps.db.delete(users).where(eq(users.id, user.id))
    const res = await deps.app.request('/probe', { headers: { Cookie: sessionCookie(user.id, deps.cfg.secretKey) } })
    expect((await res.json()).user).toBeNull()
  })

  it('loads the user for a valid cookie', async () => {
    const { user, cookie } = await makeUser(deps, { email: 'ada@example.com' })
    const res = await deps.app.request('/probe', { headers: { Cookie: cookie } })
    const body = (await res.json()) as { user: { id: string; email: string }; authKind: string }
    expect(body.user.id).toBe(user.id)
    expect(body.user.email).toBe('ada@example.com')
    expect(body.authKind).toBe('session')
  })

  it('ignores other cookies sitting alongside the session', async () => {
    const { user, cookie } = await makeUser(deps)
    const res = await deps.app.request('/probe', {
      headers: { Cookie: `other=1; ${cookie}; another=2` },
    })
    expect((await res.json()).user.id).toBe(user.id)
  })
})

describe('buildSessionCookie', () => {
  it('carries every flag the __Host- prefix and §2.2 require', () => {
    const value = buildSessionCookie('user-1', 'secret'.repeat(6))
    expect(value.startsWith('__Host-session=')).toBe(true)
    expect(value).toContain('Path=/')
    expect(value).toContain('HttpOnly')
    expect(value).toContain('Secure')
    expect(value).toContain('SameSite=Lax')
    expect(value).toContain(`Max-Age=${30 * 86400}`)
    expect(value).not.toContain('Domain=')
  })
})

describe('origin check', () => {
  const post = (app: Hono<AppEnv>, headers: Record<string, string>) =>
    app.request('/api/probe', { method: 'POST', headers })

  it('refuses a session-authed mutation with no Origin header', async () => {
    const { cookie } = await makeUser(deps)
    const res = await post(deps.app, { Cookie: cookie })
    expect(res.status).toBe(403)
  })

  it('refuses a session-authed mutation from another origin', async () => {
    const { cookie } = await makeUser(deps)
    const res = await post(deps.app, { Cookie: cookie, Origin: 'https://evil.test' })
    expect(res.status).toBe(403)
  })

  it('allows a session-authed mutation from the app origin', async () => {
    const { cookie } = await makeUser(deps)
    const res = await post(deps.app, { Cookie: cookie, Origin: 'https://artef.test' })
    expect(res.status).toBe(200)
  })

  it('does not block reads', async () => {
    const { cookie } = await makeUser(deps)
    const res = await deps.app.request('/api/probe', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })

  // The check exists to stop a browser being made to act as its logged-in
  // user, so a request carrying no session has nothing to forge. Agents send
  // `Authorization: Bearer` and never a cookie — that exemption is proved
  // against a real token in tokens.test.ts.
  it('does not block a request with no session cookie', async () => {
    const res = await post(deps.app, {})
    expect(res.status).toBe(200)
  })

  it('guards routes that do not exist yet', async () => {
    const { cookie } = await makeUser(deps)
    const res = await deps.app.request('/api/not-a-route', { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(403)
  })
})

describe('sanitizeNext', () => {
  it('keeps a same-site path', () => {
    expect(sanitizeNext('/a/123')).toBe('/a/123')
    expect(sanitizeNext('/a/123?x=1#y')).toBe('/a/123?x=1#y')
  })
  it('falls back to / for anything that could leave the site', () => {
    for (const bad of [undefined, '', 'a/123', '//evil.test/x', '/\\evil.test', 'https://evil.test', 'javascript:alert(1)']) {
      expect(sanitizeNext(bad)).toBe('/')
    }
  })
})

describe('login routes', () => {
  it('does not touch the network at startup', async () => {
    createApp({ cfg: testConfig(), db: deps.db, pool: deps.pool })
    expect(vi.mocked(oidcLib.discovery)).not.toHaveBeenCalled()
  })

  it('sends a single-provider deployment straight to the provider', async () => {
    const res = await deps.app.request('/auth/login')
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('Location')!)
    expect(url.origin).toBe(GOOGLE_ISS)
    expect(url.searchParams.get('client_id')).toBe('test-google-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://artef.test/auth/google/callback')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(vi.mocked(oidcLib.discovery)).toHaveBeenCalledTimes(1)
  })

  it('stashes state and PKCE in a short-lived __Host- cookie', async () => {
    const res = await deps.app.request('/auth/login')
    const cookie = res.headers.getSetCookie().find(c => c.startsWith('__Host-oauth='))
    expect(cookie).toBeDefined()
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=600')
  })

  it('discovers once and reuses the result', async () => {
    await deps.app.request('/auth/login')
    await deps.app.request('/auth/google')
    expect(vi.mocked(oidcLib.discovery)).toHaveBeenCalledTimes(1)
  })

  it('offers a choice when two providers are configured', async () => {
    const both = await depsWith({
      oidcIssuerUrl: 'https://sso.example.com',
      oidcClientId: 'sso-client',
      oidcClientSecret: 'sso-secret',
      oidcDisplayName: 'Company SSO',
    })
    const res = await both.app.request('/auth/login')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('/auth/google')
    expect(html).toContain('/auth/oidc')
    expect(html).toContain('Company SSO')
  })

  it('starts the generic OIDC flow at the configured issuer', async () => {
    const sso = await depsWith({
      googleClientId: undefined,
      googleClientSecret: undefined,
      oidcIssuerUrl: 'https://sso.example.com',
      oidcClientId: 'sso-client',
      oidcClientSecret: 'sso-secret',
    })
    const res = await sso.app.request('/auth/login')
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('Location')!)
    expect(url.origin).toBe('https://sso.example.com')
    expect(url.searchParams.get('redirect_uri')).toBe('https://artef.test/auth/oidc/callback')
  })

  // A wrong OIDC_ISSUER_URL is the commonest setup mistake, and it must not
  // surface as a stack trace to the person trying to sign in.
  it('explains an unreachable provider and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.mocked(oidcLib.discovery).mockRejectedValueOnce(new Error('ENOTFOUND'))
      const res = await deps.app.request('/auth/login')
      expect(res.status).toBe(502)
      expect(await res.text()).toContain('could not reach')
      expect(logged).toHaveBeenCalled()

      // The failure is not cached as the answer — the next attempt retries.
      const retry = await deps.app.request('/auth/login')
      expect(retry.status).toBe(302)
    } finally {
      logged.mockRestore()
    }
  })

  it('404s a provider that is not configured', async () => {
    const res = await deps.app.request('/auth/oidc')
    expect(res.status).toBe(404)
  })
})

describe('callback', () => {
  async function startLogin(app: Hono<AppEnv>, next?: string) {
    const path = next === undefined ? '/auth/login' : `/auth/login?next=${encodeURIComponent(next)}`
    const res = await app.request(path)
    const url = new URL(res.headers.get('Location')!)
    return { state: url.searchParams.get('state')!, cookie: replayCookies(res) }
  }

  function grantReturns(claims: Record<string, unknown>) {
    vi.mocked(oidcLib.authorizationCodeGrant).mockResolvedValue({
      claims: () => claims,
    } as unknown as Awaited<ReturnType<typeof oidcLib.authorizationCodeGrant>>)
  }

  it('completes the login, sets the session, and returns to next', async () => {
    grantReturns(googleClaims())
    const { state, cookie } = await startLogin(deps.app, '/a/target')

    const res = await deps.app.request(`/auth/google/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/a/target')

    const session = res.headers.getSetCookie().find(c => c.startsWith(`${SESSION_COOKIE}=`))
    expect(session).toBeDefined()
    expect(session).toContain('HttpOnly')

    const probe = await deps.app.request('/probe', {
      headers: { Cookie: session!.split(';')[0] },
    })
    expect((await probe.json()).user.email).toBe('ada@example.com')
  })

  it('checks state and PKCE against the stashed cookie', async () => {
    grantReturns(googleClaims())
    const { state, cookie } = await startLogin(deps.app)
    await deps.app.request(`/auth/google/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } })

    const [, currentUrl, checks] = vi.mocked(oidcLib.authorizationCodeGrant).mock.calls[0]
    expect(checks).toMatchObject({ expectedState: state })
    expect(typeof checks!.pkceCodeVerifier).toBe('string')
    // The URL handed to the library decides the redirect_uri sent to the token
    // endpoint, so it must be the public URL, not whatever host the request
    // arrived on behind a proxy.
    expect((currentUrl as URL).origin).toBe('https://artef.test')
    expect((currentUrl as URL).pathname).toBe('/auth/google/callback')
  })

  it('sanitizes next before redirecting to it', async () => {
    grantReturns(googleClaims())
    const { state, cookie } = await startLogin(deps.app, '//evil.test/x')
    const res = await deps.app.request(`/auth/google/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
    })
    expect(res.headers.get('Location')).toBe('/')
  })

  it('refuses a callback with no stashed state cookie', async () => {
    grantReturns(googleClaims())
    const res = await deps.app.request('/auth/google/callback?code=abc&state=whatever')
    expect(res.status).toBe(400)
    expect(vi.mocked(oidcLib.authorizationCodeGrant)).not.toHaveBeenCalled()
  })

  // Max-Age only governs what a browser sends back; the signed stash carries
  // its own deadline so a captured cookie cannot be replayed later.
  it('refuses a stash whose ten minutes have passed', async () => {
    grantReturns(googleClaims())
    const stale = await serializeSigned(
      '__Host-oauth',
      JSON.stringify({
        p: 'google',
        state: 'st',
        verifier: 'v'.repeat(43),
        next: '/',
        exp: Math.floor(Date.now() / 1000) - 1,
      }),
      deps.cfg.secretKey,
      { path: '/', secure: true },
    )
    const res = await deps.app.request('/auth/google/callback?code=abc&state=st', {
      headers: { Cookie: stale.split(';')[0] },
    })
    expect(res.status).toBe(400)
    expect(vi.mocked(oidcLib.authorizationCodeGrant)).not.toHaveBeenCalled()
  })

  it('refuses a stash whose signature does not verify', async () => {
    grantReturns(googleClaims())
    const { state, cookie } = await startLogin(deps.app)
    const tampered = cookie.replace('__Host-oauth=', '__Host-oauth=x')
    const res = await deps.app.request(`/auth/google/callback?code=abc&state=${state}`, {
      headers: { Cookie: tampered },
    })
    expect(res.status).toBe(400)
    expect(vi.mocked(oidcLib.authorizationCodeGrant)).not.toHaveBeenCalled()
  })

  it('refuses a state cookie minted for the other provider', async () => {
    const both = await depsWith({
      oidcIssuerUrl: 'https://sso.example.com',
      oidcClientId: 'sso-client',
      oidcClientSecret: 'sso-secret',
    })
    grantReturns(googleClaims())
    const start = await both.app.request('/auth/oidc')
    const cookie = replayCookies(start)
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!

    const res = await both.app.request(`/auth/google/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(400)
  })

  it('explains a refused domain on a plain 403 page', async () => {
    grantReturns(googleClaims({ email: 'ada@other.test', hd: 'other.test' }))
    const { state, cookie } = await startLogin(deps.app)
    const res = await deps.app.request(`/auth/google/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(await res.text()).toContain('Sign-in is limited to allowed domains')
    expect(res.headers.getSetCookie().some(c => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false)
  })

  it('explains an unverified email on a plain 403 page', async () => {
    grantReturns(googleClaims({ email_verified: false }))
    const { state, cookie } = await startLogin(deps.app)
    const res = await deps.app.request(`/auth/google/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/verif/i)
  })

  it('turns a failed code exchange into a 400, not a stack trace', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.mocked(oidcLib.authorizationCodeGrant).mockRejectedValue(new Error('invalid_grant'))
      const { state, cookie } = await startLogin(deps.app)
      const res = await deps.app.request(`/auth/google/callback?code=abc&state=${state}`, {
        headers: { Cookie: cookie },
      })
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('invalid_grant')
      // The page says nothing, so the log is the only place the operator can
      // find out why every login is dying.
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

describe('logout', () => {
  it('clears the session cookie and goes home', async () => {
    const { cookie } = await makeUser(deps)
    const res = await deps.app.request('/auth/logout', { headers: { Cookie: cookie } })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
    const cleared = res.headers.getSetCookie().find(c => c.startsWith(`${SESSION_COOKIE}=`))
    expect(cleared).toContain('Max-Age=0')
  })
})

describe('/_health', () => {
  it('reports ok while the database answers', async () => {
    const res = await deps.app.request('/_health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// --- small local helpers -----------------------------------------------------

/** Same pool and app wiring as `deps`, with a different Config. */
async function depsWith(overrides: Parameters<typeof testConfig>[0]) {
  return testDeps(overrides)
}

/** The created user together with the workspace row it landed in. */
async function upsertResult(d: Deps, claims: Parameters<typeof upsertUserFromClaims>[1]) {
  const user = await upsertUserFromClaims(d, claims)
  const [workspace] = await d.db.select().from(workspaces).where(eq(workspaces.id, user.workspaceId))
  return { user, workspace }
}
