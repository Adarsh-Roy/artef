// The homepage (GET /): three signed-in sections and their pagination.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { artifactGrants, artifacts } from '../src/db/schema.js'
import { sha256 } from '../src/lib/crypto.js'
import { gzipBuf } from '../src/lib/gzip.js'
import { closeDb, makeUser, resetDb, testDeps, type TestDeps } from './helpers.js'

let deps: TestDeps

beforeEach(async () => {
  deps = await testDeps()
  await resetDb(deps.pool)
})

afterAll(closeDb)

async function makeArtifact(opts: {
  workspaceId: string
  ownerId: string
  name?: string
  visibility?: 'private' | 'restricted' | 'workspace' | 'public'
}) {
  const [art] = await deps.db
    .insert(artifacts)
    .values({
      workspaceId: opts.workspaceId,
      ownerId: opts.ownerId,
      name: opts.name ?? null,
      visibility: opts.visibility ?? 'private',
      contentHash: sha256(''),
      body: gzipBuf(''),
      bodyBytes: 0,
      version: 1,
    })
    .returning()
  return art
}

describe('GET / signed out', () => {
  it('redirects to login with next=/', async () => {
    const res = await deps.app.request('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/auth/login?next=%2F')
  })
})

describe('GET / signed in', () => {
  it('buckets owned, granted, and workspace-visible documents separately', async () => {
    const me = await makeUser(deps)
    const colleague = await makeUser(deps)
    const mine = await makeArtifact({
      workspaceId: me.user.workspaceId, ownerId: me.user.id, name: 'my doc',
    })
    const shared = await makeArtifact({
      workspaceId: me.user.workspaceId, ownerId: colleague.user.id,
      name: 'shared doc', visibility: 'restricted',
    })
    await deps.db.insert(artifactGrants).values({
      artifactId: shared.id, userId: me.user.id, role: 'editor', grantedBy: colleague.user.id,
    })
    const open = await makeArtifact({
      workspaceId: me.user.workspaceId, ownerId: colleague.user.id,
      name: 'workspace doc', visibility: 'workspace',
    })

    const res = await deps.app.request('/', { headers: { Cookie: me.cookie } })
    expect(res.status).toBe(200)
    const html = await res.text()

    // Each document links to its shell page, in its own section.
    const yours = html.slice(html.indexOf('Your documents'), html.indexOf('Shared with you'))
    const sharedSection = html.slice(html.indexOf('Shared with you'), html.indexOf('From your workspace'))
    const workspace = html.slice(html.indexOf('From your workspace'))
    expect(yours).toContain(`/a/${mine.id}`)
    expect(sharedSection).toContain(`/a/${shared.id}`)
    // §12.1: the editor badge says "can update", never "can edit".
    expect(sharedSection).toContain('can update')
    expect(workspace).toContain(`/a/${open.id}`)
  })

  it('never shows another workspace, and never shows ungranted private docs', async () => {
    const me = await makeUser(deps)
    const colleague = await makeUser(deps)
    const stranger = await makeUser(deps, { domain: 'elsewhere.test' })
    const foreign = await makeArtifact({
      workspaceId: stranger.user.workspaceId, ownerId: stranger.user.id,
      name: 'foreign', visibility: 'public',
    })
    const private_ = await makeArtifact({
      workspaceId: me.user.workspaceId, ownerId: colleague.user.id,
      name: 'not mine', visibility: 'private',
    })
    // One document of my own, so the page renders the real list. Without it
    // the empty state would satisfy both `not.toContain`s no matter what the
    // queries did.
    const anchor = await makeArtifact({
      workspaceId: me.user.workspaceId, ownerId: me.user.id, name: 'mine',
    })

    const res = await deps.app.request('/', { headers: { Cookie: me.cookie } })
    const html = await res.text()
    expect(html).toContain(anchor.id)
    expect(html).not.toContain(foreign.id)
    expect(html).not.toContain(private_.id)
  })

  it('escapes document names', async () => {
    const me = await makeUser(deps)
    await makeArtifact({
      workspaceId: me.user.workspaceId, ownerId: me.user.id,
      name: '<img src=x onerror=alert(1)>',
    })
    const html = await (await deps.app.request('/', { headers: { Cookie: me.cookie } })).text()
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('shows an admin the same personal view, not every private doc', async () => {
    const admin = await makeUser(deps, { isAdmin: true })
    const colleague = await makeUser(deps)
    const private_ = await makeArtifact({
      workspaceId: admin.user.workspaceId, ownerId: colleague.user.id,
      name: 'private', visibility: 'private',
    })
    // Same reason as above: the admin owns something, so this is the populated
    // page rather than the empty state.
    const own = await makeArtifact({
      workspaceId: admin.user.workspaceId, ownerId: admin.user.id, name: 'admin doc',
    })
    const html = await (await deps.app.request('/', { headers: { Cookie: admin.cookie } })).text()
    expect(html).toContain(own.id)
    expect(html).not.toContain(private_.id)
  })
})

describe('deleting from the homepage', () => {
  it('owned rows carry a delete button and the page carries the dialog', async () => {
    const me = await makeUser(deps)
    await makeArtifact({ workspaceId: me.user.workspaceId, ownerId: me.user.id, name: 'mine' })
    const html = await (await deps.app.request('/', { headers: { Cookie: me.cookie } })).text()
    expect(html).toContain('class="icon-btn delete"')
    expect(html).toContain('id="delete-dialog"')
    // The copy promises permanence, and says what goes with the document.
    expect(html).toContain('cannot be undone')
    expect(html).toContain('version history')
    expect(html).toContain("everyone's access")
  })

  it('rows that are not owned carry no delete button', async () => {
    const me = await makeUser(deps)
    const colleague = await makeUser(deps)
    const art = await makeArtifact({
      workspaceId: me.user.workspaceId, ownerId: colleague.user.id, visibility: 'workspace',
    })
    await deps.db.insert(artifactGrants).values({
      artifactId: art.id, userId: me.user.id, role: 'editor', grantedBy: colleague.user.id,
    })
    const html = await (await deps.app.request('/', { headers: { Cookie: me.cookie } })).text()
    expect(html).not.toContain('class="icon-btn delete"')
    // No dialog and no script for buttons that are not on the page.
    expect(html).not.toContain('id="delete-dialog"')
    expect(html).not.toContain("method: 'DELETE'")
  })

  it('wires each button to DELETE on its own artifact and reloads on success', async () => {
    const me = await makeUser(deps)
    await makeArtifact({ workspaceId: me.user.workspaceId, ownerId: me.user.id, name: 'mine' })
    const html = await (await deps.app.request('/', { headers: { Cookie: me.cookie } })).text()

    // The id comes off the clicked button, so it is escaped on its way into
    // the URL rather than trusted to be path-safe.
    expect(html).toContain("'/api/artifacts/' + encodeURIComponent(id)")
    expect(html).toContain("method: 'DELETE'")
    expect(html).toContain("credentials: 'same-origin'")
    // 204 is the only success the API gives; the row is gone, so the list is
    // re-read rather than patched.
    expect(html).toContain('res.status !== 204')
    expect(html).toContain('location.reload()')
    // A second click while the first is in flight must not fire a second DELETE.
    expect(html).toContain('confirm.disabled = true')
    // …and a failure says so, in the dialog, rather than silently doing nothing.
    expect(html).toContain('Could not delete. Try again.')
    // The message is a <p> inside the dialog, so its rule has to outrank the
    // muted-paragraph rule above it or the failure renders grey.
    expect(html).toMatch(/#delete-dialog #delete-status\{[^}]*color:var\(--danger\)/)
    // The name is written as text, never as markup — it was authored by
    // whoever pushed the document.
    expect(html).toContain('nameSlot.textContent = button.dataset.name')
    // Hidden until the row is hovered or something in it takes focus, so the
    // list stays quiet and the button is still reachable from the keyboard.
    expect(html).toMatch(/\.doc-row:hover \.delete,\.doc-row:focus-within \.delete\{visibility:visible\}/)
  })
})

describe('GET / pagination', () => {
  it('previews 10 per section with a See all link when there are more', async () => {
    const me = await makeUser(deps)
    for (let i = 0; i < 12; i++) {
      await makeArtifact({ workspaceId: me.user.workspaceId, ownerId: me.user.id, name: `doc ${i}` })
    }
    const html = await (await deps.app.request('/', { headers: { Cookie: me.cookie } })).text()
    expect((html.match(/class="doc-row"/g) ?? []).length).toBe(10)
    expect(html).toContain('/?section=yours')
  })

  it('pages a section with a cursor and stops when exhausted', async () => {
    const me = await makeUser(deps)
    for (let i = 0; i < 55; i++) {
      await makeArtifact({ workspaceId: me.user.workspaceId, ownerId: me.user.id, name: `doc ${i}` })
    }
    const first = await (await deps.app.request('/?section=yours', { headers: { Cookie: me.cookie } })).text()
    expect((first.match(/class="doc-row"/g) ?? []).length).toBe(50)
    const older = /href="\/\?section=yours&amp;cursor=([^"]+)"/.exec(first)
    expect(older).not.toBeNull()
    const second = await (
      await deps.app.request(`/?section=yours&cursor=${older![1]}`, { headers: { Cookie: me.cookie } })
    ).text()
    expect((second.match(/class="doc-row"/g) ?? []).length).toBe(5)
    expect(second).not.toContain('&amp;cursor=')
  })

  it('redirects an invalid section or cursor back to /', async () => {
    const me = await makeUser(deps)
    for (const path of ['/?section=nonsense', '/?section=yours&cursor=!!!']) {
      const res = await deps.app.request(path, { headers: { Cookie: me.cookie } })
      expect(res.status, path).toBe(302)
      expect(res.headers.get('Location'), path).toBe('/')
    }
  })
})
