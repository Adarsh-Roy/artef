// Live updates (spec §5.5): Postgres `LISTEN`/`NOTIFY` on one dedicated
// connection, fanned out to whatever browsers have the document open.
//
// Nothing here is mocked. The notifier really connects to the test database,
// the pushes really go through `PUT .../content`, and the `updated` event is
// really the one Postgres delivered — because the whole point of this feature
// is that a `pg_notify` fired inside a write transaction reaches a stream held
// open in another process, and a fake in the middle would prove none of it.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import type pg from 'pg'
import { artifacts, users } from '../src/db/schema.js'
import { sha256, sha256Hex } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { createNotifier, type Notifier, type UpdatePayload } from '../src/notify.js'
import {
  closeDb,
  makeMachineToken,
  makeUser,
  pushHtml,
  resetDb,
  testDeps,
  TEST_DATABASE_URL,
  type TestDeps,
} from './helpers.js'

const HTML = '<!doctype html><h1>hello</h1>'
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const CHANNEL = 'artifact_updated'

type Visibility = 'private' | 'restricted' | 'workspace' | 'public'
type User = typeof users.$inferSelect

let deps: TestDeps
/** Every notifier a test opened, closed in `afterEach` whatever the test did. */
let notifiers: Notifier[] = []
/** Every SSE stream a test opened, likewise. */
let streams: SseStream[] = []

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterEach(async () => {
  for (const stream of streams) await stream.cancel()
  streams = []
  for (const notifier of notifiers) await notifier.close()
  notifiers = []
})

afterAll(closeDb)

// --- fixtures ------------------------------------------------------------------

async function makeArtifact(
  owner: User,
  opts: { visibility?: Visibility } = {},
): Promise<typeof artifacts.$inferSelect> {
  const [row] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      name: null,
      visibility: opts.visibility ?? 'private',
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
      version: 0,
    })
    .returning()
  return row
}

/** A real notifier on the test database, closed for you. */
async function newNotifier(): Promise<Notifier> {
  const notifier = await createNotifier(TEST_DATABASE_URL)
  notifiers.push(notifier)
  return notifier
}

/** Rebuilds `deps` with a notifier wired in — the route 503s without one. */
async function withNotifier(extra: { keepaliveMs?: number; notifier?: Notifier } = {}) {
  const notifier = extra.notifier ?? (await newNotifier())
  deps = await testDeps({}, { ...extra, notifier })
  return notifier
}

/**
 * A notifier that records its subscriptions and nothing else. The cleanup
 * tests need to see the subscriber map, which a real notifier does not expose —
 * and rightly so.
 */
function stubNotifier(): { notifier: Notifier; subs: Map<string, Set<unknown>> } {
  const subs = new Map<string, Set<(p: UpdatePayload) => void>>()
  const notifier: Notifier = {
    subscribe(artifactId, cb) {
      const set = subs.get(artifactId) ?? new Set()
      subs.set(artifactId, set)
      set.add(cb)
      return () => {
        set.delete(cb)
        if (set.size === 0) subs.delete(artifactId)
      }
    },
    close: async () => {},
  }
  return { notifier, subs }
}

/** A `pg_notify` from a connection that is not the notifier's own. */
function rawNotify(payload: string): Promise<unknown> {
  return deps.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload])
}

const updatePayload = (artifactId: string, version = 7, hash = 'a'.repeat(64)) =>
  JSON.stringify({ artifactId, version, hash })

/** The backends sitting on a `LISTEN`, which is what a notifier's dedicated
 *  connection looks like from the outside. */
