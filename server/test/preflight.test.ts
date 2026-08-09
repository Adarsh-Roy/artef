// The server-side CSP preflight (spec §7.1). This is the TypeScript twin of the
// Rust lint in `cli/src/lint.rs`, and this file is deliberately the same table
// of cases: the two implementations answer the same question about the same
// documents, so when one is tightened the other has to move with it.
//
// The rules all come from one place — `ARTIFACT_CSP` in `src/lib/headers.ts`
// (§2.1). Most directives allow the document's own origin, so only a reference
// that reaches another origin is dead. `script-src`/`style-src` carry no `'self'`
// and no `data:`, and `base-uri`/`form-action` are `'none'`, so for those a local
// reference is as dead as an external one.
import { describe, it, expect } from 'vitest'
import { preflight, type Violation } from '../src/lib/preflight.js'

const CLEAN_DOC = `<!doctype html>
<html><head><meta charset="utf-8"><title>Report</title>
<style>body{font-family:sans-serif;background:url(data:image/png;base64,iVBORw0K)}</style>
</head><body>
<img src="data:image/png;base64,iVBORw0K" alt="inline">
<img src="/assets/abc" alt="extracted">
<a href="https://example.com/">links out are navigations, not subresources</a>
<script>document.title = 'ready';</script>
</body></html>`

/** `R` is a reject, `W` a warning — the shape of a document's findings in the
 *  order they appear in it. */
type Severity = 'R' | 'W'

function severities(html: string): Severity[] {
  const { rejects, warns } = preflight(html)
  return [
    ...rejects.map((): Severity => 'R'),
    ...warns.map((): Severity => 'W'),
  ]
}

/** The findings as `severity rule` pairs, which is what most cases assert. */
function found(html: string): string[] {
  const { rejects, warns } = preflight(html)
  return [...rejects.map(v => `R ${v.rule}`), ...warns.map(v => `W ${v.rule}`)]
}

const only = (html: string): Violation => {
  const { rejects, warns } = preflight(html)
  const all = [...rejects, ...warns]
  expect(all).toHaveLength(1)
  return all[0]
}

