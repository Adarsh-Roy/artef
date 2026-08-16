<h1 align="center">artef</h1>

<p align="center">
Self-hosted HTML document sharing with workspace access control, for any agent harness.
</p>

<p align="center">
One container image. Deploys in about fifteen minutes.
</p>

---

Agents generate finished HTML — reports, dashboards, writeups. artef stores those
documents behind your existing SSO, gives each one a link, and renders them in a
sandbox that cannot reach your session or the network.

- **Access control.** Private, specific people, workspace-wide, or public. Checked
  on every request. A link does not confirm a document exists to someone without
  access.
- **Sandbox.** Documents render under `sandbox allow-scripts` (never
  `allow-same-origin`) with `connect-src 'none'` and `form-action 'none'`. Inline
  JavaScript runs; nothing leaves the page. See [`artef-spec.md` §2](./artef-spec.md).
- **Live updates.** A new version pushes to open tabs over SSE.
- **Two interfaces.** An MCP server at `/mcp` for agents, and a CLI for scripted
  and scheduled pushes.
- **One image.** Server, viewer, MCP, and migrations in `ghcr.io/adarsh-roy/artef`,
  with Postgres and Caddy in the same compose file.

## Deploy

1. **DNS.** An A record for `artef.company.com` pointing at the server.
2. **OAuth client.** One Google OAuth client (Google Cloud Console → APIs &
   Services → Credentials), authorized redirect URI
   `https://artef.company.com/auth/google/callback`. Any OIDC provider works
   instead — see `.env.example`.
3. **Config.** `cp .env.example .env` and set the six values it marks.
4. **Run.** `docker compose up -d`.

The image is pulled from GHCR, migrations run on boot, and Caddy obtains and
renews the TLS certificate. Serve artef at the root of its domain
(`https://artef.company.com/`, not `https://host/artef`); asset URLs and short
links are root-relative.

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

Planned: S3 blob storage, version history browsing, reverse-proxy
authentication (`AUTH_MODE=proxy`), Cloudflare adapters.
