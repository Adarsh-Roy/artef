import { describe, it, expect } from 'vitest'
import { can, type AclArtifact, type AclUser } from '../src/lib/acl.js'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

const owner: AclUser = { id: 'u-owner', workspaceId: WS, isAdmin: false }
const member: AclUser = { id: 'u-member', workspaceId: WS, isAdmin: false }
const admin: AclUser = { id: 'u-admin', workspaceId: WS, isAdmin: true }
const outsider: AclUser = { id: 'u-outsider', workspaceId: OTHER_WS, isAdmin: false }
const outsideAdmin: AclUser = { id: 'u-outside-admin', workspaceId: OTHER_WS, isAdmin: true }

const art = (visibility: AclArtifact['visibility']): AclArtifact => ({
  workspaceId: WS,
  ownerId: owner.id,
  visibility,
})

describe('can — public', () => {
  const a = art('public')

  it('lets anyone with the link view, logged in or not', () => {
    expect(can(null, a, 'viewer', null)).toBe(true)
    expect(can(member, a, 'viewer', null)).toBe(true)
    expect(can(outsider, a, 'viewer', null)).toBe(true)
  })
  it('does not let a logged-out visitor update', () => {
    expect(can(null, a, 'editor', null)).toBe(false)
  })
  it('lets the owner and admins update', () => {
    expect(can(owner, a, 'editor', null)).toBe(true)
    expect(can(admin, a, 'editor', null)).toBe(true)
  })
  // Publishing a doc must not silently revoke the write access of people it was
  // already shared with (§5.9: named people keep "can update" alongside
  // "Anyone with the link").
  it('lets an editor grant update', () => {
    expect(can(member, a, 'editor', 'editor')).toBe(true)
  })
  it('does not let a viewer grant or an ungranted member update', () => {
    expect(can(member, a, 'editor', 'viewer')).toBe(false)
    expect(can(member, a, 'editor', null)).toBe(false)
  })
  // Pins the check order: workspace isolation is decided before the editor-grant
  // branch below it, so a grant row that should not exist cannot be honored.
  it('does not let an out-of-workspace user update, grant or not', () => {
    expect(can(outsider, a, 'editor', 'editor')).toBe(false)
    expect(can(outsideAdmin, a, 'editor', 'editor')).toBe(false)
  })
})

describe('can — logged-out visitor on everything else', () => {
  it('is refused on private, restricted and workspace artifacts', () => {
    for (const v of ['private', 'restricted', 'workspace'] as const) {
      expect(can(null, art(v), 'viewer', null)).toBe(false)
      expect(can(null, art(v), 'editor', null)).toBe(false)
      // A grant row cannot exist for a null user, but never trust it if one is passed.
      expect(can(null, art(v), 'viewer', 'editor')).toBe(false)
    }
  })
})

describe('can — workspace isolation', () => {
  it('refuses a user from another workspace on every non-public artifact', () => {
    for (const v of ['private', 'restricted', 'workspace'] as const) {
      expect(can(outsider, art(v), 'viewer', null)).toBe(false)
      expect(can(outsider, art(v), 'editor', null)).toBe(false)
    }
  })
  it('refuses even an admin from another workspace', () => {
    for (const v of ['private', 'restricted', 'workspace', 'public'] as const) {
      expect(can(outsideAdmin, art(v), 'editor', null)).toBe(false)
    }
    expect(can(outsideAdmin, art('workspace'), 'viewer', null)).toBe(false)
  })
  it('refuses an out-of-workspace user holding an editor grant', () => {
    expect(can(outsider, art('restricted'), 'viewer', 'editor')).toBe(false)
    expect(can(outsider, art('restricted'), 'editor', 'editor')).toBe(false)
    expect(can(outsideAdmin, art('restricted'), 'editor', 'editor')).toBe(false)
  })
})

describe('can — private', () => {
  const a = art('private')

  it('lets the owner view and update', () => {
    expect(can(owner, a, 'viewer', null)).toBe(true)
    expect(can(owner, a, 'editor', null)).toBe(true)
  })
  it('lets a workspace admin view and update', () => {
    expect(can(admin, a, 'viewer', null)).toBe(true)
    expect(can(admin, a, 'editor', null)).toBe(true)
  })
  it('refuses another member of the workspace', () => {
    expect(can(member, a, 'viewer', null)).toBe(false)
    expect(can(member, a, 'editor', null)).toBe(false)
  })
  it('ignores grants — a stale grant row does not reopen a private artifact', () => {
    expect(can(member, a, 'viewer', 'viewer')).toBe(false)
    expect(can(member, a, 'viewer', 'editor')).toBe(false)
    expect(can(member, a, 'editor', 'editor')).toBe(false)
  })
})

describe('can — restricted', () => {
  const a = art('restricted')

  it('refuses a member with no grant', () => {
    expect(can(member, a, 'viewer', null)).toBe(false)
    expect(can(member, a, 'editor', null)).toBe(false)
  })
  it('lets a viewer grant view but not update', () => {
    expect(can(member, a, 'viewer', 'viewer')).toBe(true)
    expect(can(member, a, 'editor', 'viewer')).toBe(false)
  })
  it('lets an editor grant view and update', () => {
    expect(can(member, a, 'viewer', 'editor')).toBe(true)
    expect(can(member, a, 'editor', 'editor')).toBe(true)
  })
  it('lets the owner and admins in without a grant', () => {
    expect(can(owner, a, 'editor', null)).toBe(true)
    expect(can(admin, a, 'editor', null)).toBe(true)
  })
})

describe('can — workspace', () => {
  const a = art('workspace')

  it('lets any member view without a grant', () => {
    expect(can(member, a, 'viewer', null)).toBe(true)
  })
  it('does not let a member update without an editor grant', () => {
    expect(can(member, a, 'editor', null)).toBe(false)
    expect(can(member, a, 'editor', 'viewer')).toBe(false)
  })
  it('lets an editor grant update', () => {
    expect(can(member, a, 'editor', 'editor')).toBe(true)
  })
  it('lets the owner and admins update', () => {
    expect(can(owner, a, 'editor', null)).toBe(true)
    expect(can(admin, a, 'editor', null)).toBe(true)
  })
})
