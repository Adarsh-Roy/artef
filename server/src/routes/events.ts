// The live-update stream (spec §5.5, §2.3 step 6). The shell page opens one of
// these per open document and, on every `updated`, fetches a fresh content
// token and reloads the frame — so the connection carries no document bytes at
// all, only the news that there are new ones.
//
// Two things make this cheap enough to hold open for hours. It is an
// EventSource, not a WebSocket, so it is an ordinary HTTP response that
// reconnects by itself when a proxy times it out. And it fans out from
// Postgres `LISTEN`/`NOTIFY` (src/notify.ts) rather than from a broker, so a
// stream costs a map entry rather than a connection.
import { streamSSE } from 'hono/streaming'
import type { Hono } from 'hono'
import type { AppEnv, Deps } from '../app.js'
import { can } from '../lib/acl.js'
import { getArtifactWithGrant } from './artifacts.js'

/** How often a comment line goes down an idle stream. Proxies and load
 *  balancers cut connections that say nothing for a minute or so, and a
 *  comment is the one thing an EventSource ignores completely. */
const KEEPALIVE_MS = 30_000

export function registerEventRoutes(app: Hono<AppEnv>, deps: Deps): void {
  app.get('/api/artifacts/:id/events', async c => {
    // No login required: a `public` artifact updates live for anyone holding
    // the link, exactly as it renders for them (§4.2). `can()` is the single
    // authority, and "you may not" is the same 404 as "it is not there" (§2.3).
    const user = c.get('user')
    const found = await getArtifactWithGrant(deps, c.req.param('id'), user)
    if (found === null || !can(user, found.art, 'viewer', found.grantRole)) {
      return c.json({ error: 'not found' }, 404)
    }

    const notifier = deps.notifier
    // Only reachable in a test that built an app without one — `index.ts`
    // always creates a notifier, and fails to boot if it cannot.
    if (notifier === undefined) {
      return c.json({ error: 'live updates are unavailable' }, 503)
    }

    const art = found.art
    const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS

    return streamSSE(c, async stream => {
      // The handler has to stay on the stack for the stream to stay open, so
      // it parks here until something ends it.
      let finished = () => {}
      const until = new Promise<void>(resolve => {
        finished = resolve
      })

      const unsubscribe = notifier.subscribe(art.id, update => {
        // Not awaited: this runs inside the notifier's dispatch loop, and one
        // slow reader must not hold up every other stream. Writes to a stream
        // that has gone away are swallowed by hono today; the `catch` is so a
        // future version that stops swallowing them cannot turn a disconnect
        // into an unhandled rejection.
        void stream
          .writeSSE({ event: 'updated', data: state(update.version, update.hash) })
          .catch(() => {})
      })

      const keepalive = setInterval(() => void stream.write(': ping\n\n'), keepaliveMs)
      // Node keeps a process alive for a pending interval, and a shutdown must
      // not wait on a ping.
      keepalive.unref()

      // Idempotent, because both of the endings below can happen for one
      // disconnect: the socket closing aborts the stream, and the request
      // signal aborts too.
      const done = () => {
        clearInterval(keepalive)
        unsubscribe()
        finished()
      }
      stream.onAbort(done)
      c.req.raw.signal?.addEventListener('abort', done, { once: true })

      // The current state — written *after* the subscription is live. A push
      // that lands between the two is then delivered as an `updated` rather
      // than falling into the gap between "read the version" and "start
      // listening", and the shell ignores an update it has already seen, so an
      // `updated` that arrives before or repeats the `hello` costs nothing.
      // A browser that reconnects a second after a push needs this to catch up
      // at all (§5.5).
      await stream.writeSSE({
        event: 'hello',
        data: state(art.version, art.contentHash.toString('hex')),
      })

      await until
    })
  })
}

/** The body of both events — the same two fields, so a client handles them with
 *  one code path. The hash is bare hex, matching the `ETag` on the content
 *  routes minus its quotes. */
function state(version: number, hash: string): string {
  return JSON.stringify({ version, hash })
}
