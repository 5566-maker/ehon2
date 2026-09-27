# syntax=docker/dockerfile:1
# ehon2 — single-container image: Hono API (Node 22) + built Vite frontend.
# Runtime layout:
#   /app/deploy/dist/...   server (compiled)
#   /app/deploy/public/... frontend static files (served by the server)
#   /data                  volume: ehon2.db (SQLite) + media/ (images, audio)

# ---------- dependencies ----------
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

# ---------- build frontend ----------
FROM deps AS web-build
COPY . .
# shared must be built first: the web app imports @ehon2/shared values
RUN pnpm --filter @ehon2/shared build && pnpm --filter @ehon2/web build

# ---------- build backend + collect prod deps ----------
FROM deps AS server-build
COPY . .
RUN pnpm --filter @ehon2/shared build \
 && pnpm --filter @ehon2/server build \
 && pnpm --filter @ehon2/server --prod deploy --legacy /app/deploy

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-build /app/deploy ./deploy
COPY --from=web-build /app/apps/web/dist ./deploy/public
# SQL migrations run automatically at startup (see apps/server/src/db/migrate.ts)
COPY migrations ./deploy/migrations
VOLUME ["/data"]
ENV PORT=3000 \
    DATA_DIR=/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "deploy/dist/index.js"]
