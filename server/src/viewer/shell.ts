// The shell page (spec §2.3 step 4) and the link-preview page (§5.8). Both are
// server-rendered strings with no build step and no framework: the product's
// only UI is a header bar, an iframe and — from Task 9 — one share dialog, and
// none of that is worth a bundler in the deployment story (§1.1).
//
// The page around the document is ours; the document itself is not, and is only
// ever reached through the sandboxed frame. Everything that came from a user
// goes through `esc()` on its way into this HTML — an artifact name is written
// by whoever pushed the document, which in practice means written by a language
// model, which means it is attacker-controlled.

/** The title shown for a document nobody named. */
const FALLBACK_TITLE = 'Artef document'

export interface ShellOpts {
  id: string
  name: string | null
  version: number
  isPublic: boolean
  canShare: boolean
  /** The content token for the frame, or `null` for a public document, which
   *  needs none (§2.4). */
  token: string | null
  siteUrl: string
  workspaceDomain: string | null
  updatedAt: string
  /** Whether the reader has a session. A public document is framed for
   *  strangers too, and offering them a "Log out" button would be nonsense. */
  signedIn: boolean
}

/** `&<>"'` → entities. The single quote is in the list because an attribute
 *  written with single quotes is as much an escape hatch as one written with
 *  double quotes, and remembering which is which at each call site is exactly
 *  the kind of thing that eventually gets it wrong. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderShell(o: ShellOpts): string {
  const title = o.name ?? FALLBACK_TITLE
  // Public documents reload by cache-busting on the version; everything else
  // carries the short-lived capability that is the only credential `/c/:id`
  // accepts (§2.4).
  const src = o.isPublic
    ? `/c/${o.id}?v=${o.version}`
    : `/c/${o.id}?t=${encodeURIComponent(o.token ?? '')}`

  const subtitle = [
    o.workspaceDomain === null ? null : esc(o.workspaceDomain),
    `Updated <time datetime="${esc(o.updatedAt)}">${esc(o.updatedAt)}</time>`,
  ]
    .filter(part => part !== null)
    .join(' · ')

  const share = o.canShare
    ? '<button id="share-button" type="button">Share</button>'
    : ''
  // A POST, never a link: logging out is a state change, and a state change
  // must not be something another page can cause with an <img> tag (§2.2).
  const account = o.signedIn
    ? '<form class="logout" method="post" action="/auth/logout"><button type="submit">Log out</button></form>'
    : `<a class="signin" href="/auth/login?next=${encodeURIComponent(`/a/${o.id}`)}">Sign in</a>`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${ogTags(title, o.siteUrl, o.id)}
<style>${STYLE}</style>
</head><body>
<header class="bar">
<div class="who"><h1>${esc(title)}</h1><p class="meta">${subtitle}</p></div>
<div class="actions">${share}${account}</div>
</header>
<iframe id="artifact-frame" title="${esc(title)}" sandbox="allow-scripts" src="${esc(src)}"></iframe>
<div id="share-root"></div>
<script>${liveScript(o)}</script>
</body></html>`
}

/**
 * What an unauthenticated reader gets for a document they cannot see, when
 * `LINK_PREVIEW=name` (§5.8): the name in the OG tags so a Slack paste unfurls
 * as something better than a bare URL, and a login link. No content, no frame,
 * nothing that could reach `/c/:id`.
 */
export function renderLoginPage(o: { id: string; name: string | null; siteUrl: string }): string {
  const title = o.name ?? FALLBACK_TITLE
  const next = encodeURIComponent(`/a/${o.id}`)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${ogTags(title, o.siteUrl, o.id)}
<style>${PROSE_STYLE}</style>
</head><body><main>
<h1>${esc(title)}</h1>
<p>Sign in to read this document.</p>
<p><a href="/auth/login?next=${next}">Sign in</a></p>
</main></body></html>`
}

// ---------------------------------------------------------------------------

/** OpenGraph and Twitter tags (§5.8). No `og:image`: rasterizing a card is a
 *  WASM binary and a font subset for a prettier unfurl, deliberately deferred. */
function ogTags(title: string, siteUrl: string, id: string): string {
  const url = `${siteUrl.replace(/\/+$/, '')}/a/${id}`
  return `<meta property="og:title" content="${esc(title)}">
<meta property="og:site_name" content="Artef">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">`
}

/**
 * Live updates (§5.5): the server says only "this document changed", and the
 * page fetches the new bytes itself. Every artifact does this — there is no
 * live/static distinction (§12.3).
 *
 * The token minted into the page at render time has expired long before an
 * update arrives, so a private document takes a fresh one for each reload. A
 * public one needs no token and reloads with a cache-buster instead. Only the
 * branch that applies is emitted, so a public page never even mentions `?t=`.
 */
function liveScript(o: ShellOpts): string {
  const id = JSON.stringify(o.id)
  const reload = o.isPublic
    ? `frame.src = '/c/' + id + '?v=' + Date.now()`
    : `const r = await fetch('/api/artifacts/' + id + '/content-token')
      if (!r.ok) return
      const body = await r.json()
      if (body && body.t) frame.src = '/c/' + id + '?t=' + encodeURIComponent(body.t)`

  return `
(() => {
  const id = ${id}
  const frame = document.getElementById('artifact-frame')
  const stamp = document.querySelector('time[datetime]')
  if (stamp) { try { stamp.textContent = new Date(stamp.dateTime).toLocaleString() } catch (e) {} }
  const events = new EventSource('/api/artifacts/' + id + '/events')
  events.addEventListener('updated', async () => {
    try {
      ${reload}
    } catch (e) {}
  })
})()
`
}

const PROSE_STYLE = `body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:2rem}
main{max-width:28rem}h1{font-size:1.25rem;margin:0 0 .75rem;overflow-wrap:anywhere}p{margin:0 0 1rem;color:#333}`

const STYLE = `*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:14px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;color:#111}
.bar{display:flex;align-items:center;gap:1rem;padding:.5rem 1rem;border-bottom:1px solid #e3e3e3;background:#fafafa}
.who{min-width:0}
.bar h1{font-size:1rem;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{margin:0;color:#666;font-size:.8125rem}
.actions{margin-left:auto;display:flex;align-items:center;gap:.5rem}
.actions button,.actions a{font:inherit;padding:.35rem .75rem;border:1px solid #ccc;border-radius:.375rem;background:#fff;color:#111;text-decoration:none;cursor:pointer}
.logout{margin:0}
#artifact-frame{flex:1;width:100%;border:0}`
