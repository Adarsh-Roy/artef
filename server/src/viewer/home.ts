// The homepage (in-chat design 2026-08-19): the one page that is about the
// reader rather than a document. Three buckets, disjoint by construction —
// yours (you own it), shared (a grant row names you), workspace (visible to
// the whole workspace and not otherwise yours). Session auth only: the bearer
// middleware is scoped to /api and /mcp, so a machine token cannot enumerate
// a workspace from here.
//
// Admins deliberately get the same personal view as everyone else. Their wider
// can() reach is for acting on a document someone brings them, not for a
// standing feed of every private document in the building.
import { and, desc, eq, exists, inArray, ne, not, sql, type SQL } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { artifactGrants, artifacts, users } from '../db/schema.js'
import {
  cursorFilter,
  encodeCursor,
  INVALID,
  metaColumns,
  parseCursor,
  type ArtifactMeta,
  type Cursor,
} from '../routes/artifacts.js'
import { shellPageHeaders } from '../lib/headers.js'
import { esc, FALLBACK_TITLE } from './shell.js'
import { CHROME, THEME } from './theme.js'

/** How many rows each section shows on the combined page. */
const PREVIEW_LIMIT = 10
/** How many rows a `?section=` page shows before handing out an Older link. */
const PAGE_LIMIT = 50

