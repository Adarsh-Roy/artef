// Reading a stored document back out. Two routes hand out the same blob — the
// content API for agents (§5.2) and `/c/:id` for browsers (§2.1) — and both
// have to make the same two decisions: send the stored gzip untouched to a
// client that takes gzip, and decompress under a cap for one that does not.
// One implementation, so the two can never drift apart, and one place where
// artifact bytes are turned into a response body.
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { artifacts } from '../db/schema.js'
import { gunzipCapped } from './gzip.js'

/**
 * Sends the stored document with `headers`. Returns `null` when the row is gone
 * — deleted between the permission check and this read — which every caller
 * answers the same way it answers an id that was never real.
 *
 * `headers` decides everything about how the bytes are framed (content type,
 * caching, the sandbox CSP); this function only decides the encoding.
 */
export async function sendStoredBody(
  c: Context<AppEnv>,
  deps: Deps,
  art: { id: string; bodyBytes: number },
  headers: Record<string, string>,
): Promise<Response | null> {
  // The body is selected on its own, and only here: the metadata helpers never
  // touch this column, which is what keeps listing off the TOAST heap (§3.1).
  const [row] = await deps.db
    .select({ body: artifacts.body })
    .from(artifacts)
    .where(eq(artifacts.id, art.id))
  if (row === undefined) return null

  // Stored gzipped and served gzipped — the server does not decompress at all
  // for a client that can take it, which is most of them (spec §3).
  if (acceptsGzip(c.req.header('Accept-Encoding'))) {
    return c.body(toBody(row.body), 200, { ...headers, 'Content-Encoding': 'gzip' })
  }
  // The cap is the configured one, except for a document that was already
  // stored when the limit was higher — refusing to serve those would make
  // lowering MAX_ARTIFACT_BYTES retroactively destroy access to real data.
  const cap = Math.max(deps.cfg.maxArtifactBytes, art.bodyBytes)
  return c.body(toBody(gunzipCapped(row.body, cap)), 200, headers)
}

/** Whether the client will take gzip. `gzip;q=0` is an explicit refusal, and a
 *  client that says so gets the document decompressed. */
export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false
  for (const part of header.split(',')) {
    const [token, ...params] = part.split(';').map(s => s.trim().toLowerCase())
    if (token !== 'gzip' && token !== '*') continue
    const q = params.find(p => p.startsWith('q='))
    if (q !== undefined && Number(q.slice(2)) === 0) continue
    return true
  }
  return false
}

/** Hono's body type wants a plain Uint8Array; a node Buffer is one, but its
 *  declared ArrayBufferLike does not satisfy the narrower generic. No copy. */
const toBody = (b: Buffer): Uint8Array<ArrayBuffer> => b as unknown as Uint8Array<ArrayBuffer>
