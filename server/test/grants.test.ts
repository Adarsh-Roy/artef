// Sharing (spec §5.3) — the endpoints the share dialog drives. Three rules run
// through the whole file:
//
//   - only an owner or an admin may change who can reach a document, and the
//     usual split applies: someone who cannot even view it is told it does not
//     exist, someone who can view it is told they may not (§2.3).
//   - a grant may name a colleague who has never logged in, so the row is
//     pre-provisioned. That makes this the only place besides the login flow
//     deciding which workspace an email belongs to (§4.3).
//   - cross-workspace grants do not exist. An address that does not resolve to
//     the artifact's own workspace is refused, whatever the reason.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { artifactGrants, artifacts, users } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import {
  closeDb,
  makeMachineToken,
  makeUser,
  resetDb,
  testDeps,
  type TestDeps,
} from './helpers.js'

const ORIGIN = 'https://artef.test'
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const UNKNOWN_USER = '00000000-0000-4000-8000-0000000000ff'

type Visibility = 'private' | 'restricted' | 'workspace' | 'public'
type User = typeof users.$inferSelect

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

// --- request helpers ---------------------------------------------------------

function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return deps.app.request(path, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Session auth. A mutation needs `Origin` too, or the CSRF check refuses it. */
const asUser = (cookie: string) => ({ Cookie: cookie, Origin: ORIGIN })

const listGrants = (id: string, headers: Record<string, string>) =>
  send('GET', `/api/artifacts/${id}/grants`, headers)

const addGrant = (id: string, headers: Record<string, string>, body: unknown) =>
  send('POST', `/api/artifacts/${id}/grants`, headers, body)

const removeGrant = (id: string, userId: string, headers: Record<string, string>) =>
  send('DELETE', `/api/artifacts/${id}/grants/${userId}`, headers)

// --- fixtures ----------------------------------------------------------------

async function makeArtifact(
  owner: User,
  opts: { visibility?: Visibility } = {},
): Promise<typeof artifacts.$inferSelect> {
  const [row] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: owner.workspaceId,
      ownerId: owner.id,
      name: 'Q3 infra report',
      visibility: opts.visibility ?? 'private',
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
    })
    .returning()
  return row
}

const grantRows = (artifactId: string) =>
  deps.db.select().from(artifactGrants).where(eq(artifactGrants.artifactId, artifactId))

const userByEmail = async (email: string) =>
  (await deps.db.select().from(users).where(eq(users.email, email)).limit(1))[0]

// ---------------------------------------------------------------------------
// POST /api/artifacts/:id/grants
// ---------------------------------------------------------------------------

