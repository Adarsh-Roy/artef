//! CSP preflight lint (spec §7.1).
//!
//! Artifacts are served under `default-src 'none'; connect-src 'none';
//! img-src 'self' data:`, so any HTML that reaches out to another origin renders
//! visibly broken with no error the reader can interpret. This module finds those
//! references before the document is uploaded.

use std::cell::RefCell;

use lol_html::html_content::Element;
use lol_html::{element, rewrite_str, text, RewriteStrSettings};

/// How bad a finding is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// The document will render broken. `artef push` refuses to upload.
    Reject,
    /// The document renders, but something in it will silently do nothing.
    Warn,
}

/// One finding: what was found, and what to do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub severity: Severity,
    pub what: String,
    pub detail: String,
}

/// What to tell the user about a subresource that has to come from the document itself.
const INLINE_IT: &str = "inline it or vendor it manually";

/// JS network APIs that `connect-src 'none'` turns into no-ops.
const BLOCKED_NETWORK_APIS: [&str; 4] = ["fetch(", "XMLHttpRequest", "EventSource", "WebSocket"];

/// Scan an HTML document for references the artifact CSP blocks.
pub fn lint_html(html: &str) -> Vec<Violation> {
    let found = RefCell::new(Vec::new());
    let style_text = RefCell::new(String::new());
    let script_text = RefCell::new(String::new());

    let settings = RewriteStrSettings {
        element_content_handlers: vec![
            element!("script[src]", |el| {
                check_attr(&found, el, "src", Severity::Reject, INLINE_IT);
                Ok(())
            }),
            element!("link[href]", |el| {
                if is_stylesheet(el.get_attribute("rel").as_deref()) {
                    check_attr(&found, el, "href", Severity::Reject, INLINE_IT);
                }
                Ok(())
            }),
            element!("img", |el| {
                check_attr(&found, el, "src", Severity::Reject, INLINE_IT);
                check_srcset(&found, el);
                Ok(())
            }),
            element!("source", |el| {
                check_attr(&found, el, "src", Severity::Reject, INLINE_IT);
                check_srcset(&found, el);
                Ok(())
            }),
            element!("[poster]", |el| {
                check_attr(&found, el, "poster", Severity::Reject, INLINE_IT);
                Ok(())
            }),
            element!("iframe", |el| {
                check_frame(&found, el);
                Ok(())
            }),
            element!("object", |el| {
                check_frame(&found, el);
                Ok(())
            }),
            element!("embed", |el| {
                check_frame(&found, el);
                Ok(())
            }),
            element!("[style]", |el| {
                if let Some(css) = el.get_attribute("style") {
                    scan_css(&found, &css, CssHome::Attribute);
                }
                Ok(())
            }),
            element!("form[action]", |el| {
                check_attr(
                    &found,
                    el,
                    "action",
                    Severity::Warn,
                    "form submissions are blocked by form-action 'none'",
                );
                Ok(())
            }),
            text!("style", |chunk| {
                style_text.borrow_mut().push_str(chunk.as_str());
                if chunk.last_in_text_node() {
                    let css = std::mem::take(&mut *style_text.borrow_mut());
                    scan_css(&found, &css, CssHome::Element);
                }
                Ok(())
            }),
            text!("script", |chunk| {
                script_text.borrow_mut().push_str(chunk.as_str());
                if chunk.last_in_text_node() {
                    let js = std::mem::take(&mut *script_text.borrow_mut());
                    scan_script(&found, &js);
                }
                Ok(())
            }),
        ],
        // Ambiguous markup should degrade the scan, never abort it.
        strict: false,
        ..RewriteStrSettings::new()
    };

    if let Err(err) = rewrite_str(html, settings) {
        found.borrow_mut().push(Violation {
            severity: Severity::Warn,
            what: format!("the HTML could not be fully parsed: {err}"),
            detail: "the CSP check is incomplete for this file".to_string(),
        });
    }

    found.into_inner()
}

/// Where some CSS came from, for the message.
#[derive(Debug, Clone, Copy)]
enum CssHome {
    Element,
    Attribute,
}

impl CssHome {
    fn label(self) -> &'static str {
        match self {
            Self::Element => "<style>",
            Self::Attribute => "style attribute",
        }
    }
}

/// A reference the CSP blocks: another origin, over http(s) or protocol-relative.
/// `data:` URIs and relative or root-relative paths are fine.
fn external_url(value: &str) -> Option<&str> {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    let external =
        lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//");
    external.then_some(value)
}

fn is_stylesheet(rel: Option<&str>) -> bool {
    rel.is_some_and(|rel| {
        rel.split_whitespace()
            .any(|token| token.eq_ignore_ascii_case("stylesheet"))
    })
}

