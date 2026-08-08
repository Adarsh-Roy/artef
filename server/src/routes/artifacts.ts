// Artifact CRUD and listing (spec §5.1). Two rules run through every handler:
//
//   - "you may not" and "it is not there" are the same answer (spec §2.3), so a
//     caller who cannot view an artifact gets 404 and never learns the id is
//     real. 403 is only ever for someone who can already see the thing.
//   - the `body` column is never selected here (spec §3.1). It is TOASTed out of
//     the main heap, and listing a hundred artifacts must not drag a hundred
//     documents through Postgres to throw them away.
import { and, desc, eq, exists, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { artifactGrants, artifacts, users } from '../db/schema.js'
import { can, type Role } from '../lib/acl.js'
import { sha256 } from '../lib/crypto.js'
import { gzipBuf } from '../lib/gzip.js'

const MAX_NAME_LENGTH = 200
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** What an artifact id looks like. Exported because `GET /:id` decides whether
 *  a single path segment is a document id by exactly this shape (spec §5.7). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VISIBILITIES = ['private', 'restricted', 'workspace', 'public'] as const

type Visibility = (typeof VISIBILITIES)[number]
type User = typeof users.$inferSelect

/** Marks a field that was present but unusable, which `null` cannot: `name` and
 *  `visibility` both have meaningful null/absent cases. */
const INVALID = Symbol('invalid')

/** Every artifact column except `body` — the one thing that must never be read
 *  by a metadata route. Listing them is what keeps `SELECT *` from creeping in. */
const metaColumns = {
  id: artifacts.id,
  workspaceId: artifacts.workspaceId,
  ownerId: artifacts.ownerId,
  name: artifacts.name,
  visibility: artifacts.visibility,
  contentHash: artifacts.contentHash,
  bodyBytes: artifacts.bodyBytes,
  version: artifacts.version,
  createdAt: artifacts.createdAt,
  updatedAt: artifacts.updatedAt,
}

export type ArtifactMeta = Omit<typeof artifacts.$inferSelect, 'body'>

/**
 * The artifact plus this user's grant on it — everything `can()` needs, in one
 * round trip. Returns `null` when the id names nothing, including when it is not
 * a uuid at all: an unparseable id cannot match a row, and letting Postgres try
 * the cast turns a typo into a 500.
 *
 * `null` here means "no such artifact"; it says nothing about permission. Every
 * caller must still run `can()` on the result.
 */
export async function getArtifactWithGrant(
  deps: Deps,
  artifactId: string,
  user: { id: string } | null,
): Promise<{ art: ArtifactMeta; grantRole: Role | null } | null> {
  if (!UUID_RE.test(artifactId)) return null

  // An anonymous caller holds no grants, so the join is short-circuited rather
  // than run against a user id that does not exist.
  const grantMatch: SQL =
    user === null
      ? sql`false`
      : and(eq(artifactGrants.artifactId, artifacts.id), eq(artifactGrants.userId, user.id))!

  const [row] = await deps.db
    .select({ art: metaColumns, grantRole: artifactGrants.role })
    .from(artifacts)
    .leftJoin(artifactGrants, grantMatch)
    .where(eq(artifacts.id, artifactId))
    .limit(1)

  return row === undefined ? null : { art: row.art, grantRole: row.grantRole }
}

/**
 * Changing who can see a document is an ownership decision, not an editing one:
 * an editor grant says "help me write this", never "publish it to the world".
 * Admin is a workspace role, so it stops at the workspace boundary — otherwise
 * an admin anywhere could delete any `public` artifact, which `can()` lets them
 * view by design.
 *
 * Exported because the shell page shows the Share button to exactly the people
 * this returns true for — the button opens the dialog that changes visibility
 * and grants, so it answers the same question (§5.9).
 */
export function isOwnerOrAdmin(user: User, art: ArtifactMeta): boolean {
  if (user.workspaceId !== art.workspaceId) return false
  return user.id === art.ownerId || user.isAdmin
}

/** A scoped machine token may only name the artifacts it was minted for (spec
 *  §5.6). Anything else is 404, same as an artifact that does not exist. */
const tokenScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const scopeIds = c.get('tokenScopeIds')
  if (scopeIds === null) return next()
  // No id to check means nothing a scoped token is entitled to, so it is
  // refused rather than waved through.
  const id = c.req.param('id')?.toLowerCase()
  if (id === undefined || !scopeIds.includes(id)) return c.json({ error: 'not found' }, 404)
  return next()
}

