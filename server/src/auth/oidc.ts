// Mode A: the app runs the OIDC flow itself (spec §4.1), so a deployment is one
// container and one .env file. `openid-client` does the protocol; this file does
// the two decisions the protocol does not make — which domain a login belongs
// to (§4.3) and who is an admin (§4.2).
import { count, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import * as oidc from 'openid-client'
import type { AppEnv, Deps } from '../app.js'
import type { Config } from '../config.js'
import { users, workspaces } from '../db/schema.js'
import { CONSUMER_DOMAINS } from '../lib/consumer-domains.js'
import { esc } from '../viewer/shell.js'
import { originCheck } from './origin.js'
import { buildSessionCookie, clearSessionCookie } from './session.js'

export type AuthErrorCode = 'unverified-email' | 'missing-hd' | 'consumer-domain' | 'domain-not-allowed'

/** A refused login. Always shown to the person as plain prose, never as JSON. */
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code)
    this.name = 'AuthError'
  }
}

export interface LoginClaims {
  email?: string
  email_verified?: boolean
  name?: string
  hd?: string
  iss: string
}

// ---------------------------------------------------------------------------
// Who gets in, and into which workspace
// ---------------------------------------------------------------------------

/**
 * Turns verified ID-token claims into a user row, creating the workspace and
 * the user on first sight. Throws `AuthError` — never a bare Error — for every
 * refusal, so the caller can explain it.
 */
export async function upsertUserFromClaims(
  deps: Deps,
  claims: LoginClaims,
): Promise<typeof users.$inferSelect> {
  const { cfg, db } = deps

  if (claims.email_verified !== true) throw new AuthError('unverified-email')
  const email = claims.email?.trim().toLowerCase()
  // An address the provider never sent is not an address it verified.
  if (!email || !email.includes('@')) throw new AuthError('unverified-email')

  const claimedDomain = deriveDomain(claims, email)

  // Order matters: the blocklist is applied to what the provider claimed,
  // before WORKSPACE_DOMAIN_MAP rewrites it. A map entry like
  // `gmail.com=company.com` must not become a door into a real workspace —
  // 'workspace' visibility would then mean "every Gmail user on earth" (§4.3).
  if (CONSUMER_DOMAINS.has(claimedDomain)) throw new AuthError('consumer-domain')

  const domain = cfg.workspaceDomainMap[claimedDomain] ?? claimedDomain
  // The allowlist is explicit and has no wildcard (§4.3 rule 1).
  if (!cfg.allowedDomains.includes(domain)) throw new AuthError('domain-not-allowed')

  const workspace = await findOrCreateWorkspace(deps, domain)
  const forcedAdmin = cfg.adminEmails.includes(email)
  const now = new Date()

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (existing !== undefined) {
    // The user stays in the workspace they were created in. Emails are unique
    // across the whole deployment, and moving someone would strand the
    // artifacts they own in the old workspace.
    const [updated] = await db
      .update(users)
      .set({
        name: claims.name ?? existing.name,
        lastSeenAt: now,
        // ADMIN_EMAILS promotes but never demotes: it is the recovery path when
        // the first-login lottery picked the wrong person (§4.2).
        isAdmin: existing.isAdmin || forcedAdmin,
      })
      .where(eq(users.id, existing.id))
      .returning()
    return updated
  }

  const [{ existingUsers }] = await db
    .select({ existingUsers: count() })
    .from(users)
    .where(eq(users.workspaceId, workspace.id))

  const [created] = await db
    .insert(users)
    .values({
      workspaceId: workspace.id,
      email,
      name: claims.name ?? null,
      // First user into a workspace runs it — the only admin rule that costs
      // the operator no setup step (§4.2).
      isAdmin: existingUsers === 0 || forcedAdmin,
      lastSeenAt: now,
    })
    // Two simultaneous first logins: the loser takes the row the winner wrote.
    .onConflictDoUpdate({ target: users.email, set: { lastSeenAt: now } })
    .returning()
  return created
}

/**
 * Where a login's domain comes from. For Google it is the `hd` claim and never
 * the address: a personal account can put any vanity domain in its email, but
 * only a real Workspace account carries `hd` (§4.3 rule 3).
 */
function deriveDomain(claims: LoginClaims, email: string): string {
  if (claims.iss.includes('accounts.google.com')) {
    const hd = claims.hd?.trim().toLowerCase()
    if (!hd) throw new AuthError('missing-hd')
    return hd
  }
  return email.slice(email.lastIndexOf('@') + 1)
}

async function findOrCreateWorkspace(
  deps: Deps,
  domain: string,
): Promise<typeof workspaces.$inferSelect> {
  const inserted = await deps.db
    .insert(workspaces)
    .values({ domain })
    .onConflictDoNothing({ target: workspaces.domain })
    .returning()
  if (inserted[0] !== undefined) return inserted[0]

  const [existing] = await deps.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.domain, domain))
    .limit(1)
  return existing
}

