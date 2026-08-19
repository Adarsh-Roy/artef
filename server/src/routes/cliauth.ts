// The browser half of `artef login` (spec §7.2). The CLI starts a listener on a
// loopback port, opens `/cli/auth?port=…&state=…` in a browser, and waits. The
// person completes normal SSO, approves, and the CLI ends up holding a machine
// token.
//
// The redirect back to the loopback carries a one-time code, never the token. A
// token in a redirect URL is a long-lived credential written into browser
// history, into the referrer of anything the callback page loads, and into
// every proxy log between here and there — and unlike a session cookie it
// cannot be quietly rotated. The code is worth nothing on its own: it is spent
// once, within a minute, on a direct POST from the CLI, and only that exchange
// writes the `machine_tokens` row. An approval nobody collected therefore
// leaves no usable credential behind at all.
import { randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { originCheck } from '../auth/origin.js'
import { cliAuthCodes, machineTokens } from '../db/schema.js'
import type { users } from '../db/schema.js'
import { generateMachineToken, hashToken, sha256 } from '../lib/crypto.js'
import { cliAuthPageHeaders } from '../lib/headers.js'
import { esc } from '../viewer/shell.js'
import { CHROME, THEME } from '../viewer/theme.js'

/** What the token is called in the token list, so a person can tell which of
 *  their credentials came from `artef login`. */
const TOKEN_NAME = 'cli'

/** The loopback listener is running and waiting the whole time, so the window
 *  only has to cover one redirect. */
const CODE_TTL_MS = 60_000

/** 24 random bytes, which is exactly 32 base64url characters. */
const CODE_BYTES = 24

// The CLI's own anti-forgery value: it generates one per login and refuses a
// callback that comes back with anything else. It is echoed, never interpreted,
// so the only rule is that it survives a URL intact.
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/

// Below 1024 a process needs root to listen, so a CLI cannot be waiting there —
// a port in that range is a mistake or an attempt to aim the redirect somewhere
// interesting, and neither deserves a redirect.
const MIN_PORT = 1024
const MAX_PORT = 65535

const BAD_PORT = `The CLI asked for a callback on a port outside ${MIN_PORT}–${MAX_PORT}.`
const BAD_STATE = 'The CLI did not send a usable state value.'
const INVALID_CODE = 'invalid or expired code'

export function registerCliAuthRoutes(app: Hono<AppEnv>, deps: Deps): void {
  const now = deps.now ?? Date.now

  // Approving mints a credential, so it is a POST and it is origin-checked like
  // every other state change (§2.2). The app-wide check only covers /api, and
  // this route is deliberately outside it — the CLI flow has to work for a
  // browser that has no token and may not have a session yet.
  app.use('/cli/auth/approve', originCheck(deps.cfg))

  // --- the confirmation page ------------------------------------------------

  app.get('/cli/auth', c => {
    browserHeaders(c)
    const user = c.get('user')
    if (user === null) return toLogin(c)

    const port = parsePort(c.req.query('port'))
    if (port === null) return refusedPage(c, BAD_PORT)
    const state = c.req.query('state')
    if (state === undefined || !STATE_RE.test(state)) return refusedPage(c, BAD_STATE)

    return c.html(confirmPage(user, { port, state }))
  })

  // The way out for someone whose browser cannot reach the machine the CLI is
  // running on — an SSH session, a remote container, a browser on a phone. The
  // token is shown on the page to be copied by hand, so there is no callback,
  // no port, and nothing for `state` to protect. It is still accepted and still
  // validated, because the link to here is built from the CLI's own URL and a
  // malformed one should fail where it is written, not silently.
  app.get('/cli/auth/manual', c => {
    browserHeaders(c)
    const user = c.get('user')
    if (user === null) return toLogin(c)

    const state = c.req.query('state')
    if (state !== undefined && !STATE_RE.test(state)) return refusedPage(c, BAD_STATE)

    return c.html(confirmPage(user, null))
  })

  // --- approval -------------------------------------------------------------

  app.post('/cli/auth/approve', async c => {
    browserHeaders(c)
    // The bearer middleware does not run outside /api, so a user here is a
    // browser session and nothing else — which is the point: a machine token
    // must not be able to mint its own successor (§5.6).
    const user = c.get('user')
    if (user === null) return expiredPage(c)

    const form = await c.req.parseBody()

    // No code, no callback, no waiting listener: the token is handed straight
    // to the person on the page, and is theirs to paste.
    if (field(form, 'manual') === '1') {
      const { token, hash, prefix } = generateMachineToken()
      await deps.db.insert(machineTokens).values({
        workspaceId: user.workspaceId,
        userId: user.id,
        name: TOKEN_NAME,
        tokenHash: hash,
        prefix,
        scopeIds: null,
        expiresAt: null,
      })
      return c.html(tokenPage(token))
    }

    // Re-validated rather than trusted: these came back through a form, and
    // `port` decides where a browser is about to be sent.
    const port = parsePort(field(form, 'port'))
    if (port === null) return refusedPage(c, BAD_PORT)
    const state = field(form, 'state')
    if (state === undefined || !STATE_RE.test(state)) return refusedPage(c, BAD_STATE)

    const code = randomBytes(CODE_BYTES).toString('base64url')
    // The hash is recomputed at the exchange from the plaintext stored here,
    // because the exchange is the thing that has to hand the plaintext over.
    const { token, prefix } = generateMachineToken()

    // Codes nobody came back for are dead weight holding a plaintext secret, so
    // the next approval clears them out. Approvals are rare — once per machine
    // per login — so this costs nothing worth measuring and needs no scheduler.
    await deps.db.delete(cliAuthCodes).where(lt(cliAuthCodes.expiresAt, new Date(now())))

    await deps.db.insert(cliAuthCodes).values({
      codeHash: sha256(code),
      token,
      name: TOKEN_NAME,
      userId: user.id,
      workspaceId: user.workspaceId,
      prefix,
      expiresAt: new Date(now() + CODE_TTL_MS),
    })

    // 127.0.0.1 is hardcoded and the port is the only thing the caller chooses.
    // 'localhost' would be a name someone else's DNS could answer, and any host
    // from the query string would make this an open redirect.
    //
    // This literal is also what CLI_AUTH_CSP's `form-action` names (lib/
    // headers.ts): Chromium refuses to follow a form submission's redirect to an
    // origin the policy does not allow, so the host written here and the host
    // written there have to be the same one. Changing this line means changing
    // that one.
    const target = new URL(`http://127.0.0.1:${port}/callback`)
    target.searchParams.set('code', code)
    target.searchParams.set('state', state)
    return c.redirect(target.href, 302)
  })

  // --- the exchange ---------------------------------------------------------

  // Unauthenticated by necessity: the CLI has no credential yet, which is the
  // entire reason it is here. Holding the code is the proof — it was handed to
  // a listener on the user's own machine, it is single-use, and it dies in a
  // minute.
  app.post('/cli/auth/exchange', async c => {
    const body = await readJsonObject(c)
    const code = body?.code
    if (typeof code !== 'string' || code === '') return c.json({ error: INVALID_CODE }, 400)

    const token = await deps.db.transaction(async tx => {
      // `DELETE … RETURNING` is what makes the code single-use, and it is the
      // whole mechanism: two exchanges racing on one code contend for the same
      // row, the loser re-evaluates after the winner commits, finds nothing,
      // and returns nothing. Reading then deleting would let both through.
      const [claim] = await tx
        .delete(cliAuthCodes)
        .where(
          and(eq(cliAuthCodes.codeHash, sha256(code)), gt(cliAuthCodes.expiresAt, new Date(now()))),
        )
        .returning()
      if (claim === undefined) return null

      // Only now does a credential that can authenticate anything exist. The
      // insert shares the transaction with the delete, so the token and the
      // spending of the code stand or fall together.
      await tx.insert(machineTokens).values({
        workspaceId: claim.workspaceId,
        userId: claim.userId,
        name: claim.name,
        tokenHash: hashToken(claim.token),
        prefix: claim.prefix,
        scopeIds: null,
        expiresAt: null,
      })
      return claim.token
    })

    // Unknown, expired and already spent are one answer: whoever is guessing
    // codes learns nothing from us about which kind of wrong they are.
    if (token === null) return c.json({ error: INVALID_CODE }, 400)
    return c.json({ token })
  })
}

// --- request parsing ---------------------------------------------------------

/** A form field, or undefined for one that is absent or arrived as a file. */
function field(form: Record<string, unknown>, name: string): string | undefined {
  const value = form[name]
  return typeof value === 'string' ? value : undefined
}

/** Digits only, so ' 4242', '4242.5' and '0x10' are refused rather than
 *  silently coerced by Number() into something that looks fine. */
function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return port >= MIN_PORT && port <= MAX_PORT ? port : null
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

/**
 * Set on every response a browser gets from this flow — the pages, the refusals
 * and the redirect to the loopback alike, because the redirect is the one
 * carrying the code and the refusals are the ones a mistyped link lands on.
 */
function browserHeaders(c: Context<AppEnv>): void {
  for (const [name, value] of Object.entries(cliAuthPageHeaders())) c.header(name, value)
}

/** Back here afterwards, with the CLI's port and state intact — losing the
 *  query would leave the listener waiting forever. */
function toLogin(c: Context<AppEnv>) {
  const url = new URL(c.req.url)
  return c.redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302)
}