describe('POST /api/artifacts/:id/grants', () => {
  it('grants an existing colleague and records who granted it', async () => {
    const owner = await makeUser(deps)
    const colleague = await makeUser(deps, { email: 'priya@example.com' })
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, asUser(owner.cookie), {
      email: 'priya@example.com',
      role: 'viewer',
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      user_id: colleague.user.id,
      email: 'priya@example.com',
      role: 'viewer',
    })

    const rows = await grantRows(art.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(colleague.user.id)
    expect(rows[0].role).toBe('viewer')
    expect(rows[0].grantedBy).toBe(owner.user.id)

    // The grant is what it says it is: the grantee can now read the document.
    const seen = await deps.app.request(`/api/artifacts/${art.id}`, {
      headers: { Cookie: colleague.cookie },
    })
    expect(seen.status).toBe(200)
  })

  it('pre-provisions a user who has never logged in', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, asUser(owner.cookie), {
      email: 'new@example.com',
      role: 'editor',
    })
    expect(res.status).toBe(201)

    const created = await userByEmail('new@example.com')
    expect(created).toBeDefined()
    expect(created.workspaceId).toBe(owner.user.workspaceId)
    // Never an admin by the back door, and never seen — they have not been here.
    expect(created.isAdmin).toBe(false)
    expect(created.lastSeenAt).toBeNull()

    const rows = await grantRows(art.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(created.id)
    expect(rows[0].role).toBe('editor')
  })

  it('lowercases and trims the address rather than creating a second user', async () => {
    const owner = await makeUser(deps)
    const colleague = await makeUser(deps, { email: 'sam@example.com' })
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, asUser(owner.cookie), {
      email: '  SAM@Example.COM ',
      role: 'viewer',
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { user_id: string }).user_id).toBe(colleague.user.id)
    expect(await deps.db.select().from(users)).toHaveLength(2)
  })

  it('refuses an address outside the artifact workspace', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, asUser(owner.cookie), {
      email: 'who@other-corp.com',
      role: 'viewer',
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('example.com')
    expect(await grantRows(art.id)).toHaveLength(0)
    expect(await userByEmail('who@other-corp.com')).toBeUndefined()
  })

  it('refuses a consumer address with a message that says why', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, asUser(owner.cookie), {
      email: 'someone@gmail.com',
      role: 'viewer',
    })
    expect(res.status).toBe(422)
    const { error } = (await res.json()) as { error: string }
    expect(error).toContain('gmail.com')
    expect(error).toMatch(/personal/i)
    expect(await userByEmail('someone@gmail.com')).toBeUndefined()
  })

  it('applies WORKSPACE_DOMAIN_MAP before deciding the address is a stranger', async () => {
    const mapped = await testDeps({ workspaceDomainMap: { 'sub.example.com': 'example.com' } })
    await resetDb(mapped.pool)
    const owner = await makeUser(mapped)
    const [art] = await mapped.db
      .insert(artifacts)
      .values({
        workspaceId: owner.user.workspaceId,
        ownerId: owner.user.id,
        visibility: 'restricted',
        contentHash: sha256(''),
        body: gzipBuf(''),
        bodyBytes: 0,
      })
      .returning()

    const res = await mapped.app.request(`/api/artifacts/${art.id}/grants`, {
      method: 'POST',
      headers: { ...asUser(owner.cookie), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'lee@sub.example.com', role: 'viewer' }),
    })
    expect(res.status).toBe(201)

    const [created] = await mapped.db
      .select()
      .from(users)
      .where(eq(users.email, 'lee@sub.example.com'))
      .limit(1)
    expect(created.workspaceId).toBe(owner.user.workspaceId)
  })

  it('refuses a user row that exists in another workspace', async () => {
    const other = await testDeps({ allowedDomains: ['example.com', 'other.com'] })
    await resetDb(other.pool)
    const owner = await makeUser(other, { domain: 'example.com' })
    const outsider = await makeUser(other, { email: 'zoe@other.com', domain: 'other.com' })
    expect(outsider.user.workspaceId).not.toBe(owner.user.workspaceId)

    const [art] = await other.db
      .insert(artifacts)
      .values({
        workspaceId: owner.user.workspaceId,
        ownerId: owner.user.id,
        visibility: 'restricted',
        contentHash: sha256(''),
        body: gzipBuf(''),
        bodyBytes: 0,
      })
      .returning()

    const res = await other.app.request(`/api/artifacts/${art.id}/grants`, {
      method: 'POST',
      headers: { ...asUser(owner.cookie), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'zoe@other.com', role: 'viewer' }),
    })
    expect(res.status).toBe(422)
  })

  it('upserts on a second grant to the same person: one row, the new role', async () => {
    const owner = await makeUser(deps)
    const colleague = await makeUser(deps, { email: 'priya@example.com' })
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    const body = { email: 'priya@example.com', role: 'viewer' as const }

    expect((await addGrant(art.id, asUser(owner.cookie), body)).status).toBe(201)
    const second = await addGrant(art.id, asUser(owner.cookie), { ...body, role: 'editor' })
    expect(second.status).toBe(200)
    expect(((await second.json()) as { role: string }).role).toBe('editor')

    const rows = await grantRows(art.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('editor')
    expect(rows[0].userId).toBe(colleague.user.id)
  })

  it('refuses to grant the owner a role they already exceed', async () => {
    const owner = await makeUser(deps, { email: 'owner@example.com' })
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, asUser(owner.cookie), {
      email: 'owner@example.com',
      role: 'editor',
    })
    expect(res.status).toBe(422)
    expect(await grantRows(art.id)).toHaveLength(0)
  })

  it('takes only viewer and editor, and only a well-formed address', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    const auth = asUser(owner.cookie)

    expect((await addGrant(art.id, auth, { email: 'a@example.com', role: 'owner' })).status).toBe(422)
    expect((await addGrant(art.id, auth, { email: 'a@example.com', role: 7 })).status).toBe(422)
    expect((await addGrant(art.id, auth, { email: 'a@example.com' })).status).toBe(422)
    expect((await addGrant(art.id, auth, { role: 'viewer' })).status).toBe(400)
    expect((await addGrant(art.id, auth, { email: '', role: 'viewer' })).status).toBe(400)
    expect((await addGrant(art.id, auth, { email: 'nope', role: 'viewer' })).status).toBe(400)
    expect((await addGrant(art.id, auth, { email: 42, role: 'viewer' })).status).toBe(400)
    expect(await grantRows(art.id)).toHaveLength(0)
    // A refused request pre-provisions nobody, so a bad role cannot be used to
    // seed user rows: only the owner exists.
    expect(await deps.db.select().from(users)).toHaveLength(1)
  })

  it('is 403 for an editor-granted user and 404 for everyone who cannot see it', async () => {
    const owner = await makeUser(deps)
    const editor = await makeUser(deps, { email: 'ed@example.com' })
    const stranger = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    await deps.db
      .insert(artifactGrants)
      .values({ artifactId: art.id, userId: editor.user.id, role: 'editor' })

    const body = { email: 'new@example.com', role: 'viewer' }
    // They can see the document, so 403 tells them nothing a GET would not.
    expect((await addGrant(art.id, asUser(editor.cookie), body)).status).toBe(403)
    // They cannot, so as far as they are concerned it is not there.
    expect((await addGrant(art.id, asUser(stranger.cookie), body)).status).toBe(404)
    expect((await addGrant(UNKNOWN_ID, asUser(owner.cookie), body)).status).toBe(404)
    expect((await addGrant('not-a-uuid', asUser(owner.cookie), body)).status).toBe(404)
    expect((await addGrant(art.id, { Origin: ORIGIN }, body)).status).toBe(401)
    // Nothing was pre-provisioned along the way.
    expect(await userByEmail('new@example.com')).toBeUndefined()
  })

  it('lets a workspace admin share a document they do not own', async () => {
    const owner = await makeUser(deps)
    const admin = await makeUser(deps, { isAdmin: true })
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, asUser(admin.cookie), {
      email: 'new@example.com',
      role: 'viewer',
    })
    expect(res.status).toBe(201)
    expect((await grantRows(art.id))[0].grantedBy).toBe(admin.user.id)
  })

  it('works for an agent on a machine token, and honours its scope', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    const elsewhere = await makeArtifact(owner.user, { visibility: 'restricted' })
    const { header } = await makeMachineToken(deps, owner.user.id, { scopeIds: [art.id] })

    const body = { email: 'new@example.com', role: 'viewer' }
    expect((await addGrant(art.id, header, body)).status).toBe(201)
    expect((await addGrant(elsewhere.id, header, body)).status).toBe(404)
  })

  it('refuses a session mutation that did not come from this origin', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })

    const res = await addGrant(art.id, { Cookie: owner.cookie }, {
      email: 'new@example.com',
      role: 'viewer',
    })
    expect(res.status).toBe(403)
    expect(await grantRows(art.id)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET /api/artifacts/:id/grants
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:id/grants', () => {
  it('lists everyone the document is shared with', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    const auth = asUser(owner.cookie)
    await addGrant(art.id, auth, { email: 'priya@example.com', role: 'editor' })
    await addGrant(art.id, auth, { email: 'sam@example.com', role: 'viewer' })

    const res = await listGrants(art.id, auth)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as {
      user_id: string
      email: string
      name: string | null
      role: string
      created_at: string
    }[]
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.email)).toEqual(['priya@example.com', 'sam@example.com'])
    expect(rows.map(r => r.role)).toEqual(['editor', 'viewer'])
    expect(rows[0].user_id).toBe((await userByEmail('priya@example.com')).id)
    // A pre-provisioned colleague has no name yet, and that is a null not a crash.
    expect(rows[0].name).toBeNull()
    expect(Date.parse(rows[0].created_at)).not.toBeNaN()
  })

  it('is empty for a document nobody has been added to', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user)

    const res = await listGrants(art.id, asUser(owner.cookie))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('is 403 for a grantee and 404 for a stranger, an anonymous caller and an unknown id', async () => {
    const owner = await makeUser(deps)
    const grantee = await makeUser(deps, { email: 'priya@example.com' })
    const stranger = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    await addGrant(art.id, asUser(owner.cookie), { email: 'priya@example.com', role: 'viewer' })

    expect((await listGrants(art.id, { Cookie: grantee.cookie })).status).toBe(403)
    expect((await listGrants(art.id, { Cookie: stranger.cookie })).status).toBe(404)
    expect((await listGrants(art.id, {})).status).toBe(401)
    expect((await listGrants(UNKNOWN_ID, { Cookie: owner.cookie })).status).toBe(404)
  })

  it('is 403 for a workspace reader of a workspace-visible document', async () => {
    const owner = await makeUser(deps)
    const peer = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'workspace' })

    // They can read it, so they are told they may not — not that it is missing.
    expect((await listGrants(art.id, { Cookie: peer.cookie })).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/artifacts/:id/grants/:user_id
// ---------------------------------------------------------------------------

describe('DELETE /api/artifacts/:id/grants/:user_id', () => {
  it('removes one person and leaves the rest alone', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    const auth = asUser(owner.cookie)
    await addGrant(art.id, auth, { email: 'priya@example.com', role: 'viewer' })
    await addGrant(art.id, auth, { email: 'sam@example.com', role: 'viewer' })
    const priya = await userByEmail('priya@example.com')

    const res = await removeGrant(art.id, priya.id, auth)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    const rows = await grantRows(art.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).not.toBe(priya.id)
    // The user row survives: they are still a member of the workspace.
    expect(await userByEmail('priya@example.com')).toBeDefined()
  })

  it('is 404 for a grant that is not there', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    const auth = asUser(owner.cookie)

    expect((await removeGrant(art.id, UNKNOWN_USER, auth)).status).toBe(404)
    expect((await removeGrant(art.id, 'not-a-uuid', auth)).status).toBe(404)

    // Including the second time, which is what makes it a real delete and not a
    // silent no-op the dialog would render as success forever.
    await addGrant(art.id, auth, { email: 'priya@example.com', role: 'viewer' })
    const priya = await userByEmail('priya@example.com')
    expect((await removeGrant(art.id, priya.id, auth)).status).toBe(204)
    expect((await removeGrant(art.id, priya.id, auth)).status).toBe(404)
  })

  it('is 403 for a grantee revoking themselves and 404 for a stranger', async () => {
    const owner = await makeUser(deps)
    const grantee = await makeUser(deps, { email: 'priya@example.com' })
    const stranger = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    await addGrant(art.id, asUser(owner.cookie), { email: 'priya@example.com', role: 'editor' })

    expect((await removeGrant(art.id, grantee.user.id, asUser(grantee.cookie))).status).toBe(403)
    expect((await removeGrant(art.id, grantee.user.id, asUser(stranger.cookie))).status).toBe(404)
    expect((await removeGrant(art.id, grantee.user.id, { Origin: ORIGIN })).status).toBe(401)
    expect(await grantRows(art.id)).toHaveLength(1)
  })

  it('revokes access for real: the grantee stops being able to read the document', async () => {
    const owner = await makeUser(deps)
    const grantee = await makeUser(deps, { email: 'priya@example.com' })
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    await addGrant(art.id, asUser(owner.cookie), { email: 'priya@example.com', role: 'viewer' })

    const before = await deps.app.request(`/api/artifacts/${art.id}`, {
      headers: { Cookie: grantee.cookie },
    })
    expect(before.status).toBe(200)

    await removeGrant(art.id, grantee.user.id, asUser(owner.cookie))

    const after = await deps.app.request(`/api/artifacts/${art.id}`, {
      headers: { Cookie: grantee.cookie },
    })
    expect(after.status).toBe(404)
  })

  it('honours a scoped machine token', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    const elsewhere = await makeArtifact(owner.user, { visibility: 'restricted' })
    await addGrant(art.id, asUser(owner.cookie), { email: 'priya@example.com', role: 'viewer' })
    const priya = await userByEmail('priya@example.com')
    const { header } = await makeMachineToken(deps, owner.user.id, { scopeIds: [art.id] })

    expect((await removeGrant(elsewhere.id, priya.id, header)).status).toBe(404)
    expect((await removeGrant(art.id, priya.id, header)).status).toBe(204)
  })
})

// ---------------------------------------------------------------------------
// Deleting the artifact
// ---------------------------------------------------------------------------

describe('grant rows', () => {
  it('go away with the artifact', async () => {
    const owner = await makeUser(deps)
    const art = await makeArtifact(owner.user, { visibility: 'restricted' })
    await addGrant(art.id, asUser(owner.cookie), { email: 'priya@example.com', role: 'viewer' })

    await deps.app.request(`/api/artifacts/${art.id}`, {
      method: 'DELETE',
      headers: asUser(owner.cookie),
    })

    expect(
      await deps.db
        .select()
        .from(artifactGrants)
        .where(and(eq(artifactGrants.artifactId, art.id))),
    ).toHaveLength(0)
  })
})
