// The viewer half of the product (spec §2.3, §2.4, §5.7, §5.8): the shell page
// a person lands on, the sandboxed document it frames, and the short-lived
// token that is the only credential the document route accepts.
//
// Three rules run through the whole file:
//
//   - `/c/:id` never reads a cookie. A signed-in reader with no `?t=` gets the
//     same redirect a stranger gets, because the sandboxed frame that normally
//     asks for it sends no cookies at all (§2.4).
//   - "you may not" and "it is not there" are the same answer, byte for byte
//     (§2.3) — with one deliberate exception, the link-preview page (§5.8).
//   - artifact names are attacker-controlled, so every one of them leaves the
//     server escaped.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { artifacts, artifactGrants, users } from '../src/db/schema.js'
import { mintContentToken, sha256, verifyContentToken } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { SHELL_CSP } from '../src/lib/headers.js'
import { esc } from '../src/viewer/shell.js'
import {
  closeDb,
  makeMachineToken,
  makeUser,
  pushHtml,
  resetDb,
  testDeps,
  TEST_SECRET,
  type TestDeps,
} from './helpers.js'

const HTML = '<!doctype html><h1>hello</h1>'
const XSS_NAME = '<script>alert(1)</script>'
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

type Visibility = 'private' | 'restricted' | 'workspace' | 'public'
type User = typeof users.$inferSelect

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

// --- fixtures ----------------------------------------------------------------

async function makeArtifact(
  owner: User,
  opts: { visibility?: Visibility; name?: string } = {},
): Promise<typeof artifacts.$inferSelect> {
  const [row] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      name: opts.name ?? null,
      visibility: opts.visibility ?? 'private',
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
      version: 0,
    })
    .returning()
  return row
}

/** An owner, their artifact with `HTML` already pushed, and a token to push more. */
async function published(opts: { visibility?: Visibility; name?: string; ownerName?: string } = {}) {
  const { user, cookie } = await makeUser(deps, { name: opts.ownerName })
  const art = await makeArtifact(user, opts)
  const { header } = await makeMachineToken(deps, user.id)
  const res = await pushHtml(deps, header, art.id, HTML)
  expect(res.status).toBe(200)
  return { user, cookie, art, header }
}

const grantTo = (artifactId: string, userId: string, role: 'viewer' | 'editor') =>
  deps.db.insert(artifactGrants).values({ artifactId, userId, role })

const shell = (id: string, headers: Record<string, string> = {}) =>
  deps.app.request(`/a/${id}`, { headers })

const doc = (id: string, query = '', headers: Record<string, string> = {}) =>
  deps.app.request(`/c/${id}${query}`, { headers })

const tokenFor = (id: string, headers: Record<string, string> = {}) =>
  deps.app.request(`/api/artifacts/${id}/content-token`, { headers })

/** The `?t=` value out of the shell's iframe, HTML-unescaped and URL-decoded —
 *  exactly what a browser would send back. */
function frameToken(html: string): string {
  const src = /<iframe[^>]*\ssrc="([^"]+)"/.exec(html)
  expect(src).not.toBeNull()
  const url = new URL(src![1].replace(/&amp;/g, '&'), 'https://artef.test')
  return url.searchParams.get('t') ?? ''
}

// ---------------------------------------------------------------------------
// GET /a/:id — the shell page
// ---------------------------------------------------------------------------