async function listeningBackends(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_stat_activity
     WHERE datname = current_database() AND query LIKE 'LISTEN %' AND pid <> pg_backend_pid()`,
  )
  return Number(rows[0].count)
}

// --- reading an SSE stream -------------------------------------------------------

interface Frame {
  event: string | null
  data: string
  comment: string | null
}

interface SseStream {
  res: Response
  /** The next frame matching `match`, or a rejection when time runs out. */
  next(match?: (f: Frame) => boolean, ms?: number): Promise<Frame>
  cancel(): Promise<void>
}

function parseFrame(raw: string): Frame {
  let event: string | null = null
  let comment: string | null = null
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) comment = line.slice(1).trim()
    else if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim())
  }
  return { event, data: data.join('\n'), comment }
}

async function openStream(path: string, init: RequestInit = {}): Promise<SseStream> {
  const res = await deps.app.request(path, init)
  expect(res.status).toBe(200)
  expect(res.headers.get('Content-Type')).toContain('text/event-stream')

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let buffer = ''
  let ended = false
  // On an object rather than a bare `let`, so the reader below and the waiter
  // in `next` are talking about the same slot as far as the compiler is
  // concerned — a captured `let` initialised to null narrows to `never` here.
  const waiting: { wake: (() => void) | null } = { wake: null }

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut: number
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          frames.push(parseFrame(buffer.slice(0, cut)))
          buffer = buffer.slice(cut + 2)
        }
        waiting.wake?.()
      }
    } catch {
      // Cancelled by the test, which is one of the things being tested.
    }
    ended = true
    waiting.wake?.()
  })()

  let cursor = 0
  const stream: SseStream = {
    res,
    async next(match = () => true, ms = 5000) {
      const deadline = Date.now() + ms
      for (;;) {
        while (cursor < frames.length) {
          const frame = frames[cursor++]
          if (match(frame)) return frame
        }
        if (ended) throw new Error('the stream ended before a matching event arrived')
        const left = deadline - Date.now()
        if (left <= 0) throw new Error('timed out waiting for an event')
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, left)
          function done() {
            clearTimeout(timer)
            waiting.wake = null
            resolve()
          }
          waiting.wake = done
        })
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {})
      await pump
    },
  }
  streams.push(stream)
  return stream
}

// --- waiting ---------------------------------------------------------------------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never became true')
    await sleep(10)
  }
}

// ---------------------------------------------------------------------------
// The notifier
// ---------------------------------------------------------------------------

describe('createNotifier', () => {
  it('delivers a parsed payload to a subscriber', async () => {
    const notifier = await newNotifier()
    const seen: UpdatePayload[] = []
    notifier.subscribe('11111111-1111-4111-8111-111111111111', p => seen.push(p))

    await rawNotify(updatePayload('11111111-1111-4111-8111-111111111111', 42, 'b'.repeat(64)))
    await waitUntil(() => seen.length > 0)

    expect(seen[0]).toEqual({
      artifactId: '11111111-1111-4111-8111-111111111111',
      version: 42,
      hash: 'b'.repeat(64),
    })
  })

  it('delivers to every subscriber of that artifact and to nobody else', async () => {
    const notifier = await newNotifier()
    const mine = 'aaaaaaaa-0000-4000-8000-000000000001'
    const theirs = 'aaaaaaaa-0000-4000-8000-000000000002'
    const first: UpdatePayload[] = []
    const second: UpdatePayload[] = []
    const other: UpdatePayload[] = []
    notifier.subscribe(mine, p => first.push(p))
    notifier.subscribe(mine, p => second.push(p))
    notifier.subscribe(theirs, p => other.push(p))

    await rawNotify(updatePayload(mine))
    await waitUntil(() => first.length > 0 && second.length > 0)

    expect(other).toEqual([])
  })

  it('stops delivering after unsubscribe', async () => {
    const notifier = await newNotifier()
    const id = 'aaaaaaaa-0000-4000-8000-000000000003'
    const gone: UpdatePayload[] = []
    const kept: UpdatePayload[] = []
    const unsubscribe = notifier.subscribe(id, p => gone.push(p))
    notifier.subscribe(id, p => kept.push(p))

    unsubscribe()
    // Idempotent: a stream that both aborts and closes runs this twice.
    unsubscribe()

    await rawNotify(updatePayload(id))
    await waitUntil(() => kept.length > 0)
    expect(gone).toEqual([])
  })

  it('ignores malformed payloads and keeps listening', async () => {
    const notifier = await newNotifier()
    const id = 'aaaaaaaa-0000-4000-8000-000000000004'
    const seen: UpdatePayload[] = []
    notifier.subscribe(id, p => seen.push(p))

    for (const junk of [
      'not json at all',
      '[]',
      '"a string"',
      'null',
      '{}',
      JSON.stringify({ artifactId: id }),
      JSON.stringify({ artifactId: id, version: '1', hash: 'x' }),
      JSON.stringify({ artifactId: 7, version: 1, hash: 'x' }),
      JSON.stringify({ version: 1, hash: 'x' }),
    ]) {
      await rawNotify(junk)
    }

    await rawNotify(updatePayload(id, 3))
    await waitUntil(() => seen.length > 0)
    expect(seen).toEqual([{ artifactId: id, version: 3, hash: 'a'.repeat(64) }])
  })

  it('survives a subscriber that throws', async () => {
    // The throw is deliberate and the notifier logs it, so the log is captured
    // rather than left to scroll past in the test output.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const notifier = await newNotifier()
      const id = 'aaaaaaaa-0000-4000-8000-000000000005'
      const seen: UpdatePayload[] = []
      notifier.subscribe(id, () => {
        throw new Error('the browser went away')
      })
      notifier.subscribe(id, p => seen.push(p))

      await rawNotify(updatePayload(id))
      await waitUntil(() => seen.length > 0)

      // And the connection is still good afterwards.
      await rawNotify(updatePayload(id))
      await waitUntil(() => seen.length > 1)
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('reconnects after its connection is dropped', async () => {
    const notifier = await newNotifier()
    const id = 'aaaaaaaa-0000-4000-8000-000000000006'
    const seen: UpdatePayload[] = []
    notifier.subscribe(id, p => seen.push(p))

    const { rowCount } = await deps.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND query LIKE 'LISTEN %' AND pid <> pg_backend_pid()`,
    )
    expect(rowCount).toBeGreaterThan(0)

    // The first retry is a second away, so notify until one lands rather than
    // guessing when the connection came back.
    const deadline = Date.now() + 15_000
    while (seen.length === 0 && Date.now() < deadline) {
      await rawNotify(updatePayload(id, 9))
      await sleep(200)
    }
    expect(seen[0]?.version).toBe(9)
  })

  it('close() ends the connection and does not reconnect', async () => {
    const notifier = await newNotifier()
    const id = 'aaaaaaaa-0000-4000-8000-000000000007'
    const seen: UpdatePayload[] = []
    notifier.subscribe(id, p => seen.push(p))

    await notifier.close()
    // Idempotent — `index.ts` closes on both SIGINT and SIGTERM.
    await notifier.close()

    // Longer than the first backoff, so a notifier that reconnected would be
    // back and listening by now.
    await sleep(1500)
    expect(await listeningBackends(deps.pool)).toBe(0)

    await rawNotify(updatePayload(id))
    await sleep(200)
    expect(seen).toEqual([])
  })

  it('close() during an outage leaves no connection behind', async () => {
    const notifier = await newNotifier()

    // Killed, so a reconnection is pending, and closed before it can land.
    await deps.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND query LIKE 'LISTEN %' AND pid <> pg_backend_pid()`,
    )
    await notifier.close()

    await sleep(1500)
    expect(await listeningBackends(deps.pool)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/artifacts/:id/events
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:id/events', () => {
  it('opens with a hello event carrying the current version and hash', async () => {
    await withNotifier()
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id)
    expect((await pushHtml(deps, header, art.id, HTML)).status).toBe(200)

    const stream = await openStream(`/api/artifacts/${art.id}/events`, {
      headers: { Cookie: cookie },
    })
    const hello = await stream.next(f => f.event === 'hello')

    expect(JSON.parse(hello.data)).toEqual({ version: 1, hash: sha256Hex(HTML) })
  })

  it('forwards a real push as an updated event', async () => {
    await withNotifier()
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id)

    const stream = await openStream(`/api/artifacts/${art.id}/events`, {
      headers: { Cookie: cookie },
    })
    const hello = await stream.next(f => f.event === 'hello')
    expect(JSON.parse(hello.data).version).toBe(0)

    expect((await pushHtml(deps, header, art.id, HTML)).status).toBe(200)

    const updated = await stream.next(f => f.event === 'updated')
    expect(JSON.parse(updated.data)).toEqual({ version: 1, hash: sha256Hex(HTML) })
  })

  it('does not forward another artifact\'s pushes', async () => {
    await withNotifier()
    const { user, cookie } = await makeUser(deps)
    const mine = await makeArtifact(user)
    const theirs = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id)

    const stream = await openStream(`/api/artifacts/${mine.id}/events`, {
      headers: { Cookie: cookie },
    })
    await stream.next(f => f.event === 'hello')

    expect((await pushHtml(deps, header, theirs.id, HTML)).status).toBe(200)
    expect((await pushHtml(deps, header, mine.id, `${HTML}<p>mine</p>`)).status).toBe(200)

    const updated = await stream.next(f => f.event === 'updated')
    expect(JSON.parse(updated.data).hash).toBe(sha256Hex(`${HTML}<p>mine</p>`))
  })

  it('streams a public artifact to a caller with no session', async () => {
    await withNotifier()
    const { user } = await makeUser(deps)
    const art = await makeArtifact(user, { visibility: 'public' })

    const stream = await openStream(`/api/artifacts/${art.id}/events`)
    const hello = await stream.next(f => f.event === 'hello')

    expect(JSON.parse(hello.data)).toEqual({ version: 0, hash: sha256Hex('') })
  })

  it('sends comment keepalives', async () => {
    await withNotifier({ keepaliveMs: 40 })
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const stream = await openStream(`/api/artifacts/${art.id}/events`, {
      headers: { Cookie: cookie },
    })
    const ping = await stream.next(f => f.comment !== null)

    expect(ping.comment).not.toBe('')
  })

  it('opens for a scoped token on its own artifact and 404s on any other', async () => {
    await withNotifier()
    const { user } = await makeUser(deps)
    const mine = await makeArtifact(user)
    const theirs = await makeArtifact(user)
    const { header } = await makeMachineToken(deps, user.id, { scopeIds: [mine.id] })

    const stream = await openStream(`/api/artifacts/${mine.id}/events`, { headers: header })
    await stream.next(f => f.event === 'hello')

    const res = await deps.app.request(`/api/artifacts/${theirs.id}/events`, { headers: header })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('404s a private artifact for a caller with no session', async () => {
    await withNotifier()
    const { user } = await makeUser(deps)
    const art = await makeArtifact(user)

    const res = await deps.app.request(`/api/artifacts/${art.id}/events`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('404s an artifact in another workspace, same as one that is not there', async () => {
    await withNotifier()
    const { user } = await makeUser(deps)
    const art = await makeArtifact(user)
    const stranger = await makeUser(deps, { domain: 'other.example' })

    const theirs = await deps.app.request(`/api/artifacts/${art.id}/events`, {
      headers: { Cookie: stranger.cookie },
    })
    const missing = await deps.app.request(`/api/artifacts/${UNKNOWN_ID}/events`, {
      headers: { Cookie: stranger.cookie },
    })

    expect(theirs.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await theirs.json()).toEqual(await missing.json())
  })

  it('503s when the server has no notifier', async () => {
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const res = await deps.app.request(`/api/artifacts/${art.id}/events`, {
      headers: { Cookie: cookie },
    })

    expect(res.status).toBe(503)
    expect(typeof (await res.json()).error).toBe('string')
  })

  it('unsubscribes when the client aborts', async () => {
    const { notifier, subs } = stubNotifier()
    await withNotifier({ notifier })
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const controller = new AbortController()
    const stream = await openStream(`/api/artifacts/${art.id}/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    })
    await stream.next(f => f.event === 'hello')
    expect(subs.size).toBe(1)

    controller.abort()
    await waitUntil(() => subs.size === 0)
  })

  it('unsubscribes when the client closes the stream', async () => {
    const { notifier, subs } = stubNotifier()
    await withNotifier({ notifier })
    const { user, cookie } = await makeUser(deps)
    const art = await makeArtifact(user)

    const stream = await openStream(`/api/artifacts/${art.id}/events`, {
      headers: { Cookie: cookie },
    })
    await stream.next(f => f.event === 'hello')
    expect(subs.size).toBe(1)

    await stream.cancel()
    await waitUntil(() => subs.size === 0)
  })
})
