// Spec §2.2, "belt and braces": SameSite=Lax already stops cross-site POSTs in
// every current browser, and this is the second lock on the same door.
import type { MiddlewareHandler } from 'hono'
import type { Config } from '../config.js'
import type { AppEnv } from '../app.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Refuses a state-changing request that carries the session cookie unless it
 * came from this app's own origin. Requests authenticated some other way — an
 * agent's `Authorization: Bearer` — are untouched: nothing in a browser can
 * make the browser attach a bearer token it does not have, so there is no
 * cross-site request to forge.
 */
export function originCheck(cfg: Config): MiddlewareHandler<AppEnv> {
  const expected = new URL(cfg.url).origin
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next()
    if (c.get('authKind') !== 'session') return next()
    // A missing header is `undefined`, which is not `expected` either — an
    // absent Origin on a mutation is exactly the case worth refusing.
    if (c.req.header('Origin') !== expected) {
      return c.json({ error: 'bad origin' }, 403)
    }
    return next()
  }
}
