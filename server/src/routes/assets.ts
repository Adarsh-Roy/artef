// Content-addressed assets (spec §5.4). The two halves of this file answer to
// opposite rules, and the asymmetry is the design rather than an oversight.
//
// Uploading needs a real credential and writes into one workspace, so storage
// can be attributed and a deleted workspace takes its assets with it (§3).
//
// Serving needs no credential at all, and cannot have one: an `<img>` inside a
// document is fetched by a frame sandboxed without `allow-same-origin`, whose
// requests carry no cookies (§2.4), and stamping a content token into every
// image URL would mean rewriting the HTML on every serve. What replaces the
// credential is the hash itself — to name an asset you must know the SHA-256 of
// its bytes, and you only know that if you already have them. So the lookup is
// by hash alone, across every workspace: the primary key is
// `(workspace_id, sha256)` for accounting, but any row with a given hash holds
// the same bytes by construction (§3).
//
// Bytes are stored uncompressed, unlike documents. Every format on the
// allowlist is already compressed, so a gzip pass would spend CPU on both ends
// to make the file slightly larger.
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { assets } from '../db/schema.js'
import { sha256 } from '../lib/crypto.js'
import { assetHeaders } from '../lib/headers.js'

/**
 * What an agent may upload (spec §5.4, §6) — the list the CLI's extractor pins,
 * and nothing else. It is short on purpose: the serve route hands these bytes
 * back to a browser with the stored content type, so every entry here is a type
 * whose rendering is safe under the script-less sandbox CSP.
 *
 * `image/svg+xml` is the one that has to be argued for. An SVG is a scriptable
 * document when navigated to directly, which is precisely why `ASSET_CSP` has
 * no `allow-scripts` in it (§2.2) — refusing SVGs instead would break the chart
 * and diagram documents this product exists to serve.
 */
const ALLOWED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'font/woff',
  'font/woff2',
])

export function registerAssetRoutes(app: Hono<AppEnv>, deps: Deps): void {
  // Session or bearer, and no scope check: a token scoped to one artifact is
  // still pushing a document whose images have to go somewhere, and an asset
  // names no artifact to scope against.
  app.post('/api/assets', async c => {
    const user = c.get('user')
    if (user === null) return c.json({ error: 'unauthorized' }, 401)

    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      // A body that is not multipart at all is a client mistake, so it must not
      // surface as the 500 an uncaught throw would give.
      return c.json({ error: PART_ERROR }, 400)
    }

    const file = form.get('file')
    // `FormData.get` gives a string for an ordinary field and `null` for a part
    // that is not there; either way there are no bytes to store.
    if (file === null || typeof file === 'string') return c.json({ error: PART_ERROR }, 400)

    const mediaType = normalizeMediaType(file.type)
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return c.json({ error: `the file must be one of ${[...ALLOWED_MEDIA_TYPES].join(', ')}` }, 415)
    }

    // The same cap documents get (§12.2). Checked against the part's own size
    // rather than the request's `Content-Length`, which counts the multipart
    // framing too and would refuse a file of exactly the maximum size.
    if (file.size > deps.cfg.maxArtifactBytes) return tooLarge(c, deps)

    const body = Buffer.from(await file.arrayBuffer())
    const digest = sha256(body)

    // `DO NOTHING` rather than an upsert: the primary key is the hash of the
    // bytes, so a conflicting row already holds exactly what this request is
    // asking to store. Rewriting it would only let a later upload of the same
    // bytes restate their media type — which is the one field a second uploader
    // could vary, and the first answer is the one every existing document's
    // `<img>` was written against.
    await deps.db
      .insert(assets)
      .values({
        workspaceId: user.workspaceId,
        sha256: digest,
        mediaType,
        body,
        byteSize: body.length,
      })
      .onConflictDoNothing()

    // 201 either way. The endpoint is content-addressed, so "stored" and
    // "already stored" leave the caller in the same state and describing them
    // differently would only invite a client to treat one as a failure.
    const hex = digest.toString('hex')
    return c.json({ sha256: hex, url: `/assets/${hex}`, byte_size: body.length }, 201)
  })

  // Unauthenticated, and it must stay that way: this is what the sandboxed
  // frame's image requests hit, and they arrive with no cookies. Nothing here
  // reads `c.get('user')` — not as a filter, not as a hint.
  //
  // Registered with `app.get` alone: hono answers a HEAD from the GET handler,
  // so a separately registered HEAD would be dead code and would add a second
  // entry to the byte-serving route list the invariant test enumerates.
  app.get('/assets/:sha', async c => {
    const sha = c.req.param('sha')
    // A malformed hash is answered exactly like a hash we do not hold, in the
    // app's ordinary 404 shape — a refusal carries no user bytes, so it is not
    // one of the responses §2.2 governs. It also never reaches
    // `Buffer.from(…, 'hex')`, which silently truncates anything that is not a
    // clean pair of hex digits.
    if (!isSha256Hex(sha)) return notFound(c)

    // Any row will do (§3). The bytes are identical across workspaces by
    // construction; the media type is the one field two uploaders could have
    // disagreed about, and the worst that costs is a browser declining to
    // render an image whose stored type came from the other upload — `nosniff`
    // and the script-less CSP hold either way.
    const [row] = await deps.db
      .select({ mediaType: assets.mediaType, body: assets.body })
      .from(assets)
      .where(eq(assets.sha256, Buffer.from(sha, 'hex')))
      .limit(1)
    if (row === undefined) return notFound(c)

    // Stored uncompressed and sent as-is. The header set is the invariant
    // (§2.2): the stored content type, the script-less sandbox, `nosniff`, and
    // a cache lifetime that is safe precisely because the URL is the hash.
    return c.body(toBody(row.body), 200, assetHeaders(row.mediaType))
  })
}

const PART_ERROR = 'expected multipart/form-data with one file part named file'

const notFound = (c: Context<AppEnv>) => c.json({ error: 'not found' }, 404)

const tooLarge = (c: Context<AppEnv>, deps: Deps) =>
  c.json(
    {
      error: `the asset is larger than ${deps.cfg.maxArtifactBytes} bytes`,
      max_bytes: deps.cfg.maxArtifactBytes,
    },
    413,
  )

/**
 * Exactly 64 lowercase hex digits. The length is checked separately from the
 * pattern on purpose: `$` in a JavaScript regex also matches immediately before
 * a trailing newline, so `/^[0-9a-f]{64}$/` alone accepts `"<64 hex>\n"` — and
 * hono percent-decodes path params, so `%0A` in the URL is how that string
 * arrives here.
 */
function isSha256Hex(sha: string): boolean {
  return sha.length === 64 && /^[0-9a-f]{64}$/.test(sha)
}

/** The part's `Content-Type` without its parameters, so `image/png` and
 *  `image/png; charset=binary` are the one media type they describe. */
function normalizeMediaType(raw: string): string {
  return raw.split(';', 1)[0].trim().toLowerCase()
}

/** Hono's body type wants a plain Uint8Array; a node Buffer is one, but its
 *  declared ArrayBufferLike does not satisfy the narrower generic. No copy. */
const toBody = (b: Buffer): Uint8Array<ArrayBuffer> => b as unknown as Uint8Array<ArrayBuffer>
