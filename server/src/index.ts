// Boot: read the environment, migrate, serve. Migrations run here rather than
// in a separate step so `docker compose up` is the whole install (spec §10).
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db/client.js'
import { createNotifier } from './notify.js'

const cfg = loadConfig(process.env)
const { db, pool } = createDb(cfg.databaseUrl)
await runMigrations(pool)

// One dedicated connection for the whole process, awaited here so a database
// that will not take a `LISTEN` is a boot failure rather than a server that
// serves pages and silently never updates them (spec §5.5).
const notifier = await createNotifier(cfg.databaseUrl)

const server = serve({ fetch: createApp({ cfg, db, pool, notifier }).fetch, port: cfg.port })
console.log(`artef listening on port ${cfg.port} — ${cfg.url}`)

// The listening socket stops first, then the two things holding database
// connections. Open SSE streams are deliberately not waited for: they stay open
// for hours by design, so draining them would mean sitting out the container's
// whole stop timeout and being killed anyway.
let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  server.close()
  await notifier.close()
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
