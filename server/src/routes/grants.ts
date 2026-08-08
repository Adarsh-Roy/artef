// Sharing (spec §5.3) — the three endpoints behind the share dialog, and the
// feature the product is sold on. Three things run through the file:
//
//   - only an owner or an admin may change who can reach a document. Everyone
//     else gets the usual split: 403 if they can already see it, 404 if they
//     cannot (§2.3), so a grant list never confirms that an id is real.
//   - a grant may name a colleague who has never logged in. The user row is
//     pre-provisioned, which makes this the only place besides the login flow
//     that decides which workspace an email address belongs to (§4.3).
//   - cross-workspace grants do not exist. Whether the address resolves to
//     another company, to a consumer mailbox, or to a user row that already
//     lives elsewhere, the answer is the same 422.
import { and, asc, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { artifactGrants, users, workspaces } from '../db/schema.js'
import { can, type Role } from '../lib/acl.js'
import { CONSUMER_DOMAINS } from '../lib/consumer-domains.js'
import { getArtifactWithGrant, isOwnerOrAdmin, UUID_RE, type ArtifactMeta } from './artifacts.js'

const ROLES = ['viewer', 'editor'] as const
/** RFC 5321's ceiling on a whole address. */
const MAX_EMAIL_LENGTH = 320

type User = typeof users.$inferSelect

/** Marks a field that was present but unusable, which `null` cannot. */
const INVALID = Symbol('invalid')

/** The artifact a caller is allowed to share, or the response explaining why
 *  they are not. */
type Gate = { ok: true; art: ArtifactMeta; user: User } | { ok: false; res: Response }

export function registerGrantRoutes(app: Hono<AppEnv>, deps: Deps): void {
  // ---------------------------------------------------------------------
  // Who this is shared with. Owner and admin only: the list is a roster of
  // colleagues, and a grantee has no business reading the rest of it.
  // ---------------------------------------------------------------------
  app.get('/api/artifacts/:id/grants', async c => {
    const gate = await requireSharer(deps, c)
    if (!gate.ok) return gate.res

    const rows = await deps.db
      .select({
        userId: artifactGrants.userId,
        email: users.email,
        name: users.name,
        role: artifactGrants.role,
        createdAt: artifactGrants.createdAt,
      })
      .from(artifactGrants)
      .innerJoin(users, eq(users.id, artifactGrants.userId))
      .where(eq(artifactGrants.artifactId, gate.art.id))
      // Oldest first, so a person added while the dialog is open appears at the
      // bottom rather than shuffling the names already on screen.
      .orderBy(asc(artifactGrants.createdAt), asc(users.email))

    return c.json(
      rows.map(r => ({
        user_id: r.userId,
        email: r.email,
        name: r.name,
        role: r.role,
        created_at: r.createdAt.toISOString(),
      })),
    )
  })

  // ---------------------------------------------------------------------
  // Add someone, or change the role of someone already added — one endpoint,
  // because the dialog's role dropdown is the same gesture as its email field.
  // ---------------------------------------------------------------------
  app.post('/api/artifacts/:id/grants', async c => {
    const gate = await requireSharer(deps, c)
    if (!gate.ok) return gate.res
    const { art, user } = gate

    const body = await readJsonObject(c)
    if (body === INVALID) return c.json({ error: 'expected a JSON object' }, 400)

    // Both fields are validated before anything is looked up or created: a
    // malformed role must not leave a pre-provisioned user row behind.
    const email = parseEmail(body.email)
    if (email === INVALID) return c.json({ error: emailError() }, 400)
    const role = parseRole(body.role)
    if (role === INVALID) return c.json({ error: roleError() }, 422)

    const grantee = await resolveGrantee(deps, art, email)
    if ('error' in grantee) return c.json({ error: grantee.error }, 422)
    // The owner's access does not come from a grant row and cannot be reduced
    // by one, so accepting this would be writing a lie into the dialog.
    if (grantee.user.id === art.ownerId) {
      return c.json({ error: 'this person owns the document and already has full access' }, 422)
    }

    // Read before write, so the answer distinguishes "added" from "changed".
    // A racing second request turns one of the two 201s into a 200 the client
    // never sees a difference from — both end with the row it asked for.
    const [before] = await deps.db
      .select({ role: artifactGrants.role })
      .from(artifactGrants)
      .where(
        and(eq(artifactGrants.artifactId, art.id), eq(artifactGrants.userId, grantee.user.id)),
      )
      .limit(1)

    await deps.db
      .insert(artifactGrants)
      .values({ artifactId: art.id, userId: grantee.user.id, role, grantedBy: user.id })
      // `granted_by` is not touched on the update: it records who let this
      // person in, which a later role change does not alter.
      .onConflictDoUpdate({
        target: [artifactGrants.artifactId, artifactGrants.userId],
        set: { role },
      })

    return c.json({ user_id: grantee.user.id, email, role }, before === undefined ? 201 : 200)
  })

  // ---------------------------------------------------------------------
  // Revoke. The user row stays — they are still in the workspace, they just no
  // longer hold this document.
  // ---------------------------------------------------------------------
  app.delete('/api/artifacts/:id/grants/:user_id', async c => {
    const gate = await requireSharer(deps, c)
    if (!gate.ok) return gate.res

    const userId = c.req.param('user_id')
    // Not idempotent on purpose: a dialog that reports success for a grant that
    // was never there is a dialog that hides a stale list from the person
    // reading it. An id that is not a uuid cannot match a row, and letting
    // Postgres try the cast would turn a typo into a 500.
    if (!UUID_RE.test(userId)) return grantNotFound(c)

    const deleted = await deps.db
      .delete(artifactGrants)
      .where(and(eq(artifactGrants.artifactId, gate.art.id), eq(artifactGrants.userId, userId)))
      .returning({ userId: artifactGrants.userId })
    if (deleted.length === 0) return grantNotFound(c)

    return c.body(null, 204)
  })
}

// --- authorization ---------------------------------------------------------

/**
 * The one permission check all three endpoints share (spec §5.9): sharing is an
 * ownership decision, never an editing one — an editor grant says "help me
 * write this", not "hand it to whoever you like".
 */
async function requireSharer(deps: Deps, c: Context<AppEnv>): Promise<Gate> {
  const user = c.get('user')
  if (user === null) return { ok: false, res: c.json({ error: 'unauthorized' }, 401) }

  const found = await getArtifactWithGrant(deps, c.req.param('id') ?? '', user)
  if (found === null || !can(user, found.art, 'viewer', found.grantRole)) {
    return { ok: false, res: c.json({ error: 'not found' }, 404) }
  }
  // They can already see it, so 403 gives away nothing a `GET` has not.
  if (!isOwnerOrAdmin(user, found.art)) {
    return { ok: false, res: c.json({ error: 'forbidden' }, 403) }
  }
  return { ok: true, art: found.art, user }
}

// --- the grantee -----------------------------------------------------------

/**
 * The user row this grant names, creating it if the address has never logged in
 * (spec §5.3): a document can be shared with a colleague before their first
 * visit, because the row a login would have created is created here instead.
 *
 * The domain rules are the login flow's, in the same order (§4.3): the
 * blocklist applies to the address as written, *before* WORKSPACE_DOMAIN_MAP
 * rewrites it, so a `gmail.com=company.com` map entry cannot be used as a door
 * into a real workspace. What the map cannot do here that it does at login is
 * widen the answer — the resolved domain must be this artifact's workspace and
 * no other, because a cross-workspace grant is not a thing that exists.
 */
async function resolveGrantee(
  deps: Deps,
  art: ArtifactMeta,
  email: string,
): Promise<{ user: { id: string } } | { error: string }> {
  // The common case is a colleague who already logged in once, and it costs one
  // query: the workspace domain is only needed to refuse, or to create.
  const [existing] = await deps.db
    .select({ id: users.id, workspaceId: users.workspaceId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (existing !== undefined && existing.workspaceId === art.workspaceId) return { user: existing }

  const domain = await workspaceDomain(deps, art.workspaceId)
  if (existing !== undefined) return { error: outsiderError(email, domain) }

  const claimed = email.slice(email.lastIndexOf('@') + 1)
  if (CONSUMER_DOMAINS.has(claimed)) {
    return {
      error: `'${claimed}' is a personal email domain, so it can never be part of ${workspaceLabel(domain)}`,
    }
  }
  const resolved = deps.cfg.workspaceDomainMap[claimed] ?? claimed
  if (resolved !== domain) return { error: outsiderError(email, domain) }

  const [created] = await deps.db
    .insert(users)
    .values({
      workspaceId: art.workspaceId,
      email,
      name: null,
      // Never by this route. Admin is decided by the first login into a
      // workspace or by ADMIN_EMAILS (§4.2), and a share dialog must not be a
      // third way in.
      isAdmin: false,
      // Null, not now: they have not been here. It is what tells an operator
      // that this row is an invitation rather than a member.
      lastSeenAt: null,
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id, workspaceId: users.workspaceId })
  if (created !== undefined) return { user: created }

  // Someone else created the row between the select and the insert — a first
  // login, or the same dialog clicked twice. Their row is the one that counts,
  // and it still has to be in this workspace.
  const [raced] = await deps.db
    .select({ id: users.id, workspaceId: users.workspaceId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (raced === undefined || raced.workspaceId !== art.workspaceId) {
    return { error: outsiderError(email, domain) }
  }
  return { user: raced }
}

/** The artifact's workspace domain — the only domain a grant may name. */
async function workspaceDomain(deps: Deps, workspaceId: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ domain: workspaces.domain })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return row?.domain ?? null
}

// --- request parsing -------------------------------------------------------

/** A body is required here — every field on these routes is — so an empty one
 *  is a caller mistake rather than "all the defaults". */
async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | typeof INVALID> {
  const raw = await c.req.text()
  if (raw.trim() === '') return INVALID

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return INVALID
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return INVALID
  return parsed as Record<string, unknown>
}

/**
 * Lowercased, because `Priya@Example.com` and `priya@example.com` are one
 * person and two grant rows would be a bug you only notice when you try to
 * revoke one of them. Deliberately not a full RFC 5322 validator: the only
 * thing this has to guarantee is that the domain half is unambiguous, since the
 * next step decides a workspace from it.
 */
function parseEmail(raw: unknown): string | typeof INVALID {
  if (typeof raw !== 'string') return INVALID
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return INVALID
  // Exactly one `@`, and something on each side of it, with no whitespace.
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : INVALID
}

/** Two roles, and there is no third (§5.9). An absent role is invalid rather
 *  than defaulted: the dialog always sends one, so a missing one is a client
 *  bug worth surfacing. */
function parseRole(raw: unknown): Role | typeof INVALID {
  return typeof raw === 'string' && (ROLES as readonly string[]).includes(raw)
    ? (raw as Role)
    : INVALID
}

// --- responses -------------------------------------------------------------

const grantNotFound = (c: Context<AppEnv>) => c.json({ error: 'grant not found' }, 404)

/** A foreign key guarantees the workspace row exists, so `null` is unreachable
 *  — it is here only so a refusal never reads "the null workspace". */
const workspaceLabel = (domain: string | null) =>
  domain === null ? "this document's workspace" : `the ${domain} workspace`

const outsiderError = (email: string, domain: string | null) =>
  `${email} is not in ${workspaceLabel(domain)}, and a document can only be shared inside its own workspace`

const emailError = () => 'email must be an email address'
const roleError = () => `role must be one of ${ROLES.join(', ')}`