// ---------------------------------------------------------------------------
// The HTTP flow
// ---------------------------------------------------------------------------

type ProviderId = 'google' | 'oidc'

interface Provider {
  id: ProviderId
  label: string
  issuer: URL
  clientId: string
  clientSecret: string
}

const GOOGLE_ISSUER = 'https://accounts.google.com'
/** Long enough for a slow IdP login, short enough that a leaked stash is dead. */
const OAUTH_TTL_SECS = 600
const OAUTH_COOKIE_BASENAME = 'oauth' // hono prefixes it: `__Host-oauth`

interface OAuthStash {
  p: ProviderId
  state: string
  verifier: string
  next: string
  exp: number
}

function providersFor(cfg: Config): Provider[] {
  const list: Provider[] = []
  if (cfg.googleClientId && cfg.googleClientSecret) {
    list.push({
      id: 'google',
      label: 'Google',
      issuer: new URL(GOOGLE_ISSUER),
      clientId: cfg.googleClientId,
      clientSecret: cfg.googleClientSecret,
    })
  }
  if (cfg.oidcIssuerUrl && cfg.oidcClientId && cfg.oidcClientSecret) {
    list.push({
      id: 'oidc',
      label: cfg.oidcDisplayName ?? 'SSO',
      issuer: new URL(cfg.oidcIssuerUrl),
      clientId: cfg.oidcClientId,
      clientSecret: cfg.oidcClientSecret,
    })
  }
  return list
}

/**
 * Only ever a same-site path. A redirect target starting with `//` or `/\` is
 * protocol-relative — the browser reads it as another host — so anything but
 * exactly one leading slash falls back to the home page.
 */
export function sanitizeNext(raw: string | undefined | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: Deps): void {
  const { cfg } = deps
  const providers = providersFor(cfg)
  const base = cfg.url.replace(/\/+$/, '')
  const callbackUrl = (id: ProviderId) => `${base}/auth/${id}/callback`

  // Discovery is a network call, so it happens on the first login and not at
  // boot — a server that cannot reach its IdP must still start and serve
  // /_health. The cache lives in this closure, so parallel apps never share it.
  const discovered = new Map<ProviderId, Promise<oidc.Configuration>>()
  function configure(p: Provider): Promise<oidc.Configuration> {
    let pending = discovered.get(p.id)
    if (pending === undefined) {
      pending = oidc.discovery(p.issuer, p.clientId, p.clientSecret)
      // A transient failure must not be remembered as the answer forever.
      pending.catch(() => discovered.delete(p.id))
      discovered.set(p.id, pending)
    }
    return pending
  }

  async function startLogin(c: Context<AppEnv>, p: Provider, next: string) {
    let conf: oidc.Configuration
    try {
      conf = await configure(p)
    } catch (err) {
      // Almost always a wrong issuer URL or an unreachable IdP, which is the
      // operator's problem to fix — so it goes to the log, not the page.
      console.error(`OIDC discovery failed for ${p.issuer.href}:`, err)
      return unavailablePage(c, p)
    }
    const state = oidc.randomState()
    const verifier = oidc.randomPKCECodeVerifier()
    const stash: OAuthStash = {
      p: p.id,
      state,
      verifier,
      next,
      exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SECS,
    }
    await setSignedCookie(c, OAUTH_COOKIE_BASENAME, JSON.stringify(stash), cfg.secretKey, {
      prefix: 'host',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: OAUTH_TTL_SECS,
    })
    const url = oidc.buildAuthorizationUrl(conf, {
      redirect_uri: callbackUrl(p.id),
      scope: 'openid email profile',
      state,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    })
    return c.redirect(url.href, 302)
  }

  async function finishLogin(c: Context<AppEnv>, p: Provider) {
    const stash = await readStash(c, cfg.secretKey)
    // One authorization response per stash, whatever happens next.
    deleteCookie(c, OAUTH_COOKIE_BASENAME, { prefix: 'host' })
    if (stash === null || stash.p !== p.id) return interruptedPage(c)

    let claims: { iss: string; [k: string]: unknown } | undefined
    try {
      const conf = await configure(p)
      // The URL handed to the library also becomes the `redirect_uri` it sends
      // to the token endpoint, so it must be the public URL from config — the
      // request itself may have arrived on an internal http:// host behind a proxy.
      const currentUrl = new URL(`${base}/auth/${p.id}/callback${new URL(c.req.url).search}`)
      const tokens = await oidc.authorizationCodeGrant(conf, currentUrl, {
        expectedState: stash.state,
        pkceCodeVerifier: stash.verifier,
      })
      claims = tokens.claims()
    } catch (err) {
      // Bad state, replayed code, clock skew, IdP outage: all the same to the
      // person in front of the browser, and none of them their business — but
      // the operator debugging a login that never completes needs the cause.
      console.error(`OIDC code exchange failed for ${p.issuer.href}:`, err)
      return interruptedPage(c)
    }
    if (claims === undefined) return interruptedPage(c)

    try {
      const user = await upsertUserFromClaims(deps, {
        iss: claims.iss,
        email: asString(claims.email),
        email_verified: claims.email_verified === true,
        name: asString(claims.name),
        hd: asString(claims.hd),
      })
      c.header('set-cookie', buildSessionCookie(user.id, cfg.secretKey), { append: true })
      return c.redirect(sanitizeNext(stash.next), 302)
    } catch (err) {
      if (err instanceof AuthError) return refusedPage(c, err.code)
      throw err
    }
  }

  app.get('/auth/login', async c => {
    const next = sanitizeNext(c.req.query('next'))
    // One provider is the normal deployment, so there is nothing to choose.
    if (providers.length === 1) return startLogin(c, providers[0], next)
    return c.html(chooserPage(providers, next))
  })

  for (const p of providers) {
    app.get(`/auth/${p.id}`, c => startLogin(c, p, sanitizeNext(c.req.query('next'))))
    app.get(`/auth/${p.id}/callback`, c => finishLogin(c, p))
  }

  // Logging out is a state change, so it is a POST and it is origin-checked
  // like every other one (§2.2). As a GET it was something any other page could
  // trigger with an <img> tag or a link preview crawler, which is a nuisance
  // rather than a breach — but the fix is one form.
  app.use('/auth/logout', originCheck(cfg))

  app.get('/auth/logout', c =>
    c.html(
      page(
        'Log out',
        '<form method="post" action="/auth/logout"><button type="submit">Log out</button></form>',
      ),
    ),
  )

  app.post('/auth/logout', c => {
    c.header('set-cookie', clearSessionCookie(), { append: true })
    return c.redirect('/', 302)
  })
}