describe('the preflight table', () => {
  const cases: Array<[name: string, html: string, expect: string[]]> = [
    // --- scripts: script-src has no 'self' and no data:, so ANY src is dead ---
    ['external script', '<script src="https://cdn.jsdelivr.net/x.js"></script>', ['R script-src']],
    ['external script over plain http', '<script src="http://cdn.jsdelivr.net/x.js"></script>', ['R script-src']],
    ['protocol-relative script', '<script src="//cdn.jsdelivr.net/x.js"></script>', ['R script-src']],
    ['root-relative script src', '<script src="/app.js"></script>', ['R script-src']],
    ['relative script src', '<script src="chart.js"></script>', ['R script-src']],
    ['data: script src', '<script src="data:text/javascript,alert(1)"></script>', ['R script-src']],

    // --- stylesheets: style-src is 'unsafe-inline' only ---
    ['external stylesheet', '<link rel="stylesheet" href="https://fonts.googleapis.com/x">', ['R style-src']],
    ['external stylesheet, mixed-case multi-token rel', '<link rel="preload Stylesheet" href="https://fonts.googleapis.com/x">', ['R style-src']],
    ['root-relative stylesheet href', '<link rel="stylesheet" href="/x.css">', ['R style-src']],
    ['relative stylesheet href', '<link rel="stylesheet" href="styles.css">', ['R style-src']],
    ['non-stylesheet link is out of scope', '<link rel="icon" href="https://example.com/favicon.ico">', []],

    // --- images: img-src allows 'self' and data:, so external-only ---
    ['external img src', '<img src="https://x/y.png">', ['R img-src']],
    ['external img src, uppercase scheme', '<img src="HTTPS://X/Y.PNG">', ['R img-src']],
    ['external img srcset', '<img srcset="https://x/y.png 2x">', ['R img-src']],
    ['external candidate among local ones in srcset', '<img srcset="/assets/a.png 1x, https://x/y.png 2x">', ['R img-src']],
    ['external source srcset', '<picture><source srcset="https://x/y.webp"></picture>', ['R img-src']],
    ['data: image stays clean', '<img src="data:image/png;base64,iVBORw0K">', []],
    ['/assets image path stays clean', '<img src="/assets/abc123">', []],
    ['relative image src stays clean', '<img src="chart.png">', []],

    // --- media: media-src allows 'self' and data:, so external-only ---
    ['external source src', '<video><source src="https://x/v.mp4"></video>', ['R media-src']],
    ['external video src', '<video src="https://x/v.mp4"></video>', ['R media-src']],
    ['external audio src', '<audio src="https://x/a.mp3"></audio>', ['R media-src']],
    ['external track src', '<video><track src="https://x/s.vtt"></video>', ['R media-src']],
    ['protocol-relative video src', '<video src="//x/v.mp4"></video>', ['R media-src']],
    ['external poster', '<video poster="https://x/p.jpg"></video>', ['R img-src']],
    ['local video src is fine (media-src allows self)', '<video src="/assets/v.mp4"></video>', []],

    // --- frames and plugins ---
    ['external iframe', '<iframe src="https://x"></iframe>', ['R frame-src']],
    ['external object', '<object data="https://x/o.pdf"></object>', ['R frame-src']],
    ['external embed', '<embed src="https://x/e.svg">', ['R frame-src']],
    ['external object with a src rather than a data', '<object src="https://x/o.pdf"></object>', ['R frame-src']],
    // Parity with `cli/src/lint.rs`, which checks frames for an external URL
    // only. `ARTIFACT_CSP` names no `frame-src`, so frames actually fall back to
    // `default-src 'none'` and a local one is equally dead — neither
    // implementation reports it, and they must not disagree about it.
    ['local iframe is not reported, matching the Rust lint', '<iframe src="/a"></iframe>', []],
    ['poster on any element is fetched under img-src', '<div poster="https://x/p.jpg"></div>', ['R img-src']],

    // --- CSS ---
    ['css @import', '<style>@import url(https://x);</style>', ['R css-import']],
    ['css @import with quoted url', '<style>@import url("https://x/a.css");</style>', ['R css-import']],
    ['css @import of a bare double-quoted string', '<style>@import "https://x/a.css";</style>', ['R css-import']],
    ['css @import of a bare single-quoted string', "<style>@import 'https://x/a.css' screen;</style>", ['R css-import']],
    ['css @import after non-ascii text', '<style>/* — dash — */ @import "https://x/a.css";</style>', ['R css-import']],
    ['css @import of a local file is fine', '<style>@import "/css/reset.css";</style>', []],
    ['external url() in a style element', '<style>body{background:url(https://x/i.png)}</style>', ['R css-url']],
    ['external url() in a style attribute', '<div style="background:url(https://x/i.png)"></div>', ['R css-url']],
    ['data: url() in css is fine', '<style>body{background:url(data:image/png;base64,iVBORw0K)}</style>', []],
    ['relative url() in css is fine', '<div style="background:url(/assets/abc)"></div>', []],
    ['inline style stays clean', '<style>body{color:red}</style>', []],

    // --- warnings ---
    ['fetch in an inline script', "<script>fetch('/a')</script>", ['W connect-src']],
    ['the other blocked network APIs', "<script>new XMLHttpRequest(); new EventSource('/e'); new WebSocket('/w');</script>", ['W connect-src', 'W connect-src', 'W connect-src']],
    ['each blocked API is reported once, not per call', "<script>fetch('/a'); fetch('/b'); fetch('/c');</script>", ['W connect-src']],
    ['external form action', '<form action="https://x"></form>', ['W form-action']],
    // form-action 'none' blocks every submission, not just external ones.
    ['relative form action is warned, not clean', '<form action="/submit"></form>', ['W form-action']],
    ['a form with no action is fine', '<form><input name="q"></form>', []],
    ['root-relative base href', '<base href="/">', ['W base-uri']],
    ['external base href', '<base href="https://x/">', ['W base-uri']],
    ['base with no href is fine', '<base target="_self">', []],
    ['inline script stays clean', "<script>document.title = 'ok';</script>", []],
    ['external anchor link stays clean', '<a href="https://example.com/">out</a>', []],

    // --- whole documents ---
    ['rejects and warnings in one document', '<script src="https://x/a.js"></script><form action="https://x"></form>', ['R script-src', 'W form-action']],
    ['clean document', CLEAN_DOC, []],
  ]

  for (const [name, html, expected] of cases) {
    it(name, () => {
      expect(found(html)).toEqual(expected)
    })
  }
})