fn record(found: &RefCell<Vec<Violation>>, severity: Severity, what: String, detail: &str) {
    found.borrow_mut().push(Violation {
        severity,
        what,
        detail: detail.to_string(),
    });
}

fn check_attr(
    found: &RefCell<Vec<Violation>>,
    el: &Element<'_, '_>,
    attr: &str,
    severity: Severity,
    detail: &str,
) {
    let Some(value) = el.get_attribute(attr) else {
        return;
    };
    if let Some(url) = external_url(&value) {
        let what = format!("<{} {attr}> {url}", el.tag_name());
        record(found, severity, what, detail);
    }
}

/// `srcset` holds comma-separated candidates, each a URL plus an optional descriptor.
fn check_srcset(found: &RefCell<Vec<Violation>>, el: &Element<'_, '_>) {
    let Some(value) = el.get_attribute("srcset") else {
        return;
    };
    for candidate in value.split(',') {
        let Some(url) = candidate.split_whitespace().next() else {
            continue;
        };
        if let Some(url) = external_url(url) {
            let what = format!("<{} srcset> {url}", el.tag_name());
            record(found, Severity::Reject, what, INLINE_IT);
        }
    }
}

fn check_frame(found: &RefCell<Vec<Violation>>, el: &Element<'_, '_>) {
    const DETAIL: &str = "frames and plugins are blocked outright; remove it";

    check_attr(found, el, "src", Severity::Reject, DETAIL);
    check_attr(found, el, "data", Severity::Reject, DETAIL);
}

/// Find `url(…)` references, and note which of them are `@import`s.
fn scan_css(found: &RefCell<Vec<Violation>>, css: &str, home: CssHome) {
    let lower = css.to_ascii_lowercase();
    let mut at = 0;

    while let Some(offset) = lower[at..].find("url(") {
        let value_start = at + offset + "url(".len();
        let Some(end_offset) = lower[value_start..].find(')') else {
            return;
        };
        let value_end = value_start + end_offset;
        let value = css[value_start..value_end]
            .trim()
            .trim_matches(['"', '\''])
            .trim();

        if let Some(url) = external_url(value) {
            if lower[..at + offset].trim_end().ends_with("@import") {
                record(
                    found,
                    Severity::Reject,
                    format!("@import url({url})"),
                    INLINE_IT,
                );
            } else {
                record(
                    found,
                    Severity::Reject,
                    format!("url({url}) in {}", home.label()),
                    "inline it as a data: URI",
                );
            }
        }

        at = value_end + 1;
    }
}

