---
name: artef-html
description: Use when writing an HTML document to publish to artef (via the artef MCP tools or `artef push`), and when a published document renders wrong — blank charts, missing fonts, dead buttons, a form that does nothing. The artifact CSP forbids every external request, so the document must carry everything it needs, and the failures it causes are usually silent.
---

# Writing HTML for artef

**One rule: everything inline, no external requests, ever.**

artef serves documents in a sandbox with `default-src 'none'; connect-src 'none'`. Anything
the page loads from another origin is blocked before the request leaves the browser, and the
reader sees no error — just a blank chart or a fallback font, which they blame on the service.
Write the document so it needs nothing but itself.

## Never — publishing refuses these outright

- `<script src="…">` — no `src` at all, external or local. Only inline `<script>` runs, so put the code inside the tag. For a library (mermaid, chart.js), fetch the library source and paste it into an inline `<script>`; a few MB of it is fine under the 10MB upload cap. Otherwise write the few lines yourself.
- `<link rel="stylesheet" href="…">` — blocked whatever it points at, external or local; only inline `<style>` applies. Inline the CSS in a `<style>` tag. Google Fonts links go too — use a system font stack (`system-ui, sans-serif`) or embed a font as a `data:` URI.
- `@import url(https://…)` and `@import "https://…"` in CSS.
- `<img src="https://…">`, `srcset`, `<source>`, `poster` — base64 the bytes into a `data:` URI yourself. No flag fetches remote images for you.
- `url(https://…)` inside `<style>` or a `style=` attribute.
- `<iframe>`, `<object>`, `<embed>` pointing anywhere external — frames and plugins are blocked outright.
- Protocol-relative URLs (`//cdn…`) count as external too.

## Never — these upload but silently do nothing

Worse than a rejection, because the document looks fine to you and is dead for the reader.

- `fetch()`, `XMLHttpRequest`, `EventSource`, `WebSocket` — every outbound call is a no-op under `connect-src 'none'`. Documents are pushed to; they never poll.
- Forms. `form-action 'none'` blocks *every* submission, not just external ones — `<form action="/submit">` passes lint but the submit does nothing. There is no server to submit to; a document is a dumb document.

## What you do have

- Inline `<script>` (including `eval`) and inline `<style>` — no nonce, no hash, no restrictions.
- `data:` URIs for images, fonts, audio and video.
- `/assets/<sha>` paths — but only the ones `artef push` writes for you: the CLI pulls large inline images out of the document and uploads them separately. Publishing through MCP does no extraction, so images stay inline and count against the 10MB document cap. Either way, embed images as `data:` URIs and let the tool decide. Never hand-write a relative path like `<img src="chart.png">`: it passes the check (`img-src 'self'` allows it) but nothing exists there server-side, so it 404s.
- Ordinary links. `<a href="https://example.com">` is a navigation the reader chooses, not a subresource, so it works — but skip `target="_blank"`, the sandbox blocks new windows.

## Interactivity

Interactivity is for understanding, not for data. Toggles, steppers, filters, sortable
tables, charts drawn in JS — all fine, as long as every number is baked in at generation
time. Compute the data in the process that writes the HTML, serialize it into an inline
`<script>`, and let the page work off that array.

A document that has to stay current is re-published — `update_artifact` when you are the
one regenerating it, or `artef watch` for a file that regenerates on a schedule with
nobody watching. Open tabs pick up the new version on their own. The page itself never
reaches out.

## Publishing

**If the artef MCP server is connected, use it** — `publish_artifact { html, name?,
visibility? }` to create, `update_artifact { id, html, base_version? }` to revise. The
document is checked before anything is written, and a refusal comes back as structured
violations naming the element, the rule and the fix: repair the HTML and call again. No
file has to exist on disk.

Otherwise use the CLI, which applies the same rules:

```
artef lint report.html    # exits 1 on anything that would render broken
artef push report.html
```

`push` runs the check itself; `lint` is for checking before you hand the file over.

## When a published document renders wrong

The checks above reject external references. They cannot reject a document that is
*allowed* but pointless — code that runs and achieves nothing, because the sandbox
gives the page an opaque origin and `connect-src 'none'`. Nothing appears in the
reader's console that explains it. Match the symptom:

| Symptom | Cause | Fix |
|---|---|---|
| Chart, table or map is blank | The data was fetched at render time | Bake the data into an inline `<script>` when generating the HTML |
| Content never updates | The page polls, or opened an `EventSource` | Documents are pushed to. Re-publish with `update_artifact`, or `artef watch` on an interval |
| A button does nothing | Its handler calls `fetch`/`XHR` | There is no server for the page to call. Do the work at generation time |
| Submitting a form does nothing | `form-action 'none'` blocks every submission | Remove the form; a document is not an app |
| Text renders in the wrong font | A webfont stylesheet or file was referenced | Use a system font stack, or embed the font as a `data:` URI |
| An image is broken | Remote URL, or a relative path like `chart.png` | Embed as a `data:` URI; large ones are extracted to `/assets/` automatically |
| Nothing on the page works at all | A library was loaded by `<script src>` | Paste the library source into an inline `<script>` |

The rule behind every row: the document is a finished artifact, not a client. Everything
it will ever show must be inside it at publish time.

## A complete document that passes

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Build times</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem; }
  .row { display: grid; grid-template-columns: 5rem 1fr 3rem; gap: .5rem; align-items: center; }
  .bar { background: #2f81f7; height: 1.25rem; }
  .pct { display: none; }
  body.show-pct .pct { display: block; }
</style>
</head>
<body>
<h1><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mPQb/xOEmIY1TCqYfhqAAAY+acQkrGBcAAAAABJRU5ErkJggg==" alt="" width="16" height="16"> Build times</h1>
<button id="toggle">Show percentages</button>
<div id="chart"></div>
<script>
  // Every number the document needs, baked in when the HTML was generated.
  const data = [["api", 42], ["web", 71], ["docs", 12]];
  const max = Math.max(...data.map(([, secs]) => secs));
  document.getElementById("chart").innerHTML = data.map(([name, secs]) =>
    `<div class="row"><span>${name}</span>` +
    `<div class="bar" style="width:${(secs / max) * 100}%"></div>` +
    `<span class="pct">${Math.round((secs / max) * 100)}%</span></div>`).join("");
  document.getElementById("toggle").addEventListener("click", () => {
    document.body.classList.toggle("show-pct");
  });
</script>
</body>
</html>
```
