// Live updates with no broker (spec §5.5). A write to an artifact ends with a
// `pg_notify` inside its own transaction (routes/content.ts), and Postgres fans
// that out to every app replica listening on the channel — which is what lets
// the compose file be two containers instead of three.
//
// This file is the listening half: one dedicated connection, held open for the
// life of the process, and an in-memory map from artifact id to the SSE streams
// waiting on it.
//
// The connection is deliberately NOT from the pool. A `LISTEN` belongs to the
// session that issued it, so a pooled connection would stop delivering the
// moment the pool handed it to somebody else, recycled it, or reaped it as
// idle — and it would hold a pool slot forever besides.
import pg from 'pg'

/** What `pg_notify` carries. The producer is routes/content.ts and the shape is
 *  a contract between the two files: camelCase, version and hash of the write
 *  that just committed. */
export interface UpdatePayload {
  artifactId: string
  version: number
  hash: string
}

export interface Notifier {
  /** Registers `cb` for one artifact and returns the undo. Calling the undo
   *  twice is harmless — a stream that both aborts and closes does exactly that. */
  subscribe(artifactId: string, cb: (p: UpdatePayload) => void): () => void
  close(): Promise<void>
}

const CHANNEL = 'artifact_updated'
/** Backoff between reconnection attempts: 1s, doubling, capped at 30s. Long
 *  enough that a database restart is not a retry storm, short enough that a
 *  browser left open over the outage starts getting updates again by itself. */
const FIRST_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

/**
 * Connects, listens, and starts dispatching. The first connection is awaited so
 * a database that is not there is a boot failure rather than a server that
 * silently never delivers an update; every connection after it is the
 * reconnection loop's business and nothing waits on it.
 */
export async function createNotifier(databaseUrl: string): Promise<Notifier> {
  const subscribers = new Map<string, Set<(p: UpdatePayload) => void>>()

  let client: pg.Client | null = null
  let closed = false
  let retryTimer: NodeJS.Timeout | null = null
  let retryMs = FIRST_RETRY_MS

  /**
   * A payload from Postgres to whoever is waiting on that artifact. Anything
   * unparseable is dropped: `NOTIFY` is a public channel — anyone with a
   * database connection can send anything down it — and a throw here would
   * surface as an unhandled rejection in pg's event emitter and take the
   * connection with it.
   */
  function dispatch(raw: string | undefined): void {
    if (raw === undefined) return

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return

    const { artifactId, version, hash } = parsed as Record<string, unknown>
    if (typeof artifactId !== 'string' || typeof version !== 'number' || typeof hash !== 'string') {
      return
    }

    // Copied, because a callback may unsubscribe itself — which it does on the
    // very last update before a stream closes.
    for (const cb of [...(subscribers.get(artifactId) ?? [])]) {
      try {
        cb({ artifactId, version, hash })
      } catch (err) {
        // One dead stream must not cost every other reader their updates.
        console.error(err)
      }
    }
  }

  async function connect(): Promise<void> {
    const connecting = new pg.Client({ connectionString: databaseUrl })
    // Registered before `connect()`, because pg emits connection errors on the
    // client and an emitter with no `error` listener throws process-wide.
    connecting.on('error', () => lost(connecting))
    connecting.on('end', () => lost(connecting))
    connecting.on('notification', msg => dispatch(msg.payload))

    await connecting.connect()
    try {
      // A constant, never interpolated from anything a caller supplied — a
      // channel name is an identifier and cannot be a bound parameter.
      await connecting.query(`LISTEN ${CHANNEL}`)
    } catch (err) {
      // Connected but not listening is no use to anyone, and nothing else holds
      // a reference to it — without this the retry loop would leave a backend
      // behind on every attempt.
      await connecting.end().catch(() => {})
      throw err
    }

    // `close()` can have run while this connection was being made: it ended the
    // client it knew about, which was not this one. Left alone, this would go on
    // listening for the life of the process.
    if (closed) {
      await connecting.end().catch(() => {})
      return
    }

    client = connecting
    retryMs = FIRST_RETRY_MS
  }

  /** The connection went away. `error` and `end` both fire for one death, and a
   *  client we have already replaced is not news, so both are funnelled here. */
  function lost(dead: pg.Client): void {
    if (closed || dead !== client) return
    client = null
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (closed || retryTimer !== null) return
    const delay = retryMs
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)

    retryTimer = setTimeout(() => {
      retryTimer = null
      if (closed) return
      // Re-LISTEN is part of `connect`: the subscription lived in the session
      // that just died, so a reconnection that skipped it would look healthy
      // and deliver nothing.
      connect().catch(err => {
        console.error(err)
        scheduleReconnect()
      })
    }, delay)
    // A pending reconnection is not a reason to keep the process alive.
    retryTimer.unref()
  }

  await connect()

  return {
    subscribe(artifactId, cb) {
      const set = subscribers.get(artifactId) ?? new Set()
      subscribers.set(artifactId, set)
      set.add(cb)

      return () => {
        const current = subscribers.get(artifactId)
        if (current === undefined) return
        current.delete(cb)
        // Or the map grows by one entry per artifact anyone ever opened.
        if (current.size === 0) subscribers.delete(artifactId)
      }
    },

    async close() {
      closed = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      subscribers.clear()

      const ending = client
      client = null
      // `end()` fires `end`, which `closed` is what stops from reconnecting.
      if (ending !== null) await ending.end().catch(() => {})
    },
  }
}
