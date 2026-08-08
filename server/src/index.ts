// Boot: read the environment, migrate, serve. Migrations run here rather than
// in a separate step so `docker compose up` is the whole install (spec §10).
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db/client.js'

const cfg = loadConfig(process.env)
const { db, pool } = createDb(cfg.databaseUrl)
await runMigrations(pool)

serve({ fetch: createApp({ cfg, db, pool }).fetch, port: cfg.port })
console.log(`artef listening on port ${cfg.port} — ${cfg.url}`)