describe('GET /a/:id', () => {
  it('frames the document in a sandboxed iframe carrying a working token', async () => {
    const { art, cookie } = await published({ name: 'Q3 infra report' })

    const res = await shell(art.id, { Cookie: cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)

    const body = await res.text()
    expect(body).toContain('sandbox="allow-scripts"')
    expect(body).toContain(`/c/${art.id}?t=`)
    expect(body).toContain('id="share-root"')
    expect(body).toContain('Q3 infra report')

    // The page is not cached: it embeds a credential.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')

    const t = frameToken(body)
    expect(verifyContentToken(t, art.id, TEST_SECRET)).toBe(true)

    // And the token actually works on the route it was minted for.
    const framed = await doc(art.id, `?t=${encodeURIComponent(t)}`)
    expect(framed.status).toBe(200)
    expect(await framed.text()).toBe(HTML)
  })

  it('serves a grantee on a restricted artifact', async () => {
    const { art } = await published({ visibility: 'restricted' })
    const other = await makeUser(deps)
    await grantTo(art.id, other.user.id, 'viewer')

    const res = await shell(art.id, { Cookie: other.cookie })
    expect(res.status).toBe(200)
    expect(verifyContentToken(frameToken(await res.text()), art.id, TEST_SECRET)).toBe(true)
  })

  it('frames a public artifact for an anonymous reader with a version, not a token', async () => {
    const { art } = await published({ visibility: 'public' })

    const res = await shell(art.id)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`/c/${art.id}?v=1`)
    expect(body).not.toContain('?t=')
  })

  it('reloads on hello as well as updated, and only for a newer version', async () => {
    const { art, cookie } = await published()

    const body = await (await shell(art.id, { Cookie: cookie })).text()

    // Both events, one code path: `hello` is what an EventSource that
    // reconnected by itself gets, and a push missed while it was down is caught
    // up there rather than leaving the frame stale (§5.5).
    expect(body).toContain(`new EventSource('/api/artifacts/' + id + '/events')`)
    expect(body).toContain(`for (const kind of ['hello', 'updated'])`)
    // The version already on screen — one push has happened — so the first
    // hello reloads nothing.
    expect(body).toContain('let shown = 1')
    expect(body).toContain('version <= shown) return')
  })

  it('escapes an artifact name that is an XSS attempt, in the page and the OG tag', async () => {
    const { art, cookie } = await published({ name: XSS_NAME })

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toContain(esc(XSS_NAME))
    expect(body).not.toContain(XSS_NAME)
    expect(body).toContain(`<meta property="og:title" content="${esc(XSS_NAME)}">`)
    // The only script on the page is ours.
    expect(body).not.toContain('alert(1)</script>')
  })

  it('shows Share to the owner and to an admin, and to nobody else', async () => {
    const { art, user, cookie } = await published({ visibility: 'workspace' })
    const admin = await makeUser(deps, { isAdmin: true })
    const peer = await makeUser(deps)
    expect(admin.workspace.id).toBe(user.workspaceId)

    expect(await (await shell(art.id, { Cookie: cookie })).text()).toContain('id="share-button"')
    expect(await (await shell(art.id, { Cookie: admin.cookie })).text()).toContain('id="share-button"')

    const seenByPeer = await (await shell(art.id, { Cookie: peer.cookie })).text()
    expect(seenByPeer).not.toContain('id="share-button"')
    // The mount point is always there; the dialog inside it is not.
    expect(seenByPeer).toContain('id="share-root"')
    expect(seenByPeer).not.toContain('id="share-dialog"')
    expect(seenByPeer).not.toContain('can update')
    // The dialog knows the owner's address so it can leave them out of its
    // suggestions (§5.9). A reader with no dialog has no business being told
    // who owns the document.
    expect(seenByPeer).not.toContain(user.email)
    expect(await (await shell(art.id, { Cookie: admin.cookie })).text()).toContain(user.email)
  })

  it('carries a CSP of its own, on the shell and on the login page', async () => {
    const { art, cookie } = await published({ visibility: 'workspace' })

    const readers: Record<string, string>[] = [{ Cookie: cookie }, {}]
    for (const headers of readers) {
      const res = await shell(art.id, headers)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Security-Policy')).toBe(SHELL_CSP)
    }
    // And on the refusal, which is a page from this origin like any other.
    const missing = await shell(UNKNOWN_ID, { Cookie: cookie })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('Content-Security-Policy')).toBe(SHELL_CSP)

    // The page's own script, its EventSource and its fetches all have to keep
    // working under it — and the frame it is built around most of all.
    expect(SHELL_CSP).toContain("default-src 'none'")
    expect(SHELL_CSP).toContain("script-src 'unsafe-inline'")
    expect(SHELL_CSP).toContain("connect-src 'self'")
    expect(SHELL_CSP).toContain("frame-src 'self'")
    expect(SHELL_CSP).toContain("base-uri 'none'")
    // And nobody else's page may frame this one: it holds the reader's session
    // and a Share button that changes who can read the document.
    expect(SHELL_CSP).toContain("frame-ancestors 'self'")
  })

  // This page hosts session mutations — the share dialog's POST/PATCH/DELETE
  // fetches and the logout form — so its referrer policy must not be
  // `no-referrer`. Per the Fetch spec a `no-referrer` document sends
  // `Origin: null` even on its own same-origin requests, and the origin check
  // refuses `null` (correctly, and by design). `same-origin` costs nothing in
  // privacy: a referrer goes to this origin and to no other, so an `/a/:id` URL
  // still never reaches another site.
  it('sends a referrer to itself and nowhere else, so its own POSTs carry an Origin', async () => {
    const { art, cookie } = await published({ visibility: 'workspace' })

    const owner = await shell(art.id, { Cookie: cookie })
    expect(owner.status).toBe(200)
    expect(owner.headers.get('Referrer-Policy')).toBe('same-origin')

    // The link-preview page (§5.8) is served from the same header set, and the
    // refusal is a page from this origin like any other.
    const preview = await shell(art.id)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('Referrer-Policy')).toBe('same-origin')

    const missing = await shell(UNKNOWN_ID, { Cookie: cookie })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('Referrer-Policy')).toBe('same-origin')
  })

  it('offers logout to a signed-in reader and sign-in to an anonymous one', async () => {
    const { art, cookie } = await published({ visibility: 'public' })

    const signedIn = await (await shell(art.id, { Cookie: cookie })).text()
    expect(signedIn).toContain('<form class="logout" method="post" action="/auth/logout">')
    expect(signedIn).not.toContain('/auth/login')

    const anonymous = await (await shell(art.id)).text()
    expect(anonymous).toContain(`/auth/login?next=${encodeURIComponent(`/a/${art.id}`)}`)
    expect(anonymous).not.toContain('action="/auth/logout"')
  })

  it('gives an unauthenticated reader the name and a login prompt when LINK_PREVIEW=name', async () => {
    const { art } = await published({ name: XSS_NAME, visibility: 'workspace' })

    const res = await shell(art.id)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`<meta property="og:title" content="${esc(XSS_NAME)}">`)
    expect(body).toContain(`https://artef.test/a/${art.id}`)
    expect(body).toContain(`/auth/login?next=${encodeURIComponent(`/a/${art.id}`)}`)
    // No content and no way to reach it: the preview leaks the name, nothing else.
    expect(body).not.toContain('iframe')
    expect(body).not.toContain('/c/')
    expect(body).not.toContain(XSS_NAME)
  })

  it('does not authenticate a bearer token: an agent sees what an anonymous reader sees', async () => {
    const { art, header } = await published({ name: 'agent eyes only', visibility: 'workspace' })

    // Bearer auth is scoped to /api (§5), so a stale Authorization header lying
    // around in a client cannot change what this route decides.
    const res = await shell(art.id, header)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('iframe')
  })

  it('titles an unnamed document rather than leaving the tab blank', async () => {
    const { art, cookie } = await published()

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toContain('<title>Artef document</title>')
    expect(body).toContain('<meta property="og:title" content="Artef document">')
  })

  it('is 404 to an unauthenticated reader when LINK_PREVIEW=none', async () => {
    const quiet = await testDeps({ linkPreview: 'none' })
    const { user } = await makeUser(quiet)
    const [art] = await quiet.db
      .insert(artifacts)
      .values({
        workspaceId: user.workspaceId,
        ownerId: user.id,
        name: 'secret plans',
        visibility: 'workspace',
        contentHash: sha256(''),
        body: gzipBuf(''),
        bodyBytes: 0,
        version: 0,
      })
      .returning()

    const res = await quiet.app.request(`/a/${art.id}`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('secret plans')
  })

  it('answers a reader with no access exactly as it answers an unknown id', async () => {
    const { art } = await published({ name: 'private plans' })
    const stranger = await makeUser(deps)

    const refused = await shell(art.id, { Cookie: stranger.cookie })
    const unknown = await shell(UNKNOWN_ID, { Cookie: stranger.cookie })
    const garbage = await shell('not-a-uuid', { Cookie: stranger.cookie })

    expect(refused.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(garbage.status).toBe(404)

    const body = await refused.text()
    expect(body).toBe(await unknown.text())
    expect(body).toBe(await garbage.text())
    expect(body).not.toContain('private plans')
  })
})

