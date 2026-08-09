// The CSP preflight (spec §7.1), server side. This is what makes `/mcp` worth
// having: an agent that emits `<script src="https://cdn…">` gets back the
// offending element, the rule it broke and the fix, as data it can act on,
// rather than publishing a document that renders blank with no error anyone can
// interpret.
//
// Every rule here is read off one constant — `ARTIFACT_CSP` in `headers.ts`
// (§2.1) — and there are two shapes of them. Most directives (`img-src`,
// `media-src`, `font-src`) allow the document's own origin, so only a reference
// that reaches *another* origin is dead. But `script-src` and `style-src` carry
// no `'self'` and no `data:`, and `base-uri`/`form-action` are `'none'`, so for
// those a local reference is as dead as an external one — a `<script src>`,
// stylesheet `<link>`, `<base href>` or `<form action>` of any value at all.
//
// The Rust lint in `cli/src/lint.rs` is the same rules for the CLI path, and
// `test/preflight.test.ts` is deliberately its test table. When one is
// tightened the other has to move with it.
//
// HTML structure is read with a parser, never with a regular expression. The
// string scanning below is confined to the *text* of `<style>` and `<script>`,
// which is CSS and JavaScript rather than markup — the same division the Rust
// lint makes.
import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser'

/** One finding: which rule, what was found, and what to do about it. */
export interface Violation {
  /** The CSP directive this is about. A stable identifier, so an agent can
   *  branch on it without reading English. */
  rule: string
  /** What was found, with the offending value in it. */
  what: string
  /** What to do about it. */
  detail: string
}

/** Rejects break the document; warnings leave it rendering but inert. */
export interface PreflightResult {
  rejects: Violation[]
  warns: Violation[]
}

/** What to tell the caller about a subresource that has to come from the
 *  document itself. */
const INLINE_IT = 'inline it or vendor it manually'

/** `script-src` carries no `'self'` and no `data:`, so a `src` of any kind —
 *  external, root-relative, relative, even `data:` — is blocked. Only inline
 *  `<script>` runs. */
const SCRIPT_BLOCKED = 'external and local scripts are both blocked; inline the code in a <script> tag'

/** `style-src` is `'unsafe-inline'` only, so a stylesheet `<link>` of any href
 *  is dead. */
const STYLESHEET_BLOCKED = 'inline the CSS in a <style> tag'

/** `base-uri 'none'` makes `<base href>` inert — the browser ignores it. */
const BASE_IGNORED = "base-uri 'none' ignores <base>; use absolute or /assets paths"

/** `form-action 'none'` blocks every submission, same-origin or not. */
const FORM_BLOCKED = "form submissions are blocked by form-action 'none'"

const FRAME_BLOCKED = 'frames and plugins are blocked outright; remove it'

const DATA_URI_IT = 'inline it as a data: URI'

const NETWORK_BLOCKED =
  "network requests are blocked by connect-src 'none'; the call will silently do nothing"

/** JS network APIs that `connect-src 'none'` turns into no-ops. */
const BLOCKED_NETWORK_APIS = ['fetch(', 'XMLHttpRequest', 'EventSource', 'WebSocket'] as const

/**
 * Scans a document for references the artifact CSP blocks.
 *
 * Findings come back in document order within each list, which is the order a
 * person reads the file in and so the order an agent should fix them in.
 */
