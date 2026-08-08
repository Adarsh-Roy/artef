// Hashing and HMAC primitives. Everything here is signed with the single
// SECRET_KEY from config (spec §10) — sessions, content tokens (§2.4) and
// machine tokens (§5.6) share it, so there is no extra key to configure.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Long enough for a slow page load, short enough that a token in a log or a
 *  shared URL is dead before anyone can use it (spec §2.4). Exported because
 *  the mint endpoint tells the client how long it has. */
export const CONTENT_TOKEN_TTL_SECS = 120
const MACHINE_TOKEN_PREFIX = 'art_live_'

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest()
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmacB64url(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('base64url')
}

/**
 * Constant-time buffer comparison that tolerates unequal lengths. Node's
 * timingSafeEqual throws on those, and a length mismatch already means "not the
 * value we expected", so it is rejected up front. Use this anywhere a secret is
 * compared — token hashes included — instead of Buffer.equals.
 */
export function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Compares two base64url signature strings without leaking where they differ.
function sigMatches(expected: string, given: string): boolean {
  return timingSafeEqualBuf(Buffer.from(expected), Buffer.from(given))
}

// Domain-separation prefix for the session HMAC. SECRET_KEY also signs content
// tokens and machine tokens, so every distinct HMAC use of it must carry its own
// prefix — otherwise a signature minted for one purpose could be replayed as
// another. Invariant: any future HMAC over SECRET_KEY gets a distinct prefix.
const SESSION_SIG_PREFIX = 'session:'

/** Session cookie value: `b64url(json) + "." + b64url(HMAC-SHA256(secret, "session:" + b64url(json)))`. */
export function signSession(payload: { uid: string; exp: number }, secret: string): string {
  const jsonB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${jsonB64}.${hmacB64url(secret, SESSION_SIG_PREFIX + jsonB64)}`
}

/** Returns the user id for a well-signed, unexpired cookie; `null` for anything else. */
export function verifySession(value: string, secret: string): { uid: string } | null {
  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [jsonB64, sig] = parts
  if (!sigMatches(hmacB64url(secret, SESSION_SIG_PREFIX + jsonB64), sig)) return null

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(jsonB64, 'base64url').toString())
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const { uid, exp } = payload as { uid?: unknown; exp?: unknown }
  if (typeof uid !== 'string' || uid === '') return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  if (Math.floor(Date.now() / 1000) >= exp) return null
  return { uid }
}

/**
 * Short-lived viewing capability for one artifact (spec §2.4). The artifact id
 * is signed but not carried in the token — `/c/:id` already has it from the URL
 * path and passes it to verification, so a token for A cannot be replayed on B.
 */
export function mintContentToken(artifactId: string, secret: string, nowMs = Date.now()): string {
  const expSecs = Math.floor(nowMs / 1000) + CONTENT_TOKEN_TTL_SECS
  return `${expSecs}.${hmacB64url(secret, `content-token:${artifactId}:${expSecs}`)}`
}

export function verifyContentToken(
  t: string,
  artifactId: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  const parts = t.split('.')
  if (parts.length !== 2) return false
  const [expStr, sig] = parts
  if (!/^\d+$/.test(expStr)) return false
  const expSecs = Number(expStr)
  if (!Number.isSafeInteger(expSecs)) return false
  // The signature covers the expiry exactly as it arrived, not the number it
  // parses to, so a stretched expiry invalidates the token and no rewriting of
  // the digits — "0001700000120" for "1700000120" — verifies as the same token.
  if (!sigMatches(hmacB64url(secret, `content-token:${artifactId}:${expStr}`), sig)) return false
  // Rejects on the expiry second itself, matching verifySession.
  return Math.floor(nowMs / 1000) < expSecs
}

/**
 * Mints a machine token (spec §5.6). Only the hash is ever stored; the plaintext
 * token is returned once, to be shown to the user and then forgotten.
 */
export function generateMachineToken(): { token: string; hash: Buffer; prefix: string } {
  const token = MACHINE_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) }
}

export function hashToken(token: string): Buffer {
  return sha256(token)
}
