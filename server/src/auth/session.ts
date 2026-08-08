// The browser half of authentication: a signed cookie holding nothing but a
// user id and an expiry (spec §4.1). There is no server-side session store —
// the signature is the storage.
import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'
import type { AppEnv, Deps } from '../app.js'
import { users } from '../db/schema.js'
import { signSession, verifySession } from '../lib/crypto.js'

/** `__Host-` means browsers reject the cookie if it carries a Domain, so no
 *  sibling subdomain can shadow the real session (spec §2.2). */
export const SESSION_COOKIE = '__Host-session'
export const SESSION_TTL_DAYS = 30

// Path=/, Secure and no Domain are what the `__Host-` prefix requires; hono's
// serializer refuses to build the cookie without them.
const FLAGS = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const

/** The full `Set-Cookie` value for a fresh session. */
export function buildSessionCookie(uid: string, secret: string, maxAgeDays = SESSION_TTL_DAYS): string {
  const maxAge = maxAgeDays * 86400
  const exp = Math.floor(Date.now() / 1000) + maxAge
  return serialize(SESSION_COOKIE, signSession({ uid, exp }, secret), { ...FLAGS, maxAge })
}

/** The `Set-Cookie` value that ends a session. */
export function clearSessionCookie(): string {
  return serialize(SESSION_COOKIE, '', { ...FLAGS, maxAge: 0 })
}

/**
 * Resolves the browser's identity. Every request gets `user`, `authKind` and
 * `tokenScopeIds` set, so downstream handlers never see `undefined`; an absent,
 * malformed, expired or forged cookie all land on the same answer, `null`.
 */
export function sessionMiddleware(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', null)
    c.set('authKind', null)
    c.set('tokenScopeIds', null)

    // getCookie returns undefined when the header is absent, and verifySession
    // takes a string — so the guard belongs here, before the call.
    const raw = getCookie(c, SESSION_COOKIE)
    if (!raw) return next()

    const session = verifySession(raw, deps.cfg.secretKey)
    if (session === null) return next()

    // A deleted user's cookie stays well-signed until it expires, so this row
    // lookup is what actually revokes access.
    const [user] = await deps.db.select().from(users).where(eq(users.id, session.uid)).limit(1)
    if (user === undefined) return next()

    c.set('user', user)
    c.set('authKind', 'session')
    return next()
  }
}
