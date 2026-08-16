// The agent front door (spec §7.0). MCP over Streamable HTTP, mounted on the
// same app and the same origin as everything else, so connecting an agent is
// one config entry and no binary install.
//
// Three decisions shape this file.
//
// **Stateless.** A fresh `McpServer` and transport are built for each request
// and thrown away with it, so no replica holds a session another replica would
// have to find. That is what lets `/mcp` scale the same way `/api` does —
// horizontally, behind whatever load balancer the operator already has.
//
// **The tools are adapters, not a second API.** Every handler dispatches back
// into this app's own REST routes with the caller's own bearer credential
// (`app.request`), so the ACL, the token scope, the write rate limit and the
// wire shapes are enforced by the same code that enforces them for the CLI —
// once, in one place. Nothing here decides who may do what.
//
// **A refusal is data.** Whatever the REST layer answers — a 403 for a scoped
// token, a 409 for a stale base version, a 422 for an address outside the
// workspace — comes back as an MCP tool error carrying the JSON body, never as
// a JSON-RPC protocol error. The agent reads it, fixes its input and retries.
// The preflight (§7.1) is the same idea one step earlier: the offending
// element, the rule it broke and the fix, before anything is written.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv, Deps } from '../app.js'
import { sha256Hex } from '../lib/crypto.js'
import { gzipBuf } from '../lib/gzip.js'
import { mcpAuthChallenge } from '../lib/headers.js'
import { serverVersion } from '../lib/version.js'
import { preflight, type Violation } from '../lib/preflight.js'

/** What the agent sees in the handshake. Kept in step with the package version
 *  by hand — it identifies the server, it is not a protocol negotiation. */
const SERVER_VERSION = serverVersion()

/**
 * The one rule an agent has to know before it generates anything, said once at
 * connect time rather than discovered through a rejected publish.
 */
const INSTRUCTIONS = `Artef publishes self-contained HTML documents.

Artifacts are served under a strict sandbox content security policy: the
document may not make a single outbound request. Everything it needs must be
in the file — CSS in <style>, JavaScript in <script>, images as data: URIs.
No CDN scripts, no font stylesheets, no external images, no fetch/XHR, no
form submissions, no <iframe>.

publish_artifact and update_artifact check the document against that policy
before writing anything. A refusal comes back as a list of violations naming
the element, the rule and the fix — repair the HTML and call again.`

/** Two roles, and there is no third (spec §5.9). */
const ROLES = 'viewer, editor'
const VISIBILITIES = 'private, restricted, workspace, public'

export function registerMcpRoutes(app: Hono<AppEnv>, deps: Deps): void {
  app.all('/mcp', async c => {
    // The bearer middleware lets a request with no `Authorization` header
    // through, because most of the app has other ways in. This one does not:
    // `/mcp` is for agents, a browser session is not a credential here, and the
    // refusal happens before the MCP handshake so a client with no token gets
    // an HTTP 401 rather than a protocol-level surprise.
    const authorization = c.req.header('Authorization')
    if (c.get('authKind') !== 'bearer' || authorization === undefined) {
      // The WWW-Authenticate breadcrumb is what turns this refusal into an
      // onboarding: an MCP harness follows it to the OAuth metadata and comes
      // back with a token of its own (spec §7.0).
      c.header('WWW-Authenticate', mcpAuthChallenge(deps.cfg.url))
      return c.json({ error: 'unauthorized' }, 401)
    }

    // The Streamable HTTP transport also defines a `GET` that opens a
    // server-to-client SSE stream and a `DELETE` that ends a session. Neither
    // means anything without a session: there is nothing here to push and
    // nothing to tear down, and a stream this handler opened would be closed
    // again the moment the request finished, which a client would read as a
    // dropped connection and reconnect to in a loop. `405` is what the MCP
    // spec says to answer when the stream is not on offer.
    if (c.req.method !== 'POST') {
      return c.json({ error: 'the mcp endpoint is stateless: use POST' }, 405)
    }

    const server = buildServer(app, deps, authorization)
    // No session id: every request stands alone (§7.0). `enableJsonResponse`
    // because none of these tools streams — the whole reply is ready when the
    // handler returns, and a plain JSON body is what an intermediary, a proxy
    // and a curl all handle without special cases.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    } finally {
      // The response body is fully built by the time `handleRequest` resolves,
      // so nothing is cut short by tearing the pair down here.
      await server.close()
    }
  })
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/**
 * A server wired to one caller's credential. Built per request, which is what
 * makes the whole endpoint stateless.
 *
 * The input schemas describe *shapes* — a string is a string — and leave the
 * *values* to the routes behind them. A `visibility` enum copied into this file
 * would be the same list of names in two places, and the day a fifth one is
 * added the MCP door would quietly refuse it while the REST door accepted it.
 * The allowed values are in the descriptions, where an agent reads them, and
 * the API is the one thing that decides.
 */
