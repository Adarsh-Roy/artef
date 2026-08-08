# syntax=docker/dockerfile:1

# One image, built in two stages (spec §10). The build stage compiles the
# TypeScript and installs dependencies; the runtime stage keeps only what the
# server needs to boot, migrate, and serve.

# ---- build stage -------------------------------------------------------------
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app/server

# Install dependencies first, from the lockfile, so this layer is cached until
# package.json or the lockfile actually change.
COPY server/package.json server/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Compile with tsc. There is no rootDir, so the build preserves src/ under dist/
# and the entrypoint lands at dist/src/index.js. Then drop devDependencies
# (typescript, vitest, tsx, drizzle-kit) so node_modules ships production-only.
COPY server/ ./
RUN pnpm build && pnpm prune --prod

# ---- runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/server

# Layout invariant (spec §10): package.json sits next to drizzle/ and dist/.
# On boot the migration resolver walks up from the running file
# (dist/src/index.js) to the nearest package.json, then appends `drizzle` to
# find the SQL. That is why there must be NO dist/package.json — it would stop
# the walk one directory too early and the migrations would not be found.
COPY --from=build --chown=node:node /app/server/package.json ./package.json
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/drizzle ./drizzle
COPY --from=build --chown=node:node /app/server/dist ./dist

USER node
EXPOSE 3000

# 200 when the database is reachable (spec §10). Node 22 has a global fetch.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run on boot inside index.ts — no separate migrate step (spec §10).
CMD ["node", "dist/src/index.js"]