// ---------------------------------------------------------------------------
// The share dialog (spec §5.9) — the product's only UI
// ---------------------------------------------------------------------------

/** The dialog markup on its own, so an assertion about the dialog cannot be
 *  satisfied by something elsewhere on the page. */
function shareDialog(body: string): string {
  const found = /<dialog[\s\S]*?<\/dialog>/.exec(body)
  expect(found, 'no share dialog in the page').not.toBeNull()
  return found![0]
}

/** What a reader actually sees: tags and attributes removed, text left. */
const visibleText = (html: string) => html.replace(/<[^>]*>/g, ' ')

/** The owner's row of "People with access", which is the only one the server
 *  renders — every other row is built from the grants API. */
function ownerRow(dialog: string): string {
  const found = /<li id="share-owner"[\s\S]*?<\/li>/.exec(dialog)
  expect(found, 'no owner row in the share dialog').not.toBeNull()
  return found![0]
}

describe('the share dialog', () => {
  // §5.9 anatomy: Docs' dialog, in Docs' order — add people, the list of who
  // already has it, then general access at the bottom.
  it('is laid out as add people, People with access, then General access', async () => {
    const { art, cookie } = await published({ visibility: 'workspace' })

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    const text = visibleText(dialog)
    expect(dialog).toContain('id="share-dialog"')
    expect(text).toContain('Add people')
    expect(text).toContain('People with access')
    expect(text).toContain('General access')

    const add = dialog.indexOf('id="share-email"')
    const people = dialog.indexOf('People with access')
    const general = dialog.indexOf('General access')
    expect(add).toBeLessThan(people)
    expect(people).toBeLessThan(general)
  })

  it('names the owner on the first row, with "(you)" and no controls', async () => {
    const { art, cookie, user } = await published({ ownerName: 'Priya Nair' })

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    const row = ownerRow(dialog)
    expect(visibleText(row)).toContain('Priya Nair (you) · owner')
    expect(row).toContain(esc(user.email))
    // Their access is not a grant row and cannot be changed by one, so the row
    // carries nothing to click (§5.9).
    expect(row).not.toContain('<select')
    expect(row).not.toContain('<button')
    // First in the list, before any grantee the script appends.
    expect(dialog).toMatch(/<ul id="share-people"><li id="share-owner"/)
  })

  it('drops the "(you)" for an admin looking at somebody else\'s document', async () => {
    const { art, user } = await published({ ownerName: 'Priya Nair' })
    const admin = await makeUser(deps, { isAdmin: true })

    const dialog = shareDialog(await (await shell(art.id, { Cookie: admin.cookie })).text())
    const row = ownerRow(dialog)
    expect(visibleText(row)).toContain('Priya Nair · owner')
    expect(row).not.toContain('(you)')
    expect(row).toContain(esc(user.email))
  })

  it('gives every grantee one dropdown that sets the role and also removes them', async () => {
    const { art, cookie } = await published({ visibility: 'restricted' })

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    // Removal lives in the dropdown, exactly as Docs does it (§5.9).
    expect(body).toContain('Remove access')
    expect(body).toContain("call('DELETE', '/grants/' + encodeURIComponent(grant.user_id))")
    expect(body).toContain("call('POST', '/grants', { email: grant.email, role: role.value })")
    // …so the separate × button is gone.
    expect(body).not.toContain('\\u00d7')
    expect(body).not.toContain("className = 'remove'")
    // Two lines per row, the same shape the suggestions use.
    expect(body).toContain('.textContent = grant.name')
    expect(body).toContain('.textContent = grant.email')
  })

  it('keeps the people list scrollable, so fifty grantees stay usable', async () => {
    const { art, cookie } = await published()

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toMatch(/#share-people\{[^}]*max-height:16rem[^}]*overflow-y:auto/)
  })

  it('offers the three general-access states in one dropdown, naming the workspace', async () => {
    const { art, cookie } = await published({ visibility: 'workspace' })

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    expect(dialog).toContain('id="share-visibility"')
    const text = visibleText(dialog)
    expect(text).toContain('Only people with access')
    expect(text).toContain('Anyone at example.com')
    expect(text).toContain('Anyone with the link')
    // The one that is true is the one that is selected.
    expect(dialog).toMatch(/value="workspace"[^>]*selected/)
    expect(dialog).not.toMatch(/value="public"[^>]*selected/)
    expect(dialog).not.toMatch(/value="restricted"[^>]*selected/)
    // The radios are gone: general access is one dropdown now (§5.9 anatomy).
    expect(dialog).not.toContain('type="radio"')
  })

  it('shows a private document as "Only people with access", never as a fourth state', async () => {
    const { art, cookie } = await published()

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    // §5.9: private is the state before anything is shared. It is not a fourth
    // option, because nobody could say how it differs from "only people I choose".
    expect(dialog).not.toContain('value="private"')
    expect(dialog).toMatch(/value="restricted"[^>]*selected/)
    // And the first grant added to it still moves it to restricted by itself.
    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toContain("if (visibility === 'private')")
    expect(body).toContain("await call('PATCH', '', { visibility: 'restricted' })")
  })

  it('pins general access to "can view", as a label and not a control', async () => {
    const { art, cookie } = await published({ visibility: 'public' })

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    // Workspace-wide and link access are always view-only; update rights are
    // per-person and nothing else (§4.2, §5.9).
    const fixed = /<span id="share-general-role"[^>]*>([^<]*)<\/span>/.exec(dialog)
    expect(fixed, 'no fixed general-access role label').not.toBeNull()
    expect(fixed![1]).toBe('can view')
    // One select in the general-access section, and it is the visibility one.
    const general = /<section class="general"[\s\S]*?<\/section>/.exec(dialog)!
    expect(general[0].match(/<select/g)).toHaveLength(1)
  })

  it('spells out what each general-access state means, and updates the line on change', async () => {
    const lines: Record<string, string> = {
      restricted: 'Only the people listed above can open this link.',
      workspace: 'Everyone at example.com can view. People listed above keep their roles.',
      public:
        'Anyone on the internet with the link can view. People listed above keep their roles.',
    }

    for (const [visibility, line] of Object.entries(lines)) {
      const { art, cookie } = await published({ visibility: visibility as Visibility })
      const body = await (await shell(art.id, { Cookie: cookie })).text()
      const dialog = shareDialog(body)
      // Server-rendered for the state the server holds…
      expect(visibleText(dialog), visibility).toContain(line)
      expect(dialog, visibility).toContain('id="share-general-help"')
      // …and carried in the script, so picking another state rewrites the line
      // without a reload. Ambiguity here is the confusion field testing found.
      expect(body, visibility).toContain(line)
    }

    // A private document reads as restricted here too.
    const priv = await published()
    expect(visibleText(shareDialog(await (await shell(priv.art.id, { Cookie: priv.cookie })).text())))
      .toContain(lines.restricted)
  })

  it('labels the roles "can view" and "can update", and never "can edit"', async () => {
    const { art, cookie } = await published()

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    const text = visibleText(dialog)
    expect(text).toContain('can view')
    expect(text).toContain('can update')
    // §12.1: there is no browser editing, and a share dialog that promises a
    // text cursor is worse than one with an awkward verb. `editor` stays an API
    // value — it never reaches the reader.
    expect(text).not.toMatch(/edit/i)
  })

  it('wires the dialog to the grants API and to the copy link', async () => {
    const { art, cookie } = await published()

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toContain(`/api/artifacts/${art.id}`)
    expect(body).toContain("'/grants'")
    expect(body).toContain("credentials: 'same-origin'")
    expect(body).toContain('navigator.clipboard.writeText')
    expect(body).toContain(`https://artef.test/${art.id}`)
  })

  it('makes the email field a combobox with an empty listbox under it', async () => {
    const { art, cookie } = await published()

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    // §5.9: typing a full address is the wrong ask when the person is a
    // colleague, so the field suggests them.
    expect(dialog).toContain('id="share-email"')
    expect(dialog).toContain('role="combobox"')
    expect(dialog).toContain('aria-expanded="false"')
    expect(dialog).toContain('aria-controls="share-suggestions"')
    expect(dialog).toMatch(/<ul id="share-suggestions"[^>]*role="listbox"[^>]*><\/ul>/)
    // Nothing is server-rendered into it: every row is built from a live search.
    expect(dialog).not.toContain('role="option"')
  })

  it('asks /api/users/search as people type, and writes the answers as text', async () => {
    const { art, cookie } = await published()

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    expect(body).toContain("'/api/users/search?q=' + encodeURIComponent(")
    expect(body).toContain("credentials: 'same-origin'")
    // A name and an address are written by whoever runs the IdP, which is to
    // say they are user-controlled. They reach the DOM as text and never as
    // markup — this whole page contains no innerHTML at all.
    expect(body).not.toContain('innerHTML')
    expect(body).toContain('.textContent = person.name')
    expect(body).toContain('.textContent = person.email')
    // The keys arrow, enter and escape all have to do something, or the field
    // is a list nobody can reach without a mouse.
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(body, key).toContain(key)
    }
    // Closing the list cancels anything that would reopen it: a pending debounce
    // timer, and any search still in flight. Without both, submitting or
    // blurring within the debounce window pops the dropdown back over a field
    // that is no longer focused (or no longer holds what the list is for).
    const closeList = /function closeList\(\)\s*{[\s\S]*?\n  }/.exec(body)
    expect(closeList, 'no closeList in the script').not.toBeNull()
    expect(closeList![0]).toContain('clearTimeout(debounce)')
    expect(closeList![0]).toContain('asked++')
    // The scrollbar is part of the list container, not a row, so the container
    // holds the focus on mousedown too — otherwise grabbing it to scroll blurs
    // the field and the blur closes the list mid-scroll.
    expect(body).toContain("suggestions.addEventListener('mousedown'")
  })

  it('escapes an XSS artifact name inside the dialog too', async () => {
    const { art, cookie } = await published({ name: XSS_NAME })

    const dialog = shareDialog(await (await shell(art.id, { Cookie: cookie })).text())
    expect(dialog).toContain(esc(XSS_NAME))
    expect(dialog).not.toContain(XSS_NAME)
  })

  it('escapes an owner name written by whoever runs the IdP', async () => {
    const { art, cookie } = await published({ ownerName: XSS_NAME })

    const body = await (await shell(art.id, { Cookie: cookie })).text()
    const row = ownerRow(shareDialog(body))
    expect(row).toContain(esc(XSS_NAME))
    expect(row).not.toContain(XSS_NAME)
    expect(body).not.toContain('alert(1)</script>')
  })
})

