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

## The next task (before pitching): distributable Docker image

The one missing piece of the adoption story. Build a GitHub Actions release workflow
(spec §15) triggered on `v*` tags:

- Build + push the server image to `ghcr.io/adarsh-roy/artef:<tag>` (and `:latest`).
  Multi-arch (amd64 + arm64) if cheap. Make the package public so ops can pull anonymously.
- Build the CLI (`cargo build --release`) for macOS arm64 + x86_64 and Linux x86_64;
  attach binaries to the GitHub release.
- Then change `docker-compose.yml`'s app service to prefer `image: ghcr.io/adarsh-roy/artef:<tag>`
  (keep `build: .` as a commented alternative for source deploys).
- **Constraints from earlier reviews (in the SDD ledger):** the image must keep
  `server/package.json` adjacent to `drizzle/` and `dist/` (migrations resolve by walking up
  to the nearest package.json); never create a `dist/package.json`; entrypoint is
  `dist/src/index.js`. The current Dockerfile does all this correctly — the CI job should
  reuse it, not reinvent it.
- After the image is published: refresh `docs/pitch/deploying-artef.html` (the "Where the
  Docker image comes from" table's first row becomes the ghcr row; bump the footer), redeploy,
  and republish it.

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
