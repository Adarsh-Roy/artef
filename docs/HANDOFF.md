# Artef — handoff / state of the world

Written 2026-08-16, after the full EC2 dress rehearsal. Read this first when picking the
project back up (human or agent).

## Where things stand

Everything through milestone M5 plus MCP, skill auto-registration, and people autocomplete
is **built, adversarially reviewed, and field-tested three ways**:

1. **Local** — full flow on `http://localhost:3000` against a dev Postgres (`docker-compose.dev.yml`,
   port 5433). Demo state lives in the `artef_demo` database so test runs can't wipe it.
2. **Real browser** — live Google Workspace SSO (trial workspace `adarshroy.fyi`, users
   user1–user4), share dialog, CLI loopback login. This testing caught and we fixed three
   real-browser bugs invisible to the 500+ test suite: `no-referrer` pages send `Origin: null`
   on their own POSTs; Chromium enforces `form-action` on form-submission *redirects* (the
   loopback callback needed `form-action 'self' http://127.0.0.1:*`); 180s login window too
   short (now 600s).
3. **EC2 production** — full network battery passed on a t3.micro: real Let's Encrypt TLS,
   HTTP→HTTPS, OIDC redirect built from config behind the proxy, production Docker image
   (migrations on boot), SSE live updates through Caddy over the internet, sandbox CSP
   invariant over TLS, MCP publish + CLI update of the same document.

The EC2 instance was **terminated after the test** (billing hygiene). Nothing of value was
on it — the repo is the source of truth; production state was throwaway demo data.

## Done 2026-08-16: distributable Docker image (release v0.1.0 published)

`.github/workflows/release.yml` runs on `v*` tags: a version-drift check (tag vs
`server/package.json` vs `cli/Cargo.toml` — bump both before tagging), the ghcr image
(amd64 + arm64, built from the repo Dockerfile untouched — the package.json/drizzle/dist
layout invariant lives there, not in CI), CLI tarballs (macOS arm64 + x86_64,
Linux x86_64 musl static), and a GitHub release carrying the tarballs. Run #1 on
`v0.1.0` went green in ~5 min. `docker-compose.yml` now prefers
`image: ghcr.io/adarsh-roy/artef:0.1.0` (`build: .` stays as the commented source path).
Plan: `docs/superpowers/plans/2026-08-16-ghcr-release-workflow.md`.

The package is **public** (flipped by hand 2026-08-16 — GitHub has no API for container
visibility; each brand-new package repeats that one click at
github.com/users/Adarsh-Roy/packages/container/artef/settings). Verified: anonymous
`docker pull ghcr.io/adarsh-roy/artef:0.1.0` works, manifest carries amd64 + arm64.
Note for agents: `gh` on this machine cannot see this private repo (its active account
has no access) — check CI via the browser instead.

## Done 2026-08-16 (same day, later): full EC2 re-test with the release artifacts

The runbook below was re-run end to end using ONLY shipped artifacts — image-pull deploy
(no swapfile, no rsync, no source build; stack up in under a minute on a fresh t3.micro)
plus the released macOS arm64 CLI tarball. Whole battery passed: anonymous pull,
image boot + migrations on fresh Postgres, Let's Encrypt over tls-alpn-01, http→https 308,
OIDC redirect with PKCE behind the proxy, fresh `artef login` (loopback + code exchange),
lint/push/share, CSP sandbox invariant over TLS, SSE `hello`→`updated` through Caddy,
MCP initialize/tools/publish, and a CLI v2 push onto the MCP-created document (adopted by
hand-writing `.artef.json` — it is designed for that).