// --- the pages ---------------------------------------------------------------

const HEADING = 'Authorize the artef CLI on this machine?'

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${THEME}${CHROME}
body{font-size:16px;line-height:1.6;display:grid;place-items:center;min-height:100vh;padding:2rem}
main{max-width:32rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 1rem;color:var(--ink-muted)}
code{font:14px/1.5 ui-monospace,monospace;word-break:break-all;display:block;padding:.75rem;background:var(--bg-raised);border:1px solid var(--line);border-radius:var(--radius);color:var(--ink)}</style>
</head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`
}

/**
 * The one page of this flow a person actually reads. `loopback` is the port and
 * state for the callback, or null for the manual variant — the two differ only
 * in what the form carries and how the token comes back.
 */
function confirmPage(
  user: typeof users.$inferSelect,
  loopback: { port: number; state: string } | null,
): string {
  const hidden =
    loopback === null
      ? '<input type="hidden" name="manual" value="1">'
      : `<input type="hidden" name="port" value="${esc(String(loopback.port))}">` +
        `<input type="hidden" name="state" value="${esc(loopback.state)}">`

  const explanation =
    loopback === null
      ? 'The token will be shown on the next page for you to copy into your terminal.'
      : `The token will be sent to the command line waiting on port ${esc(String(loopback.port))} of this computer, and never shown in this browser.`

  const escape =
    loopback === null
      ? ''
      : `<p><a href="/cli/auth/manual?state=${encodeURIComponent(loopback.state)}">Can’t reach this computer from this browser? Copy the token by hand instead.</a></p>`

  return page(
    HEADING,
    `<p>Signed in as ${esc(user.email)}. Approving creates a machine token named “${TOKEN_NAME}”
that can read and write documents as you, until you revoke it. ${explanation}</p>
<form method="post" action="/cli/auth/approve">${hidden}<button class="btn btn-primary" type="submit">Authorize</button></form>
${escape}`,
  )
}

function tokenPage(token: string): string {
  return page(
    'Your artef CLI token',
    `<p>Paste this into the terminal that is waiting for it. It is shown here once and
cannot be shown again — if you lose it, revoke it and run <code>artef login</code> again.</p>
<code>${esc(token)}</code>`,
  )
}

function refusedPage(c: Context<AppEnv>, reason: string) {
  return c.html(
    page(
      'That sign-in link is not valid',
      `<p>${esc(reason)} Run <code>artef login</code> again and use the link it opens.</p>`,
    ),
    400,
  )
}

function expiredPage(c: Context<AppEnv>) {
  return c.html(
    page(
      'Sign in first',
      '<p>Your session ended before you approved this. <a href="/auth/login">Sign in</a>, then run <code>artef login</code> again.</p>',
    ),
    401,
  )
}
