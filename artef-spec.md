# Artef — Technical Specification

A self-hostable service for storing and serving agent-generated HTML documents, with SSO, per-document access control, and a CLI for agents and live-updating documents.

**Version:** 0.2 (design, audited)
**Status:** pre-implementation

> **On the name.** Artef is a truncation of *artefact*. It is short enough to be a comfortable CLI verb, carries its meaning for free to anyone who reads it, and — being a distinct string rather than a compound — does not compete for search results with Claude's Artifacts feature or with `open-artifacts` (§14).
>
> The stored objects are called **artifacts** throughout the schema, API, and docs. `POST /api/artifacts` needs no explanation.
>
> Everywhere else: CLI verb `artef`, image `ghcr.io/<org>/artef`, tokens prefixed `art_`, local state `.artef.json`, daemon config `artef.toml`.

---

## 1. Problem & Goals

Teams increasingly generate documentation, reports, and dashboards as standalone HTML via LLM agents. HTML beats Markdown for these — real layout, charts, interactivity. But there is no good place to *put* the file. Today it gets attached to Slack, downloaded, and opened from `file://`, which loses links, loses updates, and loses access control.

### Goals

- Any agent (not just one vendor's) can create and update a hosted HTML document via a plain HTTP API.
- Documents are addressable by stable URL and viewable in a browser with no download step.
- Access is gated: public link, whole workspace, or named individuals; read-only or read-write.
- Documents can be *live* — a local process regenerates them on an interval and pushes updates; open browsers refresh automatically.
- Self-hostable by a company in under 15 minutes with `docker compose up`.

### Non-goals (v1)

- Browse UI, folders, search, tagging. Links are the interface. (The share dialog in §5.9 is the one exception — access control needs a UI or nobody will use it.)
- Editing HTML in the browser.
- Real-time collaborative editing.
- SaaS features: billing, plans, per-tenant branding, tenant self-signup. A deployment can host several workspaces (§4.3), but they are isolated silos, not tenants of a product.
- Cross-workspace sharing beyond `public` links.

### 1.1 Overriding principle — setup simplicity beats everything

**This is the highest-priority constraint in this document. Where any other section conflicts with it, this section wins.**

Nobody is obligated to adopt this. A team already generating HTML docs has a working-if-ugly habit — attach to Slack, download, open locally. That habit costs them nothing to continue. Every step we add to installation is a place where someone decides the current annoyance is cheaper than the new tool, closes the tab, and never comes back. Adoption is lost during setup, not during use.

So the design target is not "powerful." It is **boring, familiar, and finished in fifteen minutes by someone who has deployed Outline before.**

Concretely, the following are treated as defects, not trade-offs:

- Requiring a second domain, a wildcard certificate, or any DNS beyond one A record.
- Requiring a purchase of any kind to complete setup.
- Requiring an extra container the operator has to understand (a reverse-proxy sidecar, a message broker, a cache).
- Requiring a manual migration step, a seed script, or a first-run admin bootstrap.
- Inventing new vocabulary for concepts the operator already has names for.
- Any config knob that must be set correctly for the thing to work at all. Defaults must produce a working install; knobs exist only to change behaviour, never to enable it.
- Any access-control concept that can't be explained by pointing at the Google Docs share dialog.

**Setup budget:** the complete install instructions fit on one screen — one DNS record, one OAuth client, six environment variables, `docker compose up`. If a feature cannot be added without extending that list, the feature is wrong, not the budget. §2.1 is the worked example: the textbook solution to serving untrusted HTML needs a second registrable domain, we refused it on these grounds, and the alternative turned out to be both simpler to deploy and cheap to verify.

**Applies to features too.** Every new capability defaults to off and costs zero setup steps when unused. The measure of this project is how many teams run it, not how much it does.

---

## 2. Architecture

```
   ONE domain. ONE certificate. ONE container image.

                 ┌─────────────────────────────────────┐
   Browser ─────▶│  artef.company.com              │
                 │  OIDC login, session, ACL           │
                 │  GET /a/<uuid>  →  shell page       │
                 └──────────────┬──────────────────────┘
                                │ <iframe src="/c/<uuid>?t=…">
                                ▼
                 ┌─────────────────────────────────────┐
                 │  GET /c/<uuid>  →  the artifact     │
                 │  CSP: sandbox allow-scripts         │
                 │  OPAQUE ORIGIN — no cookies, no     │
                 │  storage, safe even navigated to    │
                 └─────────────────────────────────────┘

   Agent/CLI ───▶ artef.company.com/api/*  (bearer machine token)

                 ┌─────────────────────────────────────┐
                 │  Postgres 16                        │
                 │  metadata + ACL + blobs (bytea)     │
                 │  LISTEN/NOTIFY for live fanout      │
                 └─────────────────────────────────────┘
```

### 2.1 The isolation rule — one domain, opaque origin

The service serves untrusted, machine-generated HTML with arbitrary inline JavaScript. If that JS runs with the reader's session, it can call the API as them — list their documents, read their private ones, mint a long-lived machine token. The ACL isn't bypassed; it's consulted and it says yes, because the request genuinely *is* them.

A second registrable domain solves this structurally, and it is what Google (`googleusercontent.com`) and GitHub (`githubusercontent.com`) do. **We are not doing that**, because requiring a domain purchase mid-install loses the deployment (§1.1). Everything runs on `artef.company.com`.

The substitute is the **CSP `sandbox` directive**, which applies sandbox flags to a document from its own response headers rather than from the frame that embeds it. `GET /c/<uuid>` returns the artifact as ordinary `text/html` with:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:; media-src 'self' data:;
  connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, no-store
```

`sandbox allow-scripts` — without `allow-same-origin` — gives the document an **opaque origin**:

| | Result |
|---|---|
| Session cookie on its requests | Not attached — an opaque origin is cross-site for `SameSite` |
| `document.cookie` | Empty |
| `localStorage` / `sessionStorage` | Throws |
| Parent frame DOM | Blocked by same-origin policy |
| `window.open` popups | Blocked (no `allow-popups`) |
| Navigating the top frame | Blocked (no `allow-top-navigation`) |

**The header travels with the response, which is the whole point.** An iframe `sandbox=` attribute only protects the framed case — paste the URL into the address bar and the document loads top-level with your real origin and no sandbox at all. A CSP `sandbox` header applies either way. Direct navigation to `/c/<uuid>` renders the artifact harmlessly, so there is no hole to plug with `text/plain` tricks, `srcdoc` juggling, or `Content-Disposition: attachment`.

`allow-scripts` and `allow-same-origin` together cancel the sandbox out entirely. Never add the second one.

`connect-src 'none'` plus `form-action 'none'` means the artifact cannot make outbound requests at all — no fetch, no XHR, no form post. `img-src 'self' data:` allows extracted assets (§6) while blocking exfiltration through an external image URL's query string.

The remaining directives are cheap hygiene: `base-uri 'none'` stops a `<base href>` tag from re-pointing relative asset URLs somewhere else; `frame-ancestors 'self'` keeps other websites from embedding an artifact in their own pages; `media-src 'self' data:` mirrors the image policy for inline audio/video; `Cache-Control: private, no-store` keeps artifact bytes out of shared caches and makes the shell's reload-on-update actually fetch.

**This is absolute — there is no allowlist and no config knob.** Artifacts are dumb documents: they render, and their JavaScript exists so a reader can toggle a chart or step through an explanation, not to fetch data. Everything an artifact knows is baked in at push time by the process that generated it. A document is "live" because a CLI daemon pushes to it, never because the page polls. See §12.4 for the full reasoning and the one honest residual.

### 2.2 The one invariant

The two-domain design was safe because of DNS. This one is safe because of a single response header, which means it needs a test that fails loudly:

**Every response from `/c/:id` carries `Content-Security-Policy: sandbox allow-scripts` and the policy above, and the sandbox token list never contains `allow-same-origin`.**

One assertion, in one place — versus five invariants scattered across CORS config, cookie flags, and per-endpoint `Origin` checks that a two-domain-free subdomain design would have needed. Write it as a test that enumerates every route and asserts that user-supplied bytes only ever leave the server under a sandboxing CSP. Three routes serve such bytes, each with its required headers:

- **`/c/:id`** — the policy above; the sandbox token list never contains `allow-same-origin`.
- **`GET /api/artifacts/:id/content`** — agents reading back. Served as `Content-Type: application/octet-stream` with `Content-Disposition: attachment` **and** the same sandbox CSP. Without this, a logged-in user clicking a link to this URL would execute the artifact's scripts on the real app origin with their real session — the exact catastrophe §2.1 exists to prevent.
- **`/assets/:sha`** — asset bytes include `image/svg+xml`, which is a scriptable document when navigated to directly. Served with `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'` (no `allow-scripts` — image rendering needs none) plus `nosniff`.

A failure on any of the three is a release blocker.

Belt and braces, all cheap: keep `sandbox="allow-scripts"` on the embedding iframe too (redundant with the header, free), name the session cookie `__Host-session` (browsers reject any `__Host-` cookie carrying a `Domain` attribute, so no subdomain can shadow it), `SameSite=Lax`, an `Origin` check on every state-changing endpoint, and one more assertion: `/c/:id` for a non-`public` artifact never returns bytes without a valid content token (§2.4).

### 2.3 Load flow

1. Browser requests `GET /a/<uuid>`.
2. App resolves identity from the session cookie (or proxy header in Mode B).
3. App checks the ACL. On failure: 404, not 403 — a 403 confirms the artifact exists.
4. App returns the shell page: header bar, share button, and `<iframe sandbox="allow-scripts" src="/c/<uuid>?t=<content-token>">` (§2.4).
5. Browser loads `/c/<uuid>?t=…`. The request arrives **without cookies** (§2.4), so the app validates the content token instead, and returns the artifact with the §2.1 headers.
6. Shell opens the SSE stream; on each update it fetches a fresh content token and reloads the iframe. Every artifact does this — there is no live/static distinction (§12.3).

`/c/:id` is access-checked in its own right, not merely by virtue of being reached from the shell. Anyone can request it directly; without a valid token it redirects to `/a/:id`, and with one it isn't dangerous.

For `visibility = 'public'`, steps 2–3 are skipped and no token is required; everything else is identical.

### 2.4 The content token — why `/c/:id` cannot use the session cookie

The obvious design — `/c/:id` re-checks the ACL off the session cookie — does not work, and the reason is worth recording. A frame sandboxed without `allow-same-origin` has an opaque origin, and browsers treat its requests as **cross-site** for `SameSite` purposes: `SameSite=Lax`/`Strict` cookies are never sent, and when third-party cookies are blocked (Chrome's default trajectory), even `SameSite=None` cookies are dropped unless the embedder opts into the Chrome-135-only `allow-same-site-none-cookies` sandbox token. Building the private-content path on that behaviour means the product works or 404s depending on browser and version. So `/c/:id` ignores cookies entirely — the only credential it accepts is a **content token** in the URL:

- `t = base64url(artifact_id ‖ expiry ‖ HMAC-SHA256(SECRET_KEY, artifact_id ‖ expiry))`. Signed with the `SECRET_KEY` already required for sessions (§10) — no new config.
- TTL ~2 minutes. Minted only after the normal session + ACL check passes, so it is a short-lived, single-artifact viewing capability: it grants nothing else and expires before it can usefully leak. `Referrer-Policy: no-referrer` keeps it out of referrers.
- The shell page embeds one at render time. `GET /api/artifacts/:id/content-token` (session-authed, ACL-checked) returns a fresh one; the shell calls it before each SSE-triggered reload.
- `/c/:id` decision: `public` → serve; valid unexpired token → serve; otherwise `302 → /a/:id`, which runs login + ACL and re-embeds.

Assets have the same no-cookies problem and get a different answer (§5.4): they are content-addressed, so knowing the URL already means knowing the content.

---

## 3. Data Model

Postgres 16. All blobs stored **gzip-compressed at the application layer** and served with `Content-Encoding: gzip` — bytes are never decompressed server-side.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;     -- users.email

CREATE TABLE workspaces (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain        text UNIQUE NOT NULL,        -- 'company.com', from SSO
    name          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email         citext UNIQUE NOT NULL,
    name          text,
    is_admin      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz
);

CREATE TYPE visibility_t AS ENUM ('private', 'restricted', 'workspace', 'public');
CREATE TYPE role_t       AS ENUM ('viewer', 'editor');

CREATE TABLE artifacts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- v4; this IS the URL
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id      uuid NOT NULL REFERENCES users(id),
    name          text,                          -- optional label, for `ls`
    visibility    visibility_t NOT NULL DEFAULT 'private',
    content_hash  bytea NOT NULL,                -- sha256 of *uncompressed* html
    body          bytea NOT NULL,                -- gzipped html
    body_bytes    integer NOT NULL,              -- uncompressed size, for quotas
    version       integer NOT NULL DEFAULT 0,   -- 0 = created, no content yet; first PUT makes it 1
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON artifacts (workspace_id, updated_at DESC);

CREATE TABLE artifact_grants (
    artifact_id   uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          role_t NOT NULL,
    granted_by    uuid REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (artifact_id, user_id)
);

CREATE INDEX ON artifact_grants (user_id);   -- "shared with me"

-- Superseded versions only; the current body lives on artifacts.
-- Pruned to the newest MAX_VERSIONS on write (§3.2).
CREATE TABLE artifact_versions (
    artifact_id   uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version       integer NOT NULL,
    content_hash  bytea NOT NULL,
    body          bytea NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (artifact_id, version)
);

-- Content-addressed assets extracted from inline base64.
-- PK is (workspace_id, sha256), not sha256 alone: dedup is per-workspace, so
-- deleting one workspace can never break another workspace's documents, and
-- quota attribution stays honest. Serving (§5.4) looks up by sha alone — any
-- matching row carries identical bytes by construction.
CREATE TABLE assets (
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sha256        bytea NOT NULL,
    media_type    text NOT NULL,
    body          bytea NOT NULL,
    byte_size     integer NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, sha256)
);

CREATE TABLE machine_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL,
    token_hash    bytea NOT NULL UNIQUE,         -- sha256 of the secret
    prefix        text NOT NULL,                 -- 'art_a1b2c3', shown in UI/CLI
    scope_ids     uuid[],                        -- NULL = whole workspace
    expires_at    timestamptz,
    last_used_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
```

### 3.1 Notes on the blob column

- `bytea` is TOASTed automatically above ~2KB. Set `ALTER TABLE artifacts ALTER COLUMN body SET STORAGE EXTERNAL` — the data is already gzipped, so Postgres re-compressing it wastes CPU for near-zero gain.
- Field ceiling is 1GB. At 1.5MB uncompressed → ~200–400KB gzipped, there is 3+ orders of magnitude of headroom.
- Metadata and blob live in one row. TOAST keeps the blob out of the main heap, so `SELECT id, name, visibility FROM artifacts` never touches it. Do not `SELECT *` on list endpoints.

### 3.2 Write churn — the actual scaling risk

A live document refreshing every 60s is 1,440 writes/day. Each rewrites TOAST chunks and generates dead tuples. Mitigations, in order of importance:

1. **Hash-first push (§5.2).** If content is unchanged, no write happens at all. Most status dashboards are unchanged most minutes. This eliminates the majority of writes for free.
2. **Cap versions, don't special-case.** Every push that changes the hash writes a version and prunes to the newest `MAX_VERSIONS` (default 20). A minute-by-minute dashboard keeps a rolling 20 and stays flat; a document pushed twice a month keeps its whole history. No flag needed.
3. **Retention.** For non-live artifacts, keep the last 20 versions; prune older on write.
4. Consider `ALTER TABLE artifacts SET (autovacuum_vacuum_scale_factor = 0.05)` if the artifact count is large.

---

## 4. Authentication & Authorization

### 4.1 Authentication — two modes, in-process by default

The target buyer has already self-hosted Outline without friction. That is the experience to reproduce: **one container, one `.env` file, set `OIDC_CLIENT_ID` and go.** Adding a second mandatory container and a "the app must never be reachable directly or headers are forgeable" caveat makes the setup materially harder than the thing they already trust. So the default is in-process OIDC, exactly as Outline does it.

**Mode A — in-process OIDC (default).** Use `openid-client` (Node, MIT) with issuer auto-discovery. One provider abstraction covers Google, Entra, Okta, Keycloak, Authentik, Auth0 and anything else OIDC-compliant; `.well-known` discovery means the operator supplies an issuer URL, a client ID, and a secret. Google gets a named shortcut because it's the common case. This is ~200 lines including the session cookie, and it buys deployment parity with Outline — which is worth more than the 200 lines saved.

```
# Google shortcut
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# or any OIDC provider
OIDC_ISSUER_URL=https://keycloak.company.com/realms/main
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_DISPLAY_NAME=Company SSO

ALLOWED_DOMAINS=company.com,subsidiary.com
```

Session is a signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie named `__Host-session` (§2.2).

Two claims are checked on every login, not just the email string: `email_verified` must be true, and the workspace domain must come from the IdP where the IdP offers one — Google's `hd` claim, not the address (§4.3).

**Mode B — trusted header (`AUTH_MODE=proxy`).** For operators who already run oauth2-proxy, Authelia, Cloudflare Access, or any identity-aware proxy, the app reads a verified identity from the request instead of running its own flow. Roughly 30 lines. Config:

```
AUTH_MODE=proxy
PROXY_EMAIL_HEADER=X-Forwarded-Email      # Cloudflare Access: Cf-Access-Authenticated-User-Email
PROXY_JWT_HEADER=Cf-Access-Jwt-Assertion  # optional; verify signature if present
PROXY_JWKS_URL=...                        # required if PROXY_JWT_HEADER is set
```

**Critical for Mode B:** the app must never be reachable except through the proxy, or the headers are forgeable. Bind to the internal network only and strip inbound `X-Forwarded-*` at the edge. Where the proxy supplies a signed JWT (Cloudflare Access does), verify it against JWKS and don't trust the plain header at all — that removes the footgun entirely. Refuse to start in Mode B if neither a JWT header nor an explicit `PROXY_TRUST_INSECURE_HEADERS=true` is set.

Both modes converge on the same internal call: `resolve_identity(request) -> (email, name)`. Everything downstream — user upsert, workspace derivation, ACL — is identical.

**Deliberately not supported:** local username/password. Same reasoning as Outline — it's a security liability that buys nothing, and every buyer already has an IdP.

### 4.2 Authorization — build this, it's small

No policy engine. No Casbin, no OPA. This is one function:

```python
def can(user: User | None, art: Artifact, need: Role) -> bool:
    if art.visibility == 'public' and need == 'viewer':
        return True
    if user is None or user.workspace_id != art.workspace_id:
        return False
    if user.id == art.owner_id or user.is_admin:
        return True
    if art.visibility == 'workspace':
        return need == 'viewer' or grant_role(user, art) == 'editor'
    if art.visibility == 'restricted':
        r = grant_role(user, art)
        return r is not None and (need == 'viewer' or r == 'editor')
    if art.visibility == 'public':
        # need == 'editor' here — the viewer case returned True at the top.
        return grant_role(user, art) == 'editor'
    return False   # 'private'
```

Visibility semantics:

| `visibility` | Who can view | Who can update |
|---|---|---|
| `private` | owner + admins | owner + admins |
| `restricted` | users in `artifact_grants` | grants with `role = 'editor'` |
| `workspace` | anyone in the workspace | owner + `editor` grants |
| `public` | anyone with the link, no login | owner + `editor` grants |

Grants stack on top of `workspace` and `public` visibility so you can make a doc readable org-wide (or by anyone with the link) but writable by three people. Publishing a doc never revokes a collaborator's write access.

Note the second line: `user.workspace_id != art.workspace_id` returns `False` before any other check. Workspace isolation is enforced once, at the top, rather than being re-derived per visibility level.

**Admin bootstrap.** The first user to log into a workspace becomes its admin — Outline's convention, and the only rule that costs zero setup steps (§1.1). `ADMIN_EMAILS` (optional, comma-separated) additionally forces admin for listed addresses at each login; it is also the recovery path if the first-login lottery picks the wrong person.

### 4.3 Multiple workspaces

A single deployment can serve several workspaces. `workspaces.domain` is unique, `users.workspace_id` is derived from the email domain at first login, and every artifact query is already scoped by `workspace_id` — so this costs no additional schema. It's the natural fit for a company with several email domains (an acquisition, a subsidiary, `company.com` plus `company.co.uk`), or a consultancy running one instance across client orgs.

Isolation is total. A user at `a.com` cannot see, list, or be granted access to anything owned by `b.com`. The one exception is `visibility = 'public'`, which by definition ignores workspaces entirely.

**The trap: consumer email domains.** `visibility = 'workspace'` means "everyone whose email ends in this domain." If a personal Gmail is allowed to log in and auto-create a `gmail.com` workspace, then every Gmail user on earth is a colleague, and the next `workspace`-visibility document is effectively public. The same applies to `outlook.com`, `yahoo.com`, `icloud.com`, `proton.me`, and a long tail of others.

Three rules, all mandatory:

1. **`ALLOWED_DOMAINS` is an explicit allowlist, never a wildcard.** A domain that isn't listed cannot log in at all. Auto-creating workspaces for arbitrary domains turns a self-hosted internal tool into an open-registration service.
2. **Ship a blocklist of known consumer domains**, checked even if an operator adds one to `ALLOWED_DOMAINS` by mistake. Refuse at startup with a clear error rather than silently creating the shared workspace.
3. **Verify the domain comes from the IdP, not the address.** With Google, use the `hd` (hosted domain) claim, which is only present for real Workspace accounts and cannot be spoofed by a personal account using a vanity address. For generic OIDC, prefer the issuer over the email domain where the provider gives you one.

Operators wanting per-workspace `ALLOWED_DOMAINS` behaviour beyond this — say, mapping three domains onto one shared workspace after a merger — get a `WORKSPACE_DOMAIN_MAP` config entry rather than any runtime UI.

---

## 5. HTTP API

All under `/api`, all JSON except content endpoints. Auth is either the proxy session (browser) or `Authorization: Bearer art_...` (agents/CLI).

### 5.1 Artifacts

```
POST   /api/artifacts
       { name?, visibility? }  →  201 { id, url, ... }

GET    /api/artifacts/:id                →  200 metadata (no body)
PATCH  /api/artifacts/:id                →  200  { name?, visibility? }
DELETE /api/artifacts/:id                →  204
GET    /api/artifacts                    →  200 flat list, workspace-scoped,
                                              ?limit=&cursor=&mine=true
```

`POST` creates the artifact at version 0 with an empty body — content arrives with the first `PUT` (§5.2). This keeps create-then-push a clean two-step for the CLI, and `GET /c/:id` of a version-0 artifact is an empty document, not an error.

Version history (M6): `GET /api/artifacts/:id/versions` lists them; `GET /api/artifacts/:id/versions/:n/content` reads one back.

### 5.2 Content — the hot path

```
HEAD   /api/artifacts/:id/content
       →  200, ETag: "<sha256-hex>", Content-Length: <uncompressed>

PUT    /api/artifacts/:id/content
       Content-Encoding: gzip
       If-None-Match: "<sha256-hex>"     ← client's hash of what it's about to send
       X-Base-Version: <n>                ← optional; version the client last saw
       body: gzipped html
       →  200 { version, changed: true }
       →  304 Not Modified                ← server already has this hash, no write
       →  409 Conflict                    ← someone else pushed since X-Base-Version

GET    /api/artifacts/:id/content         ← direct fetch, for agents reading back
       →  200, Content-Encoding: gzip, ETag,
          application/octet-stream + Content-Disposition: attachment + sandbox CSP (§2.2)
```

Rejects with `413` if the uncompressed size exceeds `MAX_ARTIFACT_BYTES` (default 10MB). Rate limited per token.

**Optimistic concurrency.** Two agents pushing to one artifact — or a CLI daemon racing a human `artef push` — otherwise silently clobber each other, and the loser never finds out. If `X-Base-Version` is present and doesn't match the current version, respond `409` with the current version and hash in the body. The CLI surfaces this as "someone else updated this; re-run to overwrite" and `--force` omits the header. Borrowed from open-artifacts (§14), which handles the same race the same way.

Omitting the header is a last-write-wins push, which is the right default for a daemon that owns its artifact outright.

**Hash-first push.** The CLI computes SHA-256 locally and sends `If-None-Match` on the `PUT`. If the server's `content_hash` matches, it returns `304` *before reading the request body* and performs no write. A document that hasn't changed costs a few hundred bytes and no disk I/O.

For the strict version — where you don't want to upload 1.5MB just to be told it's unchanged — do `HEAD` first, compare, and skip the `PUT` entirely. The CLI does this by default; single-shot `PUT` with `If-None-Match` is the one-round-trip fallback.

(`304` in response to a `PUT` bends RFC 9110's conditional-request semantics, deliberately. The CLI is both ends of this contract, and the alternative is a custom header pair that says the same thing less legibly.)

### 5.3 Sharing

```
POST   /api/artifacts/:id/grants     { email, role }   →  201
DELETE /api/artifacts/:id/grants/:user_id             →  204
GET    /api/artifacts/:id/grants                      →  200 [...]
```

The email doesn't have to belong to an existing user — a grant pre-provisions the user row (users are created on first login anyway), so a doc can be shared with a colleague before their first visit. Emails whose domain doesn't resolve to the artifact's workspace are rejected with `422`; cross-workspace grants don't exist (§4.3).

### 5.4 Assets

```
POST   /api/assets        multipart, media_type inferred  →  201 { sha256, url: "/assets/<sha>" }
GET    /assets/:sha       →  200, Cache-Control: public, max-age=31536000, immutable
```

Serving is a viewer route (`/assets/:sha`, not under `/api`) and is deliberately unauthenticated. Image requests come from inside the sandboxed frame, which sends no cookies (§2.4), so this route cannot rely on a session — and stamping content tokens into every `<img>` would mean rewriting HTML on every serve. Fetching by hash is its own capability: to name an asset you must already know its SHA-256, and you only know the hash of content you already have. Upload still requires a real token and is workspace-scoped for quota and cleanup; the serve path looks up by hash alone (§3). Responses follow §2.2 — SVG is a scriptable document, so assets carry a script-less sandbox CSP.

### 5.5 Live updates

```
GET    /api/artifacts/:id/events        text/event-stream
       event: updated
       data: {"version": 42, "hash": "..."}
```

Backed by Postgres `LISTEN`/`NOTIFY` on channel `artifact_updated` — this fans out across app replicas with no Redis, no message broker. One fewer container in the compose file, which matters for the self-host pitch.

On receiving `updated`, the shell fetches a fresh content token (§2.4) and reloads the iframe with it. The document reloads; the page around it does not.

### 5.6 Tokens

```
POST   /api/tokens    { name, scope_ids?, expires_at? }
                      →  201 { id, token: "art_live_xxxxx" }   ← shown once
GET    /api/tokens    →  200 [ { id, name, prefix, last_used_at } ]
DELETE /api/tokens/:id
```

Store only `sha256(token)`. Keep a display prefix so users can identify which token to revoke.

### 5.7 Viewer routes (not `/api`)

```
GET  /a/:id            shell page, ACL-checked
GET  /c/:id            the artifact, CSP-sandboxed (§2.1); public → serve,
                       valid ?t= content token (§2.4) → serve, else 302 → /a/:id
GET  /assets/:sha      content-addressed asset bytes (§5.4), unauthenticated
GET  /:id              301 → /a/:id           ← the short URL you actually share
```

### 5.8 Link previews

The documents being replaced are pasted into Slack today. If our link unfurls as a bare URL while the old workflow showed a filename, we have made sharing feel *worse*, and that perception costs more than it should.

The shell page emits OpenGraph and Twitter tags — `og:title` from `artifacts.name`, `og:site_name`, `og:url`.

**The catch open-artifacts doesn't have.** They have no ACL, so their crawler path is trivial. Ours isn't: Slack's unfurler is an unauthenticated bot, so a `workspace`-visibility artifact returns 404 to it and never previews. Resolving this means deciding what leaks to whoever holds the URL:

- `LINK_PREVIEW=name` (default) — unauthenticated `GET /a/:id` returns 200 with OG tags carrying the artifact name, and a body that is just a login prompt. Content stays gated. The name leaks to anyone holding the UUID, which is a 122-bit unguessable secret they'd have to be given.
- `LINK_PREVIEW=none` — 404 to everyone unauthenticated. No previews for anything but `public` artifacts.

Default to `name`: the whole point is beating a Slack file attachment, and an attachment shows its filename to everyone in the channel already.

**OG images are explicitly deferred.** open-artifacts rasterizes a PNG card at the edge with `@resvg/resvg-wasm` and an embedded font subset, because crawlers ignore SVG. That's correct and it's also a font subset, a WASM binary, and a rendering path to maintain — for a nicer-looking Slack card. Title-only unfurls are 90% of the value at 2% of the cost. Revisit if anyone asks.

### 5.9 The share dialog — the only UI

Access control is the feature being sold, and a feature that requires a CLI invocation to use is a feature nobody uses. This needs a UI, and it needs to be the one people already know: **copy Google Docs' share dialog**, because every person in the building has used it.

A single button in the shell page header opens one panel:

```
  Share "Q3 infra report"

  ● Anyone at company.com          can view      ▾
  ○ Only people I choose
  ○ Anyone with the link

  Add people:  [ email…                    ]  can view ▾

  priya@company.com                         can update ▾ ×
  sam@company.com                           can view ▾   ×

                          [ Copy link ]  [ Done ]
```

That is the whole interface. Three radio buttons mapping to `visibility`, an email field creating `artifact_grants` rows, a role dropdown per person, a copy-link button. No new concepts, no documentation needed, no folder tree.

Two details that matter:

- **The dropdown next to the visibility radio** sets whether workspace-wide means view or update. It's the one place people get confused in Docs too, so default it to view and don't be clever.
- **The role is labelled "can update", never "can edit".** There is no browser editing — the role grants the right to push new versions through the API. "Can edit" would promise a text cursor that doesn't exist.
- **`private` has no radio button.** It's the state before anything is shared, shown as "Only you" text. Exposing it as a fourth option invites people to wonder what the difference between it and "only people I choose" is.

Everything else — the flat list, versions, live status — stays link-driven and CLI-driven. This one dialog is where a UI earns its cost.

---

## 6. Asset Extraction

The largest documents are big because of inline base64 images, which gzip cannot compress — they're already-compressed formats, and base64 adds 33% overhead on top.

On push, the CLI (or server, configurable) walks the HTML, and for every `src="data:image/*;base64,..."` over a threshold (say 8KB):

1. Decode, compute SHA-256.
2. `POST /api/assets` if not already present (`409` on duplicate is fine — it's content-addressed).
3. Rewrite the attribute to `/assets/<sha>` — a relative path, permitted by the artifact's `img-src 'self'`.

Effects:

- A 1.5MB document with three embedded charts drops to ~80KB.
- Assets are deduped across every version and every document in the workspace.
- Assets are immutable and cached forever by the browser — a live document refreshing every minute stops re-shipping the same logo 1,440 times a day.

Use `lol_html` (Cloudflare, BSD-3, Rust) for streaming rewrites in the CLI, or `node-html-parser` if extraction ever needs to run server-side. Do not use regex on HTML.

---

## 7. CLI

Rust + `clap`, distributed as a single static binary (`curl | sh`, Homebrew, `cargo install`). No runtime dependency is a genuine selling point for a tool that has to run on random build agents.

### 7.1 Preflight: the CSP compatibility check

**This is the one that will otherwise generate every support ticket.** §2.1 serves artifacts under `connect-src 'none'; default-src 'none'; img-src 'self' data:`. An agent that emits `<script src="https://cdn.jsdelivr.net/npm/chart.js">` or a Google Fonts `<link>` produces HTML that renders visibly broken — blank charts, fallback fonts — with no error the reader can interpret. They will blame the service, not the document.

So `artef push` lints before uploading and **fails loudly** rather than publishing something broken:

| Found | Verdict |
|---|---|
| `<script src="http(s)://…">` | Reject — inline it or vendor it |
| `<link rel=stylesheet href="http(s)://…">` | Reject — inline it |
| `@import url(http(s)://…)` in CSS | Reject |
| `<img>`, `srcset`, `<source>`, `poster` with `http(s)://…` | Reject — `artef push` can fetch and inline it with `--vendor-assets` |
| `<iframe>`, `<object>`, `<embed>` with external src | Reject — frames and plugins are blocked outright |
| `url(http(s)://…)` in `<style>` or style attributes | Reject — inline as `data:` |
| `fetch(` / `XMLHttpRequest` / `EventSource` | Warn — will silently no-op under `connect-src 'none'` |
| `<form action="http(s)://…">` | Warn — blocked by `form-action 'none'` |
| `data:` URIs, relative paths, inline `<script>`/`<style>` | Fine |

`--no-preflight` exists for the person who knows what they're doing. The default is to refuse.

**Ship an agent skill alongside the CLI.** open-artifacts bundles a `SKILL.md` teaching agents its constraints and design conventions, and that is the right idea — the failure mode is upstream of the CLI, in what the agent generates. Ours needs to be short and mostly one rule: *everything inline, no external requests, ever.* Agent Skills standard format, installable into Claude Code and anything else that supports it, so the HTML is compatible before it's ever pushed rather than rejected after.

### 7.2 Commands

```
artef login                          # browser SSO + loopback callback, or --token art_live_xxx
artef lint <file>                    # CSP preflight only, no upload (§7.1)
artef push <file>                    # create-or-update; resolves id from local state
artef push <file> --force            # skip the 409 base-version check
artef push <file> --name "Q3 Report" --visibility workspace
artef watch <file> --every 60s --cmd "python gen_status.py > status.html"
artef daemon                         # runs every [[watch]] in artef.toml
artef ls                             # flat list
artef share <id> --public
artef share <id> --email a@co.com --role update
artef open <id>                      # xdg-open / open
artef pull <id> > out.html
artef rm <id>
```

**`artef login` is a browser round-trip against the artef server, not an IdP device-code flow.** The credential the CLI needs is an artef machine token, not an IdP token. `artef login` starts a localhost listener, opens `https://<server>/cli/auth?port=…&state=…`, the user completes normal SSO in the browser, and the server mints a machine token and hands it to the loopback redirect. If the loopback can't be reached (SSH session), the page shows the token for copy-paste. Headless environments skip all of it with `--token`.

### 7.3 Local state

`.artef.json` in the working directory, committed or gitignored as the user prefers:

```json
{
  "artifacts": {
    "reports/q3.html": { "id": "8f14e45f-...", "hash": "a3f5..." },
    "status.html":     { "id": "3c9a7b21-...", "hash": "9d02..." }
  }
}
```

This is what makes UUID-only URLs tolerable. Without it, users paste UUIDs into terminals by hand, which is miserable. `artef push ./status.html` should just know.

Global config at `~/.config/artef/config.toml`:

```toml
server = "https://artef.company.com"
token  = "art_live_xxxxxxxx"    # or read from ARTEF_TOKEN
```

### 7.4 Daemon config

`artef.toml`:

```toml
[[watch]]
file    = "status.html"
every   = "60s"
command = "python gen_status.py > status.html"

[[watch]]
file    = "build-health.html"
every   = "5m"
command = "./scripts/build_report.sh"
```

Daemon loop, per entry:

1. Run `command` in the file's directory. Non-zero exit → log, keep last good version, retry next tick.
2. Read file, extract assets, gzip, SHA-256.
3. `HEAD` the content endpoint. Hash matches → sleep, do nothing.
4. Otherwise `PUT`. Server bumps `version`, fires `NOTIFY`, open browsers refresh.

Backoff on repeated failures. Emit structured logs so this can be supervised by systemd or run as a sidecar in the customer's CI.

---

## 8. Storage Backends

One interface, two implementations from day one:

```python
class BlobStore(Protocol):
    def put(self, key: str, data: bytes, media_type: str) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def url(self, key: str, ttl: int) -> str | None: ...   # presigned, or None
```

- **`postgres`** (default) — blob lives in `artifacts.body`. Zero extra infrastructure. Correct for the vast majority of self-hosters.
- **`s3`** — blob goes to S3/R2/MinIO; `artifacts.body` holds a key reference instead. The app fetches and relays it; do not hand the browser a presigned URL, since that would serve artifact HTML from an origin we don't control the headers on (§2.1).

Switch with `FILE_STORAGE=postgres|s3` — the same variable name Outline uses (§10). Build both now — the interface is ~40 lines, and at 1.5MB documents you are close enough to the point where a heavy customer will ask that retrofitting it later would be annoying.

**License note:** MinIO is AGPL-3.0. Shipping it unmodified in a reference `docker-compose.yml` is fine, but do not vendor or fork it. SeaweedFS (Apache-2.0) is the permissive alternative if that ever becomes a concern.

---

## 9. Stack & Reuse Map

The point is to write as little novel code as possible.

| Need | Use | License | Notes |
|---|---|---|---|
| Google / OIDC login | `openid-client` | MIT | Auto-discovery covers every OIDC provider with one implementation |
| Optional proxy auth | oauth2-proxy / Authelia / CF Access | MIT | `AUTH_MODE=proxy`, operator's choice |
| Full IdP (if customer lacks one) | Authentik / Keycloak | MIT / Apache-2.0 | Reference compose only |
| Web framework | Hono | MIT | Runs on Node today; Workers-compatible if that's ever wanted |
| ORM + migrations | Drizzle | Apache-2.0 | One schema, Postgres/MySQL/SQLite targets |
| Live fanout | Postgres LISTEN/NOTIFY | — | Avoids a Redis dependency — one service fewer than Outline |
| HTML rewriting | `lol_html` (Rust) | BSD-3 | In the CLI. Never regex |
| Object storage client | `@aws-sdk/client-s3` | Apache-2.0 | S3, R2, MinIO all speak S3 |
| CLI framework | `clap` | MIT/Apache-2.0 | Single static binary |
| CLI HTTP | `reqwest` + `rustls` | MIT/Apache-2.0 | No OpenSSL dependency |
| HTML sanitization (optional) | `ammonia` / DOMPurify | MIT | Only if you ever accept third-party HTML |

**Build ourselves (unavoidable):** the ACL function (~60 lines), the OIDC flow (~200 lines), the content-token flow (~80 lines, §2.4), the API handlers, the CLI, asset extraction. That's the actual product. Everything else is configuration.

**Server language: TypeScript.** Not for Workers compatibility — that's a side benefit, not a reason. The reason is Outline parity: the buyer has already accepted a Node + Postgres + S3 container in their infra, and matching that shape removes the "what is this new thing" objection before it's raised. Python would be faster to write and slower to sell.

### 9.1 Deployment targets

**Primary: self-hosted Docker.** Everything in §10. This is the only target that matters for adoption — teams large enough to need this have their own infrastructure and their own preferences about where data lives.

**Secondary: Cloudflare (optional, never required).** The interfaces the self-host story already needs — `BlobStore` (Postgres/S3), `PubSub` (LISTEN/NOTIFY), `resolve_identity` (OIDC/proxy) — happen to be exactly the seams a Workers deployment would need: R2, Durable Objects, and Access respectively. Keeping them clean costs nothing extra. Building the Cloudflare adapters is a weekend that should not happen until the Docker path is done and in daily use.

Do not let this leak into the primary design. Cloudflare's free tier fits one person and a handful of colleagues — D1 caps at 500MB per database and 5GB per account on free, R2 at 10GB, Access at 50 users — which is a personal dogfooding environment, not a company deployment. The moment a Workers constraint would make the Docker experience worse, the Workers path loses.

---

## 10. Deployment

**Design rule: an operator who has already deployed Outline should recognise every step.** Same shape, same conventions, fewer services. This section is where §1.1 is enforced — if the list below ever grows, something upstream was designed wrong.

Reference `docker-compose.yml` — three services:

```
caddy       TLS, single host
app         Node — API, auth, ACL, shell page, content relay
postgres    data
```

No Redis (LISTEN/NOTIFY replaces it), no oauth2-proxy in the default path, no second origin. That is two services fewer than a standard Outline deployment, on one domain with one certificate.

Operational conventions copied from Outline verbatim, because familiarity is the point:

- **One published image**, `ghcr.io/<org>/artef:<tag>`. `app` and `content` are the same image with different entrypoints.
- **Migrations run automatically on boot.** No separate migrate step, no manual SQL.
- **`/_health`** returns 200 when the DB is reachable.
- **Env var names reused where semantics match** — `URL`, `SECRET_KEY`, `DATABASE_URL`, `FILE_STORAGE`, `ALLOWED_DOMAINS`, `FORCE_HTTPS`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `OIDC_*`, `AWS_*`. Whoever configured their Outline can configure this from muscle memory.

Required environment:

```
URL=https://artef.company.com
SECRET_KEY=                      # session signing
DATABASE_URL=postgres://...
FILE_STORAGE=postgres            # or: s3
MAX_ARTIFACT_BYTES=10485760      # 10MB, uncompressed
MAX_VERSIONS=20                  # rolling history per artifact
LINK_PREVIEW=name                # or: none  (§5.8)
ALLOWED_DOMAINS=company.com,subsidiary.com    # explicit list, no wildcard (§4.3)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FORCE_HTTPS=true
```

### 10.1 Setup checklist

The whole install, in order:

1. One DNS A record for `artef.company.com`.
2. One OAuth client in Google Cloud Console; redirect URI `https://artef.company.com/auth/google/callback`.
3. Fill six env vars (above).
4. `docker compose up -d`. Migrations run on boot.
5. Open the URL, log in with Google, push a file with the CLI.

Nothing in that list is unfamiliar to anyone who has deployed Outline, and nothing costs money. Caddy handles the certificate automatically. There is no second domain, no wildcard cert, no reverse-proxy sidecar to understand.

---

## 11. Build Order

| Milestone | Scope | Result |
|---|---|---|
| **M0** | Postgres, Hono, OIDC login, `PUT`/`GET` content, single origin | Push an HTML file, open it behind Google login |
| **M1** | `/c/:id` route with the CSP sandbox header, shell page, the invariant test | Safe to show anyone |
| **M2** | CLI: `login`, `push`, `ls`, local state file | Agents can use it |
| **M3** | Visibility + grants + share endpoints + share dialog (§5.9) | The access-control pitch is real |
| **M4** | `watch` / `daemon`, SSE, LISTEN/NOTIFY | Live documents work |
| **M5** | Asset extraction, content-addressed assets | 1.5MB docs become 80KB |
| **M6** | S3 backend, version history, `AUTH_MODE=proxy` | Enterprise-ready |
| **M7** | *(optional, only if wanted)* Cloudflare adapters — R2, D1, Durable Objects, Access | Free-tier personal hosting |

M0–M2 is a usable internal tool. M0–M4 is the demo that sells it. M7 is never on the critical path.

**Gate on every milestone:** does the install still fit the §1.1 setup budget — one DNS record, one OAuth client, six env vars, `docker compose up`? If a milestone would add a step, it ships behind a default-off flag or it doesn't ship.

---

## 12. Resolved Decisions

These were open; they are now settled. Recorded with reasoning so nobody relitigates them.

**1. The `editor` role is labelled "can update", not "can edit."** There is no browser editing and there won't be. The role grants the right to push new versions through the API. "Can edit" promises a text cursor that doesn't exist, and a share dialog that lies is worse than one with an awkward verb.

**2. `MAX_ARTIFACT_BYTES` defaults to 10MB, configurable.** Uncompressed size, checked before the write. Ten is comfortable headroom over the 1.5MB real-world ceiling while stopping an agent from pushing 500MB in a loop. Per §1.1 the default must work untouched — operators only change it if they have unusual documents. Pair it with a per-token rate limit on `PUT .../content`.

**3. `is_live` is removed from the schema entirely.** It existed to decide two things: whether to open the SSE stream, and whether to write version rows. Both answers turn out to be "always."

- SSE: every shell page subscribes. Static documents simply never receive an event.
- Versions: every hash-changing push writes a version and prunes to `MAX_VERSIONS` (default 20). A minute-by-minute dashboard keeps a rolling 20 and its storage stays flat; a document pushed twice a month keeps its full history. The cap does the job the flag was doing.

**No expiry for stale documents.** If a generator dies and a dashboard goes stale, that is the owner's problem, not the server's. Adding staleness detection means a threshold, a warning banner, and a config knob — three concepts to buy a guess about someone else's intent. The `updated_at` timestamp is already in the response; anyone who cares can render it.

Live-ness lives entirely in the CLI. `artef watch` knows it's watching; the server just receives pushes. One fewer concept in the data model, one fewer field in the API, one fewer thing to explain.

**4. `connect-src 'none'` is absolute. No per-artifact allowlist, no exception, no config knob.**

This is the design statement, not just a header value: **artifacts are dumb documents.** They render. Their JavaScript exists so a reader can toggle a chart, step through an explanation, or expand a section — interactivity in service of understanding. It does not exist to fetch data.

Anything an artifact needs to know is baked in at push time by the process that generated it. The terminal session that owns the document does the updating; the document never reaches out. A "live" dashboard is live because a CLI daemon pushes to it, not because the page polls.

This is worth more than the flexibility it costs:

- No exfiltration channel exists. Combined with `form-action 'none'` and `img-src 'self' data:`, an artifact cannot send a byte anywhere — so even if the sandbox in §2.1 somehow failed, there is nothing to leak through.
- The security story becomes one sentence an ops reviewer can verify in the CSP header, rather than a policy matrix.
- No config knob, per §1.1.

**Honest residual:** a sandboxed frame can still navigate *itself* (`location.href = 'https://x/?' + data`). CSP has no directive covering self-navigation since `navigate-to` was dropped from CSP3. It's not a meaningful hole here — the artifact has no cookies, no storage, and no parent access, so the only data it can send is data its own author already had. The exception is a document that solicits input from the reader, which is phishing and which no header prevents in any system.

---

## 13. Still Open

Nothing blocking. Two things to decide during implementation rather than now:

1. **Rate limit shape** on `PUT .../content` — per token, per artifact, or both. Depends on what the CLI daemon's retry behaviour looks like in practice.
2. **`MAX_VERSIONS` default.** 20 is a guess. Worth revisiting once there's a month of real push volume to look at.

3. **Sandbox `allow-downloads`.** A report that offers a "download this CSV" link needs the `allow-downloads` sandbox token, or the click silently does nothing. Off for now; add when a real artifact wants it.

---

## 14. Prior Art

**`coda0HQ/open-artifacts`** (MIT, TypeScript, Cloudflare Workers + D1 + R2) is the closest existing thing and worth reading in full before writing code. What it establishes:

- The serving half of this problem is solved and the solution is known-good. It arrived independently at the same isolation model specced in §2.1 — CSP `sandbox` + `default-src 'none'` + `connect-src 'none'` + `nosniff` + `no-referrer`. Convergent design on a security model is the strongest signal available that the model is right. §2.1's simplification from `srcdoc` to a response header is taken directly from it.
**What we took, and where it lives now:**

| Lesson | Where it landed |
|---|---|
| CSP `sandbox` as a *response header*, not an iframe attribute | §2.1 — replaced the `srcdoc` + `text/plain` design entirely; invariants went from three to one |
| Optimistic concurrency: base version on write, `409` on conflict, `force` override | §5.2 — `X-Base-Version`, so two agents don't silently clobber each other |
| Agents must be taught the no-external-requests constraint, or they emit broken HTML | §7.1 — CLI preflight lint that rejects CDN scripts and remote fonts, plus a bundled agent skill |
| Link unfurls matter when you're replacing Slack attachments | §5.8 — OG tags, with the ACL wrinkle they don't have |
| Store only the hash of write tokens | Already in §3 `machine_tokens.token_hash` |
| Schema applies itself on first request, no migration step | Already in §10 |

§7.1 is the one that would have bitten hardest. Our CSP forbids external requests, and an agent that emits a `<script src="https://cdn…">` produces a document that renders visibly broken with no error a reader can interpret — they blame the service, not the document. open-artifacts solved it upstream by shipping a skill that teaches the agent the constraint before generation. Catching it at push time is the backstop; teaching the agent is the fix.

Not taking their edge-rasterized OG image path (§5.8) — a WASM rasterizer and an embedded font subset is a lot of machinery for a prettier Slack card.

Where it diverges, and why this project still exists:

| | open-artifacts | This |
|---|---|---|
| Identity | **None.** No accounts by design | OIDC SSO, workspaces |
| Access control | Unlisted URL + optional client-side password | Per-artifact ACL: workspace / named people / public, view / update |
| Revoking one person | Not possible — rotate the password for everyone | Delete a grant row |
| Hosting | Cloudflare only (`wrangler`, D1, R2) | Docker + Postgres; Cloudflare optional (§9.1) |
| Publishing | JSON "Recipe" + fragments; direct HTML push is **rejected** | `artef push ./file.html` |
| Size ceiling | 4 MiB, fixed | `MAX_ARTIFACT_BYTES`, configurable |

The gap is not incidental — "no accounts" is their stated design stance, and identity-based access control is the entire reason a company adopts this rather than continuing to paste files into Slack. Bolting SSO, workspaces, and per-person grants onto a system built around unguessable URLs and shared passwords is not a feature addition; it's a different product.

The Recipe requirement is the second hard incompatibility. An agent cannot hand it a finished 1.5MB HTML file; it must author a Recipe JSON plus ordered fragments. That is a reasonable choice for enforcing design consistency and an unreasonable one for "here is the report, publish it."

**Recommended action:** deploy it on a personal Cloudflare account this week and use it. It costs an afternoon, it solves the immediate itch, and it is free reconnaissance — the fastest way to learn which parts of this spec are over-engineered and whether the Recipe workflow is a dealbreaker in practice or just unfamiliar.

---

## 15. Repository Layout

**One repository.** The CLI and the server share an API contract that changes most weeks through M0–M4; splitting them turns every endpoint change into a two-repo coordination problem with version skew as the reward. A monorepo makes that failure structurally impossible.

```
artef/
├── server/              TypeScript — Hono, Drizzle, migrations
├── cli/                 Rust — clap, single static binary
├── skill/               agent skill — SKILL.md + references (§7.1)
├── docs/                markdown; GitHub Pages later
├── docker-compose.yml   the reference deployment (§10)
├── Dockerfile           one image, two entrypoints
└── README.md            the project's front door
```

Mixed toolchains are not a reason to split — `cargo` and `pnpm` coexist fine in sibling directories, and CI runs both.

**One tag ships everything.** A GitHub Actions release workflow on `v*` builds the CLI for linux/macOS/Windows, publishes `ghcr.io/<org>/artef`, and updates the Homebrew formula. Server and CLI versions can never drift because they come from the same commit.

That enables a cheap compatibility check worth having: the CLI sends `X-Artef-Client: <version>`, and the server warns (not errors) on a major mismatch. Trivial in a monorepo, a coordination burden across two.

**The second repo, later: `<org>/homebrew-artef`.** Homebrew requires taps to be named `homebrew-*`, so the formula cannot live here. It holds a Ruby formula file that CI updates on release — convention, not architecture. Create it when M2 produces a binary worth installing, not before.

**Not separate repos:** the agent skill (installs from a subdirectory of any repo, exactly as open-artifacts does), the docs (`docs/` published via Pages), or the Cloudflare adapters if M7 ever happens (they're alternate implementations of interfaces defined in `server/`).