export function preflight(html: string): PreflightResult {
  const rejects: Violation[] = []
  const warns: Violation[] = []

  const reject = (rule: string, what: string, detail: string) => rejects.push({ rule, what, detail })
  const warn = (rule: string, what: string, detail: string) => warns.push({ rule, what, detail })

  // The parse has to draw the raw-text/markup line exactly where the HTML5
  // tokenizer draws it, or this preflight and the Rust lint (`artef lint`,
  // which is lol_html and so the tokenizer itself) disagree about real
  // documents — the one thing the two surfaces must never do.
  //
  // In `blockTextElements`, a listed tag is a *raw-text* element: its contents
  // are text, and the tree has no child elements to scan. `script` and `style`
  // are that in every parser, and their text is scanned separately below.
  // `textarea` and `title` are RCDATA — inert text in a browser, so a `<script>`
  // or `<img>` written inside one is never fetched — and must be raw-text here
  // too, or a document a browser treats as clean would be rejected. `noscript`
  // is raw-text under scripting, which is how these documents run.
  //
  // `pre` is deliberately absent: it is a *normal* element, its children are
  // markup, and a browser running under `allow-scripts` loads a `<script src>`
  // or `<img>` inside it. Listing it would discard exactly the references the
  // CSP blocks, passing documents the Rust lint rejects.
  const root = parse(html, {
    blockTextElements: { script: true, style: true, textarea: false, title: false, noscript: false },
  })

  walk(root, el => {
    const tag = tagName(el)

    switch (tag) {
      // `script-src`/`style-src` allow only inline code, so ANY src/href is
      // blocked — not just external ones. Report whatever value is present.
      case 'script':
        present(el, 'src', v => reject('script-src', v, SCRIPT_BLOCKED))
        scanScript(el.rawText, warn)
        break
      case 'link':
        if (isStylesheet(el.getAttribute('rel'))) {
          present(el, 'href', v => reject('style-src', v, STYLESHEET_BLOCKED))
        }
        break
      case 'style':
        scanCss(el.rawText, '<style>', reject)
        break
      // `img-src`/`media-src`/`font-src` all allow `'self'` and `data:`, so
      // these stay external-only rejects.
      case 'img':
        external(el, 'src', v => reject('img-src', v, INLINE_IT))
        srcset(el, v => reject('img-src', v, INLINE_IT))
        break
      case 'source':
        // A `<source src>` belongs to a media element; a `<source srcset>` to a
        // `<picture>`. Different directives, one element.
        external(el, 'src', v => reject('media-src', v, INLINE_IT))
        srcset(el, v => reject('img-src', v, INLINE_IT))
        break
      // A media element's own `src` (not just a nested `<source>`) is a
      // subresource under `media-src`, blocked when it points off-origin.
      case 'video':
      case 'audio':
      case 'track':
        external(el, 'src', v => reject('media-src', v, INLINE_IT))
        break
      // Both attributes on all three: `<iframe src>` and `<embed src>` are the
      // usual spellings and `<object data>` is the other one, but the policy
      // does not care which of them a document reached for.
      case 'iframe':
      case 'object':
      case 'embed':
        external(el, 'src', v => reject('frame-src', v, FRAME_BLOCKED))
        external(el, 'data', v => reject('frame-src', v, FRAME_BLOCKED))
        break
      // Every submission is blocked, same-origin or not, so warn on ANY action.
      case 'form':
        present(el, 'action', v => warn('form-action', v, FORM_BLOCKED))
        break
      // `<base href>` is inert under `base-uri 'none'` — a best-effort no-op.
      case 'base':
        present(el, 'href', v => warn('base-uri', v, BASE_IGNORED))
        break
      default:
        break
    }

    // A poster is fetched under `img-src` whatever element carries it.
    external(el, 'poster', v => reject('img-src', v, INLINE_IT))

    const style = el.getAttribute('style')
    if (style !== undefined) scanCss(style, 'style attribute', reject)
  })

  return { rejects, warns }
}

// --- the walk ----------------------------------------------------------------

/** Every element, in document order. */
function walk(node: Node, visit: (el: HTMLElement) => void): void {
  if (node instanceof HTMLElement && node.nodeType === NodeType.ELEMENT_NODE && node.rawTagName) {
    visit(node)
  }
  for (const child of node.childNodes) walk(child, visit)
}

/** Lowercased, because `<IMG>` and `<img>` are the same element and the
 *  messages should not shout. */
function tagName(el: HTMLElement): string {
  return (el.rawTagName ?? '').toLowerCase()
}

// --- attributes ---------------------------------------------------------------

/**
 * A reference the CSP blocks: another origin, over http(s) or protocol-relative.
 * `data:` URIs and relative or root-relative paths are fine.
 */
function externalUrl(value: string): string | null {
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  const out = lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')
  return out ? trimmed : null
}

/** Reports the attribute only when its value reaches another origin. */
function external(el: HTMLElement, attr: string, report: (what: string) => void): void {
  const value = el.getAttribute(attr)
  if (value === undefined) return
  const url = externalUrl(value)
  if (url !== null) report(`<${tagName(el)} ${attr}> ${url}`)
}