export function registerArtifactRoutes(app: Hono<AppEnv>, deps: Deps): void {
  // Registered on the sub-path too, so the content, grants and event routes
  // built on top of these ids inherit the scope check rather than each
  // remembering it.
  app.use('/api/artifacts/:id', tokenScope)
  app.use('/api/artifacts/:id/*', tokenScope)

  app.post('/api/artifacts', async c => {
    const user = c.get('user')
    if (user === null) return c.json({ error: 'unauthorized' }, 401)
    // A scoped token names existing artifacts, so there is no id a new one
    // could be created under that the token would then be allowed to touch.
    if (c.get('tokenScopeIds') !== null) {
      return c.json({ error: 'this token is scoped to specific artifacts' }, 403)
    }

    const body = await readJsonObject(c)
    if (body === INVALID) return c.json({ error: 'expected a JSON object' }, 400)

    const name = parseName(body.name)
    if (name === INVALID) return c.json({ error: nameError() }, 400)
    const visibility = parseVisibility(body.visibility)
    if (visibility === INVALID) return c.json({ error: visibilityError() }, 422)

    // Version 0 with an empty body, not a placeholder row: `GET /c/:id` of a
    // freshly created artifact is an empty document, not an error (spec §5.1).
    const [row] = await deps.db
      .insert(artifacts)
      .values({
        workspaceId: user.workspaceId,
        ownerId: user.id,
        name,
        visibility: visibility ?? 'private',
        contentHash: sha256(''),
        body: gzipBuf(''),
        bodyBytes: 0,
        version: 0,
      })
      .returning(metaColumns)

    return c.json(
      {
        id: row.id,
        url: `${deps.cfg.url.replace(/\/+$/, '')}/a/${row.id}`,
        name: row.name,
        visibility: row.visibility,
        version: row.version,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      },
      201,
    )
  })

  // No login required: a `public` artifact is viewable by anyone with the link
  // (spec §4.2), and `can()` is the single authority on that.
  app.get('/api/artifacts/:id', async c => {
    const user = c.get('user')
    const found = await getArtifactWithGrant(deps, c.req.param('id'), user)
    if (found === null || !can(user, found.art, 'viewer', found.grantRole)) return notFound(c)
    return c.json(toMeta(found.art))
  })

  app.patch('/api/artifacts/:id', async c => {
    const user = c.get('user')
    if (user === null) return c.json({ error: 'unauthorized' }, 401)

    const found = await getArtifactWithGrant(deps, c.req.param('id'), user)
    if (found === null || !can(user, found.art, 'viewer', found.grantRole)) return notFound(c)

    const body = await readJsonObject(c)
    if (body === INVALID) return c.json({ error: 'expected a JSON object' }, 400)

    // Authorize before validating, so a caller with no right to a field learns
    // nothing about whether their value would have been accepted.
    const patch: { name?: string | null; visibility?: Visibility } = {}

    if ('name' in body) {
      if (!can(user, found.art, 'editor', found.grantRole)) return forbidden(c)
      const name = parseName(body.name)
      if (name === INVALID) return c.json({ error: nameError() }, 400)
      patch.name = name
    }

    if ('visibility' in body) {
      if (!isOwnerOrAdmin(user, found.art)) return forbidden(c)
      const visibility = parseVisibility(body.visibility)
      if (visibility === INVALID || visibility === null) {
        return c.json({ error: visibilityError() }, 422)
      }
      patch.visibility = visibility
    }

    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'name or visibility is required' }, 400)
    }

    // A rename is a change to the artifact, so it moves to the top of the list
    // like any other. `version` is content's counter and is left alone.
    const [row] = await deps.db
      .update(artifacts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(artifacts.id, found.art.id))
      .returning(metaColumns)

    return c.json(toMeta(row))
  })

  app.delete('/api/artifacts/:id', async c => {
    const user = c.get('user')
    if (user === null) return c.json({ error: 'unauthorized' }, 401)

    const found = await getArtifactWithGrant(deps, c.req.param('id'), user)
    if (found === null || !can(user, found.art, 'viewer', found.grantRole)) return notFound(c)
    // They can already see it, so 403 gives nothing away that the 200 on `GET`
    // has not given away already.
    if (!isOwnerOrAdmin(user, found.art)) return forbidden(c)

    await deps.db.delete(artifacts).where(eq(artifacts.id, found.art.id))
    return c.body(null, 204)
  })

  app.get('/api/artifacts', async c => {
    const user = c.get('user')
    if (user === null) return c.json({ error: 'unauthorized' }, 401)

    const limit = parseLimit(c.req.query('limit'))
    const cursor = parseCursor(c.req.query('cursor'))
    if (cursor === INVALID) return c.json({ error: 'invalid cursor' }, 400)

    // A scoped token is a containment boundary, not merely a write guard: an
    // agent trusted with one document must not be able to enumerate the names
    // of every other one. This narrows the page, it never widens it — the
    // visibility filter still has to pass for each row (spec §5.6).
    const scopeIds = c.get('tokenScopeIds')

    const where = and(
      // Workspace isolation first, exactly as `can()` does it (spec §4.2) —
      // including for `public`, which is listable only by its own workspace.
      eq(artifacts.workspaceId, user.workspaceId),
      visibleToUser(deps, user, c.req.query('mine') === 'true'),
      scopeIds === null ? undefined : inArray(artifacts.id, scopeIds),
      cursorFilter(cursor),
    )

    // One extra row answers "is there a next page?" without a second query and
    // without handing back a cursor to an empty page.
    const rows = await deps.db
      .select(metaColumns)
      .from(artifacts)
      .where(where)
      .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
      .limit(limit + 1)

    const items = rows.slice(0, limit)
    const last = items[items.length - 1]
    return c.json({
      items: items.map(toMeta),
      next_cursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    })
  })
}

