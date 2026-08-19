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

import { CHROME, THEME } from './theme.js'

/** The title shown for a document nobody named. */
export const FALLBACK_TITLE = 'Artef document'

export interface ShellOpts {
  id: string
  name: string | null
  version: number
  visibility: 'private' | 'restricted' | 'workspace' | 'public'
  canShare: boolean
  /** The owner's address, so the share dialog can leave them out of its
   *  suggestions — their access does not come from a grant row and cannot be
   *  given by one (§5.9). `null` whenever there is no dialog to render. */
  ownerEmail: string | null
  /** The owner's display name, for the first row of "People with access". Null
   *  for somebody who has never logged in, whose row falls back to the address. */
  ownerName: string | null
  /** Whether the reader is that owner. The dialog opens for an admin too, and an
   *  admin looking at somebody else's document is not "(you)" (§5.9). */
  viewerIsOwner: boolean
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

  // Signed-in only, and deliberately: a stranger reading a public document has
  // no homepage behind that link, so offering it would send them to a login
  // wall they never asked for.
  const home = o.signedIn
    ? `<a class="icon-btn home" href="/" aria-label="Home">${HOME_ICON}</a>`
    : ''
  const share = o.canShare
    ? '<button id="share-button" class="btn" type="button">Share</button>'
    : ''
  // Owner only, deliberately. The API lets an admin delete somebody else's
  // document, and an admin who means to still can — but a button that throws
  // away another person's work does not belong one click away in the chrome of
  // a page they opened to read.
  const del = o.viewerIsOwner
    ? '<button id="delete-button" class="btn btn-danger" type="button">Delete</button>'
    : ''
  // A POST, never a link: logging out is a state change, and a state change
  // must not be something another page can cause with an <img> tag (§2.2).
  const account = o.signedIn
    ? '<form class="logout" method="post" action="/auth/logout"><button class="btn" type="submit">Log out</button></form>'
    : `<a class="btn btn-primary signin" href="/auth/login?next=${encodeURIComponent(`/a/${o.id}`)}">Sign in</a>`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${ogTags(title, o.siteUrl, o.id)}
<style>${STYLE}</style>
</head><body>
<header class="bar">${home}
<div class="who"><h1>${esc(title)}</h1><p class="meta">${subtitle}</p></div>${del}
<div class="actions">${share}${account}</div>
</header>
<iframe id="artifact-frame" title="${esc(title)}" sandbox="allow-scripts" src="${esc(src)}"></iframe>
<div id="share-root">${shareDialog(o, title)}</div>
${o.viewerIsOwner ? deleteDialog(title) : ''}
<script>${liveScript(o, isPublic)}</script>
${o.canShare ? `<script>${shareScript(o)}</script>` : ''}
${o.viewerIsOwner ? `<script>${deleteScript(o)}</script>` : ''}
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
<p><a class="btn btn-primary" href="/auth/login?next=${next}">Sign in</a></p>
</main></body></html>`
}

// ---------------------------------------------------------------------------

/** A wireframe house: stroke-only, so it inherits `currentColor` and recolors
 *  with the theme for free. `aria-hidden` because the link around it carries
 *  the label. */
const HOME_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/><path d="M10 21v-6h4v6"/></svg>'

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
 * used it — and Docs' anatomy rather than a loose homage, because v0.2 field
 * testing found the loose version confusing (§5.9). Top to bottom: add people,
 * the list of who already has it, and general access at the bottom behind a
 * border. Nothing else — this is the whole UI the product has, and the reason
 * it can be one file of markup with no build step.
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
  const shown = generalState(o.visibility)
  const option = (value: string, label: string) =>
    `<option value="${value}"${shown === value ? ' selected' : ''}>${esc(label)}</option>`

  return `
<dialog id="share-dialog" aria-labelledby="share-title">
<h2 id="share-title">Share "${esc(title)}"</h2>
<div class="add">
<label for="share-email">Add people</label>
<div class="combo">
<input id="share-email" type="email" autocomplete="off" placeholder="email" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="share-suggestions">
<ul id="share-suggestions" role="listbox" aria-label="Matching people" hidden></ul>
</div>
<select id="share-role" aria-label="Role for the person being added">${ROLE_OPTIONS}</select>
<button id="share-add" type="button">Add</button>
</div>
<section class="people" aria-labelledby="share-people-heading">
<h3 id="share-people-heading">People with access</h3>
<ul id="share-people">${ownerRow(o)}</ul>
</section>
<section class="general" aria-labelledby="share-general-heading">
<h3 id="share-general-heading">General access</h3>
<div class="general-row">
<select id="share-visibility" aria-label="General access" aria-describedby="share-general-help">
${option('restricted', 'Only people with access')}
${option('workspace', `Anyone at ${domain}`)}
${option('public', 'Anyone with the link')}
</select>
<span id="share-general-role" class="fixed-role">can view</span>
</div>
<p id="share-general-help">${esc(generalHelp(domain)[shown])}</p>
</section>
<p id="share-status" role="status" hidden></p>
<div class="foot">
<button id="share-copy" type="button">Copy link</button>
<button id="share-done" type="button">Done</button>
</div>
</dialog>`
}

/**
 * The first row of "People with access": whoever owns the document, named the
 * way Docs names them and carrying nothing to click. Their access is not a
 * grant row, so there is no role to set and nothing to revoke (§5.9). The
 * script keeps this row and appends the grantees after it.
 *
 * Written by whoever runs the IdP, which is to say attacker-controlled, so both
 * halves go through `esc()`.
 */
function ownerRow(o: ShellOpts): string {
  const email = o.ownerEmail ?? ''
  const name = (o.ownerName ?? '').trim() || email
  // No lookup, no row: an empty list is better than a row reading "· owner".
  if (name === '') return ''
  const label = `${name}${o.viewerIsOwner ? ' (you)' : ''} · owner`
  // Somebody who has never logged in has no name, and their address is already
  // on the first line — a second copy of it is noise.
  const second = name === email ? '' : `<span class="email">${esc(email)}</span>`
  return `<li id="share-owner" class="owner"><span class="who"><span class="name">${esc(label)}</span>${second}</span></li>`
}

/** What the general-access dropdown shows for a visibility. `private` is the
 *  state before anything is shared and reads as "Only people with access" — it
 *  is not a fourth option, because nobody could say how it differs (§5.9). */
const generalState = (visibility: ShellOpts['visibility']): 'restricted' | 'workspace' | 'public' =>
  visibility === 'private' ? 'restricted' : visibility

/**
 * One line under the dropdown saying plainly what the state does — and, for the
 * two that are not restricted, that it does not touch the roles above it.
 * Ambiguity about what a general-access change grants was the exact confusion
 * v0.2 field testing reported, and this line is half the answer (§5.9). The
 * other half is the fixed "can view" beside the dropdown.
 */
const generalHelp = (domain: string): Record<'restricted' | 'workspace' | 'public', string> => ({
  restricted: 'Only the people listed above can open this link.',
  workspace: `Everyone at ${domain} can view. People listed above keep their roles.`,
  public: 'Anyone on the internet with the link can view. People listed above keep their roles.',
})

/** "can update", never "can edit" — there is no browser editing, and a dialog
 *  that promises a text cursor is worse than one with an awkward verb (§12.1). */
const ROLE_OPTIONS = '<option value="viewer">can view</option><option value="editor">can update</option>'

/**
 * What makes the dialog work: `fetch` calls against the artifact's own API,
 * same-origin, with the list re-read from the server after every one of them.
 * Nothing is patched into the DOM optimistically — if a grant failed, the list
 * must show what the server actually holds rather than what was clicked. The
 * one call that is not about this artifact is `/api/users/search`, which turns
 * the email field into a combobox over the workspace's own people (§5.9).
 *
 * Every string that came from a person is written with `textContent`. The
 * markup above goes through `esc()`; in here there is no innerHTML at all, so
 * an email address — or a colleague's name, which comes from whoever runs the
 * IdP — is text and can never be markup.
 */
function shareScript(o: ShellOpts): string {
  return `
(() => {
  const base = ${jsString(`/api/artifacts/${o.id}`)}
  const link = ${jsString(`${o.siteUrl.replace(/\/+$/, '')}/${o.id}`)}
  const owner = ${jsString((o.ownerEmail ?? '').toLowerCase())}
  const dialog = document.getElementById('share-dialog')
  const openButton = document.getElementById('share-button')
  if (!dialog || !openButton) return
  const people = document.getElementById('share-people')
  const statusLine = document.getElementById('share-status')
  const emailInput = document.getElementById('share-email')
  const suggestions = document.getElementById('share-suggestions')
  const roleSelect = document.getElementById('share-role')
  const generalSelect = document.getElementById('share-visibility')
  const helpLine = document.getElementById('share-general-help')
  /** The owner's row, server-rendered and kept: re-reading the grants replaces
   *  everything else in the list, and the owner is not in the grants. */
  const ownerRow = document.getElementById('share-owner')
  const HELP = ${jsValue(generalHelp(o.workspaceDomain ?? 'your workspace'))}
  let visibility = ${jsString(o.visibility)}
  /** Addresses the dialog will not suggest: everyone already on the list, and
   *  the owner, who cannot be granted anything they do not already have. */
  let taken = new Set(owner === '' ? [] : [owner])

  const say = message => { statusLine.textContent = message; statusLine.hidden = message === '' }

  /** The dropdown always shows what the server holds, never what was clicked —
   *  and the line under it says what that means. A private document shows as
   *  "Only people with access": it is the state before anything is shared, not a
   *  fourth option (§5.9). */
  function showVisibility(value) {
    visibility = value
    const state = value === 'private' ? 'restricted' : value
    generalSelect.value = state
    helpLine.textContent = HELP[state] || ''
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

  /**
   * One grantee: name on the first line, address on the second — the same two
   * lines the suggestions use — and a single dropdown on the right. Removal is
   * one of its options rather than a separate ×, which is how Docs does it and
   * where people look for it (§5.9).
   */
  function personRow(grant) {
    const row = document.createElement('li')
    const who = document.createElement('span')
    who.className = 'who'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = grant.name || grant.email
    who.appendChild(name)
    // Somebody pre-provisioned by an earlier grant has no name yet, and their
    // address is already on the first line — a second copy of it is noise.
    if (grant.name) {
      const email = document.createElement('span')
      email.className = 'email'
      email.textContent = grant.email
      who.appendChild(email)
    }
    const role = document.createElement('select')
    role.className = 'role'
    role.setAttribute('aria-label', 'Access for ' + grant.email)
    for (const option of [['viewer', 'can view'], ['editor', 'can update'], ['remove', 'Remove access']]) {
      const choice = document.createElement('option')
      choice.value = option[0]
      choice.textContent = option[1]
      choice.selected = grant.role === option[0]
      role.appendChild(choice)
    }
    role.addEventListener('change', () => {
      // 'remove' is not a role and is never sent as one — the branches part
      // before anything reaches the API.
      if (role.value === 'remove') {
        run(() => call('DELETE', '/grants/' + encodeURIComponent(grant.user_id)))
      } else {
        run(() => call('POST', '/grants', { email: grant.email, role: role.value }))
      }
    })
    row.append(who, role)
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
      // The owner stays first and the grantees follow, in the order the server
      // gave them — oldest first, so somebody added while the dialog is open
      // appears at the bottom rather than shuffling the names on screen.
      people.replaceChildren(...(ownerRow ? [ownerRow] : []), ...grants.map(personRow))
      taken = new Set(owner === '' ? [] : [owner])
      for (const grant of grants) taken.add(String(grant.email).toLowerCase())
    } catch (e) {
      say(e.message)
    }
  }

  // --- suggesting colleagues (§5.9) ----------------------------------------
  // Backed by the workspace's own users table, so it knows the people artef has
  // seen and nobody else. Typing an address it never suggests still works
  // exactly as before — a grant pre-provisions the user (§5.3) — which is why
  // nothing in here may ever block or delay the plain Add.

  let matches = []
  let active = -1
  let debounce = null
  /** Only the newest request may write the list: the answer for 'sa' arriving
   *  after the answer for 'sah' would replace the right list with a stale one. */
  let asked = 0

  function closeList() {
    // Closing also cancels anything that would reopen it: a keystroke still
    // waiting out its debounce, and a search already in flight. Without this,
    // hitting Enter within 150ms of typing fires the timer and pops the list
    // back over the now-cleared field, and a blur with a fetch pending lets its
    // answer reopen the list while the field is not even focused.
    if (debounce) clearTimeout(debounce)
    debounce = null
    asked++
    matches = []
    active = -1
    suggestions.replaceChildren()
    suggestions.hidden = true
    emailInput.setAttribute('aria-expanded', 'false')
    emailInput.removeAttribute('aria-activedescendant')
  }

  function highlight(index) {
    active = index
    for (let i = 0; i < suggestions.children.length; i++) {
      suggestions.children[i].setAttribute('aria-selected', i === active ? 'true' : 'false')
    }
    if (active < 0) {
      emailInput.removeAttribute('aria-activedescendant')
      return
    }
    emailInput.setAttribute('aria-activedescendant', 'share-suggestion-' + active)
    const row = suggestions.children[active]
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
  }

  /** Picking fills the field and closes the list. It does not add anybody: the
   *  role dropdown sits next to the field, and choosing a person is not the
   *  same gesture as deciding what they may do. */
  function pick(index) {
    const person = matches[index]
    if (!person) return
    emailInput.value = person.email
    closeList()
    emailInput.focus()
  }

  /** Two lines, the way every share dialog does it: who they are, then the
   *  address the grant will be written for. Both are createElement and
   *  textContent — a name is user-controlled and is never markup. */
  function suggestionRow(person, index) {
    const row = document.createElement('li')
    row.id = 'share-suggestion-' + index
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', 'false')
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = person.name || person.email
    row.appendChild(name)
    // Somebody pre-provisioned by an earlier grant has no name yet, and their
    // address is already on the first line — a second copy of it is noise.
    if (person.name) {
      const email = document.createElement('span')
      email.className = 'email'
      email.textContent = person.email
      row.appendChild(email)
    }
    // mousedown rather than click, and the default prevented: a click would
    // blur the field first, and the blur closes the list out from under it.
    row.addEventListener('mousedown', event => { event.preventDefault(); pick(index) })
    return row
  }

  function show(found) {
    matches = found
    if (matches.length === 0) return closeList()
    suggestions.replaceChildren(...matches.map(suggestionRow))
    suggestions.hidden = false
    emailInput.setAttribute('aria-expanded', 'true')
    // Nothing highlighted to begin with, so Enter still submits what was typed.
    highlight(-1)
  }

  async function lookUp(value) {
    const mine = ++asked
    let found = []
    try {
      const res = await fetch('/api/users/search?q=' + encodeURIComponent(value), {
        credentials: 'same-origin',
      })
      if (res.ok) found = await res.json()
    } catch (e) {
      // A failed search is not worth a message. The field works without it.
    }
    if (mine !== asked) return
    if (!Array.isArray(found)) found = []
    show(found.filter(p => p && p.email && !taken.has(String(p.email).toLowerCase())))
  }

  emailInput.addEventListener('input', () => {
    const value = emailInput.value.trim()
    if (debounce) clearTimeout(debounce)
    if (value === '') return closeList()
    // A keystroke is not a query: a short wait turns a typed address into one
    // request instead of twenty.
    debounce = setTimeout(() => lookUp(value), 150)
  })

  emailInput.addEventListener('blur', closeList)

  // Grabbing the scrollbar — only reachable once the list is ten tall — is a
  // mousedown on the container, not on a row, and would blur the field and
  // close the list mid-scroll. Same guard the rows carry: hold the focus so the
  // list stays put. A mousedown that lands on a row still reaches its own
  // handler, which is what actually picks the person.
  suggestions.addEventListener('mousedown', event => { event.preventDefault() })

  function add() {
    const email = emailInput.value.trim()
    if (email === '') return
    closeList()
    run(async () => {
      await call('POST', '/grants', { email: email, role: roleSelect.value })
      emailInput.value = ''
      // A private document ignores grants entirely (§4.2), so naming someone
      // while it is private would add a row that grants nothing. Naming a
      // person IS choosing "only people with access", and the general-access
      // dropdown already reads that way — this is what makes it true.
      if (visibility === 'private') {
        await call('PATCH', '', { visibility: 'restricted' })
        showVisibility('restricted')
      }
    })
  }

  openButton.addEventListener('click', () => { if (!dialog.open) dialog.showModal(); closeList(); run() })
  document.getElementById('share-done').addEventListener('click', () => dialog.close())
  document.getElementById('share-add').addEventListener('click', add)

  emailInput.addEventListener('keydown', e => {
    const open = matches.length > 0
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault()
      highlight(active + 1 >= matches.length ? 0 : active + 1)
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault()
      highlight(active - 1 < 0 ? matches.length - 1 : active - 1)
    } else if (e.key === 'Escape' && open) {
      // The list closes and the dialog stays open, which is what Escape means
      // while a dropdown is showing. Without preventDefault the dialog itself
      // would close, losing the list and the dialog in one keystroke.
      e.preventDefault()
      e.stopPropagation()
      closeList()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Highlighted: that is who they meant. Nothing highlighted: the typed
      // address is the answer, and it stays the answer when it matches nobody
      // — a grant pre-provisions the user (§5.3).
      if (active >= 0) pick(active)
      else add()
    }
  })

  generalSelect.addEventListener('change', () => {
    const wanted = generalSelect.value
    run(async () => {
      try {
        await call('PATCH', '', { visibility: wanted })
      } catch (e) {
        // Put the dropdown back to what the server still holds.
        showVisibility(visibility)
        throw e
      }
      showVisibility(wanted)
    })
  })

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

// ---------------------------------------------------------------------------
// Deleting a document
// ---------------------------------------------------------------------------

/**
 * The confirmation between the Delete button and the API call. The copy is the
 * contract: the version history goes with the document, everyone's access goes
 * with it, and nothing brings either back. `esc()` because the name was written
 * by whoever pushed the document.
 */
function deleteDialog(title: string): string {
  return `
<dialog id="delete-dialog" aria-labelledby="delete-title">
<h2 id="delete-title">Delete "${esc(title)}"?</h2>
<p>This permanently deletes the document, its version history, and everyone's access. It cannot be undone.</p>
<p id="delete-status" role="status" hidden></p>
<div class="foot">
<button id="delete-cancel" class="btn" type="button" autofocus>Cancel</button>
<button id="delete-confirm" class="btn btn-danger" type="button">Delete</button>
</div>
</dialog>`
}

/**
 * One `fetch` against the artifact's own API, same-origin, and then away from a
 * page that no longer has a document behind it. The button is disabled for the
 * length of the call so a second click cannot fire a second DELETE, and a
 * failure puts it back rather than leaving a dialog nobody can act on.
 *
 * Opening resets the dialog, the same way the homepage's does: a previous
 * attempt's "Could not delete. Try again." would otherwise still be sitting
 * there when someone cancels and opens it again.
 */
function deleteScript(o: ShellOpts): string {
  return `
(() => {
  const api = ${jsString(`/api/artifacts/${o.id}`)}
  const dialog = document.getElementById('delete-dialog')
  const openButton = document.getElementById('delete-button')
  if (!dialog || !openButton) return
  const statusLine = document.getElementById('delete-status')
  const confirm = document.getElementById('delete-confirm')
  openButton.addEventListener('click', () => { statusLine.hidden = true; confirm.disabled = false; if (!dialog.open) dialog.showModal() })
  document.getElementById('delete-cancel').addEventListener('click', () => dialog.close())
  confirm.addEventListener('click', async () => {
    confirm.disabled = true
    statusLine.hidden = true
    try {
      const res = await fetch(api, { method: 'DELETE', credentials: 'same-origin' })
      if (res.status !== 204) throw new Error()
      // The document is gone; the only place left to stand is the homepage.
      location.href = '/'
    } catch (e) {
      confirm.disabled = false
      statusLine.textContent = 'Could not delete. Try again.'
      statusLine.hidden = false
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
function jsValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** `jsValue` for the common case, where the value is a string. */
const jsString = (s: string): string => jsValue(s)

const PROSE_STYLE = `${THEME}${CHROME}
body{font-size:16px;line-height:1.6;display:grid;place-items:center;min-height:100vh;padding:2rem}
main{max-width:28rem}h1{font-size:1.25rem;margin:0 0 .75rem;overflow-wrap:anywhere}p{margin:0 0 1rem;color:var(--ink-muted)}`

/**
 * The shell's own layout, on top of the shared theme. `#artifact-frame` keeps
 * `background:#fff` on purpose: artifact documents are overwhelmingly light
 * pages, and a transparent frame over a dark shell flashes dark while loading.
 */
const STYLE = `${THEME}${CHROME}
html,body{height:100%}
body{display:flex;flex-direction:column}
.logout{margin:0}
#artifact-frame{flex:1;width:100%;border:0;background:#fff}
#share-dialog{width:min(28rem,92vw);padding:1.25rem}
#share-dialog h2{font-size:1rem;margin:0 0 .75rem;overflow-wrap:anywhere}
#share-dialog label{display:block}
#share-dialog h3{font-size:.8125rem;font-weight:600;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.04em;margin:1rem 0 .5rem}
#share-dialog .add{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:0}
#share-dialog .add label{flex-basis:100%}
#share-dialog .combo{position:relative;flex:1;min-width:10rem}
#share-email{width:100%;font:inherit;padding:.35rem .5rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);color:var(--ink)}
#share-suggestions{position:absolute;z-index:1;left:0;right:0;top:calc(100% + .15rem);margin:0;padding:.15rem;list-style:none;background:var(--bg-raised);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);max-height:13rem;overflow-y:auto}
#share-suggestions[hidden]{display:none}
#share-suggestions li{padding:.3rem .45rem;border-radius:.25rem;cursor:pointer;overflow-wrap:anywhere}
#share-suggestions li[aria-selected="true"]{background:var(--bg-hover)}
#share-suggestions .name{display:block}
#share-suggestions .email{display:block;color:var(--ink-muted);font-size:.75rem}
#share-people{list-style:none;margin:0;padding:0 .25rem 0 0;display:grid;gap:.5rem;max-height:16rem;overflow-y:auto}
#share-people li{display:flex;align-items:center;gap:.5rem}
#share-people .who{flex:1;min-width:0}
#share-people .name,#share-people .email{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#share-people .email{color:var(--ink-muted);font-size:.75rem}
#share-dialog .general{margin-top:1rem;padding-top:.75rem;border-top:1px solid var(--line)}
#share-dialog .general h3{margin-top:0}
#share-dialog .general-row{display:flex;align-items:center;gap:.5rem}
#share-general-role{color:var(--ink-muted)}
#share-general-help{margin:.4rem 0 0;color:var(--ink-muted);font-size:.75rem}
#share-status{margin:.75rem 0 0;color:var(--danger)}
#share-dialog .foot{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem}
#share-dialog button,#share-dialog select{font:inherit;font-size:.8125rem;padding:.3rem .6rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg-raised);color:var(--ink);cursor:pointer}
#share-dialog button:hover{background:var(--bg-hover)}
#delete-dialog{width:min(24rem,92vw);padding:1.25rem}
#delete-dialog h2{font-size:1rem;margin:0 0 .5rem;overflow-wrap:anywhere}
#delete-dialog p{margin:.25rem 0;color:var(--ink-muted)}
/* Doubled selector on purpose: the status line is a <p> in the dialog, so a
   bare #delete-status loses to #delete-dialog p above and the failure message
   would come out muted grey rather than red. */
#delete-dialog #delete-status{color:var(--danger)}
#delete-dialog .foot{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem}`
