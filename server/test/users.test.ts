// People autocomplete (spec §5.3, §5.9) — the one endpoint behind the share
// dialog's suggestions. Three things this file is really about:
//
//   - it never crosses a workspace boundary. A colleague-shaped name in another
//     company's workspace is not a colleague, and suggesting them would leak the
//     one thing the product promises to keep separate (§4.3).
//   - it answers to a browser session and to nothing else. A machine token that
//     could list everybody's name and address is a directory dump waiting to
//     happen, and an agent has no use for it (§5.6).
//   - it hands back an email and a name, and not one field more.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { users } from '../src/db/schema.js'
import { closeDb, makeMachineToken, makeUser, resetDb, testDeps, type TestDeps } from './helpers.js'

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

type Suggestion = { email: string; name: string | null }

/** The caller: a real user with a real session, in the default workspace. */
async function caller(email = 'me@example.com') {
  const { user, workspace, cookie } = await makeUser(deps, { email })
  return { user, workspace, cookie }
}

/** A colleague row written straight to the table, so a test can control the
 *  name and the address exactly. */
async function colleague(workspaceId: string, email: string, name: string | null) {
  const [row] = await deps.db.insert(users).values({ workspaceId, email, name }).returning()
  return row
}

async function search(cookie: string, query: string): Promise<Response> {
  return deps.app.request(`/api/users/search${query}`, { headers: { Cookie: cookie } })
}

async function suggest(cookie: string, q: string, extra = ''): Promise<Suggestion[]> {
  const res = await search(cookie, `?q=${encodeURIComponent(q)}${extra}`)
  expect(res.status).toBe(200)
  return (await res.json()) as Suggestion[]
}

