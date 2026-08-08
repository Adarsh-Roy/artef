---
name: artef-html
description: Use when generating an HTML document that will be published with `artef push` — the artifact CSP forbids every external request, so the document has to carry everything it needs.
---

# Writing HTML for artef

**One rule: everything inline, no external requests, ever.**

artef serves documents in a sandbox with `default-src 'none'; connect-src 'none'`. Anything
the page loads from another origin is blocked before the request leaves the browser, and the
reader sees no error — just a blank chart or a fallback font, which they blame on the service.
Write the document so it needs nothing but itself.

## Never — `artef push` refuses to upload these

- `<script src="https://cdn…">` — no CDN libraries. Inline the code you need, or write the few lines yourself.
- `<link rel="stylesheet" href="https://…">`, including Google Fonts. Use a system font stack (`system-ui, sans-serif`), or embed a font as a `data:` URI.
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
- `/assets/<sha>` paths — but only the ones `artef push` emits by pulling large inline images out for you. Don't hand-write relative paths like `<img src="chart.png">`: it passes lint (`img-src 'self'` allows it) but nothing exists there server-side, so it 404s. Embed images as `data:` URIs; extraction moves the big ones to `/assets/` on its own.
- Ordinary links. `<a href="https://example.com">` is a navigation the reader chooses, not a subresource, so it works — but skip `target="_blank"`, the sandbox blocks new windows.

## Interactivity

Interactivity is for understanding, not for data. Toggles, steppers, filters, sortable
tables, charts drawn in JS — all fine, as long as every number is baked in at generation
time. Compute the data in the process that writes the HTML, serialize it into an inline
`<script>`, and let the page work off that array.

A document that has to stay current is `artef watch` re-pushing a freshly generated file on
an interval. The page itself never reaches out.

## Verify

```
artef lint report.html    # exits 1 on anything that would render broken
artef push report.html
```

Lint before you hand the file over. `push` runs the same check and refuses on its own.

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