describe('what the preflight hands back', () => {
  it('splits findings into the two lists by severity', () => {
    const { rejects, warns } = preflight(
      '<script src="https://x/a.js"></script><form action="/go"></form>',
    )
    expect(rejects).toHaveLength(1)
    expect(warns).toHaveLength(1)
    expect(rejects[0].rule).toBe('script-src')
    expect(warns[0].rule).toBe('form-action')
  })

  it('names the offending url and says what to do about it', () => {
    const script = only('<script src="https://cdn.jsdelivr.net/x.js"></script>')
    expect(script.what).toContain('https://cdn.jsdelivr.net/x.js')
    expect(script.detail).not.toBe('')

    const img = only('<img src="https://x/y.png">')
    expect(img.what).toContain('https://x/y.png')
    expect(img.detail).toBe('inline it or vendor it manually')

    const call = only("<script>fetch('/a')</script>")
    expect(call.what).toContain('fetch(')
  })

  it('tells a local script and stylesheet to be inlined, not fetched', () => {
    // A local `src` is dead under `script-src`, so the message must not suggest
    // the file will load — it must say to inline the code.
    const script = only('<script src="/app.js"></script>')
    expect(script.what).toContain('/app.js')
    expect(script.detail).toContain('inline the code')

    const sheet = only('<link rel="stylesheet" href="/x.css">')
    expect(sheet.what).toContain('/x.css')
    expect(sheet.detail).toContain('inline the CSS')

    // `<base href>` is inert rather than broken, so it warns and names base-uri.
    const base = only('<base href="/">')
    expect(base.detail).toContain('base-uri')
  })

  it('names the url a bare-string @import found', () => {
    const v = only('<style>@import "https://x/a.css";</style>')
    expect(v.what).toContain('https://x/a.css')
    expect(v.what).toContain('@import')
  })

  it('reports findings in document order', () => {
    const html = `<img src="https://x/1.png"><script src="https://x/2.js"></script><img src="https://x/3.png">`
    expect(preflight(html).rejects.map(v => v.rule)).toEqual(['img-src', 'script-src', 'img-src'])
  })

  it('scans everyday malformed markup rather than refusing it', () => {
    // Unclosed tags and stray end tags are what agent output actually looks
    // like; refusing those would be the preflight crying wolf.
    expect(severities('<div><p>hi</div></p><img src="https://x/y.png">')).toEqual(['R'])
    expect(severities('<style>body{color:red}')).toEqual([])
  })

  it('still finds a script the markup tried to hide', () => {
    // `<xmp>` inside `<select>` is the case the Rust lint refuses outright
    // because a streaming parser cannot tell what a browser would do with it.
    // This parser builds a tree, sees the script, and rejects it by name.
    const v = only('<select><xmp><script src="https://cdn.jsdelivr.net/x.js"></script></select>')
    expect(v.rule).toBe('script-src')
  })

  it('scans a style element however long its text is', () => {
    const filler = `/* ${'pad '.repeat(5000)}*/`
    const html = `<style>${filler}\n@import url(https://x/a.css);</style>`
    expect(severities(html)).toEqual(['R'])
  })

  it('reads an empty document as clean', () => {
    expect(preflight('')).toEqual({ rejects: [], warns: [] })
  })
})
