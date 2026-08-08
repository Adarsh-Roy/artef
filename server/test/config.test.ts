import { describe, it, expect } from 'vitest'
import { loadConfig, ConfigError } from '../src/config.js'

const base = {
  URL: 'https://artef.example.com', SECRET_KEY: 's'.repeat(32),
  DATABASE_URL: 'postgres://artef:artef@localhost:5433/artef',
  ALLOWED_DOMAINS: 'example.com', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y',
}

describe('loadConfig', () => {
  it('parses a minimal valid env with spec defaults', () => {
    const c = loadConfig(base as any)
    expect(c.maxArtifactBytes).toBe(10485760)
    expect(c.maxVersions).toBe(20)
    expect(c.linkPreview).toBe('name')
    expect(c.allowedDomains).toEqual(['example.com'])
  })
  it('rejects missing SECRET_KEY', () => {
    expect(() => loadConfig({ ...base, SECRET_KEY: undefined } as any)).toThrow(ConfigError)
  })
  it('refuses consumer domains in ALLOWED_DOMAINS (spec §4.3 rule 2)', () => {
    expect(() => loadConfig({ ...base, ALLOWED_DOMAINS: 'example.com,gmail.com' } as any))
      .toThrow(/gmail\.com/)
  })
  it('requires at least one auth provider', () => {
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined } as any))
      .toThrow(/auth provider/i)
  })
  it('parses WORKSPACE_DOMAIN_MAP', () => {
    const c = loadConfig({ ...base, WORKSPACE_DOMAIN_MAP: 'a.com=example.com, b.com=example.com' } as any)
    expect(c.workspaceDomainMap).toEqual({ 'a.com': 'example.com', 'b.com': 'example.com' })
  })
  // Hardening A1 (spec §4.3 "refuse at startup"): the map is made safe by
  // construction, so no call site has to remember to re-check the blocklist.
  it('refuses a WORKSPACE_DOMAIN_MAP key that is a consumer domain', () => {
    expect(() => loadConfig({ ...base, WORKSPACE_DOMAIN_MAP: 'gmail.com=company.com' } as any))
      .toThrow(/gmail\.com/)
  })
  it('refuses a WORKSPACE_DOMAIN_MAP target that is not an allowed domain', () => {
    expect(() => loadConfig({ ...base, WORKSPACE_DOMAIN_MAP: 'a.com=not-allowed.com' } as any))
      .toThrow(ConfigError)
  })
  // Hardening A2: a partially configured provider is a deployment mistake, not
  // an intent to disable it, so it is refused rather than silently dropped.
  it('refuses a half-configured Google provider even when OIDC is complete', () => {
    expect(() => loadConfig({
      ...base,
      GOOGLE_CLIENT_SECRET: undefined,
      OIDC_ISSUER_URL: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'oidc-id',
      OIDC_CLIENT_SECRET: 'oidc-secret',
    } as any)).toThrow(ConfigError)
  })
  it('refuses a partially configured OIDC provider even when Google is complete', () => {
    expect(() => loadConfig({
      ...base,
      OIDC_ISSUER_URL: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'oidc-id',
      // OIDC_CLIENT_SECRET intentionally absent — the triple is incomplete.
    } as any)).toThrow(ConfigError)
  })
})
