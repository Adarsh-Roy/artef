# artef

Self-hostable service for the HTML documents your agents already generate: push
a file, get a private link, share it like a Google Doc. One domain, one
container image, behind your existing Google (or any OIDC) login.

Agents produce finished HTML constantly — reports, dashboards, writeups — and it
lands as attachments, gists, or pastes into chat. artef gives those documents a
home with the two properties none of that combines: **real access control**
(workspace SSO, per-person grants, link sharing) and **safe execution** (every
document runs in a CSP sandbox that cannot read your session or send a byte
anywhere).

## What you get

- **Private links, shared like docs** — private, specific people, workspace-wide,
  or public; checked on every request; a link never confirms a document exists
  to someone without access.
- **A hard sandbox** — documents render under `sandbox allow-scripts` (never
  `allow-same-origin`) with `connect-src 'none'` and `form-action 'none'`:
  inline JavaScript runs, exfiltration doesn't. The invariant has its own
  release-gate test. Full reasoning in [`artef-spec.md` §2](./artef-spec.md).
- **Live documents** — `artef watch` re-pushes a regenerated file on an
  interval; open tabs update over SSE.
- **Agent-native** — an MCP server at `/mcp` (publish/update/share as typed
  tools), a CLI for the same API, and an agent skill that teaches the sandbox
  rules, installed automatically.
- **One image** — server, viewer, MCP, and migrations in
  `ghcr.io/adarsh-roy/artef`; Postgres and Caddy beside it in one compose file.

## Deploy

Fifteen minutes for anyone who has deployed
[Outline](https://www.getoutline.com/) before: one DNS record, one OAuth
client, a handful of env vars, `docker compose up`.

1. **DNS.** One A record for `artef.company.com` pointing at the server.
2. **OAuth.** One Google OAuth client (Google Cloud Console → APIs & Services →
   Credentials) with authorized redirect URI
   `https://artef.company.com/auth/google/callback`.
3. **Env.** `cp .env.example .env` and fill in the six values it flags.
4. **Run.** `docker compose up -d` — pulls the published multi-arch image,
   runs migrations on boot, and Caddy fetches and renews TLS on its own.

No second domain, no wildcard certificate, no sidecars. Serve artef at the
**root** of its domain (`https://artef.company.com/`, not `https://host/artef`):
asset URLs and short links are root-relative.

## Connect an agent (MCP)

Nothing to install. The MCP server lives at `/mcp` on the deployment itself,
with OAuth sign-in built in:

```bash
claude mcp add --transport http artef https://artef.company.com/mcp
```

On first use the agent reports that the server needs authentication; approving
opens the browser, you confirm on a page that reuses your normal SSO session,
and the harness holds and refreshes its own token from then on. The tools —
`publish_artifact`, `update_artifact`, `get_artifact`, `get_content`,
`list_artifacts`, `set_visibility`, `grant_access` — validate documents
server-side and return violations as data the agent can fix and retry. Revoke
the connection any time by deleting the `mcp: …` token from your token list.

## Install the CLI (optional)

For `artef watch` (re-push a regenerated file on an interval), CI pipelines,
and pushing by hand. Download with `curl`, not the browser (browser downloads
trip macOS Gatekeeper on unsigned binaries), or build from source with
`cargo build --release` in `cli/`:

```bash
V=v0.2.0
T=aarch64-apple-darwin   # or: x86_64-apple-darwin, x86_64-unknown-linux-musl
curl -fsSL "https://github.com/Adarsh-Roy/artef/releases/download/$V/artef-$V-$T.tar.gz" | tar xz
sudo mv artef /usr/local/bin/   # or anywhere on your PATH
```

Then:

```bash
artef login --server https://artef.company.com   # opens a browser, stores a machine token
artef push report.html                            # create or update, prints the link
artef share --email teammate@company.com report.html
```

`artef lint report.html` checks a file against the sandbox rules before you
push; `push` runs the same check on its own. See `artef --help` for `ls`,
`open`, `pull`, `rm`, and `watch`. On its first run the CLI also registers the
**agent skill** ([`skill/SKILL.md`](./skill/SKILL.md)) for Claude Code and
Codex, so an agent generating documents locally knows the everything-inline
rules.

## Development

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres only, on localhost:5433
cd server && pnpm i && pnpm test                  # server tests (vitest)
cd ../cli && cargo test                           # CLI tests
```

The server is TypeScript (Hono, Drizzle, Postgres); the CLI is Rust.

## Roadmap

Shipped: push/serve on one origin, the sandbox and its invariant test, the CLI,
visibility and sharing, live documents (`watch` + SSE), content-addressed asset
extraction, the MCP server with OAuth sign-in, and the tagged-release pipeline
(image + CLI binaries). Still ahead: an S3 blob backend, version-history
browsing, reverse-proxy (`AUTH_MODE=proxy`) authentication, and optional
Cloudflare adapters.
