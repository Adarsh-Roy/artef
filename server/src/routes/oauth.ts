// OAuth 2.1 for the MCP door (spec §7.0). An MCP harness that hits /mcp with
// no token gets a 401 naming the protected-resource metadata; from there it
// discovers this authorization server, registers itself (RFC 7591), sends the
// person to `/oauth/authorize`, and trades the code for tokens — the browser
// half is the person's existing SSO session plus one approval page, exactly
// like `artef login` (routes/cliauth.ts), whose one-time-code mechanics this
// file deliberately mirrors.
//
// The access token an exchange mints is an ordinary machine token: same table,
// same bearer middleware, same revocation. What OAuth adds is who holds it —
// the harness keeps and refreshes the credential itself, so nothing lands in a
// config file — plus PKCE, which is what binds a code to the client instance
// that started the flow, since public clients have no secret to prove with.
import { randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { originCheck } from '../auth/origin.js'
import { machineTokens, oauthClients, oauthCodes, oauthRefreshTokens } from '../db/schema.js'
import type { users } from '../db/schema.js'
import { generateMachineToken, hashToken, sha256, timingSafeEqualBuf } from '../lib/crypto.js'
import { oauthPageHeaders } from '../lib/headers.js'
import { esc } from '../viewer/shell.js'
import { CHROME, THEME } from '../viewer/theme.js'

/** The consent page is up and the redirect is immediate, so as with the CLI
 *  flow, one minute covers the round-trip with room to spare. */
const CODE_TTL_MS = 60_000
/** Access tokens expire so a harness that vanishes stops holding a live
 *  credential; a week keeps refresh traffic to a rounding error. */
const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Refresh tokens rotate on every use; 90 days idle means signing in again. */
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000
const CODE_BYTES = 24
const REFRESH_PREFIX = 'art_refresh_'

/** RFC 7636 §4.1: the verifier's exact alphabet and length. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/
/** base64url(sha256(…)) is exactly 43 characters, no padding. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
/** `state` is the client's own echo. Opaque, printable, bounded. */
const STATE_RE = /^[\x20-\x7E]{1,512}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_MAX = 200

const BAD_CLIENT = 'This authorization link names a client this server has never met.'
const BAD_REDIRECT = 'This authorization link asks to send the code somewhere its client never registered.'

export function registerOauthRoutes(app: Hono<AppEnv>, deps: Deps): void {
  const now = deps.now ?? Date.now
  const base = deps.cfg.url.replace(/\/$/, '')

  // Approving mints a credential: POST, origin-checked, exactly like the CLI
  // flow's approve (§2.2). Registered here because the app-wide check covers
  // /api only.
  app.use('/oauth/authorize/approve', originCheck(deps.cfg))

  // --- discovery (RFC 9728 + RFC 8414) ---------------------------------------

  // Twice, because the MCP SDK asks for the path-inserted variant
  // (…/oauth-protected-resource/mcp) for a resource at /mcp, while older
  // clients ask at the root. Same body either way.
  const protectedResource = (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
    })
  }
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)
  app.get('/.well-known/oauth-protected-resource', protectedResource)

  app.get('/.well-known/oauth-authorization-server', c => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  })

  // --- dynamic client registration (RFC 7591) --------------------------------

  // Unauthenticated by design — a harness registers before any person is
  // involved. A row here grants nothing: authorization still takes a signed-in
  // person approving, and the codes are PKCE-bound to the instance that asked.
  app.post('/oauth/register', async c => {
    const body = await readJsonObject(c)
    const uris = body?.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isAcceptableRedirectUri)) {
      return c.json(
        { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https or loopback http URLs' },
        400,
      )
    }
    const rawName = body?.client_name
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim().slice(0, NAME_MAX) : null

    const [client] = await deps.db
      .insert(oauthClients)
      .values({ name, redirectUris: uris as string[] })
      .returning()

    return c.json(
      {
        client_id: client.id,
        ...(name === null ? {} : { client_name: name }),
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    )
  })

  // --- authorization ----------------------------------------------------------

  app.get('/oauth/authorize', async c => {
    browserHeaders(c)
    const user = c.get('user')
    if (user === null) return toLogin(c)

    const q = (name: string) => c.req.query(name)
    const client = await lookupClient(deps, q('client_id'))
    if (client === null) return refusedPage(c, BAD_CLIENT)
    const redirectUri = q('redirect_uri')
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      // An unvalidated redirect_uri never gets redirected to — this page is
      // where the flow ends (OAuth 2.1 §4.1.2.1).
      return refusedPage(c, BAD_REDIRECT)
    }

    const problem = requestProblem(q('response_type'), q('code_challenge'), q('code_challenge_method'), q('resource'), base)
    const state = q('state')
    if (state !== undefined && !STATE_RE.test(state)) return errorRedirect(c, redirectUri, 'invalid_request', undefined)
    if (problem !== null) return errorRedirect(c, redirectUri, problem, state)

    return c.html(
      consentPage(user, client, {
        redirectUri,
        state,
        codeChallenge: q('code_challenge')!,
        resource: q('resource'),
      }),
    )
  })

  app.post('/oauth/authorize/approve', async c => {
    browserHeaders(c)
    // Bearer middleware does not run here, so a user is a browser session and
    // nothing else — a machine token must not approve its own successor, the
    // same line the CLI flow draws (§5.6).
    const user = c.get('user')
    if (user === null) return expiredPage(c)

    const form = await c.req.parseBody()
    const client = await lookupClient(deps, field(form, 'client_id'))
    if (client === null) return refusedPage(c, BAD_CLIENT)
    const redirectUri = field(form, 'redirect_uri')
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      return refusedPage(c, BAD_REDIRECT)
    }

    const state = field(form, 'state')
    if (state !== undefined && !STATE_RE.test(state)) return errorRedirect(c, redirectUri, 'invalid_request', undefined)

    if (field(form, 'decision') !== 'approve') return errorRedirect(c, redirectUri, 'access_denied', state)

    // Re-validated rather than trusted: these came back through a form.
    const codeChallenge = field(form, 'code_challenge')
    if (codeChallenge === undefined || !CHALLENGE_RE.test(codeChallenge)) {
      return errorRedirect(c, redirectUri, 'invalid_request', state)
    }

    const code = randomBytes(CODE_BYTES).toString('base64url')

    // Codes nobody exchanged are dead weight; the next approval sweeps them.
    await deps.db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date(now())))
    await deps.db.insert(oauthCodes).values({
      codeHash: sha256(code),
      clientId: client.id,
      userId: user.id,
      workspaceId: user.workspaceId,
      redirectUri,
      codeChallenge,
      expiresAt: new Date(now() + CODE_TTL_MS),
    })

    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    if (state !== undefined) target.searchParams.set('state', state)
    return c.redirect(target.href, 302)
  })

  // --- the exchange -----------------------------------------------------------

  // Unauthenticated by necessity, like the CLI exchange: the client has no
  // credential yet. Holding the code and the PKCE verifier is the proof.
  app.post('/oauth/token', async c => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')

    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const grantType = field(form, 'grant_type')

    if (grantType === 'authorization_code') {
      const code = field(form, 'code')
      const verifier = field(form, 'code_verifier')
      const clientId = field(form, 'client_id')
      const redirectUri = field(form, 'redirect_uri')
      if (code === undefined || code === '' || verifier === undefined || !VERIFIER_RE.test(verifier)) {
        return c.json({ error: 'invalid_request' }, 400)
      }

      const minted = await deps.db.transaction(async tx => {
        // DELETE … RETURNING is the single-use guarantee, exactly as in the
        // CLI exchange: two racing exchanges contend for one row and the loser
        // finds nothing. A code that fails PKCE below is already spent — a
        // stolen code cannot be retried with a better guess.
        const [claim] = await tx
          .delete(oauthCodes)
          .where(and(eq(oauthCodes.codeHash, sha256(code)), gt(oauthCodes.expiresAt, new Date(now()))))
          .returning()
        if (claim === undefined) return null
        if (clientId !== claim.clientId || redirectUri !== claim.redirectUri) return null
        if (!timingSafeEqualBuf(Buffer.from(sha256(verifier).toString('base64url')), Buffer.from(claim.codeChallenge))) {
          return null
        }
        const [client] = await tx.select().from(oauthClients).where(eq(oauthClients.id, claim.clientId)).limit(1)
        const name = tokenName(client?.name ?? null, claim.clientId)
        return issueTokens(tx, {
          clientId: claim.clientId,
          userId: claim.userId,
          workspaceId: claim.workspaceId,
          name,
        })
      })

      // Unknown, expired, spent, mismatched and unproven are one answer.
      if (minted === null) return c.json({ error: 'invalid_grant' }, 400)
      return c.json(minted)
    }

    if (grantType === 'refresh_token') {
      const presented = field(form, 'refresh_token')
      const clientId = field(form, 'client_id')
      if (presented === undefined || presented === '') return c.json({ error: 'invalid_request' }, 400)

      const minted = await deps.db.transaction(async tx => {
        // Rotation by deletion: the presented token is spent here whatever
        // happens next, and the new pair is the only way forward.
        const [claim] = await tx
          .delete(oauthRefreshTokens)
          .where(
            and(
              eq(oauthRefreshTokens.tokenHash, hashToken(presented)),
              gt(oauthRefreshTokens.expiresAt, new Date(now())),
            ),
          )
          .returning()
        if (claim === undefined) return null
        if (clientId !== claim.clientId) return null
        // The old access token retires with the refresh that carried it; the
        // token list shows one live credential per connected client, not a
        // history of them.
        await tx.delete(machineTokens).where(eq(machineTokens.id, claim.accessTokenId))
        return issueTokens(tx, claim)
      })

      if (minted === null) return c.json({ error: 'invalid_grant' }, 400)
      return c.json(minted)
    }

    return c.json({ error: 'unsupported_grant_type' }, 400)
  })

  // --- minting ---------------------------------------------------------------

  /** One access token (a machine_tokens row) plus the refresh token that will
   *  replace it. Shares whatever transaction the caller is in, so spending the
   *  grant and minting the credentials stand or fall together. */
  async function issueTokens(
    tx: Pick<Deps['db'], 'insert'>,
    owner: { clientId: string; userId: string; workspaceId: string; name: string },
  ): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string }> {
    const { token, hash, prefix } = generateMachineToken()
    const [access] = await tx
      .insert(machineTokens)
      .values({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        name: owner.name,
        tokenHash: hash,
        prefix,
        scopeIds: null,
        expiresAt: new Date(now() + ACCESS_TTL_MS),
      })
      .returning({ id: machineTokens.id })

    const refresh = REFRESH_PREFIX + randomBytes(32).toString('base64url')
    await tx.insert(oauthRefreshTokens).values({
      tokenHash: hashToken(refresh),
      clientId: owner.clientId,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      name: owner.name,
      accessTokenId: access.id,
      expiresAt: new Date(now() + REFRESH_TTL_MS),
    })

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
    }
  }
}

