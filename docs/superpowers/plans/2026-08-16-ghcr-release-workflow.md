# GHCR Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub Actions release workflow on `v*` tags that publishes the server image to `ghcr.io/adarsh-roy/artef` (amd64+arm64) and attaches CLI binaries (macOS arm64/x86_64, Linux x86_64) to a GitHub release, then points `docker-compose.yml` at the published image.

**Architecture:** Four jobs. `check` guards that the tag matches the versions in `server/package.json` and `cli/Cargo.toml`. `image` reuses the existing `Dockerfile` unchanged via buildx+QEMU and pushes semver + `latest` tags to GHCR with `GITHUB_TOKEN`. `cli` is a two-row matrix (ubuntu builds Linux musl; macos builds both Apple targets) uploading tarballs as artifacts. `release` downloads all tarballs and creates the GitHub release in one shot (no creation race).

**Tech Stack:** GitHub Actions, docker buildx (`docker/*` official actions), cargo with `rustup target add`, `gh` CLI inside the runner.

**Spec:** `artef-spec.md` §15 (release shape) + `docs/HANDOFF.md` "The next task" (scope: no Windows build, no Homebrew yet, multi-arch only if cheap — QEMU is cheap).

## Global Constraints

- The image must keep `server/package.json` adjacent to `drizzle/` and `dist/`; never create a `dist/package.json`; entrypoint `dist/src/index.js`. The existing `Dockerfile` already does this — CI must **reuse it, not reinvent it** (so: `docker/build-push-action` with default `file: Dockerfile`, context `.`).
- Image name is lowercase: `ghcr.io/adarsh-roy/artef`.
- Repo is currently **private**; the workflow must only rely on `GITHUB_TOKEN` (works on private repos). Making the GHCR package public is a one-time manual UI step after the first publish (no REST API exists for container visibility).
- Versions are `0.1.0` in both `server/package.json` and `cli/Cargo.toml`, so the first tag is `v0.1.0`.
- CLI deps are pure-Rust (`rustls`, `miniz_oxide` backend, `lol_html`) — Linux target is `x86_64-unknown-linux-musl` (fully static) with `musl-tools` installed; fall back to `x86_64-unknown-linux-gnu` only if musl fails in CI.

---

### Task 1: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Produces: GHCR tags `<version>` (tag minus `v`) and `latest`; release assets named `artef-<tag>-<target>.tar.gz` each containing a single `artef` binary.

- [ ] **Step 1: Write the workflow**

```yaml
# Release on v* tags (spec §15, scoped by docs/HANDOFF.md): one tag ships the
# server image to ghcr and the CLI binaries to the GitHub release. The image
# job reuses the repo Dockerfile untouched — the package.json/drizzle/dist
# layout invariant lives there, not here.
name: release

on:
  push:
    tags: ["v*"]

jobs:
  # The tag must match both manifests, or the CLI's X-Artef-Client header
  # would lie about the server it shipped with.
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Tag matches package versions
        run: |
          want="${GITHUB_REF_NAME#v}"
          server=$(node -p "require('./server/package.json').version")
          cli=$(grep -m1 '^version' cli/Cargo.toml | cut -d'"' -f2)
          echo "tag=$want server=$server cli=$cli"
          [ "$want" = "$server" ] && [ "$want" = "$cli" ]

  image:
    needs: check
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/adarsh-roy/artef
          tags: type=semver,pattern={{version}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  cli:
    needs: check
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            targets: x86_64-unknown-linux-musl
          - os: macos-latest
            targets: aarch64-apple-darwin x86_64-apple-darwin
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y musl-tools
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: cli
      - name: Build and package each target
        working-directory: cli
        run: |
          for t in ${{ matrix.targets }}; do
            rustup target add "$t"
            cargo build --release --target "$t"
            tar -C "target/$t/release" -czf "../artef-${GITHUB_REF_NAME}-${t}.tar.gz" artef
          done
      - uses: actions/upload-artifact@v4
        with:
          name: cli-${{ matrix.os }}
          path: artef-*.tar.gz

  release:
    needs: [image, cli]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: cli-*
          merge-multiple: true
      - name: Create release with binaries
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" \
            --title "$GITHUB_REF_NAME" --generate-notes artef-*.tar.gz
```

- [ ] **Step 2: Validate the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`
Expected: `OK`

- [ ] **Step 3: Run the version check script locally against tag v0.1.0**

Run the `check` job's script body with `GITHUB_REF_NAME=v0.1.0` from the repo root.
Expected: `tag=0.1.0 server=0.1.0 cli=0.1.0`, exit 0.

### Task 2: Compose prefers the published image

**Files:**
- Modify: `docker-compose.yml:25-27` (app service)

- [ ] **Step 1: Swap build for image, keep build as commented alternative**

```yaml
  app:
    # Published release image (built by .github/workflows/release.yml from the
    # repo Dockerfile). For a source deploy, comment `image:` and uncomment:
    # build: .
    image: ghcr.io/adarsh-roy/artef:0.1.0
```

- [ ] **Step 2: Validate compose config**

Run: `DOMAIN=x POSTGRES_PASSWORD=x docker compose config -q && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit both files**

```bash
git add .github/workflows/release.yml docker-compose.yml docs/superpowers/plans/2026-08-16-ghcr-release-workflow.md
git commit -m "ci: release workflow — ghcr image (amd64+arm64) + CLI binaries on v* tags"
```

### Task 3: Tag and ship

- [ ] **Step 1: Push main, tag, push tag**

```bash
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **Step 2: Watch the run**

gh cannot see this private repo (its active account has no access — surfaced to Adarsh). Watch via browser (github.com/Adarsh-Roy/artef/actions, user's Chrome session) or user checks. If a job fails: fix, commit, `git tag -f v0.1.0 && git push -f origin v0.1.0` (no consumers of v0.1.0 exist yet).
Expected: all four jobs green; release `v0.1.0` exists with 3 tarballs; package `artef` appears under the user's packages.

### Task 4: Make the package public + verify anonymous pull

- [ ] **Step 1: Flip visibility (manual UI — no API exists)**

`github.com/users/Adarsh-Roy/packages/container/artef/settings` → Danger zone → Change visibility → Public. Browser automation if signed in, else the user.

- [ ] **Step 2: Verify anonymous pull**

Run: `docker logout ghcr.io; docker pull ghcr.io/adarsh-roy/artef:0.1.0`
Expected: pull succeeds with no credentials.

### Task 5: Refresh the pitch doc

- [ ] **Step 1: Edit `docs/pitch/deploying-artef.html`**

"Where the Docker image comes from" table: first row becomes the ghcr row (`ghcr.io/adarsh-roy/artef:0.1.0`, anonymous pull); bump the footer date. Commit.

- [ ] **Step 2: Republish the artifact**

Find the existing artifact URL (Artifact list) and republish the same file to the same URL.
