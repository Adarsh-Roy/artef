import { pgTable, pgEnum, uuid, text, boolean, timestamp, integer, customType, primaryKey, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const citext = customType<{ data: string }>({ dataType: () => 'citext' })

export const visibilityEnum = pgEnum('visibility_t', ['private', 'restricted', 'workspace', 'public'])
export const roleEnum = pgEnum('role_t', ['viewer', 'editor'])

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  domain: text('domain').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  email: citext('email').notNull().unique(),
  name: text('name'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, precision: 3 }),
})

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text('name'),
  visibility: visibilityEnum('visibility').notNull().default('private'),
  contentHash: bytea('content_hash').notNull(),
  body: bytea('body').notNull(),
  bodyBytes: integer('body_bytes').notNull(),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, t => [index('artifacts_ws_updated_idx').on(t.workspaceId, t.updatedAt.desc())])

export const artifactGrants = pgTable('artifact_grants', {
  artifactId: uuid('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull(),
  grantedBy: uuid('granted_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.artifactId, t.userId] }), index('artifact_grants_user_idx').on(t.userId)])

export const artifactVersions = pgTable('artifact_versions', {
  artifactId: uuid('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  contentHash: bytea('content_hash').notNull(),
  body: bytea('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.artifactId, t.version] })])

export const assets = pgTable('assets', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sha256: bytea('sha256').notNull(),
  mediaType: text('media_type').notNull(),
  body: bytea('body').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.workspaceId, t.sha256] }),
  // The serve path (§5.4) is unauthenticated, so it has no workspace to filter
  // on and looks up by hash alone — which the primary key cannot answer, since
  // `sha256` is its second column. Without this every image request in every
  // artifact view scans the table.
  index('assets_sha256_idx').on(t.sha256),
])

export const machineTokens = pgTable('machine_tokens', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: bytea('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  scopeIds: uuid('scope_ids').array(),
  expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, precision: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
})
