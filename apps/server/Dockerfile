# Neon Arcade game server — Bun runtime, built from the monorepo root.
# Build with the REPO ROOT as context (fly.toml sets this):
#   fly deploy --config apps/server/fly.toml --dockerfile apps/server/Dockerfile
FROM oven/bun:1.3.14 AS base
WORKDIR /app

# Workspace manifests first so dependency install caches across code changes.
# ‼️ EVERY workspace member's package.json must be present — the root
# manifest declares workspaces ["apps/*", "packages/*"] and a frozen-lockfile
# install validates the whole graph, so a missing apps/web/package.json
# fails the build even though the server never imports it.
COPY package.json bun.lock turbo.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/types/package.json packages/types/package.json
# --filter keeps the image lean: only the server (and the workspace types
# package it depends on) get their dependencies installed — the web app's
# three.js/wallet stack has no business in a game-server image.
RUN bun install --frozen-lockfile --production --filter '@neon/server' --filter '@neon/types'

# Source (server + the shared types package it imports from source).
COPY packages/types packages/types
COPY apps/server apps/server

WORKDIR /app/apps/server
ENV NODE_ENV=production
# Fly injects PORT; the server reads it from env (config/env.ts).
CMD ["bun", "run", "src/index.ts"]
