// People autocomplete (spec §5.3), the one endpoint behind the share dialog's
// email field (§5.9). It answers "who in my workspace starts with these
// letters" and nothing else.
//
// Three properties hold the whole thing up:
//
//   - the answer comes from *our* `users` table, never from an IdP directory.
//     Rows arrive by first login and by grant pre-provisioning, so a fresh
//     deployment suggests nobody and fills in as the team arrives — the price
//     of needing no Directory API, no extra OAuth scope, no setup step (§1.1).
//   - it is scoped to the caller's workspace on every path through the query.
//     Suggesting a name from another company would leak the one boundary the
//     product exists to hold (§4.3).
//   - it is a browser affordance, so it takes a session and refuses a machine
//     token. An agent shares by address; it has no use for a roster, and one
//     leaked token should not become a directory dump (§5.6).
import { and, eq, ilike, ne, or, sql } from 'drizzle-orm'
import type { Hono, MiddlewareHandler } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { users } from '../db/schema.js'

/** §5.3: at most ten. It is a dropdown under a text field, not a people
 *  directory — a longer list is a worse one. */
const MAX_RESULTS = 10
/** RFC 5321's ceiling on a whole address. Longer than that cannot be the
 *  prefix of anything anyone would type, so it is answered without a query. */
const MAX_QUERY_LENGTH = 320

/**
 * The tokens routes' gate (§5.6), for the same reason in a different shape: a
 * machine token is an agent's credential, and enumerating colleagues is not
 * something an agent does. `authKind` is already decided by the bearer
 * middleware, so this only reads it.
 */
const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const kind = c.get('authKind')
  if (kind === 'session') return next()
  return c.json({ error: kind === 'bearer' ? 'session required' : 'unauthorized' }, 401)
}

export function registerUserRoutes(app: Hono<AppEnv>, deps: Deps): void {
  app.get('/api/users/search', sessionOnly, async c => {
    const user = c.get('user')! // sessionOnly ran: there is a user.

    const q = (c.req.query('q') ?? '').trim()
    // No query, no answer. An empty `q` matching everyone would turn a text
    // field's focus event into a printout of the whole workspace.
    if (q === '' || q.length > MAX_QUERY_LENGTH) return c.json([])

    // The value never reaches the SQL text: it is bound as a parameter, and the
    // only thing this builds is the trailing wildcard. LIKE metacharacters
    // inside it are escaped first, so someone typing `%` searches for a per cent
    // sign rather than matching every colleague they have (Postgres's default
    // LIKE escape character is the backslash, which is why it is escaped too).
    const prefix = `${escapeLike(q)}%`
    const limit = parseLimit(c.req.query('limit'))

    /**
     * The order, and it is deliberately dumb: an address typed in full is what
     * the caller meant, so it wins; a name match reads as a person and an email
     * match reads as a string, so names come next; everything else is
     * alphabetical by whatever the dialog will actually display. Email last
     * makes the whole order total — it is unique — so paging never repeats or
     * drops a row.
     */
    const rank = sql<number>`case
      when ${users.email} = ${q} then 0
      when ${users.name} ilike ${prefix} then 1
      else 2 end`
    const display = sql`lower(coalesce(${users.name}, ${users.email}::text))`

    const rows = await deps.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(
        and(
          // The isolation property, first condition in the list and not
          // negotiable: this route can only ever see one workspace.
          eq(users.workspaceId, user.workspaceId),
          // You do not share a document with yourself. The dialog would filter
          // it anyway; it should never have to.
          ne(users.id, user.id),
          or(ilike(users.email, prefix), ilike(users.name, prefix)),
        ),
      )
      .orderBy(rank, display, users.email)
      .limit(limit)

    // The selected columns are the wire shape: an email and a name, and never
    // the id, the admin bit or the last-seen time. A share dialog needs two
    // fields, and every extra one is a fact about a colleague nobody asked for.
    return c.json(rows)
  })
}

/** `%`, `_` and the escape character itself, made literal. One pass, so an
 *  escaped backslash is not then read as escaping what follows it. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, m => `\\${m}`)

/** Ten unless asked for fewer. Anything larger is the cap, and anything that is
 *  not a positive whole number is the default — a client sending `limit=abc`
 *  has a bug, and answering it with nothing would hide that behind an empty
 *  dropdown. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return MAX_RESULTS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return MAX_RESULTS
  return Math.min(n, MAX_RESULTS)
}
