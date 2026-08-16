// The MCP front door (spec §7.0). Everything here goes over the real `/mcp`
// endpoint with the official SDK client on the other end of it, because the
// point of this route is that a real MCP client can drive it — a test that
// called the tool handlers directly would prove nothing about the transport,
// the handshake, or the JSON-RPC framing.
//
// Two properties run through the file:
//
//   - `/mcp` is bearer-only. A cookie is not a credential here and no token at
//     all is a 401 before any handshake happens (§7.0).
//   - every tool is an adapter over the REST API, so the ACL, the token scope
//     and the wire shapes are the ones `/api` already enforces — and a refusal
//     comes back as tool data the agent can read, never as a protocol error.
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { artifacts } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { closeDb, makeMachineToken, makeUser, resetDb, testDeps, type TestDeps } from './helpers.js'

const HTML = '<!doctype html><title>Q3</title><p>hello</p>'
const CDN_HTML = '<!doctype html><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>'

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

/** An MCP client speaking to this app's `/mcp` over the SDK's own Streamable
 *  HTTP transport, with `fetch` pointed at the in-process app. */
async function connect(token: string | null): Promise<Client> {
  const client = new Client({ name: 'artef-test', version: '0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://artef.test/mcp'), {
      fetch: async (url, init) => deps.app.fetch(new Request(url, init)),
      requestInit: token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

/** The one JSON payload a tool result carries. Every tool answers with a single
 *  text block holding JSON — success or failure — so the agent parses one thing. */
function payload(result: CallToolResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1)
  const [block] = result.content
  if (block.type !== 'text') throw new Error(`expected a text block, got ${block.type}`)
  return JSON.parse(block.text) as Record<string, unknown>
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  return { isError: result.isError === true, body: payload(result) }
}

/** A user, a token, and a connected client — what most cases start from. */
async function agent(opts: { scopeIds?: string[] | null } = {}) {
  const { user, workspace, cookie } = await makeUser(deps)
  const { token, header } = await makeMachineToken(deps, user.id, { scopeIds: opts.scopeIds ?? null })
  return { user, workspace, cookie, token, header, client: await connect(token) }
}

/** An empty artifact row, the way `POST /api/artifacts` writes one — for the
 *  cases that need an id to exist before any MCP call is made. */
async function emptyArtifact(owner: { id: string; workspaceId: string }) {
  const [art] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      visibility: 'private',
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
      version: 0,
    })
    .returning()
  return art
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

describe('/mcp requires a machine token', () => {
  it('refuses a request with no credential, before any handshake', async () => {
    const res = await deps.app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('refuses a token that is not real', async () => {
    const res = await deps.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer art_live_notarealtoken',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid token' })
  })

  it('refuses a browser session cookie — this door is for agents', async () => {
    const { cookie } = await makeUser(deps)
    const res = await deps.app.request('/mcp', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('introduces itself with the version from package.json — never a constant', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id)
    const res = await deps.app.request('/mcp', {
      method: 'POST',
      headers: { ...header, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    })
    expect(res.status).toBe(200)
    const { result } = (await res.json()) as { result: { serverInfo: { name: string; version: string } } }
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(result.serverInfo).toEqual({ name: 'artef', version: manifest.version })
  })

  it('offers no server-to-client stream, because it holds no session', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id)

    for (const method of ['GET', 'DELETE']) {
      const res = await deps.app.request('/mcp', {
        method,
        headers: { ...header, Accept: 'text/event-stream' },
      })
      expect(res.status, method).toBe(405)
      expect(await res.json(), method).toEqual({ error: 'the mcp endpoint is stateless: use POST' })
    }
  })

  it('refuses an expired token', async () => {
    const { user } = await makeUser(deps)
    const { header } = await makeMachineToken(deps, user.id, { expiresAt: new Date(Date.now() - 1000) })
    const res = await deps.app.request('/mcp', {
      method: 'POST',
      headers: { ...header, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('tools/list over the wire', () => {
  it('advertises the seven tools of spec §7.0, each with an input schema', async () => {
    const { client } = await agent()
    const { tools } = await client.listTools()

    expect(tools.map(t => t.name).sort()).toEqual([
      'get_artifact',
      'get_content',
      'grant_access',
      'list_artifacts',
      'publish_artifact',
      'set_visibility',
      'update_artifact',
    ])
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy()
      expect(tool.inputSchema.type, tool.name).toBe('object')
    }
    await client.close()
  })

  it("describes publish_artifact's arguments so an agent can fill them in", async () => {
    const { client } = await agent()
    const { tools } = await client.listTools()
    const publish = tools.find(t => t.name === 'publish_artifact')!
    const properties = publish.inputSchema.properties as Record<string, unknown>

    expect(Object.keys(properties).sort()).toEqual(['html', 'name', 'visibility'])
    expect(publish.inputSchema.required).toEqual(['html'])
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('publish_artifact', () => {
  it('creates the artifact, pushes the html, and hands back the url', async () => {
    const { client, user } = await agent()

    const published = await call(client, 'publish_artifact', { html: HTML, name: 'Q3 Report' })
    expect(published.isError).toBe(false)
    expect(published.body.version).toBe(1)
    expect(published.body.url).toBe(`https://artef.test/a/${published.body.id}`)

    // Read back through the transport, not the database: the round trip is the
    // thing being tested.
    const content = await call(client, 'get_content', { id: published.body.id })
    expect(content.isError).toBe(false)
    expect(content.body.html).toBe(HTML)

    const meta = await call(client, 'get_artifact', { id: published.body.id })
    expect(meta.body.name).toBe('Q3 Report')
    expect(meta.body.visibility).toBe('private')
    expect(meta.body.owner_id).toBe(user.id)
    await client.close()
  })

  it('honours the visibility it was asked for', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML, visibility: 'workspace' })
    const meta = await call(client, 'get_artifact', { id: published.body.id })
    expect(meta.body.visibility).toBe('workspace')
    await client.close()
  })

  it('surfaces a rejected visibility as tool data, not a protocol error', async () => {
    const { client } = await agent()
    const result = await call(client, 'publish_artifact', { html: HTML, visibility: 'everyone' })
    expect(result.isError).toBe(true)
    expect(String(result.body.error)).toContain('visibility must be one of')
    expect(result.body.status).toBe(422)
    await client.close()
  })
})

describe('the preflight refuses a document the CSP would break', () => {
  it('rejects a CDN script and says which rule, without creating anything', async () => {
    const { client } = await agent()

    const result = await call(client, 'publish_artifact', { html: CDN_HTML })
    expect(result.isError).toBe(true)

    const rejects = result.body.rejects as Array<Record<string, string>>
    expect(rejects).toHaveLength(1)
    expect(rejects[0].rule).toBe('script-src')
    expect(rejects[0].what).toContain('https://cdn.jsdelivr.net/npm/chart.js')
    expect(rejects[0].detail).toBeTruthy()

    // Refused before the first write: a preflight that left a husk behind would
    // be worse than no preflight at all.
    expect(await deps.db.select().from(artifacts)).toHaveLength(0)
    await client.close()
  })

  it('publishes a document that only warns, and reports the warning', async () => {
    const { client } = await agent()
    const html = `<!doctype html><script>fetch('/api/x')</script>`

    const result = await call(client, 'publish_artifact', { html })
    expect(result.isError).toBe(false)
    const warns = result.body.warns as Array<Record<string, string>>
    expect(warns.map(w => w.rule)).toEqual(['connect-src'])
    await client.close()
  })

  it('refuses an update the same way it refuses a publish', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const result = await call(client, 'update_artifact', { id: published.body.id, html: CDN_HTML })
    expect(result.isError).toBe(true)
    expect((result.body.rejects as Array<Record<string, string>>)[0].rule).toBe('script-src')

    // The stored document is untouched.
    const content = await call(client, 'get_content', { id: published.body.id })
    expect(content.body.html).toBe(HTML)
    await client.close()
  })
})

describe('update_artifact', () => {
  it('bumps the version and reports the change', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const updated = await call(client, 'update_artifact', {
      id: published.body.id,
      html: `${HTML}<p>more</p>`,
    })
    expect(updated.isError).toBe(false)
    expect(updated.body).toMatchObject({ version: 2, changed: true })
    await client.close()
  })

  it('reports an unchanged push as no change rather than a new version', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const again = await call(client, 'update_artifact', { id: published.body.id, html: HTML })
    expect(again.isError).toBe(false)
    expect(again.body).toMatchObject({ version: 1, changed: false })
    await client.close()
  })

  it('turns a stale base_version into a structured conflict', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })
    await call(client, 'update_artifact', { id: published.body.id, html: `${HTML}<p>two</p>` })

    const stale = await call(client, 'update_artifact', {
      id: published.body.id,
      html: `${HTML}<p>three</p>`,
      base_version: 1,
    })
    expect(stale.isError).toBe(true)
    expect(stale.body.conflict).toBe(true)
    expect(stale.body.current_version).toBe(2)
    expect(String(stale.body.hint)).toBeTruthy()
    await client.close()
  })

  it('accepts a base_version that is current', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const ok = await call(client, 'update_artifact', {
      id: published.body.id,
      html: `${HTML}<p>two</p>`,
      base_version: 1,
    })
    expect(ok.isError).toBe(false)
    expect(ok.body.version).toBe(2)
    await client.close()
  })

  it('answers an id that is not there the way the API does', async () => {
    const { client } = await agent()
    const missing = await call(client, 'update_artifact', {
      id: '00000000-0000-4000-8000-000000000000',
      html: HTML,
    })
    expect(missing.isError).toBe(true)
    expect(missing.body).toMatchObject({ status: 404, error: 'not found' })
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// The adapters carry the REST rules with them
// ---------------------------------------------------------------------------

describe('a scoped token', () => {
  it('may update the artifact it names but may not publish a new one', async () => {
    const { user } = await makeUser(deps)
    const art = await emptyArtifact(user)
    const { token } = await makeMachineToken(deps, user.id, { scopeIds: [art.id] })
    const client = await connect(token)

    const updated = await call(client, 'update_artifact', { id: art.id, html: HTML })
    expect(updated.isError).toBe(false)
    expect(updated.body.version).toBe(1)

    const published = await call(client, 'publish_artifact', { html: HTML })
    expect(published.isError).toBe(true)
    expect(published.body.status).toBe(403)
    expect(String(published.body.error)).toContain('scoped')
    await client.close()
  })

  it('sees only its own artifact when it lists', async () => {
    const { user } = await makeUser(deps)
    const mine = await emptyArtifact(user)
    await emptyArtifact(user)
    const { token } = await makeMachineToken(deps, user.id, { scopeIds: [mine.id] })
    const client = await connect(token)

    const listed = await call(client, 'list_artifacts')
    expect((listed.body.items as Array<{ id: string }>).map(i => i.id)).toEqual([mine.id])
    await client.close()
  })
})

describe('list_artifacts', () => {
  it("returns the caller's artifacts", async () => {
    const { client } = await agent()
    const first = await call(client, 'publish_artifact', { html: HTML, name: 'one' })
    const second = await call(client, 'publish_artifact', { html: `${HTML}<p>2</p>`, name: 'two' })

    const listed = await call(client, 'list_artifacts')
    expect(listed.isError).toBe(false)
    const ids = (listed.body.items as Array<{ id: string }>).map(i => i.id)
    expect(new Set(ids)).toEqual(new Set([first.body.id, second.body.id]))
    await client.close()
  })

  it("does not show another workspace's documents", async () => {
    const { client } = await agent()
    const stranger = await makeUser(deps, { domain: 'other.example' })
    await emptyArtifact(stranger.user)

    const listed = await call(client, 'list_artifacts')
    expect(listed.body.items).toEqual([])
    await client.close()
  })
})

describe('set_visibility', () => {
  it('changes it, and the change is visible through get_artifact', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const changed = await call(client, 'set_visibility', {
      id: published.body.id,
      visibility: 'public',
    })
    expect(changed.isError).toBe(false)
    expect(changed.body.visibility).toBe('public')

    const meta = await call(client, 'get_artifact', { id: published.body.id })
    expect(meta.body.visibility).toBe('public')
    await client.close()
  })

  it('refuses a visibility that is not one of the four', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })
    const result = await call(client, 'set_visibility', { id: published.body.id, visibility: 'secret' })
    expect(result.isError).toBe(true)
    expect(result.body.status).toBe(422)
    await client.close()
  })
})

describe('grant_access', () => {
  it('shares the document with a colleague', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const granted = await call(client, 'grant_access', {
      id: published.body.id,
      email: 'priya@example.com',
      role: 'editor',
    })
    expect(granted.isError).toBe(false)
    expect(granted.body).toMatchObject({ email: 'priya@example.com', role: 'editor' })
    await client.close()
  })

  it('surfaces the 422 for an address outside the workspace, message and all', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const refused = await call(client, 'grant_access', {
      id: published.body.id,
      email: 'someone@notourcompany.test',
      role: 'viewer',
    })
    expect(refused.isError).toBe(true)
    expect(refused.body.status).toBe(422)
    expect(String(refused.body.error)).toContain('can only be shared inside its own workspace')
    await client.close()
  })

  it('surfaces the 422 for a personal email domain', async () => {
    const { client } = await agent()
    const published = await call(client, 'publish_artifact', { html: HTML })

    const refused = await call(client, 'grant_access', {
      id: published.body.id,
      email: 'someone@gmail.com',
      role: 'viewer',
    })
    expect(refused.isError).toBe(true)
    expect(refused.body.status).toBe(422)
    expect(String(refused.body.error)).toContain('personal email domain')
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// Not-yours is not-found, here as everywhere
// ---------------------------------------------------------------------------

describe("another workspace's document", () => {
  it('is not found by any of the reading tools', async () => {
    const { client } = await agent()
    const stranger = await makeUser(deps, { domain: 'other.example' })
    const art = await emptyArtifact(stranger.user)

    for (const tool of ['get_artifact', 'get_content']) {
      const result = await call(client, tool, { id: art.id })
      expect(result.isError, tool).toBe(true)
      expect(result.body.status, tool).toBe(404)
    }
    await client.close()
  })
})