**Live demo box (2026-08-16 night): `i-042745fe2afa6e399` (artef-demo-2)**, t3.micro,
eu-north-1b, 16.171.254.48, running `ghcr.io/adarsh-roy/artef:0.2.1` behind
artef.adarshroy.fyi. Launched fresh because eu-north-1a ran out of t3.micro capacity —
the older stopped instance `i-095288f33cfef942d` still exists (stopped, stale data,
safe to terminate). The v0.2.x OAuth flow is **verified live end to end** by a scripted
OAuth client (DCR → consent → PKCE exchange → MCP call → refresh rotation) and by
Claude Code's real client up through DCR + authorize URL ("Needs authentication" in
`claude mcp list`; `claude mcp login artef` completes it — needs an interactive
terminal). Database is fresh: user1 seeded by hand; the pitch doc is NOT republished
on this box yet. Oracle migration remains parked in the local notes
(`.claude/notes-consumer-signin.md`) — blocked on OCI account + Chrome extension site
access. CI note: qemu is pinned to v8.1.5 in the release workflow — newer qemu
SIGILLs Node during the arm64 pnpm install whenever that layer goes cold (killed the
first v0.2.1 run); if the repo goes public, free native arm runners
(`ubuntu-24.04-arm`) are the better fix.

Field notes from the re-test: macOS Gatekeeper SIGKILLs the downloaded release binary
(unsigned; browser download adds `com.apple.quarantine` — one kill even auto-removed the
file). `xattr -c` clears it; signing/notarization or a brew tap is the real fix and worth
doing before pitching the CLI download path. Also: to run the CLI
with isolated state, set `XDG_CONFIG_HOME` — that's the knob `config.rs::config_dir`
honors first; a `HOME=` prefix did not isolate it in this test and the login wrote the
real `~/.config/artef/config.toml` (harmless here: the entry it replaced pointed at the
previous, terminated deployment).

## Done 2026-08-16 (evening): MCP OAuth (v0.2.0)

`/mcp` now onboards harnesses itself: 401 carries `WWW-Authenticate` →
`/.well-known/oauth-protected-resource/mcp` → RFC 8414 metadata → dynamic client
registration → consent page on the existing SSO session → PKCE code exchange. Access
tokens are ordinary machine tokens (`mcp: <client>`, 7-day expiry); refresh tokens
rotate and cascade-die with the visible token, so revoking in the token list fully
disconnects a client. `claude mcp add --transport http artef <url>/mcp` needs no
header and no CLI. Routes in `server/src/routes/oauth.ts` (mirrors cliauth.ts
mechanics), 36 tests in `server/test/oauth.test.ts`, spec §7.0 rewritten, invariant
snapshot updated. Versions bumped to 0.2.0 (both manifests + compose pin).

## How to redo the EC2 deployment (agent-executable)