const emails = (rows: Suggestion[]) => rows.map(r => r.email)

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe('GET /api/users/search', () => {
  it('matches a prefix of the name', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'sb@example.com', 'Saharsh Barve')
    await colleague(workspace.id, 'priya@example.com', 'Priya Nair')

    expect(emails(await suggest(cookie, 'sah'))).toEqual(['sb@example.com'])
  })

  it('matches a prefix of the email', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'saharsh.barve@example.com', null)
    await colleague(workspace.id, 'priya@example.com', 'Priya Nair')

    expect(emails(await suggest(cookie, 'sah'))).toEqual(['saharsh.barve@example.com'])
  })

  it('matches either side, name or email, from one query', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'sb@example.com', 'Saharsh Barve')
    await colleague(workspace.id, 'saharsh.barve@example.com', 'Someone Else')

    expect(emails(await suggest(cookie, 'sah')).sort()).toEqual([
      'saharsh.barve@example.com',
      'sb@example.com',
    ])
  })

  it('is case-insensitive on both sides', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'Saharsh.Barve@Example.com', 'Saharsh Barve')

    for (const q of ['SAH', 'sah', 'SaHaRsH']) {
      expect(emails(await suggest(cookie, q)), q).toEqual(['Saharsh.Barve@Example.com'])
    }
  })

  it('is a prefix match, never a substring one', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'nb@example.com', 'Nikhil Barve')

    // 'barve' appears in the name and in nothing that starts with it.
    expect(await suggest(cookie, 'barve')).toEqual([])
    expect(emails(await suggest(cookie, 'nik'))).toEqual(['nb@example.com'])
  })

  // -------------------------------------------------------------------------
  // The boundary that matters
  // -------------------------------------------------------------------------

  it('never suggests a person from another workspace', async () => {
    const { workspace, cookie } = await caller()
    const mine = await colleague(workspace.id, 'saharsh@example.com', 'Saharsh Barve')
    const other = await makeUser(deps, { domain: 'other.test', email: 'boss@other.test' })
    // Same name, same prefix, different company. This is the one that must not
    // show up, whichever way it is asked for.
    await colleague(other.workspace.id, 'saharsh@other.test', 'Saharsh Barve')

    expect(emails(await suggest(cookie, 'sah'))).toEqual([mine.email])
    expect(await suggest(cookie, 'saharsh@other.test')).toEqual([])
    expect(await suggest(cookie, 'boss')).toEqual([])

    // And symmetrically: the other workspace cannot see into this one.
    expect(emails(await suggest(other.cookie, 'sah'))).toEqual(['saharsh@other.test'])
  })

  it('leaves the caller out of their own results', async () => {
    const { workspace, cookie } = await caller('sam@example.com')
    await colleague(workspace.id, 'sam.other@example.com', 'Sam Other')

    // 'sam' matches both rows; only the colleague comes back.
    expect(emails(await suggest(cookie, 'sam'))).toEqual(['sam.other@example.com'])
    expect(await suggest(cookie, 'sam@example.com')).toEqual([])
  })

  // -------------------------------------------------------------------------
  // What it will not do
  // -------------------------------------------------------------------------

  it('answers an empty or blank q with an empty list, never the directory', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'a@example.com', 'A Person')
    await colleague(workspace.id, 'b@example.com', 'B Person')

    for (const query of ['', '?q=', '?q=%20%20', '?limit=10']) {
      const res = await search(cookie, query)
      expect(res.status, query).toBe(200)
      expect(await res.json(), query).toEqual([])
    }
  })

  it('caps the list at ten however many match and whatever limit asks for', async () => {
    const { workspace, cookie } = await caller()
    for (let i = 0; i < 15; i++) {
      await colleague(workspace.id, `person-${i}@example.com`, `Person ${i}`)
    }

    expect((await suggest(cookie, 'person')).length).toBe(10)
    expect((await suggest(cookie, 'person', '&limit=50')).length).toBe(10)
    expect((await suggest(cookie, 'person', '&limit=nonsense')).length).toBe(10)
    // A smaller limit is honoured — the cap is a ceiling, not a fixed size.
    expect((await suggest(cookie, 'person', '&limit=3')).length).toBe(3)
  })

  it('returns an email and a name and nothing else', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'priya@example.com', 'Priya Nair')

    const [row] = await suggest(cookie, 'priya')
    // Not the id, not is_admin, not last_seen_at: the dialog needs two fields
    // and every extra one is a fact about a colleague nobody asked for.
    expect(Object.keys(row).sort()).toEqual(['email', 'name'])
    expect(row).toEqual({ email: 'priya@example.com', name: 'Priya Nair' })
  })

  it('reports a person nobody has named yet with a null name', async () => {
    const { workspace, cookie } = await caller()
    // Pre-provisioned by an earlier grant: a row with no name at all (§5.3).
    await colleague(workspace.id, 'invited@example.com', null)

    expect(await suggest(cookie, 'invited')).toEqual([
      { email: 'invited@example.com', name: null },
    ])
  })

  it('treats LIKE metacharacters as text, not as a pattern', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'weird@example.com', 'a%b')
    await colleague(workspace.id, 'under_score@example.com', 'Under Score')
    await colleague(workspace.id, 'priya@example.com', 'Priya Nair')

    // '%' as a wildcard would match every row in the workspace. It matches the
    // one person whose name literally starts with it: nobody.
    expect(await suggest(cookie, '%')).toEqual([])
    expect(emails(await suggest(cookie, 'a%'))).toEqual(['weird@example.com'])
    // '_' as a wildcard would match any single character, so 'under_' would
    // still find 'under_score' — 'xnder_' is the one that tells them apart.
    expect(await suggest(cookie, 'xnder_')).toEqual([])
    expect(emails(await suggest(cookie, 'under_'))).toEqual(['under_score@example.com'])
    // A trailing backslash must not escape the wildcard the query builder
    // appends: unescaped, 'a\' + '%' reads as "a, then a literal per cent".
    expect(await suggest(cookie, '\\')).toEqual([])
    expect(await suggest(cookie, 'a\\')).toEqual([])
  })

  it('orders exact address, then name prefix, then email prefix', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'sam@example.com', 'Zoe Wu')
    await colleague(workspace.id, 'zz@example.com', 'Samir Khan')
    await colleague(workspace.id, 'sam.two@example.com', 'Yara Vos')

    // A name match reads as a person; an email match reads as a string. Two
    // email matches fall back to alphabetical, which is Yara before Zoe.
    expect(emails(await suggest(cookie, 'sam'))).toEqual([
      'zz@example.com',
      'sam.two@example.com',
      'sam@example.com',
    ])
  })

  it('puts the address typed in full at the top, whatever else matches it', async () => {
    const { workspace, cookie } = await caller()
    await colleague(workspace.id, 'sam@example.com', 'Zoe Wu')
    // A name that is itself an address — contrived, but it is what makes the
    // exact-email rule observable, and a name is whatever the IdP hands over.
    await colleague(workspace.id, 'zz@example.com', 'sam@example.com')

    expect(emails(await suggest(cookie, 'sam@example.com'))).toEqual([
      'sam@example.com',
      'zz@example.com',
    ])
  })

  // -------------------------------------------------------------------------
  // Who may ask
  // -------------------------------------------------------------------------

  it('refuses a machine token, even a valid one', async () => {
    const { user, workspace } = await caller()
    await colleague(workspace.id, 'priya@example.com', 'Priya Nair')
    const { header } = await makeMachineToken(deps, user.id)

    const res = await deps.app.request('/api/users/search?q=priya', { headers: header })
    // An agent enumerating colleagues is a directory dump, and no agent needs
    // one: it publishes documents and shares them by address (§5.6).
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'session required' })
  })

  it('refuses an anonymous caller', async () => {
    const res = await deps.app.request('/api/users/search?q=priya')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })
})