// ---------------------------------------------------------------------------
// The delete button and its confirmation (design 2026-08-19)
// ---------------------------------------------------------------------------

/** The delete dialog on its own, so an assertion about it cannot be satisfied
 *  by the share dialog sitting next to it on the same page. */
function deleteDialog(body: string): string {
  const found = /<dialog id="delete-dialog"[\s\S]*?<\/dialog>/.exec(body)
  expect(found, 'no delete dialog in the page').not.toBeNull()
  return found![0]
}

describe('the delete button (design 2026-08-19)', () => {
  it('renders button and dialog for the owner', async () => {
    const { art, cookie } = await published({ name: 'mine' })

    const html = await (await shell(art.id, { Cookie: cookie })).text()
    expect(html).toContain('id="delete-button"')
    expect(html).toContain('id="delete-dialog"')
    // The copy promises permanence — that is the whole point of the dialog.
    expect(html).toContain('cannot be undone')

    const dialog = deleteDialog(html)
    const text = visibleText(dialog)
    expect(text).toContain('mine')
    // What goes with the document has to be said, not implied: nobody keeps an
    // older version and nobody keeps their access.
    expect(text).toContain('version history')
    expect(text).toContain('access')
    expect(dialog).toContain('id="delete-confirm"')
    expect(dialog).toContain('id="delete-cancel"')
    expect(dialog).toContain('id="delete-status"')
  })

  it('wires the confirm button to DELETE on the artifact, then to the homepage', async () => {
    const { art, cookie } = await published()

    const html = await (await shell(art.id, { Cookie: cookie })).text()
    expect(html).toContain(`/api/artifacts/${art.id}`)
    expect(html).toContain("method: 'DELETE'")
    expect(html).toContain("credentials: 'same-origin'")
    // 204 is the only success the API gives, and the page it was on no longer
    // exists — the only place left to stand is the homepage.
    expect(html).toContain('res.status !== 204')
    expect(html).toContain("location.href = '/'")
    // A second click while the first is in flight must not fire a second DELETE.
    expect(html).toContain('confirm.disabled = true')
    // …and a failure says so, in the dialog, rather than silently doing nothing.
    expect(html).toContain('Could not delete. Try again.')
    // The message is a <p> inside the dialog, so its rule has to outrank the
    // muted-paragraph rule above it or the failure renders grey.
    expect(html).toMatch(/#delete-dialog #delete-status\{[^}]*color:var\(--danger\)/)
  })

  it('renders neither for an admin, an editor, or a stranger to the doc', async () => {
    const { art } = await published({ visibility: 'workspace' })
    const admin = await makeUser(deps, { isAdmin: true })
    const editor = await makeUser(deps)
    await grantTo(art.id, editor.user.id, 'editor')
    const peer = await makeUser(deps)

    // The API still lets an admin delete; the UI deliberately does not offer it.
    for (const { cookie } of [admin, editor, peer]) {
      const html = await (await shell(art.id, { Cookie: cookie })).text()
      expect(html).not.toContain('id="delete-button"')
      expect(html).not.toContain('id="delete-dialog"')
      // And no script for a dialog that is not there.
      expect(html).not.toContain("method: 'DELETE'")
    }

    // Nor for an anonymous reader of a public document.
    const open = await published({ visibility: 'public' })
    const anonymous = await (await shell(open.art.id)).text()
    expect(anonymous).not.toContain('id="delete-button"')
    expect(anonymous).not.toContain('id="delete-dialog"')
  })

  it('escapes an XSS artifact name in the confirmation heading', async () => {
    const { art, cookie } = await published({ name: XSS_NAME })

    const html = await (await shell(art.id, { Cookie: cookie })).text()
    const dialog = deleteDialog(html)
    expect(dialog).toContain(esc(XSS_NAME))
    expect(dialog).not.toContain(XSS_NAME)
    expect(html).not.toContain('alert(1)</script>')
  })
})

// ---------------------------------------------------------------------------
// The home link in the bar (design 2026-08-19)
// ---------------------------------------------------------------------------

describe('the home link (design 2026-08-19)', () => {
  it('is in the bar for a signed-in reader and absent for a stranger', async () => {
    const { art, cookie } = await published({ visibility: 'public' })

    const signedIn = await (await shell(art.id, { Cookie: cookie })).text()
    expect(signedIn).toContain('class="icon-btn home"')
    expect(signedIn).toContain('href="/"')

    // A stranger reading a public document has no homepage to go to — the link
    // would only lead them to a login wall they never asked for.
    const anonymous = await (await shell(art.id)).text()
    expect(anonymous).not.toContain('class="icon-btn home"')
  })
})

// ---------------------------------------------------------------------------
// GET /c/:id — the document itself
// ---------------------------------------------------------------------------

describe('GET /c/:id', () => {
  it('serves the document to a valid token as html', async () => {
    const { art } = await published()
    const t = mintContentToken(art.id, TEST_SECRET)

    const res = await doc(art.id, `?t=${encodeURIComponent(t)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe(HTML)
  })

  it('serves the stored gzip to a client that takes it', async () => {
    const { art } = await published()
    const t = mintContentToken(art.id, TEST_SECRET)

    const res = await doc(art.id, `?t=${encodeURIComponent(t)}`, { 'Accept-Encoding': 'gzip' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(HTML)
  })

  it('serves a public artifact with no token at all', async () => {
    const { art } = await published({ visibility: 'public' })

    const res = await doc(art.id)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HTML)
  })

  it('serves a version-0 artifact as an empty document, not an error', async () => {
    const { user } = await makeUser(deps)
    const art = await makeArtifact(user)
    const t = mintContentToken(art.id, TEST_SECRET)

    const res = await doc(art.id, `?t=${encodeURIComponent(t)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('redirects to the shell without a token, with garbage, and with an expired one', async () => {
    const { art } = await published()
    const stale = mintContentToken(art.id, TEST_SECRET, Date.now() - 180_000)
    const other = await published()
    const wrongArtifact = mintContentToken(other.art.id, TEST_SECRET)

    for (const query of ['', '?t=', '?t=nonsense', `?t=${stale}`, `?t=${wrongArtifact}`]) {
      const res = await doc(art.id, query)
      expect(res.status, query).toBe(302)
      expect(res.headers.get('Location')).toBe(`/a/${art.id}`)
      expect(await res.text()).toBe('')
    }
  })

  it('ignores the session cookie: a signed-in owner with no token is still redirected', async () => {
    const { art, cookie } = await published()

    const res = await doc(art.id, '', { Cookie: cookie })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/a/${art.id}`)
    expect(await res.text()).toBe('')
  })

  it('redirects rather than 404s for an unknown id, so existence never leaks', async () => {
    const res = await doc(UNKNOWN_ID)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/a/${UNKNOWN_ID}`)
  })
})

// ---------------------------------------------------------------------------
// GET /api/artifacts/:id/content-token
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:id/content-token', () => {
  it('mints a token a session holder can use on /c/:id', async () => {
    const { art, cookie } = await published()

    const res = await tokenFor(art.id, { Cookie: cookie })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { t: string; ttl_seconds: number }
    expect(body.ttl_seconds).toBe(120)
    expect(verifyContentToken(body.t, art.id, TEST_SECRET)).toBe(true)
    expect(res.headers.get('Cache-Control')).toBe('no-store')

    const served = await doc(art.id, `?t=${encodeURIComponent(body.t)}`)
    expect(served.status).toBe(200)
  })

  it('mints for an agent on a bearer token too', async () => {
    const { art, header } = await published()

    const res = await tokenFor(art.id, header)
    expect(res.status).toBe(200)
    const { t } = (await res.json()) as { t: string }
    expect(verifyContentToken(t, art.id, TEST_SECRET)).toBe(true)
  })

  it('is 404 for a stranger, an anonymous caller, an unknown id and an out-of-scope token', async () => {
    const { art, user } = await published()
    const stranger = await makeUser(deps)

    expect((await tokenFor(art.id, { Cookie: stranger.cookie })).status).toBe(404)
    expect((await tokenFor(art.id)).status).toBe(404)
    expect((await tokenFor(UNKNOWN_ID, { Cookie: stranger.cookie })).status).toBe(404)

    const hidden = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [hidden.id] })
    expect((await tokenFor(art.id, header)).status).toBe(404)
    expect((await tokenFor(hidden.id, header)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// GET /:id — the short URL people actually paste
// ---------------------------------------------------------------------------

describe('GET /:id', () => {
  it('redirects a uuid to its shell page permanently', async () => {
    const { art } = await published()

    const res = await deps.app.request(`/${art.id}`)
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe(`/a/${art.id}`)
  })

  it('redirects without looking the artifact up, so it leaks nothing', async () => {
    const res = await deps.app.request(`/${UNKNOWN_ID}`)
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe(`/a/${UNKNOWN_ID}`)
  })

  it('leaves everything else alone', async () => {
    expect((await deps.app.request('/nonsense')).status).toBe(404)
    // The routes that share the shape still answer for themselves.
    expect((await deps.app.request('/_health')).status).toBe(200)
  })
})
