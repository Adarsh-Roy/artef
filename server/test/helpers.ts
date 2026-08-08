// Shared test fixtures. Every server test builds its world from here: one
// memoized pool (migrated once), a Config that never reads process.env, and
// row-level factories that bypass the HTTP layer.
import type pg from 'pg'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { Config } from '../src/config.js'
import { createDb, runMigrations } from '../src/db/client.js'
import { machineTokens, users, workspaces } from '../src/db/schema.js'
import { generateMachineToken, sha256Hex, signSession } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { createApp, type AppEnv, type Deps } from '../src/app.js'
import { SESSION_COOKIE, SESSION_TTL_DAYS } from '../src/auth/session.js'

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://artef:artef@localhost:5433/artef'

// 32 chars — loadConfig's minimum, so a test config is a config the server
// would actually accept.
export const TEST_SECRET = 'test-secret-0123456789abcdefghij'

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: 'https://artef.test',
    secretKey: TEST_SECRET,
    databaseUrl: TEST_DATABASE_URL,
    allowedDomains: ['example.com'],
    adminEmails: [],
    maxArtifactBytes: 10485760,
    maxVersions: 20,
    linkPreview: 'name',
    // One provider by default, so `/auth/login` has an unambiguous target.
    googleClientId: 'test-google-client-id',
    googleClientSecret: 'test-google-client-secret',
    workspaceDomainMap: {},
    forceHttps: true,
    port: 3000,
    ...overrides,
  }
}

// Connecting and migrating costs ~50ms, so it happens once per worker and is
// shared by every test file. The app itself is built fresh per call — nothing
// in `createApp` is module-level, so parallel apps do not interfere.
let connection: Promise<{ db: Deps['db']; pool: pg.Pool }> | undefined

function connect() {
  if (!connection) {
    connection = (async () => {
      const { db, pool } = createDb(TEST_DATABASE_URL)
      await runMigrations(pool)
      return { db, pool }
    })()
  }
  return connection
}

export type TestDeps = Deps & { app: Hono<AppEnv> }

export async function testDeps(
  cfgOverrides: Partial<Config> = {},
  // The clock and the notifier are the two dependencies a test may need to
  // control, so they are passed in rather than reached for.
  extra: Partial<Pick<Deps, 'notifier' | 'now'>> = {},
): Promise<TestDeps> {
  const { db, pool } = await connect()
  const deps: Deps = { cfg: testConfig(cfgOverrides), db, pool, ...extra }
  return { ...deps, app: createApp(deps) }
}

/** Closes the shared pool. Safe to call from any file's `afterAll`: the next
 *  `testDeps()` reconnects rather than reusing the closed pool. */
export async function closeDb(): Promise<void> {
  if (connection === undefined) return
  const { pool } = await connection
  connection = undefined
  await pool.end()
}

/** Empties every application table. Drizzle's migration bookkeeping lives in
 *  the `drizzle` schema, so truncating `public` never undoes the migration. */
export async function resetDb(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  )
  if (rows.length === 0) return
  const tables = rows.map(r => `public."${r.table_name}"`).join(', ')
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`)
}

/** The `Cookie:` request header value for a signed, unexpired session. */
export function sessionCookie(userId: string, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86400
  return `${SESSION_COOKIE}=${signSession({ uid: userId, exp }, secret)}`
}

let userSeq = 0

export async function makeUser(
  deps: Deps,
  opts: { email?: string; isAdmin?: boolean; domain?: string } = {},
): Promise<{
  user: typeof users.$inferSelect
  workspace: typeof workspaces.$inferSelect
  cookie: string
}> {
  const domain = opts.domain ?? deps.cfg.allowedDomains[0] ?? 'example.com'
  const email = opts.email ?? `user-${++userSeq}@${domain}`

  const inserted = await deps.db
    .insert(workspaces)
    .values({ domain })
    .onConflictDoNothing({ target: workspaces.domain })
    .returning()
  const workspace =
    inserted[0] ??
    (await deps.db.select().from(workspaces).where(eq(workspaces.domain, domain)).limit(1))[0]

  const [user] = await deps.db
    .insert(users)
    .values({
      workspaceId: workspace.id,
      email,
      name: email.split('@')[0],
      isAdmin: opts.isAdmin ?? false,
    })
    .returning()

  return { user, workspace, cookie: sessionCookie(user.id, deps.cfg.secretKey) }
}

let tokenSeq = 0

/**
 * A machine token written straight to the table, so a test can authenticate as
 * an agent without going through `POST /api/tokens` first. The plaintext token
 * only exists here — the row keeps its hash, exactly as the real route does.
 */
export async function makeMachineToken(
  deps: Deps,
  userId: string,
  opts: { name?: string; scopeIds?: string[] | null; expiresAt?: Date | null } = {},
): Promise<{
  token: string
  row: typeof machineTokens.$inferSelect
  header: { Authorization: string }
}> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1)
  const { token, hash, prefix } = generateMachineToken()

  const [row] = await deps.db
    .insert(machineTokens)
    .values({
      workspaceId: user.workspaceId,
      userId,
      name: opts.name ?? `token-${++tokenSeq}`,
      tokenHash: hash,
      prefix,
      scopeIds: opts.scopeIds ?? null,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning()

  return { token, row, header: { Authorization: `Bearer ${token}` } }
}

/**
 * A `PUT .../content` shaped exactly the way the CLI shapes it (spec §5.2): the
 * body gzipped, and `If-None-Match` carrying the sha256 of the *uncompressed*
 * bytes. `headers` is applied last, so a test can override or blank out any of
 * it — an empty `If-None-Match` reads as no header at all.
 */
export async function pushHtml(
  deps: TestDeps,
  auth: Record<string, string>,
  id: string,
  html: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return deps.app.request(`/api/artifacts/${id}/content`, {
    method: 'PUT',
    headers: {
      ...auth,
      'Content-Encoding': 'gzip',
      'If-None-Match': `"${sha256Hex(html)}"`,
      ...headers,
    },
    body: new Uint8Array(gzipBuf(html)),
  })
}