// --- visibility ---------------------------------------------------------------

/** The list-side twin of `can(..., 'viewer', ...)`, expressed as SQL so the
 *  filtering happens in Postgres rather than over a fetched workspace. */
function visibleToUser(deps: Deps, user: User, mineOnly: boolean): SQL | undefined {
  // `mine=true` is "documents I own", so it overrides admin's wider reach.
  if (mineOnly) return eq(artifacts.ownerId, user.id)
  if (user.isAdmin) return undefined

  return or(
    eq(artifacts.ownerId, user.id),
    inArray(artifacts.visibility, ['workspace', 'public']),
    exists(
      deps.db
        .select({ one: sql`1` })
        .from(artifactGrants)
        .where(and(eq(artifactGrants.artifactId, artifacts.id), eq(artifactGrants.userId, user.id))),
    ),
  )
}

// --- pagination ----------------------------------------------------------------

interface Cursor {
  updatedAt: Date
  id: string
}

/** Exactly what `Date.prototype.toISOString` produces — UTC, three fractional
 *  digits — and so exactly what `encodeCursor` mints. A cursor is our own opaque
 *  token, so any other shape is a forgery or a bug, never something to guess at.
 *  Year 0000 is excluded: JS Date parses and round-trips it, but Postgres has no
 *  year zero and raises on the `::timestamptz` cast, which would turn a crafted
 *  cursor into a 500 instead of the 400 an invalid cursor deserves. */
