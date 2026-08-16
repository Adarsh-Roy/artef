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

/**
 * One-time codes for the `artef login` browser flow (spec §7.2). The browser is
 * redirected to the CLI's loopback listener carrying a code, not a token, so no
 * long-lived credential ever lands in browser history, a referrer header or a
 * proxy log. The row holds the minted token in plaintext for the sixty seconds
 * between approval and collection — the only window in which it exists outside
 * the CLI — and the `machine_tokens` row is not written until the exchange, so
 * an approval nobody collected leaves no usable credential behind.
 */
export const cliAuthCodes = pgTable('cli_auth_codes', {
  codeHash: bytea('code_hash').primaryKey(),
  token: text('token').notNull(),
  name: text('name').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  prefix: text('prefix').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
})

/**
 * Public OAuth clients, from dynamic registration (RFC 7591) — how an MCP
 * harness introduces itself before the browser flow (spec §7.0). No secret is
 * stored because none exists: these are public clients, and PKCE is what binds
 * an authorization code to the client instance that started the flow.
 */
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name'),
  redirectUris: text('redirect_uris').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
})

/**
 * One-time OAuth authorization codes, hashed like `cli_auth_codes` above.
 * Unlike those, no token is pre-minted here: PKCE has to pass first, so the
 * machine token is created at the exchange, inside the same transaction that
 * spends the code.
 */
export const oauthCodes = pgTable('oauth_codes', {
  codeHash: bytea('code_hash').primaryKey(),
  clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
})

/**
 * Rotating OAuth refresh tokens. `access_token_id` cascades from the machine
 * token it accompanies, so revoking the visible token in the token list fully
 * disconnects the client — its next refresh finds no row and has to re-run the
 * browser flow. Only the hash is stored, like every other credential here.
 */
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  tokenHash: bytea('token_hash').primaryKey(),
  clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  accessTokenId: uuid('access_token_id').notNull().references(() => machineTokens.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
})

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
