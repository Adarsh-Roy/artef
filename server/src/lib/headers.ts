// The one invariant, in one place (spec §2.2). Three routes serve bytes that a
// user or an agent supplied — the artifact page at `/c/:id`, the content API,
// and `/assets/:sha` — and every one of them must leave the server under a
// sandboxing CSP. The policies live here as constants rather than as string
// literals at each call site, so the invariant test can assert against the same
// value the handlers send, and so a change to the policy is a change in exactly
// one file.
//
// `sandbox` never contains `allow-same-origin`. That single token is what keeps
// an artifact's JavaScript off the real app origin, away from the session
// cookie and away from every other document (§2.1). A failure here is a release
// blocker, not a bug.

/** Artifact documents: scripts may run, but in an opaque origin that can reach
 *  nothing — `connect-src 'none'` and `form-action 'none'` leave no channel to
 *  send a byte anywhere (§12.4). */
export const ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"

/** Asset bytes: `image/svg+xml` is a scriptable document when navigated to
 *  directly, so the sandbox has no `allow-scripts` at all — rendering an image
 *  needs none (§5.4). */
export const ASSET_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'"

/** `/c/:id` — the artifact itself, framed by the shell page. */
export function artifactPageHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': ARTIFACT_CSP,
    'X-Content-Type-Options': 'nosniff',
    // The content token lives in this URL's query string (§2.4), so it must not
    // ride along in a referrer.
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  }
}

/** `/a/:id` — the app's own page, which embeds a content token in the markup
 *  it returns (§2.4). A short-lived credential must not sit in a cache waiting
 *  for the next person on a shared machine. */
export function shellPageHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  }
}

/**
 * `GET /api/artifacts/:id/content` — agents reading a document back. The
 * `Content-Disposition` matters as much as the CSP: without it a logged-in
 * person who clicks a link to this URL would run the artifact's scripts on the
 * real app origin with their real session.
 */
export function contentApiHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': ARTIFACT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'attachment; filename="artifact.html"',
    'Cache-Control': 'private, no-store',
  }
}

/** `/assets/:sha` — immutable because the URL is the hash of the bytes, so the
 *  content behind it can never change (§5.4). */
export function assetHeaders(mediaType: string): Record<string, string> {
  return {
    'Content-Type': mediaType,
    'Content-Security-Policy': ASSET_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable',
  }
}
