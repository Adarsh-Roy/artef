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
  visibility: 'private' | 'restricted' | 'workspace' | 'public'
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
  const isPublic = o.visibility === 'public'
  // Public documents reload by cache-busting on the version; everything else
  // carries the short-lived capability that is the only credential `/c/:id`
  // accepts (§2.4).
  const src = isPublic
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
<div id="share-root">${shareDialog(o, title)}</div>
<script>${liveScript(o, isPublic)}</script>
${o.canShare ? `<script>${shareScript(o)}</script>` : ''}
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
 *
 * `hello` and `updated` are handled by the same code path because they carry
 * the same `{version, hash}`. That is what makes a dropped connection
 * survivable: an EventSource reconnects by itself, the fresh stream opens with
 * the version the server holds *now*, and a push that landed while the page was
 * disconnected is caught up there instead of leaving the frame stale until the
 * next one.
 */
function liveScript(o: ShellOpts, isPublic: boolean): string {
  const id = jsString(o.id)
  const reload = isPublic
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
  // What the frame is already showing, so the hello on the first connection
  // reloads nothing.
  let shown = ${o.version}
  const events = new EventSource('/api/artifacts/' + id + '/events')
  for (const kind of ['hello', 'updated']) {
    events.addEventListener(kind, async event => {
      let version = null
      try { version = JSON.parse(event.data).version } catch (e) { return }
      if (typeof version !== 'number' || version <= shown) return
      shown = version
      try {
        ${reload}
      } catch (e) {}
    })
  }
})()
`
}

// ---------------------------------------------------------------------------
// The share dialog (§5.9)
// ---------------------------------------------------------------------------

/**
 * Google Docs' share dialog, because every person in the building has already
 * used it: three radios for `visibility`, an email field that writes grant
 * rows, a role dropdown per person, a copy-link button. Nothing else — this is
 * the whole UI the product has, and the reason it can be one file of markup
 * with no build step.
 *
 * Rendered only for the people who may act on it. An owner sees it, an admin
 * sees it, and for everyone else `#share-root` stays the empty div it was.
 */
function shareDialog(o: ShellOpts, title: string): string {
  if (!o.canShare) return ''

  // `canShare` already means "in this artifact's workspace", so the domain is
  // known; the fallback is there so a missing lookup degrades to vague copy
  // rather than to the word "null" in the dialog.
  const domain = o.workspaceDomain ?? 'your workspace'
  const radio = (value: string, label: string) =>
    `<label><input type="radio" name="visibility" value="${value}"${
      o.visibility === value ? ' checked' : ''
    }> ${esc(label)}</label>`

  return `
<dialog id="share-dialog" aria-labelledby="share-title">
<h2 id="share-title">Share "${esc(title)}"</h2>
<div class="choices">
${radio('workspace', `Anyone at ${domain}`)}
${radio('restricted', 'Only people I choose')}
${radio('public', 'Anyone with the link')}
</div>
<p id="share-only-you"${o.visibility === 'private' ? '' : ' hidden'}>Only you</p>
<div class="add">
<label for="share-email">Add people</label>
<input id="share-email" type="email" autocomplete="off" placeholder="email">
<select id="share-role" aria-label="Role for the person being added">${ROLE_OPTIONS}</select>
<button id="share-add" type="button">Add</button>
</div>
<ul id="share-people"></ul>
<p id="share-status" role="status" hidden></p>
<div class="foot">
<button id="share-copy" type="button">Copy link</button>
<button id="share-done" type="button">Done</button>
</div>
</dialog>`
}

/** "can update", never "can edit" — there is no browser editing, and a dialog
 *  that promises a text cursor is worse than one with an awkward verb (§12.1). */
const ROLE_OPTIONS = '<option value="viewer">can view</option><option value="editor">can update</option>'

/**
 * What makes the dialog work: four `fetch` calls against the artifact's own
 * API, same-origin, with the list re-read from the server after every one of
 * them. Nothing is patched into the DOM optimistically — if a grant failed, the
 * list must show what the server actually holds rather than what was clicked.
 *
 * Every string that came from a person is written with `textContent`. The
 * markup above goes through `esc()`; in here there is no innerHTML at all, so
 * an email address is text and can never be markup.
 */
