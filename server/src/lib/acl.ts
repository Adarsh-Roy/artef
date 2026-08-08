// The whole authorization model (spec §4.2). No policy engine — one function.
// It is pure: the caller looks up the grant row and passes `grantRole`.

export type Role = 'viewer' | 'editor'

export interface AclUser {
  id: string
  workspaceId: string
  isAdmin: boolean
}

export interface AclArtifact {
  workspaceId: string
  ownerId: string
  visibility: 'private' | 'restricted' | 'workspace' | 'public'
}

/**
 * Can `user` do `need` to `art`? The order of the checks is the spec's:
 * public viewing is decided before login, workspace isolation is enforced once
 * at the top, and only then do the per-visibility rules run.
 */
export function can(
  user: AclUser | null,
  art: AclArtifact,
  need: Role,
  grantRole: Role | null,
): boolean {
  if (art.visibility === 'public' && need === 'viewer') return true
  if (user === null || user.workspaceId !== art.workspaceId) return false
  if (user.id === art.ownerId || user.isAdmin) return true
  if (art.visibility === 'workspace') return need === 'viewer' || grantRole === 'editor'
  if (art.visibility === 'restricted') {
    return grantRole !== null && (need === 'viewer' || grantRole === 'editor')
  }
  // Falls through for 'private' (owner and admins only — grants are ignored) and
  // for updating a 'public' artifact, which the spec's function also refuses:
  // publishing a doc leaves only the owner and admins able to change it.
  return false
}
