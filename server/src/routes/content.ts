// The content protocol (spec §5.2) — the hot path. A watching CLI pushes here
// once a minute forever, so the shape of this file is dictated by one number:
// most of those pushes contain a document the server already has.
//
//   - A push whose hash matches what is stored is answered `304` and performs
//     no write at all (§3.2). This is the single biggest thing keeping a live
//     dashboard from churning TOAST chunks all day.
//   - A push that does change the hash writes one version row and prunes to the
//     newest MAX_VERSIONS, so a minute-by-minute document's storage stays flat
//     while a rarely-touched one keeps its whole history (§12.3).
//   - Bytes only ever leave here under the sandbox CSP (§2.2), because a
//     logged-in person who clicks a link to this URL must not run the
//     artifact's scripts on the real app origin.
//
// `304` in answer to a `PUT` bends RFC 9110's conditional-request semantics.
// That is deliberate and recorded in §5.2: the CLI is both ends of this
// contract, and the alternative is a custom header pair saying the same thing
// less legibly.
import { eq, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { artifacts } from '../db/schema.js'
import { can } from '../lib/acl.js'
import { sendStoredBody } from '../lib/blob.js'
import { CONTENT_TOKEN_TTL_SECS, mintContentToken, sha256 } from '../lib/crypto.js'
import { gunzipCapped, gzipBuf, PayloadTooLarge } from '../lib/gzip.js'
import { contentApiHeaders } from '../lib/headers.js'
import { getArtifactWithGrant, type ArtifactMeta } from './artifacts.js'

/** Writes per caller per window, and the window (spec §12.2 — the limit that
 *  pairs with MAX_ARTIFACT_BYTES to stop an agent pushing in a loop). */
const WRITE_LIMIT = 60
const WRITE_WINDOW_MS = 60_000

/** Marks a header that was present but unusable, which `null` cannot. */
const INVALID = Symbol('invalid')

type PutResult =
  | { kind: 'missing' }
  | { kind: 'unchanged' }
  | { kind: 'conflict'; version: number; hash: string }
  | { kind: 'written'; version: number }

export function registerContentRoutes(app: Hono<AppEnv>, deps: Deps): void {
  const allowWrite = createWriteLimiter(deps.now ?? Date.now)

  // One handler for both methods, because hono's router answers a HEAD from the
  // GET route on a parameterized path — a separately registered HEAD handler
  // would silently never run.
  app.on(['GET', 'HEAD'], '/api/artifacts/:id/content', async c => {
    const found = await viewable(deps, c)
    if (found === null) return notFound(c)

    // HEAD is what the CLI asks before it uploads, so it must answer without
    // touching the blob at all. `Content-Length` is the *uncompressed* size —
    // the number the client can compare against the file on its disk (§5.2).
    if (c.req.method === 'HEAD') {
      return c.body(null, 200, { ...readHeaders(found), 'Content-Length': String(found.bodyBytes) })
    }

    return (await sendStoredBody(c, deps, found, readHeaders(found))) ?? notFound(c)
  })

  // The credential the shell embeds in its iframe and refreshes before each
  // live reload (spec §2.4). Minted only after the ordinary session-or-bearer
  // ACL check passes, which is what makes it safe to put in a URL: it is a
  // two-minute, single-artifact viewing capability and grants nothing else.
  app.get('/api/artifacts/:id/content-token', async c => {
    const found = await viewable(deps, c)
    if (found === null) return notFound(c)

    // A short-lived credential has no business in any cache.
    c.header('Cache-Control', 'no-store')
    return c.json({
      t: mintContentToken(found.id, deps.cfg.secretKey),
      ttl_seconds: CONTENT_TOKEN_TTL_SECS,
    })
  })

  app.put('/api/artifacts/:id/content', async c => {
    const user = c.get('user')
    if (user === null) return c.json({ error: 'unauthorized' }, 401)

    // Keyed on the token where there is one, so revoking a runaway agent's
    // token also frees the budget of every other agent its owner runs.
    if (!allowWrite(c.get('tokenId') ?? user.id)) {
      return c.json({ error: `too many writes: at most ${WRITE_LIMIT} a minute` }, 429)
    }

    const found = await getArtifactWithGrant(deps, c.req.param('id'), user)
    if (found === null || !can(user, found.art, 'viewer', found.grantRole)) return notFound(c)
    // They can already see it, so 403 tells them nothing a `GET` would not.
    if (!can(user, found.art, 'editor', found.grantRole)) {
      return c.json({ error: 'forbidden' }, 403)
    }

    if (!isGzip(c.req.header('Content-Encoding'))) {
      return c.json({ error: 'the body must be gzipped: send Content-Encoding: gzip' }, 415)
    }

    const baseVersion = parseBaseVersion(c.req.header('X-Base-Version'))
    if (baseVersion === INVALID) {
      return c.json({ error: 'X-Base-Version must be an integer' }, 400)
    }

    let html: Buffer
    try {
      html = gunzipCapped(Buffer.from(await c.req.arrayBuffer()), deps.cfg.maxArtifactBytes)
    } catch (err) {
      if (err instanceof PayloadTooLarge) {
        return c.json(
          {
            error: `the document is larger than ${deps.cfg.maxArtifactBytes} bytes uncompressed`,
            max_bytes: deps.cfg.maxArtifactBytes,
          },
          413,
        )
      }
      // A body that zlib cannot read is a client mistake, not a server fault,
      // so it must not surface as the 500 an uncaught throw would give.
      return c.json({ error: 'the body is not valid gzip' }, 400)
    }

    const result = await write(deps, found.art.id, {
      html,
      ifNoneMatch: parseEtag(c.req.header('If-None-Match')),
      baseVersion,
    })

    switch (result.kind) {
      // Deleted between the permission check and the lock. Same answer as an id
      // that was never real.
      case 'missing':
        return notFound(c)
      case 'unchanged':
        return c.body(null, 304)
      case 'conflict':
        return c.json({ version: result.version, hash: result.hash }, 409)
      case 'written':
        return c.json({ version: result.version, changed: true })
    }
  })
}

/**
 * The whole write, under one transaction and one row lock. The lock is what
 * makes `X-Base-Version` mean anything: without it two agents both read version
 * 4, both find their base current, and both write version 5.
 *
 * Every decision — is this a no-op, is this a conflict — is taken against the
 * locked row rather than the row the permission check read, so a push that
 * lands in between cannot turn a real write into a `304`.
 */
async function write(
  deps: Deps,
  id: string,
  push: { html: Buffer; ifNoneMatch: string | null; baseVersion: number | null },
): Promise<PutResult> {
  const newHash = sha256(push.html)
  const newHex = newHash.toString('hex')

  return deps.db.transaction(async (tx): Promise<PutResult> => {
    const [current] = await tx
      .select({ version: artifacts.version, contentHash: artifacts.contentHash })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .for('update')
    if (current === undefined) return { kind: 'missing' }

    const currentHex = current.contentHash.toString('hex')
    // Two ways to say the same thing. The header is the cheap one the CLI
    // sends; the hash of what actually arrived is the one that catches a client
    // that did not send the header, or sent the wrong one. Neither writes.
    if (newHex === currentHex || push.ifNoneMatch === currentHex) return { kind: 'unchanged' }

    if (push.baseVersion !== null && push.baseVersion !== current.version) {
      return { kind: 'conflict', version: current.version, hash: currentHex }
    }

    const version = current.version + 1

    // Version 0 is the empty document a `POST` creates, never something anyone
    // pushed, so it is not history and is not kept.
    if (current.version >= 1) {
      // The blob is copied inside Postgres. Selecting it into node first and
      // sending it back would drag the whole document across the wire twice for
      // no reason.
      await tx.execute(sql`
        INSERT INTO artifact_versions (artifact_id, version, content_hash, body)
        SELECT id, version, content_hash, body FROM artifacts WHERE id = ${id}
      `)
      // Keep the newest MAX_VERSIONS. The version about to be written lives on
      // the artifacts row itself, so the archive holds the MAX_VERSIONS below
      // it: at version 5 with a cap of 3 that is 4, 3, 2, and 1 goes.
      const cutoff = version - 1 - deps.cfg.maxVersions
      if (cutoff >= 1) {
        await tx.execute(
          sql`DELETE FROM artifact_versions WHERE artifact_id = ${id} AND version <= ${cutoff}`,
        )
      }
    }

    await tx
      .update(artifacts)
      .set({
        contentHash: newHash,
        // Re-gzipped here rather than storing what arrived: the bytes on disk
        // are then this server's own encoding, not whatever framing, dictionary
        // or compression level the client happened to use.
        body: gzipBuf(push.html),
        bodyBytes: push.html.length,
        version,
        updatedAt: new Date(),
      })
      .where(eq(artifacts.id, id))

    // Inside the transaction, so it fires on commit and never for a write that
    // rolled back. Postgres fans this out to every replica listening on the
    // channel, which is how live updates work with no broker (spec §5.5).
    await tx.execute(sql`
      SELECT pg_notify(
        'artifact_updated',
        json_build_object('artifactId', ${id}::text, 'version', ${version}::int, 'hash', ${newHex}::text)::text
      )
    `)

    return { kind: 'written', version }
  })
}

// --- rate limiting -------------------------------------------------------------

/**
 * Sliding window, in memory, **per replica**: two app containers each allow
 * their own 60 writes a minute. That is the honest trade for having no Redis in
 * the compose file (§1.1) — this limit exists to stop an agent pushing in a
 * loop, not to meter a paid quota, and a factor of "however many replicas you
 * run" does not change what it is for.
 */
function createWriteLimiter(now: () => number): (key: string) => boolean {
  const hits = new Map<string, number[]>()

  return key => {
    const at = now()
    const cutoff = at - WRITE_WINDOW_MS

    // Callers accumulate keys, so anything whose whole window has expired is
    // dropped once the map is big enough to be worth walking. Without this a
    // long-lived process keeps an entry per token it has ever seen.
    if (hits.size > 1024) {
      for (const [k, times] of hits) {
        if (times[times.length - 1] <= cutoff) hits.delete(k)
      }
    }

    const recent = (hits.get(key) ?? []).filter(t => t > cutoff)
    hits.set(key, recent)
    if (recent.length >= WRITE_LIMIT) return false
    recent.push(at)
    return true
  }
}

// --- headers ---------------------------------------------------------------------

/** What both read routes send. The ETag is the sha256 of the *uncompressed*
 *  document — the same number the CLI computes from the file on disk — so it
 *  does not change if the gzip encoding ever does. */
function readHeaders(art: ArtifactMeta): Record<string, string> {
  return {
    ...contentApiHeaders(),
    'Content-Type': 'application/octet-stream',
    ETag: `"${art.contentHash.toString('hex')}"`,
    'X-Artef-Version': String(art.version),
  }
}

/** `"<hex>"`, `W/"<hex>"` and a bare `<hex>` all mean the same thing here. An
 *  empty header is no header. */
function parseEtag(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const value = raw.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1').trim()
  return value === '' ? null : value.toLowerCase()
}

function isGzip(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'gzip'
}

/**
 * Digits and nothing else. `Number()` is far too generous for a value this
 * load-bearing: it reads `1e2` as 100, `0x10` as 16 and `1.0` as 1, so a client
 * that garbled the header would silently have its write compared against a
 * version it never meant — and `Number.isInteger` waves all three through.
 */
function parseBaseVersion(raw: string | undefined): number | null | typeof INVALID {
  const value = raw?.trim() ?? ''
  if (value === '') return null
  if (!/^\d+$/.test(value)) return INVALID
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : INVALID
}

// --- shared ----------------------------------------------------------------------

/** The artifact this request may view, or `null` for both "no such artifact"
 *  and "not yours" — which are the same answer on the wire (spec §2.3). */
async function viewable(deps: Deps, c: Context<AppEnv>): Promise<ArtifactMeta | null> {
  const user = c.get('user')
  // A path with no `:id` cannot reach these handlers, so the fallback is only
  // here to keep the lookup taking a string; it matches nothing either way.
  const found = await getArtifactWithGrant(deps, c.req.param('id') ?? '', user)
  if (found === null || !can(user, found.art, 'viewer', found.grantRole)) return null
  return found.art
}

const notFound = (c: Context<AppEnv>) => c.json({ error: 'not found' }, 404)
