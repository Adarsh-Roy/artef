<h1 align="center">artef</h1>

<p align="center">
Self-hosted HTML document sharing for any agents (mostly).
</p>

---

Agents generate finished HTML — reports, dashboards, writeups. artef stores those
documents behind your existing SSO, gives each one a link, and renders them in a
sandbox that cannot reach your session or the network.

- **Access control.** Private, specific people, workspace-wide, or public. Checked
  on every request. A link does not confirm a document exists to someone without
  access.
- **Sign-in.** Google Workspace, or any OIDC provider. Accounts belong to a
  workspace by email domain, so consumer accounts (gmail.com and similar) cannot
  sign in. See [Sign-in](#sign-in).
- **Sandbox.** Documents render under `sandbox allow-scripts` (never
  `allow-same-origin`) with `connect-src 'none'` and `form-action 'none'`. Inline
  JavaScript runs; nothing leaves the page.
- **Live updates.** A new version pushes to open tabs over SSE.
- **Two interfaces.** An MCP server at `/mcp` for agents, and a CLI for scripted
  and scheduled pushes.
- **One image.** Server, viewer, MCP, and migrations in `ghcr.io/adarsh-roy/artef`,
  with Postgres and Caddy in the same compose file.

## Deploy

1. **DNS.** An A record for `artef.company.com` pointing at the server.
2. **OAuth client.** One Google OAuth client (Google Cloud Console → APIs &
   Services → Credentials), authorized redirect URI
   `https://artef.company.com/auth/google/callback`. For a different provider,
   see [Sign-in](#sign-in).
3. **Config.** `cp .env.example .env` and set the six values it marks.
4. **Run.** `docker compose up -d`.

The image is pulled from GHCR, migrations run on boot, and Caddy obtains and
renews the TLS certificate. Serve artef at the root of its domain
(`https://artef.company.com/`, not `https://host/artef`); asset URLs and short
links are root-relative.

### Sign-in

Set `ALLOWED_DOMAINS` to the email domains that may sign in. Everyone at a domain
shares one workspace, which is what workspace-wide sharing and the people
autocomplete are scoped to. Consumer domains (gmail.com, outlook.com, and
similar) are rejected: a workspace built from one would put strangers in the same
sharing scope. Several domains can be folded into one workspace with
`WORKSPACE_DOMAIN_MAP`.

Two provider configurations are supported:

- **Google Workspace** — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. This is
  the path that has been tested against a live provider.
- **Any OIDC provider** — `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`, and optionally `OIDC_DISPLAY_NAME`. The issuer must serve
  discovery at `/.well-known/openid-configuration`; the redirect URI is
  `https://artef.company.com/auth/oidc/callback`. Implemented and covered by
  tests, but not yet verified against a real deployment of Okta, Entra ID, or
  Authentik — expect to report rough edges.

### Versions

`docker-compose.yml` pins a released version. Published tags are listed on the
[package page](https://github.com/Adarsh-Roy/artef/pkgs/container/artef); each
release also appears under
[Releases](https://github.com/Adarsh-Roy/artef/releases), which is where the CLI
binaries are attached. Images are built for `linux/amd64` and `linux/arm64`.

To run a different version, set it in `.env`:

```bash
ARTEF_VERSION=0.2.1   # or `latest` to track the most recent release
```

To upgrade, change that value and:

```bash
docker compose pull && docker compose up -d
```

Migrations for the new version run on boot. To roll back, set the previous
version and repeat — note that migrations are not reversed, so a rollback across
a schema change needs a database restored from backup.

## Use

### From an agent (MCP)

```bash
claude mcp add --transport http artef https://artef.company.com/mcp
```

The server reports that it needs authentication. Approving opens a browser,
you confirm on a page that uses your normal SSO session, and the harness stores
and refreshes its own token — nothing is pasted into a config file. Revoke access
by deleting the `mcp: …` token from your token list.

Tools: `publish_artifact`, `update_artifact`, `get_artifact`, `get_content`,
`list_artifacts`, `set_visibility`, `grant_access`. Documents are validated
against the sandbox rules before they are written, and a rejection lists the
violations so the agent can correct them.

### From the command line (CLI)

The CLI covers what MCP cannot: pushing on a schedule with no agent session
running, and CI. `artef watch` regenerates and re-pushes a file on an interval,
so open tabs stay current without anything watching them:

```bash
artef watch report.html --every 5m --cmd "python build_report.py"
```

Install from a release. Use `curl` rather than a browser download, which marks
unsigned binaries as quarantined on macOS:

```bash
V=v0.2.1
T=aarch64-apple-darwin   # or: x86_64-apple-darwin, x86_64-unknown-linux-musl
curl -fsSL "https://github.com/Adarsh-Roy/artef/releases/download/$V/artef-$V-$T.tar.gz" | tar xz
sudo mv artef /usr/local/bin/
```

Or build from source: `cargo build --release` in `cli/`.

```bash
artef login --server https://artef.company.com
artef push report.html
artef share --email teammate@company.com report.html
```

`artef lint` checks a file against the sandbox rules; `push` runs the same check.
See `artef --help` for `ls`, `open`, `pull`, `rm`, and `watch`. On first run the
CLI installs the agent skill ([`skill/SKILL.md`](./skill/SKILL.md)) for Claude
Code and Codex.

## Development

```bash
docker compose -f docker-compose.dev.yml up -d   # postgres on localhost:5433
cd server && pnpm i && pnpm test
cd ../cli && cargo test
```

Server: TypeScript (Hono, Drizzle, Postgres). CLI: Rust.

## Roadmap

Shipped: document push and serving, the sandbox and its invariant test,
visibility and sharing, live updates over SSE, content-addressed asset
extraction, the MCP server with OAuth, the CLI, and tagged releases.

Planned: verified support for OIDC providers beyond Google (Okta, Entra ID,
Authentik), guest access so people outside the workspace — including consumer
accounts — can be granted a document by email, S3 blob storage, version history
browsing, reverse-proxy authentication (`AUTH_MODE=proxy`), and Cloudflare
adapters.