function buildServer(app: Hono<AppEnv>, deps: Deps, authorization: string): McpServer {
  const server = new McpServer(
    { name: 'artef', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  )

  /** This app answering itself, as the agent that called in. Every rule the
   *  REST layer applies applies here, because it is the REST layer. */
  const api = async (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: { authorization, ...init.headers },
      body: init.body,
    })

  const json = (path: string, method: string, body: unknown): Promise<Response> =>
    api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  /**
   * A document push, shaped exactly the way the CLI shapes it (§5.2): gzipped,
   * with `If-None-Match` carrying the sha256 of the *uncompressed* bytes so an
   * unchanged document costs no write at all.
   */
  const push = async (id: string, html: string, baseVersion?: number): Promise<Response> =>
    api(`/api/artifacts/${encodeURIComponent(id)}/content`, {
      method: 'PUT',
      headers: {
        'Content-Encoding': 'gzip',
        'If-None-Match': `"${sha256Hex(html)}"`,
        ...(baseVersion === undefined ? {} : { 'X-Base-Version': String(baseVersion) }),
      },
      body: new Uint8Array(gzipBuf(html)),
    })

  /** The version an artifact is at now. Only needed on the `304` path, where
   *  the answer to "what changed" is "nothing" and the caller still wants the
   *  number. `HEAD` reads it from the metadata without touching the blob. */
  const versionOf = async (id: string): Promise<number | null> => {
    const res = await api(`/api/artifacts/${encodeURIComponent(id)}/content`, { method: 'HEAD' })
    const version = Number(res.headers.get('X-Artef-Version'))
    return res.ok && Number.isInteger(version) ? version : null
  }

  // -------------------------------------------------------------------------

  server.registerTool(
    'publish_artifact',
    {
      title: 'Publish an artifact',
      description:
        'Create a new artifact from a self-contained HTML document and return its shareable URL. ' +
        'The document must be fully self-contained — no external scripts/styles/images; inline everything (libraries included). ' +
        'It is checked against the artifact content security policy first: if it references ' +
        'anything external it is refused, unwritten, with the violations listed. ' +
        `Documents are limited to ${deps.cfg.maxArtifactBytes} bytes uncompressed.`,
      inputSchema: {
        html: z
          .string()
          .describe('The complete HTML document. Everything inline — no external requests of any kind.'),
        name: z.string().optional().describe('A human title for the document, up to 200 characters.'),
        visibility: z
          .string()
          .optional()
          .describe(`Who can reach it: ${VISIBILITIES}. Defaults to private.`),
      },
    },
    async ({ html, name, visibility }) => {
      const checked = preflight(html)
      if (checked.rejects.length > 0) return refusedByPreflight(checked)

      const created = await json('/api/artifacts', 'POST', { name, visibility })
      if (!created.ok) return await failure(created)
      const meta = (await created.json()) as { id: string; url: string }

      const pushed = await push(meta.id, html)
      if (!pushed.ok && pushed.status !== 304) {
        // The row exists but holds nothing, so the agent is told both facts:
        // the id it can retry against, and why the bytes did not land.
        return await failure(pushed, { id: meta.id, hint: 'the artifact was created but empty; retry with update_artifact' })
      }

      return ok({
        id: meta.id,
        url: meta.url,
        version: pushed.status === 304 ? 0 : ((await pushed.json()) as { version: number }).version,
        warns: checked.warns,
      })
    },
  )

  server.registerTool(
    'update_artifact',
    {
      title: 'Update an artifact',
      description:
        'Replace the contents of an existing artifact. The same content security policy check runs first. ' +
        'The document must be fully self-contained — no external scripts/styles/images; inline everything (libraries included). ' +
        'Pass base_version to make the write conditional: if someone else has published since, the write is ' +
        'refused with the version that is current instead of overwriting their work.',
      inputSchema: {
        id: z.string().describe('The artifact id returned by publish_artifact.'),
        html: z.string().describe('The complete replacement HTML document, everything inline.'),
        base_version: z
          .number()
          .int()
          .optional()
          .describe('The version this edit was made against. Omit to overwrite whatever is there.'),
      },
    },
    async ({ id, html, base_version }) => {
      const checked = preflight(html)
      if (checked.rejects.length > 0) return refusedByPreflight(checked)

      const pushed = await push(id, html, base_version)

      // Nothing to write: the stored document is already this one. Reported as
      // a success with `changed: false`, because it is one — a watching agent
      // pushing an unchanged file has not failed at anything.
      if (pushed.status === 304) {
        return ok({ id, version: await versionOf(id), changed: false, warns: checked.warns })
      }

      if (pushed.status === 409) {
        const current = (await pushed.json()) as { version: number; hash: string }
        return error({
          status: 409,
          conflict: true,
          current_version: current.version,
          current_hash: current.hash,
          error: `the artifact has moved on: it is at version ${current.version}, which is not the version this edit was made against`,
          hint: 'someone else published since; read it back with get_content, merge, and update against the current version',
        })
      }

      if (!pushed.ok) return await failure(pushed)

      const written = (await pushed.json()) as { version: number }
      return ok({ id, version: written.version, changed: true, warns: checked.warns })
    },
  )

  server.registerTool(
    'get_artifact',
    {
      title: 'Get artifact metadata',
      description:
        'Read an artifact’s name, visibility, version, owner and size. Does not return the document itself.',
      inputSchema: { id: z.string().describe('The artifact id.') },
    },
    async ({ id }) => passThrough(await api(`/api/artifacts/${encodeURIComponent(id)}`)),
  )

  server.registerTool(
    'get_content',
    {
      title: 'Get artifact content',
      description: 'Read back the HTML document stored in an artifact.',
      inputSchema: { id: z.string().describe('The artifact id.') },
    },
    async ({ id }) => {
      const res = await api(`/api/artifacts/${encodeURIComponent(id)}/content`)
      if (!res.ok) return await failure(res)
      const version = Number(res.headers.get('X-Artef-Version'))
      return ok({
        id,
        html: await res.text(),
        version: Number.isInteger(version) ? version : null,
      })
    },
  )

  server.registerTool(
    'list_artifacts',
    {
      title: 'List artifacts',
      description:
        'List the artifacts this credential can see, most recently updated first. ' +
        'A token scoped to particular artifacts sees only those.',
      inputSchema: {},
    },
    async () => passThrough(await api('/api/artifacts')),
  )

  server.registerTool(
    'set_visibility',
    {
      title: 'Set artifact visibility',
      description:
        'Change who can reach an artifact. Only its owner or a workspace admin may do this.',
      inputSchema: {
        id: z.string().describe('The artifact id.'),
        visibility: z
          .string()
          .describe(
            `One of: ${VISIBILITIES}. private is the owner alone, restricted is the people ` +
              'granted access, workspace is everyone in the company, public is anyone with the link.',
          ),
      },
    },
    async ({ id, visibility }) =>
      passThrough(await json(`/api/artifacts/${encodeURIComponent(id)}`, 'PATCH', { visibility })),
  )

  server.registerTool(
    'grant_access',
    {
      title: 'Grant access to an artifact',
      description:
        'Share an artifact with a colleague by email address, or change the role of someone already ' +
        'shared with. The address must be in the same workspace as the document.',
      inputSchema: {
        id: z.string().describe('The artifact id.'),
        email: z.string().describe('The colleague’s work email address.'),
        role: z.string().describe(`One of: ${ROLES}. A viewer reads it; an editor can also update it.`),
      },
    },
    async ({ id, email, role }) =>
      passThrough(await json(`/api/artifacts/${encodeURIComponent(id)}/grants`, 'POST', { email, role })),
  )

  return server
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Every tool answers with exactly one text block holding one JSON object,
 * whether it succeeded or not, so an agent parses one thing and branches on
 * `isError` rather than on the shape of what came back.
 */
function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function error(data: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/** A REST answer handed straight to the agent: the body it already speaks, with
 *  a failure marked as one. */
async function passThrough(res: Response): Promise<CallToolResult> {
  if (!res.ok) return await failure(res)
  return ok(await res.json())
}

/**
 * A non-2xx REST answer as tool data. The body of every error on this API is
 * `{"error": …}` (§5), so the agent gets the same message a CLI user would,
 * plus the status it came with. `extra` is for the caller that knows something
 * the route did not — an id it created a moment ago, say.
 */
async function failure(res: Response, extra: Record<string, unknown> = {}): Promise<CallToolResult> {
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const body =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { error: text === '' ? res.statusText : text }

  // Status last, so a body that happened to carry one cannot misreport it.
  return error({ ...body, ...extra, status: res.status })
}

/** The preflight's refusal, as the thing it exists to be: a list the agent can
 *  walk, fixing one entry at a time (§7.1). */
function refusedByPreflight(checked: { rejects: Violation[]; warns: Violation[] }): CallToolResult {
  return error({
    error: 'the document would render broken under the artifact content security policy, so nothing was written',
    rejects: checked.rejects,
    warns: checked.warns,
    hint:
      'everything the document needs must be inline: CSS in <style>, JavaScript in <script>, images as data: URIs. ' +
      'If the document needs a library (chart/diagram/etc.), fetch the library’s source and include it inline — do not reference CDNs',
  })
}