// --- validation ---------------------------------------------------------------

/** https anywhere, or plain http only back to this machine's loopback — the
 *  two places an OAuth redirect can land without the code crossing a network
 *  in the clear. */
function isAcceptableRedirectUri(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

/** The client row for a well-formed id, or null — a malformed id must not
 *  reach the uuid column, where Postgres would answer with a 500. */
async function lookupClient(deps: Deps, id: string | undefined) {
  if (id === undefined || !UUID_RE.test(id)) return null
  const [client] = await deps.db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1)
  return client ?? null
}

/** The error code for a request whose client and redirect_uri checked out but
 *  whose remaining parameters did not — those are safe to report by redirect. */
function requestProblem(
  responseType: string | undefined,
  challenge: string | undefined,
  method: string | undefined,
  resource: string | undefined,
  base: string,
): string | null {
  if (responseType !== 'code') return 'unsupported_response_type'
  if (challenge === undefined || !CHALLENGE_RE.test(challenge) || method !== 'S256') return 'invalid_request'
  // RFC 8707: a client naming a resource must name this one. Both spellings of
  // "this server" are accepted; anything else is a token aimed elsewhere.
  if (resource !== undefined && resource !== base && resource !== `${base}/mcp`) return 'invalid_request'
  return null
}

/** What the minted tokens are called in the person's token list. */
function tokenName(clientName: string | null, clientId: string): string {
  return `mcp: ${clientName ?? clientId.slice(0, 8)}`
}

