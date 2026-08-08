// The agent half of authentication (spec §5.6). A machine token is a bearer
// credential: whoever presents it is the user it was minted for. Only the
// sha256 of the token is stored, so the lookup is by hash and the database does
// the comparison — the plaintext exists on the wire and nowhere else.
import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { machineTokens, users } from '../db/schema.js'
import { hashToken } from '../lib/crypto.js'

/** How stale `last_used_at` may get before a request pays for a write. */
const LAST_USED_REFRESH_MS = 60_000

/**
 * Resolves an agent's identity. A request with no bearer credential passes
 * straight through, leaving whatever the session middleware decided; a request
 * that presents one is answered by the token alone — a valid token wins over a
 * cookie sent alongside it, and a bad token ends the request at 401 rather than
 * quietly continuing as somebody else.
 */
export function bearerMiddleware(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const presented = bearerCredential(c.req.header('Authorization'))
    if (presented === null) return next()

    const [found] = await deps.db
      .select({ token: machineTokens, user: users })
      .from(machineTokens)
      .innerJoin(users, eq(users.id, machineTokens.userId))
      .where(eq(machineTokens.tokenHash, hashToken(presented)))
      .limit(1)

    // Unknown, revoked and expired are one answer on the wire: whoever holds a
    // dead token learns nothing from us about why it is dead.
    if (found === undefined) return c.json({ error: 'invalid token' }, 401)
    const { token, user } = found
    if (token.expiresAt !== null && token.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: 'invalid token' }, 401)
    }

    c.set('user', user)
    c.set('authKind', 'bearer')
    // NULL means the token covers the whole workspace (spec §3). Enforcing the
    // scope is the artifact routes' job; carrying it is this middleware's.
    c.set('tokenScopeIds', token.scopeIds)

    await touchLastUsed(deps, token)
    return next()
  }
}

/** The credential from an `Authorization: Bearer …` header, or null if the
 *  request presented no bearer credential at all. */
function bearerCredential(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer +(.*)$/i.exec(header)
  if (match === null) return null
  const token = match[1].trim()
  return token === '' ? null : token
}

/** Keeps `last_used_at` roughly current without turning every agent request
 *  into a write — the timestamp is read by people, at minute resolution. */
async function touchLastUsed(deps: Deps, token: typeof machineTokens.$inferSelect): Promise<void> {
  const now = Date.now()
  if (token.lastUsedAt !== null && now - token.lastUsedAt.getTime() < LAST_USED_REFRESH_MS) return
  await deps.db
    .update(machineTokens)
    .set({ lastUsedAt: new Date(now) })
    .where(eq(machineTokens.id, token.id))
}
