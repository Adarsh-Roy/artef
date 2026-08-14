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

/**
 * The shell page itself. Not a sandbox — this page *is* ours, it holds the
 * reader's session, and its inline script is what runs the live reload and the
 * share dialog. What the policy buys is a floor under an injection: `default-src
 * 'none'` means an escaped artifact name that slipped through `esc()` could not
 * pull in a script, a stylesheet or an image from anywhere at all.
 *
 * Every source that is allowed is allowed because the page already uses it:
 * `script-src`/`style-src 'unsafe-inline'` for the inline block and the inline
 * `<style>`, `frame-src 'self'` for the artifact frame, `connect-src 'self'`
 * for the EventSource and the dialog's fetches. `base-uri 'none'` is the one
 * pure restriction — nothing here needs a `<base>`, and an injected one would
 * repoint every relative URL on the page.
 *
 * `frame-ancestors 'self'` is the clickjacking floor: this page holds the
 * reader's session and a Share button that changes who can read a document, so
 * another site must not be able to frame it and trick someone into clicking.
 */
export const SHELL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'"

/**
 * The `artef login` pages (§7.2). These have no script and no images — a
 * heading, a form and a link — so everything is denied and only the inline
 * `<style>` and the form's own target are allowed back.
 *
 * `form-action` names the loopback as well as `'self'`, and that is not a
 * loosening — it is the flow. Chromium checks `form-action` against the
 * *redirect target* of a form submission, not only against the URL in the
 * `action` attribute, and the loopback callback IS our redirect target: the
 * Authorize button posts to `/cli/auth/approve` on this origin, which answers
 * 302 to `http://127.0.0.1:<port>/callback`. Without the allowance Chrome mints
 * the code, refuses to follow the redirect, and the CLI waits forever. Firefox
 * and Safari never enforced it on redirects, so this is Chromium-only — and
 * Chromium is most browsers.
 *
 * The host is a literal because the redirect builds a literal: routes/cliauth.ts
 * hardcodes `127.0.0.1` and lets the caller choose only the port, so the port is
 * the one thing this wildcard has to cover and the policy cannot drift away from
 * the redirect without someone editing both. Nothing else opens — the manual
 * variant still posts to `'self'`, and no other origin is named.
 */
export const CLI_AUTH_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'"

/**
 * `/cli/auth`, `/cli/auth/manual` and the response to approving. The manual
 * page carries a plaintext machine token in its body, so `no-store` is not
 * hygiene here — it is what keeps the credential off the disk of a shared
 * machine.
 *
 * `same-origin` rather than `no-referrer`, and the difference matters: the
 * Authorize button is a POST from this page to `/cli/auth/approve`, and per the
 * Fetch spec a document served with `no-referrer` sends `Origin: null` on its
 * own same-origin requests. The origin check refuses `null` — correctly, since
 * an opaque origin is not this app — so a `no-referrer` page cannot perform a
 * single session mutation in a real browser. A page that hosts one must never
 * use `no-referrer` (see auth/origin.ts).
 *
 * It gives nothing away. `same-origin` sends a referrer to this origin and to
 * no other, so no `/cli/auth` URL reaches another site — and the redirect to
 * the loopback (`localhost:3000` → `127.0.0.1:<port>`) is a cross-origin
 * destination, which means the browser strips the referrer there exactly as
 * `no-referrer` did. The callback URL holds the one-time code, and the listener
 * is still told nothing about which server the person signed in to.
 */
export function cliAuthPageHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': CLI_AUTH_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
  }
}

/** `/c/:id` — the artifact itself, framed by the shell page. */
export function artifactPageHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': ARTIFACT_CSP,
    'X-Content-Type-Options': 'nosniff',
    // The content token lives in this URL's query string (§2.4), so it must not
    // ride along in a referrer — not even a same-origin one, which is why this
    // stays `no-referrer` while the app's own pages use `same-origin`. Nothing
    // is lost by it: this document is sandboxed into an opaque origin and its
    // CSP leaves it no request to make, so it has no mutation to null the
    // Origin header on.
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  }
}

/**
 * `/a/:id` — the app's own page, which embeds a content token in the markup it
 * returns (§2.4). A short-lived credential must not sit in a cache waiting for
 * the next person on a shared machine.
 *
 * `same-origin` rather than `no-referrer`, for the same reason as the cli-auth
 * pages above: this page hosts session mutations — the share dialog's POST,
 * PATCH and DELETE fetches and the logout form — and a `no-referrer` document
 * sends `Origin: null` on its own same-origin requests, which the origin check
 * refuses (see auth/origin.ts). Under `no-referrer` every one of those comes
 * back 403 in a real browser.
 *
 * The privacy the original policy bought is intact: `same-origin` sends a
 * referrer to this origin and to no other, so an `/a/:id` URL never leaves for
 * a third-party site. Note that the token is in the markup, not in this URL —
 * the URL that does carry one is `/c/:id`, which keeps `no-referrer` above.
 */
export function shellPageHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': SHELL_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
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
