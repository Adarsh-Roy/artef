// The composition root. Everything the app can do is registered here, against
// dependencies passed in — nothing is read from the environment and nothing is
// held at module level, so a test can stand up as many independent apps as it
// likes.
import { Hono } from 'hono'
import type pg from 'pg'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Config } from './config.js'
import type * as schema from './db/schema.js'
import type { users } from './db/schema.js'
import { bearerMiddleware } from './auth/bearer.js'
import { registerAuthRoutes } from './auth/oidc.js'
import { originCheck } from './auth/origin.js'
import { sessionMiddleware } from './auth/session.js'
import { registerTokenRoutes } from './routes/tokens.js'

/** Live-update fan-out (spec §5.5). Optional until the SSE milestone builds it. */
export interface Notifier {
  publish(artifactId: string): void | Promise<void>
}

export interface Deps {
  cfg: Config
  db: NodePgDatabase<typeof schema>
  pool: pg.Pool
  notifier?: Notifier
}

/** Request-scoped identity, set by the auth middleware and read by every route. */
export type AppEnv = {
  Variables: {
    user: typeof users.$inferSelect | null
    authKind: 'session' | 'bearer' | null
    tokenScopeIds: string[] | null
  }
}

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', sessionMiddleware(deps))
  // Scoped to /api because that is where the spec draws the bearer line (§5),
  // and a dead token must not shut a caller out of everything else: /_health has
  // to answer for the database alone (§10), and /auth/* is where a client whose
  // token just died goes to get a new one.
  //
  // Order is load-bearing: bearer runs after the session so a token wins over a
  // stray cookie, and before the origin check so `authKind` is already 'bearer'
  // when that check decides whether an Origin header is required.
  app.use('/api/*', bearerMiddleware(deps))
  // Mounted before any route so it also covers /api paths that do not exist
  // yet — a state-changing request must never reach a handler unchecked.
  app.use('/api/*', originCheck(deps.cfg))

  registerAuthRoutes(app, deps)
  registerTokenRoutes(app, deps)

  // Spec §10: 200 exactly when the database is reachable.
  app.get('/_health', async c => {
    try {
      await deps.pool.query('SELECT 1')
      return c.json({ ok: true })
    } catch {
      return c.json({ ok: false }, 503)
    }
  })

  return app
}