function shareScript(o: ShellOpts): string {
  return `
(() => {
  const base = ${jsString(`/api/artifacts/${o.id}`)}
  const link = ${jsString(`${o.siteUrl.replace(/\/+$/, '')}/${o.id}`)}
  const dialog = document.getElementById('share-dialog')
  const openButton = document.getElementById('share-button')
  if (!dialog || !openButton) return
  const people = document.getElementById('share-people')
  const statusLine = document.getElementById('share-status')
  const onlyYou = document.getElementById('share-only-you')
  const emailInput = document.getElementById('share-email')
  const roleSelect = document.getElementById('share-role')
  const radios = dialog.querySelectorAll('input[name="visibility"]')
  let visibility = ${jsString(o.visibility)}

  const say = message => { statusLine.textContent = message; statusLine.hidden = message === '' }

  /** The radios always show what the server holds, never what was clicked. */
  function showVisibility(value) {
    visibility = value
    for (const radio of radios) radio.checked = radio.value === value
    if (onlyYou) onlyYou.hidden = value !== 'private'
  }

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method: method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 204) return null
    if (res.ok) return res.json()
    let message = 'Something went wrong. Try again.'
    try { const failed = await res.json(); if (failed && failed.error) message = failed.error } catch (e) {}
    throw new Error(message)
  }

  function personRow(grant) {
    const row = document.createElement('li')
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = grant.email
    const role = document.createElement('select')
    role.setAttribute('aria-label', 'Role for ' + grant.email)
    for (const option of [['viewer', 'can view'], ['editor', 'can update']]) {
      const choice = document.createElement('option')
      choice.value = option[0]
      choice.textContent = option[1]
      choice.selected = grant.role === option[0]
      role.appendChild(choice)
    }
    role.addEventListener('change', () => {
      run(() => call('POST', '/grants', { email: grant.email, role: role.value }))
    })
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove'
    remove.textContent = '\\u00d7'
    remove.setAttribute('aria-label', 'Remove ' + grant.email)
    remove.addEventListener('click', () => {
      run(() => call('DELETE', '/grants/' + encodeURIComponent(grant.user_id)))
    })
    row.append(who, role, remove)
    return row
  }

  /**
   * Do the thing, then re-read the list — whether the thing worked or not. A
   * failed change must not leave the dialog showing a role the server refused,
   * because the dialog is the only place anyone can see who has access.
   */
  async function run(action) {
    say('')
    try {
      if (action) await action()
    } catch (e) {
      say(e.message)
    }
    try {
      const grants = await call('GET', '/grants')
      people.replaceChildren(...grants.map(personRow))
    } catch (e) {
      say(e.message)
    }
  }

  function add() {
    const email = emailInput.value.trim()
    if (email === '') return
    run(async () => {
      await call('POST', '/grants', { email: email, role: roleSelect.value })
      emailInput.value = ''
      // A private document ignores grants entirely (§4.2), so naming someone
      // while it is private would add a row that grants nothing. Naming a
      // person IS choosing "only people I choose", and the radio moves to say so.
      if (visibility === 'private') {
        await call('PATCH', '', { visibility: 'restricted' })
        showVisibility('restricted')
      }
    })
  }

  openButton.addEventListener('click', () => { if (!dialog.open) dialog.showModal(); run() })
  document.getElementById('share-done').addEventListener('click', () => dialog.close())
  document.getElementById('share-add').addEventListener('click', add)
  emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add() } })

  for (const radio of radios) {
    radio.addEventListener('change', () => {
      const wanted = radio.value
      run(async () => {
        try {
          await call('PATCH', '', { visibility: wanted })
        } catch (e) {
          // Put the radios back to what the server still holds.
          showVisibility(visibility)
          throw e
        }
        showVisibility(wanted)
      })
    })
  }

  document.getElementById('share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link)
      say('Link copied.')
    } catch (e) {
      say('Could not copy automatically. The link is ' + link)
    }
  })
})()
`
}

/**
 * A server value on its way into an inline `<script>`. `JSON.stringify` alone
 * is not enough: the HTML parser ends the script at the first `</script`
 * wherever it appears, string literal or not, so `<` is escaped as well.
 */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c')
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
#artifact-frame{flex:1;width:100%;border:0}
#share-dialog{width:min(28rem,92vw);padding:1.25rem;border:1px solid #ddd;border-radius:.5rem}
#share-dialog::backdrop{background:rgba(0,0,0,.35)}
#share-dialog h2{font-size:1rem;margin:0 0 .75rem;overflow-wrap:anywhere}
#share-dialog label{display:block}
#share-dialog .choices{display:grid;gap:.35rem;margin-bottom:.5rem}
#share-only-you{margin:0 0 .5rem;color:#666}
#share-dialog .add{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.75rem 0;padding-top:.75rem;border-top:1px solid #eee}
#share-dialog .add label{flex-basis:100%}
#share-email{flex:1;min-width:10rem;font:inherit;padding:.35rem .5rem;border:1px solid #ccc;border-radius:.375rem}
#share-people{list-style:none;margin:0;padding:0;display:grid;gap:.35rem}
#share-people li{display:flex;align-items:center;gap:.5rem}
#share-people .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#share-people .remove{line-height:1}
#share-status{margin:.75rem 0 0;color:#a11}
#share-dialog .foot{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem}
#share-dialog button,#share-dialog select{font:inherit;padding:.3rem .6rem;border:1px solid #ccc;border-radius:.375rem;background:#fff;color:#111;cursor:pointer}`
