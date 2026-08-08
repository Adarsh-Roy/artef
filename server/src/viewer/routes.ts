// The three routes a browser actually visits (spec §5.7), and the load flow
// they implement together (§2.3):
//
//   GET /:id    → 301 /a/:id            the short URL people paste
//   GET /a/:id  → the shell page        session + ACL, then a framed document
//   GET /c/:id  → the document itself   no cookies, `?t=` or public, nothing else
//
// The split between the last two is the whole isolation design. `/a/:id` is an
// ordinary page on the real origin with the reader's session. `/c/:id` is the
// untrusted document, served under the sandbox CSP (§2.1) into a frame whose
// requests carry no cookies at all — so it cannot use the session even in
// principle, and takes a short-lived content token instead (§2.4).
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { workspaces } from '../db/schema.js'
import { can } from '../lib/acl.js'
import { sendStoredBody } from '../lib/blob.js'
import { mintContentToken, verifyContentToken } from '../lib/crypto.js'
import { artifactPageHeaders, shellPageHeaders } from '../lib/headers.js'
import { getArtifactWithGrant, isOwnerOrAdmin, UUID_RE } from '../routes/artifacts.js'
import { renderLoginPage, renderShell } from './shell.js'

/** One body for every refusal, so "you may not" and "it is not there" are the
 *  same answer down to the byte (spec §2.3). */
const NOT_FOUND_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:2rem}
main{max-width:28rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;color:#333}</style>
</head><body><main><h1>Not found</h1>
<p>This document does not exist, or you do not have access to it.</p></main></body></html>`

export function registerViewerRoutes(app: Hono<AppEnv>, deps: Deps): void {
  // -------------------------------------------------------------------------
  // The document. Cookies are never read here — not as a fallback, not as a
  // hint. A frame sandboxed without `allow-same-origin` has an opaque origin,
  // and browsers treat its requests as cross-site, so the session cookie is
  // simply not attached (§2.4). Building on it would make the product work or
  // 404 depending on the browser version.
  //
  // Registered with `app.get` alone: hono answers a HEAD from the GET handler
  // on a parameterized path, so a separately registered HEAD would be dead
  // code — and would add a second entry to the byte-serving route list that
  // the invariant test enumerates.
  // -------------------------------------------------------------------------
  app.get('/c/:id', async c => {
    const id = c.req.param('id')
    // `null` for the user, always: this lookup resolves the artifact, never an
    // identity.
    const found = await getArtifactWithGrant(deps, id, null)
    if (found === null) return toShell(c, id)

    const t = c.req.query('t')
    const allowed =
      found.art.visibility === 'public' ||
      (t !== undefined && t !== '' && verifyContentToken(t, found.art.id, deps.cfg.secretKey))
    if (!allowed) return toShell(c, found.art.id)

    const res = await sendStoredBody(c, deps, found.art, {
      ...artifactPageHeaders(),
      // Ordinary html, because the sandbox travels in the CSP rather than in
      // the content type — direct navigation to this URL renders the document
      // harmlessly (§2.1).
      'Content-Type': 'text/html; charset=utf-8',
    })
    // Deleted between the lookup and the read. Same answer as an id that was
    // never real, which for this route is the redirect.
    return res ?? toShell(c, found.art.id)
  })

  // -------------------------------------------------------------------------
  // The shell page: identity, ACL, and then a frame pointed at the document.
  // -------------------------------------------------------------------------
  app.get('/a/:id', async c => {
    const user = c.get('user')
    const found = await getArtifactWithGrant(deps, c.req.param('id'), user)

    if (found !== null && can(user, found.art, 'viewer', found.grantRole)) {
      const art = found.art
      const isPublic = art.visibility === 'public'
      const html = renderShell({
        id: art.id,
        name: art.name,
        version: art.version,
        isPublic,
        // Sharing is an ownership decision, never an editing one (§5.9).
        canShare: user !== null && isOwnerOrAdmin(user, art),
        token: isPublic ? null : mintContentToken(art.id, deps.cfg.secretKey),
        siteUrl: deps.cfg.url,
        workspaceDomain: await workspaceDomain(deps, user, art.workspaceId),
        updatedAt: art.updatedAt.toISOString(),
        signedIn: user !== null,
      })
      return page(c, html, 200)
    }

    // Slack's unfurler is an unauthenticated bot, so a document it cannot read
    // would never preview at all. `LINK_PREVIEW=name` trades the name — to
    // whoever already holds a 122-bit unguessable id — for a useful unfurl and
    // a login prompt; `none` refuses even that (§5.8).
    //
    // This is the one place where the answer differs by whether the artifact
    // exists, and it is deliberate: the setting exists precisely to leak the
    // name to a link holder, and existence is less than the name. A signed-in
    // reader never reaches it — for them, "not yours" and "not there" stay the
    // same 404 (§2.3).
    if (user === null && found !== null && deps.cfg.linkPreview === 'name') {
      const preview = renderLoginPage({
        id: found.art.id,
        name: found.art.name,
        siteUrl: deps.cfg.url,
      })
      return page(c, preview, 200)
    }

    return page(c, NOT_FOUND_PAGE, 404)
  })

  // -------------------------------------------------------------------------
  // The short URL. Nothing is looked up: the redirect is the same for an id
  // that exists and one that does not, and `/a/:id` is where access is decided.
  // Anything not shaped like a uuid falls through to whatever else claims it,
  // and then to the 404 handler.
  // -------------------------------------------------------------------------
  app.get('/:id', async (c, next) => {
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) return next()
    return c.body(null, 301, { Location: shellPath(id) })
  })
}

/**
 * The redirect `/c/:id` gives anyone without a valid token. It carries the full
 * artifact header set, because §2.2 is written as "every response from
 * `/c/:id`" and a response that has to be reasoned about is a response that is
 * not covered by one assertion.
 */
function toShell(c: Context<AppEnv>, id: string): Response {
  return c.body(null, 302, { ...artifactPageHeaders(), Location: shellPath(id) })
}

/** The id goes into a response header, so it is encoded rather than trusted:
 *  hono decodes percent-escapes into path params, and a decoded newline in a
 *  `Location` is a header injection. A uuid is unchanged by this. */
const shellPath = (id: string) => `/a/${encodeURIComponent(id)}`

const page = (c: Context<AppEnv>, html: string, status: 200 | 404) =>
  c.body(html, status, { ...shellPageHeaders(), 'Content-Type': 'text/html; charset=utf-8' })

/**
 * The domain shown in the header bar, and only to someone inside that
 * workspace: a public document is framed for strangers too, and they have no
 * business learning which company published it.
 */
async function workspaceDomain(
  deps: Deps,
  user: { workspaceId: string } | null,
  workspaceId: string,
): Promise<string | null> {
  if (user === null || user.workspaceId !== workspaceId) return null
  const [row] = await deps.db
    .select({ domain: workspaces.domain })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return row?.domain ?? null
}