fn scan_script(found: &RefCell<Vec<Violation>>, js: &str) {
    for api in BLOCKED_NETWORK_APIS {
        if js.contains(api) {
            record(
                found,
                Severity::Warn,
                format!("{api} in <script>"),
                "network requests are blocked by connect-src 'none'; the call will silently do nothing",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Severity::{Reject, Warn};
    use super::*;

    const CLEAN_DOC: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>Report</title>
<style>body{font-family:sans-serif;background:url(data:image/png;base64,iVBORw0K)}</style>
</head><body>
<img src="data:image/png;base64,iVBORw0K" alt="inline">
<img src="/assets/abc" alt="extracted">
<a href="https://example.com/">links out are navigations, not subresources</a>
<script>document.title = 'ready';</script>
</body></html>"#;

    struct Case {
        name: &'static str,
        html: &'static str,
        expect: &'static [Severity],
    }

    fn severities(html: &str) -> Vec<Severity> {
        lint_html(html).into_iter().map(|v| v.severity).collect()
    }

    #[test]
    fn lint_table() {
        let cases = [
            Case {
                name: "external script",
                html: r#"<script src="https://cdn.jsdelivr.net/x.js"></script>"#,
                expect: &[Reject],
            },
            Case {
                name: "external script over plain http",
                html: r#"<script src="http://cdn.jsdelivr.net/x.js"></script>"#,
                expect: &[Reject],
            },
            Case {
                name: "protocol-relative script",
                html: r#"<script src="//cdn.jsdelivr.net/x.js"></script>"#,
                expect: &[Reject],
            },
            Case {
                name: "external stylesheet",
                html: r#"<link rel="stylesheet" href="https://fonts.googleapis.com/x">"#,
                expect: &[Reject],
            },
            Case {
                name: "external stylesheet, mixed-case multi-token rel",
                html: r#"<link rel="preload Stylesheet" href="https://fonts.googleapis.com/x">"#,
                expect: &[Reject],
            },
            Case {
                name: "non-stylesheet link is out of scope",
                html: r#"<link rel="icon" href="https://example.com/favicon.ico">"#,
                expect: &[],
            },
            Case {
                name: "external img src",
                html: r#"<img src="https://x/y.png">"#,
                expect: &[Reject],
            },
            Case {
                name: "external img src, uppercase scheme",
                html: r#"<img src="HTTPS://X/Y.PNG">"#,
                expect: &[Reject],
            },
            Case {
                name: "external img srcset",
                html: r#"<img srcset="https://x/y.png 2x">"#,
                expect: &[Reject],
            },
            Case {
                name: "external candidate among local ones in srcset",
                html: r#"<img srcset="/assets/a.png 1x, https://x/y.png 2x">"#,
                expect: &[Reject],
            },
            Case {
                name: "external source src",
                html: r#"<video><source src="https://x/v.mp4"></video>"#,
                expect: &[Reject],
            },
            Case {
                name: "external source srcset",
                html: r#"<picture><source srcset="https://x/y.webp"></picture>"#,
                expect: &[Reject],
            },
            Case {
                name: "external poster",
                html: r#"<video poster="https://x/p.jpg"></video>"#,
                expect: &[Reject],
            },
            Case {
                name: "external iframe",
                html: r#"<iframe src="https://x"></iframe>"#,
                expect: &[Reject],
            },
            Case {
                name: "external object",
                html: r#"<object data="https://x/o.pdf"></object>"#,
                expect: &[Reject],
            },
            Case {
                name: "external embed",
                html: r#"<embed src="https://x/e.svg">"#,
                expect: &[Reject],
            },
            Case {
                name: "css @import",
                html: r#"<style>@import url(https://x);</style>"#,
                expect: &[Reject],
            },
            Case {
                name: "css @import with quoted url",
                html: r#"<style>@import url("https://x/a.css");</style>"#,
                expect: &[Reject],
            },
            Case {
                name: "external url() in a style element",
                html: r#"<style>body{background:url(https://x/i.png)}</style>"#,
                expect: &[Reject],
            },
            Case {
                name: "external url() in a style attribute",
                html: r#"<div style="background:url(https://x/i.png)"></div>"#,
                expect: &[Reject],
            },
            Case {
                name: "data: url() in css is fine",
                html: r#"<style>body{background:url(data:image/png;base64,iVBORw0K)}</style>"#,
                expect: &[],
            },
            Case {
                name: "relative url() in css is fine",
                html: r#"<div style="background:url(/assets/abc)"></div>"#,
                expect: &[],
            },
            Case {
                name: "fetch in an inline script",
                html: r#"<script>fetch('/a')</script>"#,
                expect: &[Warn],
            },
            Case {
                name: "the other blocked network APIs",
                html: r#"<script>new XMLHttpRequest(); new EventSource('/e'); new WebSocket('/w');</script>"#,
                expect: &[Warn, Warn, Warn],
            },
            Case {
                name: "each blocked API is reported once, not per call",
                html: r#"<script>fetch('/a'); fetch('/b'); fetch('/c');</script>"#,
                expect: &[Warn],
            },
            Case {
                name: "external form action",
                html: r#"<form action="https://x"></form>"#,
                expect: &[Warn],
            },
            Case {
                name: "relative form action is fine",
                html: r#"<form action="/submit"></form>"#,
                expect: &[],
            },
            Case {
                name: "rejects and warnings in one document, in document order",
                html: r#"<script src="https://x/a.js"></script><form action="https://x"></form>"#,
                expect: &[Reject, Warn],
            },
            Case {
                name: "clean document",
                html: CLEAN_DOC,
                expect: &[],
            },
        ];

        for case in cases {
            assert_eq!(
                severities(case.html),
                case.expect,
                "case {:?} produced {:#?}",
                case.name,
                lint_html(case.html)
            );
        }
    }

    #[test]
    fn violations_name_the_offending_url_and_say_what_to_do() {
        let v = &lint_html(r#"<script src="https://cdn.jsdelivr.net/x.js"></script>"#)[0];
        assert!(
            v.what.contains("https://cdn.jsdelivr.net/x.js"),
            "what was {:?}",
            v.what
        );
        assert!(!v.detail.is_empty());

        let v = &lint_html(r#"<img src="https://x/y.png">"#)[0];
        assert!(v.what.contains("https://x/y.png"), "what was {:?}", v.what);
        assert_eq!(v.detail, "inline it or vendor it manually");

        let v = &lint_html(r#"<script>fetch('/a')</script>"#)[0];
        assert!(v.what.contains("fetch("), "what was {:?}", v.what);
    }

    #[test]
    fn text_split_across_chunks_is_still_scanned() {
        // lol_html delivers text in chunks; a long comment forces more than one.
        let filler = "/* ".to_string() + &"pad ".repeat(5000) + "*/";
        let html = format!("<style>{filler}\n@import url(https://x/a.css);</style>");
        assert_eq!(severities(&html), vec![Reject]);
    }
}