// --- request parsing (the cliauth helpers, same shapes) -----------------------

function field(form: Record<string, unknown>, name: string): string | undefined {
  const value = form[name]
  return typeof value === 'string' ? value : undefined
}

async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function browserHeaders(c: Context<AppEnv>): void {
  for (const [name, value] of Object.entries(oauthPageHeaders())) c.header(name, value)
}

function toLogin(c: Context<AppEnv>) {
  const url = new URL(c.req.url)
  return c.redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302)
}

/** Errors the redirect_uri has earned the right to hear about (it validated). */
function errorRedirect(c: Context<AppEnv>, redirectUri: string, error: string, state: string | undefined) {
  const target = new URL(redirectUri)
  target.searchParams.set('error', error)
  if (state !== undefined) target.searchParams.set('state', state)
  return c.redirect(target.href, 302)
}

// --- the pages (cliauth's one-column style) -----------------------------------

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${THEME}${CHROME}
body{font-size:16px;line-height:1.6;display:grid;place-items:center;min-height:100vh;padding:2rem}
main{max-width:32rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 1rem;color:var(--ink-muted)}
strong{color:var(--ink)}form{display:inline-block;margin-right:.5rem}</style>
</head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`
}

function consentPage(
  user: typeof users.$inferSelect,
  client: { id: string; name: string | null },
  request: { redirectUri: string; state: string | undefined; codeChallenge: string; resource: string | undefined },
): string {
  const who = client.name ?? 'An MCP client'
  const hidden = [
    ['client_id', client.id],
    ['redirect_uri', request.redirectUri],
    ['code_challenge', request.codeChallenge],
    ...(request.state === undefined ? [] : [['state', request.state] as const]),
    ...(request.resource === undefined ? [] : [['resource', request.resource] as const]),
  ]
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('')

  return page(
    `Authorize ${who}?`,
    `<p>Signed in as ${esc(user.email)}. Approving lets <strong>${esc(who)}</strong> read and
write documents as you, until you revoke its token (named “${esc(tokenName(client.name, client.id))}”)
from your token list. The credential goes to the application, never through this page.</p>
<form method="post" action="/oauth/authorize/approve">${hidden}<button class="btn btn-primary" type="submit" name="decision" value="approve">Authorize</button></form>
<form method="post" action="/oauth/authorize/approve">${hidden}<button class="btn" type="submit" name="decision" value="deny">Deny</button></form>`,
  )
}

function refusedPage(c: Context<AppEnv>, reason: string) {
  return c.html(
    page(
      'That authorization link is not valid',
      `<p>${esc(reason)} Nothing was approved. Close this tab and start again from the application.</p>`,
    ),
    400,
  )
}

function expiredPage(c: Context<AppEnv>) {
  return c.html(
    page(
      'Sign in first',
      '<p>Your session ended before you approved this. <a href="/auth/login">Sign in</a>, then start again from the application.</p>',
    ),
    401,
  )
}
