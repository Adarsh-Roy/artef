import { describe, it, expect } from 'vitest'
import { createDb, runMigrations } from '../src/db/client.js'

describe('schema', () => {
  it('migrates from scratch and has all tables', async () => {
    const { pool } = createDb(process.env.DATABASE_URL ?? 'postgres://artef:artef@localhost:5433/artef')
    await runMigrations(pool)
    const r = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
    const names = r.rows.map((x: any) => x.table_name)
    for (const t of ['workspaces','users','artifacts','artifact_grants','artifact_versions','assets','machine_tokens'])
      expect(names).toContain(t)
    // Postgres reports extension base types as data_type 'USER-DEFINED'; the
    // actual type name is in udt_name.
    const col = await pool.query(`SELECT udt_name FROM information_schema.columns WHERE table_name='users' AND column_name='email'`)
    expect(col.rows[0].udt_name).toBe('citext')
    // Bodies are already gzipped, so Postgres must not re-compress them (spec §3.1).
    const storage = await pool.query(`
      SELECT c.relname, a.attstorage FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname IN ('artifacts','artifact_versions','assets') AND a.attname = 'body'`)
    expect(storage.rows.map((x: any) => x.attstorage)).toEqual(['e', 'e', 'e'])
    // `GET /assets/:sha` is unauthenticated (§5.4), so it has no workspace to
    // filter on and matches by hash alone — which the (workspace_id, sha256)
    // primary key cannot answer. Without this index every image request in
    // every artifact view scans the assets table.
    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='assets'`,
    )
    expect(idx.rows.map((x: any) => x.indexname)).toContain('assets_sha256_idx')
    await pool.end()
  })
})
