// The product's one look, as CSS strings shared by every server-rendered page
// (shell, homepage, prose pages). Dark is the default; light arrives only via
// the OS preference. No fonts are loaded and no request leaves the page — the
// whole design budget is custom properties and the system font stack.

/** Custom properties + base element styles. Every page's <style> starts here. */
export const THEME = `:root{color-scheme:dark;
--bg:#111418;--bg-raised:#1a1f26;--bg-hover:#232932;
--ink:#e8eaed;--ink-muted:#9aa3ad;--line:#2a313b;
--accent:#4c8dff;--accent-ink:#0b1526;--danger:#e5534b;--danger-ink:#fff;
--radius:.5rem;--shadow:0 8px 24px rgba(0,0,0,.4)}
@media (prefers-color-scheme: light){:root{color-scheme:light;
--bg:#ffffff;--bg-raised:#f6f7f9;--bg-hover:#eceef1;
--ink:#1a1f26;--ink-muted:#5c6570;--line:#e3e6ea;
--accent:#2f6fed;--accent-ink:#ffffff;--danger:#d1332b;--danger-ink:#fff;
--shadow:0 8px 24px rgba(0,0,0,.14)}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--accent)}`

/** The header bar, buttons, and dialog chrome shared by the shell and the
 *  homepage. Class contracts: .bar/.who/.meta/.actions as today, plus
 *  .btn (bordered), .btn-primary (accent fill), .btn-danger (destructive),
 *  .icon-btn (square icon link/button). */
export const CHROME = `
.bar{display:flex;align-items:center;gap:.75rem;padding:.5rem 1rem;border-bottom:1px solid var(--line);background:var(--bg-raised)}
.who{min-width:0}
.bar h1{font-size:.9375rem;font-weight:600;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{margin:0;color:var(--ink-muted);font-size:.75rem}
.actions{margin-left:auto;display:flex;align-items:center;gap:.5rem}
.btn{font:inherit;font-size:.8125rem;padding:.35rem .8rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg-raised);color:var(--ink);text-decoration:none;cursor:pointer}
.btn:hover{background:var(--bg-hover)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn-primary:hover{filter:brightness(1.1);background:var(--accent)}
.btn-danger{background:var(--danger);border-color:var(--danger);color:var(--danger-ink)}
.btn-danger:hover{filter:brightness(1.1);background:var(--danger)}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;padding:0;border:1px solid transparent;border-radius:var(--radius);color:var(--ink-muted);background:none;cursor:pointer}
.icon-btn:hover{background:var(--bg-hover);color:var(--ink)}
.icon-btn svg{width:1.125rem;height:1.125rem}
:is(.btn,.icon-btn):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
dialog{background:var(--bg-raised);color:var(--ink);border:1px solid var(--line);border-radius:.625rem;box-shadow:var(--shadow)}
dialog::backdrop{background:rgba(0,0,0,.55)}`