const ISO_MS_RE = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Keyset pagination, not OFFSET: the page after this one is defined by the row
 * the caller last saw, so an artifact updated mid-scroll cannot make another one
 * appear twice or vanish.
 *
 * The timestamp travels at millisecond precision because that is all a JS Date
 * holds. The columns are `timestamptz(3)` for the same reason (migration 0001),
 * so the value here is the whole stored value — if the column were ever widened
 * back to microseconds, a row microseconds older than the page boundary would
 * fall outside this filter and never be served.
 */
function encodeCursor(row: ArtifactMeta): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString('base64url')
}

function parseCursor(raw: string | undefined): Cursor | null | typeof INVALID {
  if (raw === undefined || raw === '') return null

  const decoded = Buffer.from(raw, 'base64url').toString()
  const sep = decoded.indexOf('|')
  if (sep === -1) return INVALID

  const time = decoded.slice(0, sep)
  const id = decoded.slice(sep + 1)
  if (!UUID_RE.test(id)) return INVALID

  // Three checks, none redundant. `new Date` alone is far too generous — it
  // reads "0" as the year 2000 and "2024-02-31" as the 2nd of March — and the
  // string was on its way into a `::timestamptz` cast that Postgres would raise
  // on, turning a crafted query string into a 500. The round-trip is what
  // rejects a date that parses but is not the date it claims to be.
  if (!ISO_MS_RE.test(time)) return INVALID
  const updatedAt = new Date(time)
  if (Number.isNaN(updatedAt.getTime())) return INVALID
  if (updatedAt.toISOString() !== time) return INVALID

  return { updatedAt, id }
}

function cursorFilter(cursor: Cursor | null): SQL | undefined {
  if (cursor === null) return undefined
  // A row comparison, so the (updated_at, id) tiebreak in the ORDER BY and the
  // page boundary are the same rule — two separate comparisons would drop rows
  // that share a timestamp.
  //
  // The bound value is re-serialized from the parsed Date, never the caller's
  // text, so the only thing that can reach the database is a string this process
  // produced itself.
  return sql`(${artifacts.updatedAt}, ${artifacts.id}) < (${cursor.updatedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
}

/** Anything unusable falls back to the default rather than failing the request:
 *  a page size is a hint, and refusing `?limit=lots` helps nobody. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

// --- serialization -------------------------------------------------------------

function toMeta(a: ArtifactMeta) {
  return {
    id: a.id,
    name: a.name,
    visibility: a.visibility,
    version: a.version,
    body_bytes: a.bodyBytes,
    content_hash: a.contentHash.toString('hex'),
    owner_id: a.ownerId,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  }
}

// --- request parsing -----------------------------------------------------------

/** An absent body reads as `{}`: every field on these routes is optional, so
 *  "create with all the defaults" is a legitimate bodyless POST. Malformed JSON
 *  is still refused — that is a caller bug, not a default. */
async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | typeof INVALID> {
  const raw = await c.req.text()
  if (raw.trim() === '') return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return INVALID
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return INVALID
  return parsed as Record<string, unknown>
}

/** Absent and `null` both mean "no name". A blank string is read as clearing it
 *  rather than stored, so an empty title never reaches a link preview (§5.8). */
function parseName(raw: unknown): string | null | typeof INVALID {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return INVALID
  const name = raw.trim()
  if (name === '') return null
  return name.length > MAX_NAME_LENGTH ? INVALID : name
}

/** Absent means "leave it to the default" on create; the PATCH handler treats
 *  that same `null` as invalid, since clearing a visibility is meaningless. */
function parseVisibility(raw: unknown): Visibility | null | typeof INVALID {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return INVALID
  return (VISIBILITIES as readonly string[]).includes(raw) ? (raw as Visibility) : INVALID
}

// --- responses -----------------------------------------------------------------

const notFound = (c: Context<AppEnv>) => c.json({ error: 'not found' }, 404)
const forbidden = (c: Context<AppEnv>) => c.json({ error: 'forbidden' }, 403)
const nameError = () => `name must be a string of at most ${MAX_NAME_LENGTH} characters`
const visibilityError = () => `visibility must be one of ${VISIBILITIES.join(', ')}`
