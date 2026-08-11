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
import type { Notifier } from './notify.js'
import { registerArtifactRoutes } from './routes/artifacts.js'
import { registerAssetRoutes } from './routes/assets.js'
import { registerCliAuthRoutes } from './routes/cliauth.js'
import { registerContentRoutes } from './routes/content.js'
import { registerEventRoutes } from './routes/events.js'
import { registerGrantRoutes } from './routes/grants.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerTokenRoutes } from './routes/tokens.js'
import { registerUserRoutes } from './routes/users.js'
import { registerViewerRoutes } from './viewer/routes.js'

export interface Deps {
  cfg: Config
  db: NodePgDatabase<typeof schema>
  pool: pg.Pool
  /** Live-update fan-out (spec §5.5). `index.ts` always creates one; a test
   *  that does not care about updates leaves it out and the events route 503s. */
  notifier?: Notifier
  /** Wall clock, injectable so time-windowed behaviour (the write rate limit)
   *  can be tested without sleeping. Defaults to `Date.now`. */
  now?: () => number
  /** How often an idle SSE stream sends its keepalive comment. Injectable for
   *  the same reason as the clock — a test cannot wait 30 seconds. */
  keepaliveMs?: number
}

/** Request-scoped identity, set by the auth middleware and read by every route. */
export type AppEnv = {
  Variables: {
    user: typeof users.$inferSelect | null
    authKind: 'session' | 'bearer' | null
    tokenScopeIds: string[] | null
    /** The machine token this request arrived on, or null for a browser
     *  session — the rate limiter meters an agent, not the person who owns it. */
    tokenId: string | null
  }
}

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', sessionMiddleware(deps))
  // Scoped to the two doors agents come through — /api, where the spec draws
  // the bearer line (§5), and /mcp, which is the same credential over a
  // different protocol (§7.0). A dead token must not shut a caller out of
  // everything else: /_health has to answer for the database alone (§10), and
  // /auth/* is where a client whose token just died goes to get a new one.
  //
  // Order is load-bearing: bearer runs after the session so a token wins over a
  // stray cookie, and before the origin check so `authKind` is already 'bearer'
  // when that check decides whether an Origin header is required.
  app.use('/api/*', bearerMiddleware(deps))
  app.use('/mcp', bearerMiddleware(deps))
  // Mounted before any route so it also covers /api paths that do not exist
  // yet — a state-changing request must never reach a handler unchecked.
  //
  // /mcp is not under it and does not need to be: the route refuses anything
  // that did not arrive on a bearer token, and this check exempts those by
  // design — nothing in a browser can make it attach a token it does not have.
  app.use('/api/*', originCheck(deps.cfg))

  // A path that matches no route is an error like any other, so it answers in
  // the same shape. Hono's default is plain text, which a client that parses
  // every response as JSON reports as a parse failure rather than a 404.
  app.notFound(c => c.json({ error: 'not found' }, 404))

  // Every error body on this API is `{ "error": ... }`, and an unexpected throw
  // must not be the one exception — Hono's default 500 is plain text, which a
  // client parsing JSON reports as a parse failure instead of a server error.
  // The real error goes to the log; the caller gets nothing but the fact.
  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  registerAuthRoutes(app, deps)
  registerTokenRoutes(app, deps)
  // The other way to get a machine token (§7.2): a browser flow instead of an
  // API call, because the CLI has no credential yet and is the thing asking.
  registerCliAuthRoutes(app, deps)
  // After the artifact routes, which is what puts the content endpoints behind
  // the `/api/artifacts/:id/*` token-scope middleware registered there — hono
  // runs middleware in registration order, so a route registered first would
  // never see it.
  registerArtifactRoutes(app, deps)
  registerContentRoutes(app, deps)
  registerEventRoutes(app, deps)
  registerGrantRoutes(app, deps)
  // Next to the grants, because it backs the same dialog: the field that writes
  // a grant row is the field this suggests colleagues into (§5.9).
  registerUserRoutes(app, deps)
  registerAssetRoutes(app, deps)
  // The MCP tools are adapters: each one dispatches back into this same app
  // over `app.request` (§7.0). That works from anywhere in this list — a tool
  // only runs long after `createApp` has returned and registered everything —
  // but it is written after the routes it calls because that is the order it
  // reads in. What does matter is that it comes before the viewer below, whose
  // `GET /:id` would otherwise be asked about `/mcp` first.
  registerMcpRoutes(app, deps)
  // Last, because `GET /:id` matches any single path segment. It hands anything
  // that is not shaped like an artifact id straight on to the next handler, so
  // registration order is not what keeps /_health working — but a route that
  // greedy still belongs at the bottom of the file.
  registerViewerRoutes(app, deps)

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
