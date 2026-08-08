// Blobs are stored gzip-compressed at the application layer (spec §3) and
// served with `Content-Encoding: gzip`, so the server rarely decompresses at
// all. When it must, it decompresses under a cap: a small stored blob can
// expand to gigabytes, and zlib should stop rather than allocate that.
import { gzipSync, gunzipSync } from 'node:zlib'

export class PayloadTooLarge extends Error {
  constructor(message = 'decompressed payload too large') {
    super(message)
    this.name = 'PayloadTooLarge'
  }
}

export function gzipBuf(data: Buffer | string): Buffer {
  return gzipSync(data)
}

/**
 * Decompresses `gz`, refusing to produce more than `maxBytes`. zlib enforces
 * the cap while inflating, so an over-sized payload never gets allocated.
 * Throws `PayloadTooLarge` when the cap is hit; other zlib errors (corrupt
 * input, bad header) propagate unchanged.
 */
export function gunzipCapped(gz: Buffer, maxBytes: number): Buffer {
  try {
    return gunzipSync(gz, { maxOutputLength: maxBytes })
  } catch (err) {
    if (isOutputTooLarge(err)) {
      throw new PayloadTooLarge(`decompressed payload exceeds ${maxBytes} bytes`)
    }
    throw err
  }
}

// Node reports the cap being hit as ERR_BUFFER_TOO_LARGE, but the exact code
// has moved between releases, so fall back to matching the RangeError text.
function isOutputTooLarge(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === 'ERR_BUFFER_TOO_LARGE') return true
  return err instanceof RangeError && typeof message === 'string' && /larger than/.test(message)
}