All personal-account work. **Never use the `aws-prod`/`aws-stage` CLI profiles on this
machine — they are the company's.** Personal AWS is console-only (adarshroy.formal@gmail.com);
the user signs in themselves (agents don't handle passwords), then the agent can drive the
console via browser tooling.

1. **Launch** (region `eu-north-1` was used; any is fine): Ubuntu LTS AMI (free-tier eligible),
   `t3.micro`, key pair `artef-demo` (create anew if the old `.pem` is gone — it was in
   `~/Downloads/artef-demo.pem`), security group allowing 22/80/443 from anywhere, 20 GiB gp3.
   A zero-spend budget alert already exists on the account.
2. **DNS**: Cloudflare zone `adarshroy.fyi` → A record `artef` → instance public IP,
   **DNS only (grey cloud)** — Caddy must answer its own ACME challenge. User adds this
   (their Cloudflare login), or agent drives it if signed in.
3. **Provision** over SSH (`ubuntu@<ip>`, the .pem, `chmod 400` first):
   - 2G swapfile (1GB RAM is not enough for the source build; unnecessary if deploying the
     published ghcr image — that's the point of the next task).
   - Docker: `curl -fsSL https://get.docker.com | sudo sh`.
   - `rsync` the repo (exclude `node_modules dist target .git .superpowers .claude .env*`)
     — or after the CI work, skip rsync entirely and just copy `docker-compose.yml`,
     `Caddyfile`, `.env`.
4. **`.env`** on the box (chmod 600): `DOMAIN=artef.adarshroy.fyi`,
   `URL=https://artef.adarshroy.fyi`, fresh `SECRET_KEY=$(openssl rand -hex 32)`, fresh
   `POSTGRES_PASSWORD`, `FILE_STORAGE=postgres`, `MAX_ARTIFACT_BYTES=10485760`,
   `MAX_VERSIONS=20`, `LINK_PREVIEW=name`, `ALLOWED_DOMAINS=adarshroy.fyi`,
   `FORCE_HTTPS=true`, and the Google client (ID is in `server/.env.local` locally —
   gitignored — along with the secret; the OAuth client `artef-local` in the trial
   workspace's `artef-test` GCP project already has BOTH redirect URIs:
   `http://localhost:3000/auth/google/callback` and
   `https://artef.adarshroy.fyi/auth/google/callback`).
5. **Start**: `sudo docker compose up -d --build` (or `pull` once the image exists). If
   Caddy logged ACME NXDOMAIN failures from before DNS propagated, `docker compose restart caddy`.
6. **Verify** (the network battery): `curl https://…/_health` → `{"ok":true}`; http→https 308;
   `/auth/login` redirect contains `redirect_uri=https%3A%2F%2Fartef.adarshroy.fyi…`;
   `/c/<id>` CSP contains `sandbox allow-scripts` and never `allow-same-origin`;
   SSE: `curl -N /api/artifacts/<id>/events` through the proxy receives `hello` then
   `updated` on a push.
7. **Headless test identity** (no browser needed): seed a machine token inside the app
   container — `docker compose exec -T app node --input-type=module -e '…'` importing
   `createDb`, schema, and `generateMachineToken` from `/app/server/dist/src/…` (see the
   session ledger for the exact snippet), then drive the CLI/MCP with `ARTEF_TOKEN`.
8. **Tear down when done**: EC2 console → terminate the instance (root volume deletes with
   it; key pair + security group are free to keep). Links die with the box.

## Trial-workspace facts (Google side)

- Google Workspace trial on `adarshroy.fyi` (13-ish days left at writing; created 2026-08-14),
  users user1–user4@adarshroy.fyi; user1 is Workspace admin AND artef workspace admin.
- Domain verified via Cloudflare TXT. Gmail/MX **not** activated — deliberately; don't.
- GCP project `artef-test` under the workspace org; OAuth consent = Internal; client
  `artef-local` (Web) with the two redirect URIs above.
- When the trial lapses, logins stop but nothing else breaks; a future test needs any
  OIDC IdP + updating `ALLOWED_DOMAINS`/client env.

## Key repo facts for a fresh agent

- Plan + reviews ledger: `.superpowers/sdd/2026-08-08-artef-m0-m5/progress.md` (gitignored,
  local) — full task-by-task history, deferred-minors backlog, parked findings.
- Invariant test (`server/test/invariant.test.ts`) is the release gate: full route-table
  snapshot; `/c/:id` + `/assets/:sha` are the only byte routes; `allow-same-origin` must
  never appear.
- Suites: `cd server && pnpm test` (needs dev Postgres up; 500+ tests) and
  `cd cli && cargo test`. A locally running dev server holds `LISTEN` on the dev DB and
  makes exactly 2 `events.test.ts` listener-count tests fail — environmental, not real.
- The CLI self-registers the agent skill (`~/.claude/skills/artef-html`, `~/.codex/skills`)
  from an embedded copy; `artef skill status|install|uninstall`.
- Deferred by design: M6 (S3 blob storage, `AUTH_MODE=proxy`, version-history read API),
  M7 (Cloudflare adapters), vendored-script dedup (spec §13.4), guest/external sharing
  (external users today = `public` links only; grants are workspace-internal, enforced).

## Open user-facing decisions on record

- Workspace-wide access stays view-only (update is per-person) unless a real team asks.
- CDN allowlisting rejected on design grounds; script dedup via content-addressed
  `/assets/<sha>.js` + `script-src 'self'` is the specced future fix (§13.4).
- The gitshare-inspired ideas not yet built: revoke-to-410, view counts.
