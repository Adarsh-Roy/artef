import { CONSUMER_DOMAINS } from './lib/consumer-domains.js'

export class ConfigError extends Error {}

export interface Config {
  url: string; secretKey: string; databaseUrl: string
  allowedDomains: string[]; adminEmails: string[]
  maxArtifactBytes: number; maxVersions: number
  linkPreview: 'name' | 'none'
  googleClientId?: string; googleClientSecret?: string
  oidcIssuerUrl?: string; oidcClientId?: string; oidcClientSecret?: string; oidcDisplayName?: string
  workspaceDomainMap: Record<string, string>
  forceHttps: boolean; port: number
}

const splitCsv = (v?: string) => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(`MISSING ${name}`)
  return value
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = optional(env, name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`INVALID ${name}: expected a positive integer, got '${raw}'`)
  return n
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optional(env, name)?.toLowerCase()
  if (raw === undefined) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new ConfigError(`INVALID ${name}: expected 'true' or 'false', got '${raw}'`)
}

// 'a.com=example.com, b.com=example.com' -> { 'a.com': 'example.com', 'b.com': 'example.com' }
function parseDomainMap(raw?: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const entry of splitCsv(raw)) {
    const [from, to, ...rest] = entry.split('=').map(s => s.trim())
    if (!from || !to || rest.length > 0) {
      throw new ConfigError(`INVALID WORKSPACE_DOMAIN_MAP entry '${entry}': expected 'from.com=to.com'`)
    }
    map[from] = to
  }
  return map
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const url = required(env, 'URL')
  try {
    new URL(url)
  } catch {
    throw new ConfigError(`INVALID URL: '${url}' is not a valid URL`)
  }

  const secretKey = required(env, 'SECRET_KEY')
  if (secretKey.length < 32) {
    throw new ConfigError(`INVALID SECRET_KEY: must be at least 32 characters, got ${secretKey.length}`)
  }

  const databaseUrl = required(env, 'DATABASE_URL')

  const allowedDomains = splitCsv(env.ALLOWED_DOMAINS)
  if (allowedDomains.length === 0) throw new ConfigError('MISSING ALLOWED_DOMAINS')
  // Spec §4.3 rule 2: a consumer domain here would make every 'workspace'
  // visibility document readable by anyone with that provider's free account.
  for (const domain of allowedDomains) {
    if (CONSUMER_DOMAINS.has(domain)) {
      throw new ConfigError(
        `INVALID ALLOWED_DOMAINS: '${domain}' is a consumer email domain, so anyone with a free account there could join the workspace`,
      )
    }
  }

  const linkPreview = optional(env, 'LINK_PREVIEW')?.toLowerCase() ?? 'name'
  if (linkPreview !== 'name' && linkPreview !== 'none') {
    throw new ConfigError(`INVALID LINK_PREVIEW: expected 'name' or 'none', got '${linkPreview}'`)
  }

  const googleClientId = optional(env, 'GOOGLE_CLIENT_ID')
  const googleClientSecret = optional(env, 'GOOGLE_CLIENT_SECRET')
  const oidcIssuerUrl = optional(env, 'OIDC_ISSUER_URL')
  const oidcClientId = optional(env, 'OIDC_CLIENT_ID')
  const oidcClientSecret = optional(env, 'OIDC_CLIENT_SECRET')

  const hasGoogle = Boolean(googleClientId && googleClientSecret)
  const hasOidc = Boolean(oidcIssuerUrl && oidcClientId && oidcClientSecret)
  if (!hasGoogle && !hasOidc) {
    throw new ConfigError(
      'MISSING auth provider: set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, or OIDC_ISSUER_URL + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET',
    )
  }

  return {
    url,
    secretKey,
    databaseUrl,
    allowedDomains,
    adminEmails: splitCsv(env.ADMIN_EMAILS),
    maxArtifactBytes: parsePositiveInt(env, 'MAX_ARTIFACT_BYTES', 10485760),
    maxVersions: parsePositiveInt(env, 'MAX_VERSIONS', 20),
    linkPreview,
    googleClientId,
    googleClientSecret,
    oidcIssuerUrl,
    oidcClientId,
    oidcClientSecret,
    oidcDisplayName: optional(env, 'OIDC_DISPLAY_NAME'),
    workspaceDomainMap: parseDomainMap(env.WORKSPACE_DOMAIN_MAP),
    forceHttps: parseBoolean(env, 'FORCE_HTTPS', true),
    port: parsePositiveInt(env, 'PORT', 3000),
  }
}