/**
 * Reports the attribute whenever it is present, whatever its value. For the
 * directives that permit no source at all (`script-src`/`style-src` have no
 * `'self'` or `data:`; `base-uri`/`form-action` are `'none'`), a local value is
 * as blocked as an external one, so there is nothing to distinguish.
 */
function present(el: HTMLElement, attr: string, report: (what: string) => void): void {
  const value = el.getAttribute(attr)
  if (value === undefined) return
  report(`<${tagName(el)} ${attr}> ${value.trim()}`)
}

/** `srcset` holds comma-separated candidates, each a URL plus an optional
 *  descriptor. */
function srcset(el: HTMLElement, report: (what: string) => void): void {
  const value = el.getAttribute('srcset')
  if (value === undefined) return
  for (const candidate of value.split(',')) {
    const [first] = candidate.trim().split(/\s+/)
    if (first === undefined || first === '') continue
    const url = externalUrl(first)
    if (url !== null) report(`<${tagName(el)} srcset> ${url}`)
  }
}

function isStylesheet(rel: string | undefined): boolean {
  if (rel === undefined) return false
  return rel.split(/\s+/).some(token => token.toLowerCase() === 'stylesheet')
}

// --- CSS -----------------------------------------------------------------------

type Report = (rule: string, what: string, detail: string) => void

/** Both shapes of external reference CSS has: `url(…)` and the bare-string
 *  `@import "…"`. `home` is where the CSS came from, for the message. */
function scanCss(css: string, home: '<style>' | 'style attribute', report: Report): void {
  scanCssUrls(css, home, report)
  scanCssStringImports(css, report)
}

/** Finds `url(…)` references, and notes which of them are `@import`s. */
function scanCssUrls(css: string, home: string, report: Report): void {
  const lower = css.toLowerCase()
  let at = 0

  for (;;) {
    const found = lower.indexOf('url(', at)
    if (found === -1) return

    const valueStart = found + 'url('.length
    const valueEnd = lower.indexOf(')', valueStart)
    if (valueEnd === -1) return

    const url = externalUrl(trimQuotes(css.slice(valueStart, valueEnd).trim()))
    if (url !== null) {
      // `@import url(…)` and a plain `url(…)` are different fixes: one is a
      // whole stylesheet to inline, the other a single asset to embed.
      if (lower.slice(0, found).trimEnd().endsWith('@import')) {
        report('css-import', `@import url(${url})`, INLINE_IT)
      } else {
        report('css-url', `url(${url}) in ${home}`, DATA_URI_IT)
      }
    }

    at = valueEnd + 1
  }
}

/**
 * `@import "https://…";` — the form that names the stylesheet as a plain string
 * instead of `url(…)`. It is valid CSS and equally blocked, so the `url(…)`
 * scan above is not enough on its own.
 */
function scanCssStringImports(css: string, report: Report): void {
  const lower = css.toLowerCase()
  let at = 0

  for (;;) {
    const found = lower.indexOf('@import', at)
    if (found === -1) return
    at = found + '@import'.length

    const rest = css.slice(at)
    const trimmed = rest.trimStart()
    const quote = trimmed[0]
    // `url(…)`, a variable, or nothing we can read — the `url(…)` scan has it.
    if (quote !== '"' && quote !== "'") continue

    const valueStart = rest.length - trimmed.length + 1
    const end = rest.indexOf(quote, valueStart)
    // An unterminated string: nothing further in this block is readable.
    if (end === -1) return

    const url = externalUrl(rest.slice(valueStart, end))
    if (url !== null) report('css-import', `@import "${url}"`, INLINE_IT)
    at += end
  }
}

/** `"…"` and `'…'` around a CSS url value are noise. */
function trimQuotes(value: string): string {
  return value.replace(/^["']+/, '').replace(/["']+$/, '').trim()
}

// --- JavaScript ------------------------------------------------------------------

/** Each blocked API is reported once per script, not once per call: three
 *  `fetch`es are one thing to fix. */
function scanScript(js: string, warn: (rule: string, what: string, detail: string) => void): void {
  for (const api of BLOCKED_NETWORK_APIS) {
    if (js.includes(api)) warn('connect-src', `${api} in <script>`, NETWORK_BLOCKED)
  }
}
