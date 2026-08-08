//! Pull large inline images out of a document (spec §6).
//!
//! Agent-generated documents are big because of base64 images, and gzip cannot help:
//! PNG and JPEG are already compressed, and base64 adds 33% on top. Every image over
//! `INLINE_THRESHOLD` is decoded, hashed, and replaced by `/assets/<sha>` — a relative
//! path the artifact CSP allows, cached forever by the browser, and shared by every
//! document in the workspace that contains the same bytes.
//!
//! Nothing here fails a push over a broken image. An attribute we cannot read is left
//! exactly as it was written: the document still renders the same way it did before.

use std::cell::RefCell;
use std::collections::HashSet;

use anyhow::{Context, Result};
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use lol_html::html_content::Element;
use lol_html::{element, rewrite_str, RewriteStrSettings};
use sha2::{Digest, Sha256};

/// Images at or below this decoded size stay inline. Extracting a 200-byte icon would
/// cost a round trip on push and a request on every view to save nothing (spec §6).
pub const INLINE_THRESHOLD: usize = 8 * 1024;

/// One image that came out of the document, ready to upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedAsset {
    pub sha_hex: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

/// The image types the extractor recognises (spec §6). Anything else — a PDF, an
/// inline font, a `data:text/html` — is left in the document untouched.
const IMAGE_TYPES: [&str; 6] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
];

/// Real documents wrap long attributes across lines and drop the padding, and both are
/// still perfectly readable base64. Being strict about either would leave a megabyte
/// inline for no reason.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// Rewrite a document's large inline images to `/assets/<sha>`, and hand back the
/// images that have to be uploaded for those paths to resolve.
///
/// Assets are deduped by hash: a logo that appears in twenty places is one upload and
/// twenty rewritten attributes.
pub fn extract_assets(html: &str) -> Result<(String, Vec<ExtractedAsset>)> {
    let found = RefCell::new(Collected::default());

    let settings = RewriteStrSettings {
        // No `srcset`. It holds a comma-separated list of candidates, and a data: URI
        // has commas of its own, so reading one takes a real parser rather than a
        // `split(',')`. Candidates stay inline until that is worth writing; the
        // document still renders either way.
        element_content_handlers: vec![
            element!("img[src]", |el| take(&found, el, "src")),
            element!("source[src]", |el| take(&found, el, "src")),
            element!("[poster]", |el| take(&found, el, "poster")),
        ],
        // Unlike the lint (§7.1), ambiguous markup is not a reason to refuse: the worst
        // that a token stream we cannot fully resolve costs here is an image left
        // inline. `artef push --no-preflight` has to keep working on documents the lint
        // would have turned away.
        strict: false,
        ..RewriteStrSettings::new()
    };

    let rewritten =
        rewrite_str(html, settings).context("rewriting the document's inline images")?;
    Ok((rewritten, found.into_inner().assets))
}

/// The assets pulled out so far, in the order they appeared, and the hashes already
/// taken so the same image is only collected once.
#[derive(Default)]
struct Collected {
    assets: Vec<ExtractedAsset>,
    seen: HashSet<String>,
}

/// Extract one attribute's image, if it holds one worth extracting.
fn take(
    found: &RefCell<Collected>,
    el: &mut Element<'_, '_>,
    attr: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(value) = el.get_attribute(attr) else {
        return Ok(());
    };
    let Some(asset) = extractable(&value) else {
        return Ok(());
    };

    el.set_attribute(attr, &format!("/assets/{}", asset.sha_hex))?;

    let mut found = found.borrow_mut();
    if found.seen.insert(asset.sha_hex.clone()) {
        found.assets.push(asset);
    }
    Ok(())
}

/// The image an attribute holds, if it is an inline image over the threshold.
fn extractable(value: &str) -> Option<ExtractedAsset> {
    let (media_type, payload) = image_data_uri(value)?;

    // Four base64 characters carry at most three bytes, so this rules out the small
    // ones without decoding them.
    if payload.len() / 4 * 3 <= INLINE_THRESHOLD {
        return None;
    }

    let bytes = decode(payload)?;
    if bytes.len() <= INLINE_THRESHOLD {
        return None;
    }

    Some(ExtractedAsset {
        sha_hex: hex::encode(Sha256::digest(&bytes)),
        media_type,
        bytes,
    })
}