const SECTIONS = ['yours', 'shared', 'workspace'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_TITLES: Record<Section, string> = {
  yours: 'Your documents',
  shared: 'Shared with you',
  workspace: 'From your workspace',
}

interface Row {
  art: ArtifactMeta
  /** The badge: 'owner' | 'can update' | 'can view'. */
  badge: string
  /** Owner's display name, only for the workspace bucket. */
  ownerName: string | null
  /** Only owned rows carry a delete button (Task 4). */
  deletable: boolean
}

type User = typeof users.$inferSelect

export function registerHomeRoute(app: Hono<AppEnv>, deps: Deps): void {
  app.get('/', async c => {
    const user = c.get('user')
    if (user === null) return c.body(null, 302, { Location: '/auth/login?next=%2F' })

    const rawSection = c.req.query('section')
    const cursor = parseCursor(c.req.query('cursor'))
    // A bad section or cursor is a mangled paste, not an API call — send the
    // person home rather than a JSON error.
    if (cursor === INVALID) return c.body(null, 302, { Location: '/' })
    if (rawSection !== undefined) {
      if (!SECTIONS.includes(rawSection as Section)) return c.body(null, 302, { Location: '/' })
      return sectionPage(c, deps, user, rawSection as Section, cursor)
    }
    if (cursor !== null) return c.body(null, 302, { Location: '/' })
    return combinedPage(c, deps, user)
  })
}

// --- the three bucket queries ----------------------------------------------
// Disjoint on purpose: a granted document never repeats in the workspace
// bucket, and nothing you own appears anywhere but "yours".

const orderNewest = [desc(artifacts.updatedAt), desc(artifacts.id)] as const

async function fetchYours(deps: Deps, user: User, cursor: Cursor | null, limit: number): Promise<Row[]> {
  const rows = await deps.db
    .select(metaColumns)
    .from(artifacts)
    .where(and(
      eq(artifacts.workspaceId, user.workspaceId),
      eq(artifacts.ownerId, user.id),
      cursorFilter(cursor),
    ))
    .orderBy(...orderNewest)
    .limit(limit)
  return rows.map(art => ({ art, badge: 'owner', ownerName: null, deletable: true }))
}

async function fetchShared(deps: Deps, user: User, cursor: Cursor | null, limit: number): Promise<Row[]> {
  const rows = await deps.db
    .select({ art: metaColumns, role: artifactGrants.role })
    .from(artifacts)
    .innerJoin(
      artifactGrants,
      and(eq(artifactGrants.artifactId, artifacts.id), eq(artifactGrants.userId, user.id)),
    )
    .where(and(
      eq(artifacts.workspaceId, user.workspaceId),
      ne(artifacts.ownerId, user.id),
      cursorFilter(cursor),
    ))
    .orderBy(...orderNewest)
    .limit(limit)
  // §12.1: "can update", never "can edit".
  return rows.map(r => ({
    art: r.art,
    badge: r.role === 'editor' ? 'can update' : 'can view',
    ownerName: null,
    deletable: false,
  }))
}

async function fetchWorkspace(deps: Deps, user: User, cursor: Cursor | null, limit: number): Promise<Row[]> {
  const granted: SQL = exists(
    deps.db
      .select({ one: sql`1` })
      .from(artifactGrants)
      .where(and(eq(artifactGrants.artifactId, artifacts.id), eq(artifactGrants.userId, user.id))),
  )
  const rows = await deps.db
    .select({ art: metaColumns, ownerName: users.name, ownerEmail: users.email })
    .from(artifacts)
    .innerJoin(users, eq(users.id, artifacts.ownerId))
    .where(and(
      eq(artifacts.workspaceId, user.workspaceId),
      inArray(artifacts.visibility, ['workspace', 'public']),
      ne(artifacts.ownerId, user.id),
      not(granted),
      cursorFilter(cursor),
    ))
    .orderBy(...orderNewest)
    .limit(limit)
  return rows.map(r => ({
    art: r.art,
    badge: 'can view',
    ownerName: (r.ownerName ?? '').trim() || r.ownerEmail,
    deletable: false,
  }))
}

const FETCH: Record<Section, typeof fetchYours> = {
  yours: fetchYours,
  shared: fetchShared,
  workspace: fetchWorkspace,
}

// --- pages ------------------------------------------------------------------

async function combinedPage(c: Context<AppEnv>, deps: Deps, user: User): Promise<Response> {
  // One extra row per section answers "is there a See all page?" without a
  // count query.
  const [yours, shared, workspace] = await Promise.all(
    SECTIONS.map(s => FETCH[s](deps, user, null, PREVIEW_LIMIT + 1)),
  )
  const sections = { yours, shared, workspace }
  const empty = SECTIONS.every(s => sections[s].length === 0)
  const body = empty
    ? '<p class="empty">Documents you create, and documents shared with you, appear here.</p>'
    : SECTIONS.map(s => sectionHtml(s, sections[s], PREVIEW_LIMIT, null)).join('')
  // The extra row each query fetched answers "is there more?" and is never
  // rendered, so the dialog follows what is actually on the page.
  const deletable = !empty && SECTIONS.some(s => anyDeletable(sections[s], PREVIEW_LIMIT))
  return page(c, 'Artef', body, deletable)
}

/** Whether any row that will actually be rendered carries a delete button. */
const anyDeletable = (rows: Row[], limit: number): boolean =>
  rows.slice(0, limit).some(r => r.deletable)

async function sectionPage(
  c: Context<AppEnv>, deps: Deps, user: User, section: Section, cursor: Cursor | null,
): Promise<Response> {
  const rows = await FETCH[section](deps, user, cursor, PAGE_LIMIT + 1)
  const body =
    `<p class="crumb"><a href="/">&larr; All documents</a></p>` +
    sectionHtml(section, rows, PAGE_LIMIT, section)
  return page(c, SECTION_TITLES[section], body, anyDeletable(rows, PAGE_LIMIT))
}

/** One section: heading, up to `limit` rows, and the link onward — "See all"
 *  from the combined page, "Older" from a section page. */
function sectionHtml(section: Section, rows: Row[], limit: number, paged: Section | null): string {
  const shown = rows.slice(0, limit)
  const more = rows.length > limit
  const last = shown[shown.length - 1]
  const onward = !more || last === undefined
    ? ''
    : paged === null
      ? `<p class="more"><a href="/?section=${section}">See all &rarr;</a></p>`
      : `<p class="more"><a href="/?section=${section}&amp;cursor=${encodeCursor(last.art)}">Older &rarr;</a></p>`
  const items = shown.length === 0
    ? '<p class="empty">Nothing here yet.</p>'
    : `<ul class="docs">${shown.map(rowHtml).join('')}</ul>`
  return `<section><h2>${SECTION_TITLES[section]}</h2>${items}${onward}</section>`
}

function rowHtml(row: Row): string {
  const name = row.art.name ?? FALLBACK_TITLE
  const owner = row.ownerName === null ? '' : `<span class="owner-name">${esc(row.ownerName)}</span>`
  const del = row.deletable
    ? `<button class="icon-btn delete" type="button" data-id="${row.art.id}" data-name="${esc(name)}" aria-label="Delete ${esc(name)}">${TRASH_ICON}</button>`
    : ''
  return `<li class="doc-row">
<a class="doc" href="/a/${row.art.id}"><span class="name">${esc(name)}</span>
<span class="sub">${owner}<time datetime="${esc(row.art.updatedAt.toISOString())}">${esc(row.art.updatedAt.toISOString())}</time></span></a>
<span class="badge">${esc(row.badge)}</span>${del}</li>`
}

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7"/><path d="M10 11v6M14 11v6"/></svg>'

/** `deletable` is whether any rendered row carries a delete button. No button,
 *  no dialog and no script — a page of documents somebody else owns gets none
 *  of this markup at all. */
function page(c: Context<AppEnv>, title: string, body: string, deletable: boolean): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body>
<header class="bar">
<div class="who"><h1>Artef</h1></div>
<div class="actions"><form class="logout" method="post" action="/auth/logout"><button class="btn" type="submit">Log out</button></form></div>
</header>
<main>${body}</main>
${deletable ? DELETE_DIALOG + `<script>${DELETE_SCRIPT}</script>` : ''}
<script>${STAMP_SCRIPT}</script>
</body></html>`
  return c.body(html, 200, { ...shellPageHeaders(), 'Content-Type': 'text/html; charset=utf-8' })
}

/**
 * One dialog for the whole page; whichever button was clicked fills in its own
 * document's name. The copy is the shell's copy word for word, because it is
 * the same promise: the version history goes with the document, everyone's
 * access goes with it, and nothing brings either back.
 *
 * The ids match the shell's on purpose. These are different pages and are never
 * rendered together, so there is one set of names to remember rather than two.
 */
const DELETE_DIALOG = `
<dialog id="delete-dialog" aria-labelledby="delete-title">
<h2 id="delete-title">Delete "<span id="delete-name"></span>"?</h2>
<p>This permanently deletes the document, its version history, and everyone's access. It cannot be undone.</p>
<p id="delete-status" role="status" hidden></p>
<div class="foot">
<button id="delete-cancel" class="btn" type="button" autofocus>Cancel</button>
<button id="delete-confirm" class="btn btn-danger" type="button">Delete</button>
</div>
</dialog>`

/**
 * The dialog is shared, so every click has to reset it: the name, the stale
 * failure message from a previous attempt, and the confirm button a failed
 * attempt may have left disabled. The name is written with `textContent` —
 * it was authored by whoever pushed the document, and it is text, never markup.
 *
 * On success the page reloads rather than removing the row by hand: the counts,
 * the section that row lived in, and the See all links all move together, and
 * re-reading is the only way to be sure the page shows what the server holds.
 */
const DELETE_SCRIPT = `
(() => {
  const dialog = document.getElementById('delete-dialog')
  if (!dialog) return
  const nameSlot = document.getElementById('delete-name')
  const statusLine = document.getElementById('delete-status')
  const confirm = document.getElementById('delete-confirm')
  let id = null
  for (const button of document.querySelectorAll('button.delete')) {
    button.addEventListener('click', () => {
      id = button.dataset.id
      nameSlot.textContent = button.dataset.name
      statusLine.hidden = true
      confirm.disabled = false
      if (!dialog.open) dialog.showModal()
    })
  }
  document.getElementById('delete-cancel').addEventListener('click', () => dialog.close())
  confirm.addEventListener('click', async () => {
    if (!id) return
    confirm.disabled = true
    statusLine.hidden = true
    try {
      const res = await fetch('/api/artifacts/' + encodeURIComponent(id), {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (res.status !== 204) throw new Error()
      location.reload()
    } catch (e) {
      confirm.disabled = false
      statusLine.textContent = 'Could not delete. Try again.'
      statusLine.hidden = false
    }
  })
})()
`

/** ISO stamps are rendered server-side and localized in the browser, the same
 *  move the shell makes — the server does not know the reader's locale. */
const STAMP_SCRIPT = `for (const t of document.querySelectorAll('time[datetime]')) {
  try { t.textContent = new Date(t.dateTime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) } catch (e) {}
}`

const STYLE = `${THEME}${CHROME}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 3rem}
section{margin:0 0 2rem}
h2{font-size:.8125rem;font-weight:600;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 .5rem}
.docs{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:.625rem;overflow:hidden}
.doc-row{display:flex;align-items:center;gap:.5rem;padding:0 .75rem 0 0}
.doc-row + .doc-row{border-top:1px solid var(--line)}
.doc-row:hover{background:var(--bg-hover)}
.doc{flex:1;min-width:0;display:block;padding:.6rem .75rem;color:var(--ink);text-decoration:none}
.doc .name{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc .sub{display:flex;gap:.5rem;color:var(--ink-muted);font-size:.75rem}
.badge{flex:none;color:var(--ink-muted);font-size:.6875rem;border:1px solid var(--line);border-radius:999px;padding:.1rem .5rem;white-space:nowrap}
.empty{color:var(--ink-muted);margin:.25rem 0}
.more{margin:.5rem 0 0;font-size:.8125rem}
.more a,.crumb a{text-decoration:none}
.crumb{margin:0 0 1rem;font-size:.8125rem}
#delete-dialog{width:min(24rem,92vw);padding:1.25rem}
#delete-dialog h2{font-size:1rem;margin:0 0 .5rem;overflow-wrap:anywhere}
#delete-dialog p{margin:.25rem 0;color:var(--ink-muted)}
/* Doubled selector on purpose: the status line is a <p> in the dialog, so a
   bare #delete-status loses to #delete-dialog p above and the failure message
   would come out muted grey rather than red. */
#delete-dialog #delete-status{color:var(--danger)}
#delete-dialog .foot{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem}
/* Quiet until the row is pointed at — and focus-within as well as hover, so
   tabbing to the button still shows it. Hidden with visibility rather than
   display, so the row does not reflow when it appears. */
.doc-row .delete{visibility:hidden}
.doc-row:hover .delete,.doc-row:focus-within .delete{visibility:visible}
/* A touchscreen has no hover to reveal the button with, and tapping the row
   opens the document instead — so on a device without a pointer the button is
   simply always there. Last in the sheet on purpose: same specificity as the
   hidden rule above, so source order is what makes it win. */
@media (hover:none){.doc-row .delete{visibility:visible}}`
