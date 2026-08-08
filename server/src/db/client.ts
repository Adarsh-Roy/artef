import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import * as schema from './schema.js'

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  return { db: drizzle(pool, { schema }), pool }
}

export async function runMigrations(pool: pg.Pool) {
  await migrate(drizzle(pool), { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })
}