async function readStash(c: Context<AppEnv>, secret: string): Promise<OAuthStash | null> {
  // `false` means the signature did not verify; `undefined` means no cookie.
  const raw = await getSignedCookie(c, secret, OAUTH_COOKIE_BASENAME, 'host')
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { p, state, verifier, next, exp } = parsed as Record<string, unknown>
  if ((p !== 'google' && p !== 'oidc') || typeof state !== 'string' || typeof verifier !== 'string') {
    return null
  }
  // Max-Age only stops a browser from sending the cookie; the signature has no
  // expiry of its own, so the deadline is carried inside and checked here.
  if (typeof exp !== 'number' || Math.floor(Date.now() / 1000) >= exp) return null
  return { p, state, verifier, next: sanitizeNext(typeof next === 'string' ? next : undefined), exp }
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// ---------------------------------------------------------------------------
// The three pages this flow can end on
// ---------------------------------------------------------------------------

const REFUSALS: Record<AuthErrorCode, string> = {
  'unverified-email':
    'Your identity provider did not confirm that this email address is verified, so the sign-in was refused.',
  'missing-hd':
    'This looks like a personal Google account. Sign-in is limited to allowed domains, and Google only states the domain for Google Workspace accounts.',
  'consumer-domain':
    'Sign-in is limited to allowed domains. A personal email domain cannot be used, because everyone who has one would end up sharing a workspace.',
  'domain-not-allowed':
    'Sign-in is limited to allowed domains. Ask whoever runs this server to add your domain to ALLOWED_DOMAINS.',
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:2rem}
main{max-width:28rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 1rem;color:#333}
a{display:inline-block;margin-right:.75rem}</style>
</head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`
}

function refusedPage(c: Context<AppEnv>, code: AuthErrorCode) {
  return c.html(page('Sign-in refused', `<p>${esc(REFUSALS[code])}</p>`), 403)
}

function interruptedPage(c: Context<AppEnv>) {
  return c.html(
    page(
      'Sign-in did not complete',
      '<p>The sign-in took too long or was interrupted.</p><p><a href="/auth/login">Try again</a></p>',
    ),
    400,
  )
}

function unavailablePage(c: Context<AppEnv>, p: Provider) {
  return c.html(
    page(
      'Sign-in is unavailable',
      `<p>This server could not reach ${esc(p.label)} to start the sign-in. Try again in a moment; if it keeps failing, whoever runs this server needs to check its sign-in settings.</p>`,
    ),
    502,
  )
}

function chooserPage(providers: Provider[], next: string): string {
  const links = providers
    .map(p => `<a href="/auth/${p.id}?next=${encodeURIComponent(next)}">Sign in with ${esc(p.label)}</a>`)
    .join('')
  return page('Sign in', `<p>${links}</p>`)
}