/// Split `data:image/png;base64,iVBOR…` into its media type and its payload. `None`
/// for anything that is not a base64 image: a relative path, an `http:` URL, a
/// `data:application/pdf`, or an SVG written out as plain text after the comma.
fn image_data_uri(value: &str) -> Option<(String, &str)> {
    let value = value.trim();
    if !value.get(..5)?.eq_ignore_ascii_case("data:") {
        return None;
    }
    let (header, payload) = value[5..].split_once(',')?;

    // The last parameter has to be `base64`; that is what makes the payload bytes.
    if !header
        .rsplit(';')
        .next()
        .is_some_and(|last| last.trim().eq_ignore_ascii_case("base64"))
    {
        return None;
    }

    let media_type = header.split(';').next()?.trim().to_ascii_lowercase();
    IMAGE_TYPES
        .contains(&media_type.as_str())
        .then_some((media_type, payload))
}

/// Decode a base64 payload, tolerating the line breaks a long attribute picks up.
/// `None` means it did not decode, and the caller leaves the attribute alone.
fn decode(payload: &str) -> Option<Vec<u8>> {
    if payload.bytes().any(|byte| byte.is_ascii_whitespace()) {
        let compact: String = payload
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect();
        return BASE64.decode(compact).ok();
    }
    BASE64.decode(payload).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bytes that look like a file and do not repeat, so two sizes never collide.
    fn image(size: usize) -> Vec<u8> {
        (0..size).map(|i| (i % 251) as u8).collect()
    }

    fn data_uri(media_type: &str, bytes: &[u8]) -> String {
        format!(
            "data:{media_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn a_large_inline_image_becomes_the_path_its_bytes_hash_to() {
        let bytes = image(20 * 1024);
        let sha = sha_of(&bytes);
        let html = format!(
            r#"<p>before</p><img alt="chart" src="{}"><p>after</p>"#,
            data_uri("image/png", &bytes)
        );

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(
            out,
            format!(r#"<p>before</p><img alt="chart" src="/assets/{sha}"><p>after</p>"#)
        );
        assert_eq!(
            assets,
            vec![ExtractedAsset {
                sha_hex: sha,
                media_type: "image/png".to_string(),
                bytes,
            }]
        );
    }

    #[test]
    fn a_small_inline_image_stays_exactly_where_it_was() {
        let html = format!(r#"<img src="{}">"#, data_uri("image/png", &image(2 * 1024)));

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(out, html);
        assert_eq!(assets, vec![]);
    }

    #[test]
    fn the_threshold_is_the_decoded_size_and_it_takes_more_than_exactly_that() {
        let at = format!(
            r#"<img src="{}">"#,
            data_uri("image/png", &image(INLINE_THRESHOLD))
        );
        let (out, assets) = extract_assets(&at).unwrap();
        assert_eq!(out, at, "8KB exactly is not over the threshold");
        assert_eq!(assets, vec![]);

        let over = format!(
            r#"<img src="{}">"#,
            data_uri("image/png", &image(INLINE_THRESHOLD + 1))
        );
        let (_, assets) = extract_assets(&over).unwrap();
        assert_eq!(assets.len(), 1, "one byte more is");
    }

    #[test]
    fn the_same_image_twice_is_one_asset_and_two_rewritten_attributes() {
        let bytes = image(20 * 1024);
        let sha = sha_of(&bytes);
        let uri = data_uri("image/png", &bytes);
        let html = format!(r#"<img src="{uri}"><section><img src="{uri}"></section>"#);

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(assets.len(), 1, "the same bytes are uploaded once");
        assert_eq!(
            out,
            format!(r#"<img src="/assets/{sha}"><section><img src="/assets/{sha}"></section>"#)
        );
    }

    #[test]
    fn base64_that_does_not_decode_is_left_alone_instead_of_failing_the_push() {
        let html = format!(
            r#"<img src="data:image/png;base64,{}">"#,
            "!".repeat(30_000)
        );

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(out, html);
        assert_eq!(assets, vec![]);
    }

    #[test]
    fn an_inline_svg_is_extracted_under_its_own_media_type() {
        let svg = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\">{}</svg>",
            "x".repeat(20_000)
        )
        .into_bytes();
        let html = format!(r#"<img src="{}">"#, data_uri("image/svg+xml", &svg));

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].media_type, "image/svg+xml");
        assert!(out.contains(&format!("/assets/{}", sha_of(&svg))), "{out}");
    }

    #[test]
    fn every_image_type_the_spec_names_is_recognised_however_it_is_spelled() {
        for media_type in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/avif",
        ] {
            let html = format!(r#"<img src="{}">"#, data_uri(media_type, &image(20 * 1024)));
            let (_, assets) = extract_assets(&html).unwrap();
            assert_eq!(assets.len(), 1, "{media_type} was not extracted");
            assert_eq!(assets[0].media_type, media_type);
        }

        // HTML is not case-sensitive about any of this, and neither is the media type.
        let html = format!(
            r#"<IMG SRC="DATA:IMAGE/PNG;BASE64,{}">"#,
            base64::engine::general_purpose::STANDARD.encode(image(20 * 1024))
        );
        let (_, assets) = extract_assets(&html).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].media_type, "image/png");
    }

    #[test]
    fn a_data_uri_that_is_not_a_base64_image_is_left_inline() {
        let big = image(20 * 1024);
        for uri in [
            data_uri("application/pdf", &big),
            data_uri("text/html", &big),
            data_uri("font/woff2", &big),
            // An SVG spelled out after the comma instead of base64: there is nothing to
            // decode, and rewriting it would need percent-decoding rules we do not have.
            format!("data:image/svg+xml,<svg>{}</svg>", "x".repeat(20_000)),
        ] {
            let html = format!(r#"<img src="{uri}">"#);
            let (out, assets) = extract_assets(&html).unwrap();
            assert_eq!(out, html);
            assert_eq!(
                assets,
                vec![],
                "{} was extracted",
                &uri[..24.min(uri.len())]
            );
        }
    }

    #[test]
    fn a_src_that_is_not_a_data_uri_is_never_touched() {
        let html = r#"<img src="/logo.png"><img src="https://example.com/x.png"><img>"#;
        let (out, assets) = extract_assets(html).unwrap();
        assert_eq!(out, html);
        assert_eq!(assets, vec![]);
    }

    #[test]
    fn a_poster_and_a_source_hold_images_too() {
        let poster = image(20 * 1024);
        let source = image(20 * 1024 + 1);
        let html = format!(
            r#"<video poster="{}"><source src="{}"></video>"#,
            data_uri("image/jpeg", &poster),
            data_uri("image/webp", &source),
        );

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(assets.len(), 2);
        assert!(
            out.contains(&format!(r#"poster="/assets/{}""#, sha_of(&poster))),
            "{out}"
        );
        assert!(
            out.contains(&format!(r#"src="/assets/{}""#, sha_of(&source))),
            "{out}"
        );
    }

    #[test]
    fn a_srcset_is_deliberately_left_as_it_is() {
        // `srcset` holds a comma-separated list, and a data: URI has commas of its own,
        // so splitting one correctly is a parser rather than a `split(',')`. Until that
        // is worth writing, the candidates stay inline — the document still renders.
        let html = format!(
            r#"<img srcset="{} 2x" src="/logo.png">"#,
            data_uri("image/png", &image(20 * 1024))
        );

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(out, html);
        assert_eq!(assets, vec![]);
    }

    #[test]
    fn an_attribute_wrapped_across_lines_still_decodes() {
        let bytes = image(20 * 1024);
        let wrapped: String = base64::engine::general_purpose::STANDARD
            .encode(&bytes)
            .as_bytes()
            .chunks(76)
            .map(|line| format!("{}\n", String::from_utf8_lossy(line)))
            .collect();
        let html = format!(r#"<img src="data:image/png;base64,{wrapped}">"#);

        let (out, assets) = extract_assets(&html).unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].bytes, bytes);
        assert!(
            out.contains(&format!("/assets/{}", sha_of(&bytes))),
            "{out}"
        );
    }
}
