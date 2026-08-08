import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import * as schema from './schema.js'

// Invariant: this must resolve the same `server/drizzle` folder whether the file
// runs from `server/src/db/` (tsx, vitest) or from `server/dist/src/db/` (after
// tsc). A fixed number of `..` segments cannot do that, because the two paths sit
// at different depths and nothing copies `drizzle/` into `dist/`. Walking up to
// the nearest package.json finds the package root from either location.
// fileURLToPath, not URL.pathname — pathname stays percent-encoded, so a path
// containing a space or a non-ASCII character would resolve to the wrong folder.
function findMigrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`Cannot locate the server package root above ${dir}`)
    dir = parent
  }
  return join(dir, 'drizzle')
}

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  return { db: drizzle(pool, { schema }), pool }
}

export async function runMigrations(pool: pg.Pool) {
  await migrate(drizzle(pool), { migrationsFolder: findMigrationsFolder() })
}
