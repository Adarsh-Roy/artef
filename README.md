# artef

Self-hostable service for the HTML documents your agents already generate: push a
file, get a private link, share it like a Google Doc. Everything runs on one
domain in one container image, behind Google (or any OIDC) login.

## Install

Fifteen minutes for anyone who has deployed [Outline](https://www.getoutline.com/)
before. One DNS record, one OAuth client, a handful of env vars, `docker compose up`.

1. **DNS.** One A record for `artef.company.com` pointing at the server.
2. **OAuth.** One Google OAuth client (Google Cloud Console → APIs & Services →
   Credentials). Authorized redirect URI:
   `https://artef.company.com/auth/google/callback`.
3. **Env.** Copy the example and fill in the six values it flags:
   ```bash
   cp .env.example .env
   # set DOMAIN, URL, SECRET_KEY (openssl rand -hex 32), ALLOWED_DOMAINS,
   # GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
   ```
4. **Run.** Migrations run on boot — no separate migrate step:
   ```bash
   docker compose up -d
   ```
5. **Use.** Open `https://artef.company.com`, log in with Google, push a file
   with the CLI (below).

Caddy fetches and renews the TLS certificate automatically. There is no second
domain, no wildcard certificate, and no reverse-proxy sidecar to understand.

Serve artef at the **root** of its domain (`https://artef.company.com/`, not
`https://host/artef`) in v1: asset URLs (`/assets/…`) and short links (`/a/…`)
are root-relative.

## CLI quickstart

```bash
artef login --server https://artef.company.com   # opens a browser, stores a machine token
artef push report.html                            # create or update an artifact, prints its link
```

`artef lint report.html` checks a file against the sandbox rules before you push;
`artef push` runs the same check on its own. See `artef --help` for `ls`, `share`,
`open`, `pull`, `rm`, and `watch` (re-push a regenerated file on an interval).

## Security model

Artifacts are untrusted, machine-generated HTML with arbitrary inline
JavaScript, and they all run on the same domain as the app. What keeps that safe
is a single response header. `GET /c/<uuid>` serves each document under a CSP
`sandbox allow-scripts` policy (never `allow-same-origin`), which gives it an
**opaque origin**: no session cookie, no `document.cookie`, no storage, no access
to the parent frame, and — because `connect-src 'none'` and `form-action 'none'`
are absolute — no way to send a byte anywhere. Private documents are reached with
short-lived **content tokens** in the URL rather than the session cookie, so the
sandbox works the same whether the page is framed or opened directly. The full
reasoning, the load flow, and the one honest residual are in
[`artef-spec.md` §2](./artef-spec.md).

## Agent skill

When an agent generates a document for `artef push`, point it at
[`skill/SKILL.md`](./skill/SKILL.md). The sandbox forbids every external request,
so the document must carry everything inline — the skill spells out what is
allowed, what fails loudly, and what fails silently, with a complete example.

## Development

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres only, on localhost:5433
cd server && pnpm i && pnpm test                  # server tests (vitest)
cd ../cli && cargo test                           # CLI tests
```

The server is TypeScript (Hono, Drizzle, Postgres); the CLI is Rust.

## Roadmap

Shipped: push/serve on one origin, the sandbox and its invariant test, the CLI,
visibility and sharing, live documents (`watch` + SSE), and content-addressed
asset extraction. Still ahead (later milestones, not yet here): an S3 blob
backend, version-history browsing, reverse-proxy (`AUTH_MODE=proxy`)
authentication, and optional Cloudflare adapters.
