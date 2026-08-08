import { describe, it, expect, vi } from 'vitest'
import {
  sha256, sha256Hex, signSession, verifySession,
  mintContentToken, verifyContentToken, generateMachineToken, hashToken,
  timingSafeEqualBuf,
} from '../src/lib/crypto.js'
import { gzipBuf, gunzipCapped, PayloadTooLarge } from '../src/lib/gzip.js'

const secret = 's'.repeat(32)
const other = 'x'.repeat(32)
const nowSecs = () => Math.floor(Date.now() / 1000)

describe('sha256', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
  it('hashes strings and buffers identically', () => {
    expect(sha256('abc').equals(sha256(Buffer.from('abc')))).toBe(true)
    expect(sha256Hex('abc')).toBe(sha256('abc').toString('hex'))
  })
})

describe('signSession / verifySession', () => {
  it('roundtrips a payload', () => {
    const v = signSession({ uid: 'user-1', exp: nowSecs() + 3600 }, secret)
    expect(verifySession(v, secret)).toEqual({ uid: 'user-1' })
  })
  it('rejects a tampered payload', () => {
    const v = signSession({ uid: 'user-1', exp: nowSecs() + 3600 }, secret)
    const [jsonB64, sig] = v.split('.')
    const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: nowSecs() + 3600 }))
      .toString('base64url')
    expect(forged).not.toBe(jsonB64)
    expect(verifySession(`${forged}.${sig}`, secret)).toBeNull()
  })
  it('rejects a tampered signature', () => {
    const v = signSession({ uid: 'user-1', exp: nowSecs() + 3600 }, secret)
    const [jsonB64, sig] = v.split('.')
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A')
    expect(verifySession(`${jsonB64}.${flipped}`, secret)).toBeNull()
  })
  it('rejects a signature made with a different secret', () => {
    const v = signSession({ uid: 'user-1', exp: nowSecs() + 3600 }, other)
    expect(verifySession(v, secret)).toBeNull()
  })
  it('rejects an expired session', () => {
    const v = signSession({ uid: 'user-1', exp: nowSecs() - 1 }, secret)
    expect(verifySession(v, secret)).toBeNull()
  })
  // The expiry second itself is already expired — same boundary as
  // verifyContentToken, so the two never disagree by one second.
  it('rejects a session on the exact expiry second', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      expect(verifySession(signSession({ uid: 'user-1', exp: 1_700_000_000 }, secret), secret)).toBeNull()
      expect(verifySession(signSession({ uid: 'user-1', exp: 1_700_000_001 }, secret), secret)).toEqual({
        uid: 'user-1',
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('rejects malformed values', () => {
    expect(verifySession('', secret)).toBeNull()
    expect(verifySession('nodot', secret)).toBeNull()
    expect(verifySession('a.b.c', secret)).toBeNull()
    expect(verifySession('!!!.!!!', secret)).toBeNull()
  })
})

describe('mintContentToken / verifyContentToken', () => {
  const artifact = '11111111-1111-4111-8111-111111111111'
  const otherArtifact = '22222222-2222-4222-8222-222222222222'
  const now = 1_700_000_000_000

  it('roundtrips for the artifact it was minted for', () => {
    const t = mintContentToken(artifact, secret, now)
    expect(verifyContentToken(t, artifact, secret, now)).toBe(true)
  })
  it('has the "<expSecs>.<sig>" shape with a 120s TTL', () => {
    const t = mintContentToken(artifact, secret, now)
    const [expSecs, sig] = t.split('.')
    expect(Number(expSecs)).toBe(Math.floor(now / 1000) + 120)
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('rejects a token minted for a different artifact', () => {
    const t = mintContentToken(artifact, secret, now)
    expect(verifyContentToken(t, otherArtifact, secret, now)).toBe(false)
  })
  it('rejects a token past its expiry', () => {
    const t = mintContentToken(artifact, secret, now)
    expect(verifyContentToken(t, artifact, secret, now + 119_000)).toBe(true)
    expect(verifyContentToken(t, artifact, secret, now + 121_000)).toBe(false)
  })
  it('rejects a tampered signature', () => {
    const t = mintContentToken(artifact, secret, now)
    const [expSecs, sig] = t.split('.')
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A')
    expect(verifyContentToken(`${expSecs}.${flipped}`, artifact, secret, now)).toBe(false)
  })
  it('rejects an extended expiry replayed with the old signature', () => {
    const t = mintContentToken(artifact, secret, now)
    const sig = t.split('.')[1]
    const later = Math.floor(now / 1000) + 100_000
    expect(verifyContentToken(`${later}.${sig}`, artifact, secret, now)).toBe(false)
  })
  it('rejects a token signed with a different secret', () => {
    const t = mintContentToken(artifact, secret, now)
    expect(verifyContentToken(t, artifact, other, now)).toBe(false)
  })
  it('rejects malformed tokens', () => {
    expect(verifyContentToken('', artifact, secret, now)).toBe(false)
    expect(verifyContentToken('nodot', artifact, secret, now)).toBe(false)
    expect(verifyContentToken('abc.def', artifact, secret, now)).toBe(false)
    expect(verifyContentToken('.', artifact, secret, now)).toBe(false)
  })
  it('rejects an expiry padded with leading zeros — only the minted string verifies', () => {
    const t = mintContentToken(artifact, secret, now)
    const [expStr, sig] = t.split('.')
    expect(verifyContentToken(`0${expStr}.${sig}`, artifact, secret, now)).toBe(false)
    expect(verifyContentToken(`000${expStr}.${sig}`, artifact, secret, now)).toBe(false)
    expect(verifyContentToken(`${expStr}.${sig}`, artifact, secret, now)).toBe(true)
  })
  it('expires exactly on its expiry second, like a session does', () => {
    const t = mintContentToken(artifact, secret, now)
    expect(verifyContentToken(t, artifact, secret, now + 119_000)).toBe(true)
    expect(verifyContentToken(t, artifact, secret, now + 119_999)).toBe(true)
    expect(verifyContentToken(t, artifact, secret, now + 120_000)).toBe(false)
  })
})

describe('timingSafeEqualBuf', () => {
  it('is true for equal buffers', () => {
    expect(timingSafeEqualBuf(Buffer.from('abc'), Buffer.from('abc'))).toBe(true)
    expect(timingSafeEqualBuf(Buffer.alloc(0), Buffer.alloc(0))).toBe(true)
  })
  it('is false for same-length buffers that differ', () => {
    expect(timingSafeEqualBuf(Buffer.from('abc'), Buffer.from('abd'))).toBe(false)
  })
  it('is false for different lengths instead of throwing', () => {
    expect(timingSafeEqualBuf(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false)
    expect(timingSafeEqualBuf(Buffer.from('abc'), Buffer.alloc(0))).toBe(false)
  })
})

describe('generateMachineToken / hashToken', () => {
  it('mints "art_live_" + 43 base64url chars', () => {
    const { token } = generateMachineToken()
    expect(token.startsWith('art_live_')).toBe(true)
    expect(token.slice('art_live_'.length)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
  it('returns a 12-char prefix taken from the token', () => {
    const { token, prefix } = generateMachineToken()
    expect(prefix).toHaveLength(12)
    expect(prefix).toBe(token.slice(0, 12))
  })
  it('returns a hash that equals hashToken(token)', () => {
    const { token, hash } = generateMachineToken()
    expect(hashToken(token).equals(hash)).toBe(true)
    expect(hash).toHaveLength(32)
  })
  it('never repeats a token', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateMachineToken().token))
    expect(seen.size).toBe(100)
  })
})

describe('gzipBuf / gunzipCapped', () => {
  it('roundtrips a string under the cap', () => {
    const s = 'hello '.repeat(1000)
    expect(gunzipCapped(gzipBuf(s), 10_000_000).toString()).toBe(s)
  })
  it('roundtrips binary data', () => {
    const b = Buffer.from([0, 1, 2, 253, 254, 255])
    expect(gunzipCapped(gzipBuf(b), 10_000_000).equals(b)).toBe(true)
  })
  it('actually compresses repetitive input', () => {
    expect(gzipBuf('x'.repeat(100_000)).length).toBeLessThan(100_000)
  })
  it('throws PayloadTooLarge when the uncompressed size exceeds the cap', () => {
    expect(() => gunzipCapped(gzipBuf('x'.repeat(2000)), 100)).toThrow(PayloadTooLarge)
  })
  it('throws PayloadTooLarge on a zip bomb rather than allocating it', () => {
    const bomb = gzipBuf(Buffer.alloc(50_000_000))
    expect(bomb.length).toBeLessThan(100_000)
    expect(() => gunzipCapped(bomb, 1_000_000)).toThrow(PayloadTooLarge)
  })
  it('allows output exactly at the cap', () => {
    const s = 'y'.repeat(1000)
    expect(gunzipCapped(gzipBuf(s), 1000).length).toBe(1000)
  })
  it('rethrows non-size errors for corrupt input', () => {
    const bad = Buffer.from('not gzip at all')
    expect(() => gunzipCapped(bad, 10_000_000)).toThrow()
    expect(() => gunzipCapped(bad, 10_000_000)).not.toThrow(PayloadTooLarge)
  })
})
