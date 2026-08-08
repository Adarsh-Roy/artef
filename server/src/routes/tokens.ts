// Machine tokens (spec §5.6): the credential agents and the CLI authenticate
// with. The plaintext token is returned by the mint route and never again —
// the row keeps only its sha256 and a short display prefix, so the answer to a
// lost token is to revoke it and mint another.
import { and, desc, eq, or } from 'drizzle-orm'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { machineTokens } from '../db/schema.js'
import { generateMachineToken } from '../lib/crypto.js'

const MAX_NAME_LENGTH = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Marks a field that was present but unusable, which `null` cannot: for every
 *  field here, absent is a meaningful and valid answer. */
const INVALID = Symbol('invalid')

/**
 * These routes take a browser session and nothing else. A machine token able to
 * mint machine tokens would make a single leak permanent — revoking the leaked
 * token would leave its offspring alive — so an agent is refused here even for
 * its own token (spec §5.6).
 */
const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const kind = c.get('authKind')
  if (kind === 'session') return next()
  return c.json({ error: kind === 'bearer' ? 'session required' : 'unauthorized' }, 401)
}

export function registerTokenRoutes(app: Hono<AppEnv>, deps: Deps): void {
  app.post('/api/tokens', sessionOnly, async c => {
    const user = c.get('user')! // sessionOnly ran: there is a user.
    const body = await readJsonObject(c)
    if (body === null) return c.json({ error: 'expected a JSON object' }, 400)

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '') return c.json({ error: 'name is required' }, 400)
    if (name.length > MAX_NAME_LENGTH) {
      return c.json({ error: `name must be at most ${MAX_NAME_LENGTH} characters` }, 400)
    }

    const scopeIds = parseScopeIds(body.scope_ids)
    if (scopeIds === INVALID) {
      return c.json({ error: 'scope_ids must be a non-empty array of artifact ids' }, 400)
    }

    const expiresAt = parseExpiresAt(body.expires_at)
    if (expiresAt === INVALID) {
      return c.json({ error: 'expires_at must be an ISO-8601 timestamp in the future' }, 400)
    }

    const { token, hash, prefix } = generateMachineToken()
    const [row] = await deps.db
      .insert(machineTokens)
      .values({
        workspaceId: user.workspaceId,
        userId: user.id,
        name,
        tokenHash: hash,
        prefix,
        scopeIds,
        expiresAt,
      })
      .returning({ id: machineTokens.id })

    // The one and only time the plaintext token is ever sent anywhere.
    return c.json({ id: row.id, token, prefix }, 201)
  })

  app.get('/api/tokens', sessionOnly, async c => {
    const user = c.get('user')!
    // Columns are listed rather than selected wholesale: `token_hash` has no
    // business leaving the database, and this is the route that would leak it.
    const rows = await deps.db
      .select({
        id: machineTokens.id,
        name: machineTokens.name,
        prefix: machineTokens.prefix,
        scopeIds: machineTokens.scopeIds,
        expiresAt: machineTokens.expiresAt,
        lastUsedAt: machineTokens.lastUsedAt,
        createdAt: machineTokens.createdAt,
      })
      .from(machineTokens)
      // Own tokens only, admin or not — this list is "your credentials", and
      // an admin who needs to revoke someone else's can do it by id.
      .where(eq(machineTokens.userId, user.id))
      .orderBy(desc(machineTokens.createdAt))

    return c.json(
      rows.map(r => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scope_ids: r.scopeIds,
        expires_at: iso(r.expiresAt),
        last_used_at: iso(r.lastUsedAt),
        created_at: r.createdAt.toISOString(),
      })),
    )
  })

  app.delete('/api/tokens/:id', sessionOnly, async c => {
    const user = c.get('user')!
    const id = c.req.param('id')
    // An id that is not a uuid cannot name a row, and Postgres would raise
    // rather than compare, so it is answered before the query.
    if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404)

    const mine = eq(machineTokens.userId, user.id)
    // An admin may revoke anybody's token, but only inside their own workspace
    // — admin is a workspace role, not a deployment-wide one (spec §4.2).
    const revocable = user.isAdmin ? or(mine, eq(machineTokens.workspaceId, user.workspaceId)) : mine

    const [deleted] = await deps.db
      .delete(machineTokens)
      .where(and(eq(machineTokens.id, id), revocable))
      .returning({ id: machineTokens.id })

    // Somebody else's token is "not found", not "forbidden": the caller has no
    // business learning that the id exists.
    if (deleted === undefined) return c.json({ error: 'not found' }, 404)
    return c.body(null, 204)
  })
}

// --- request parsing ---------------------------------------------------------

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

/** Absent means the token covers the whole workspace. An empty array is
 *  refused rather than read as that — it much more likely means the caller
 *  meant to scope the token and computed the list wrong. */
function parseScopeIds(raw: unknown): string[] | null | typeof INVALID {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || raw.length === 0) return INVALID
  if (!raw.every(v => typeof v === 'string' && UUID_RE.test(v))) return INVALID
  return raw as string[]
}

/** Absent means the token never expires. A time already past is refused: it
 *  would mint a token that is dead on arrival. */
function parseExpiresAt(raw: unknown): Date | null | typeof INVALID {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return INVALID
  const at = new Date(raw)
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) return INVALID
  return at
}

const iso = (at: Date | null): string | null => at?.toISOString() ?? null
