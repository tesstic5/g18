# apps/api/Dockerfile — Fastify API + Socket.IO.
#
# Minimal production image (pending item #4):
#   • code ships as a pre-compiled tsup bundle — the workspace packages
#     (@casino/shared, @casino/game-core) are folded in, so `node dist/` never
#     touches TypeScript at boot (no reliance on Node's type-stripping).
#   • node_modules is a production-only install: every devDependency (vitest,
#     eslint, tsup, tsx, types…) is pruned.
#   • the runner is plain node:22-alpine — no pnpm, no corepack, no sources.
FROM node:22.14-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/game-core/package.json packages/game-core/package.json
# --ignore-scripts: prisma generate would run before the schema is copied
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN cd apps/api && pnpm exec prisma generate
RUN pnpm --filter @casino/api build

# Production-only dependency tree (validated locally): manifests + the filtered
# prod install; nothing else from the repo is needed in this stage.
FROM base AS prod-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/game-core/package.json packages/game-core/package.json
COPY apps/api/package.json apps/api/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --prod --filter @casino/api...

FROM node:22.14-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/api/node_modules /app/apps/api/node_modules
# workspace link targets (@casino/* packages are bundled into dist, so only
# their manifests ship — nothing imports them at runtime)
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/game-core/package.json /app/packages/game-core/package.json
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/prisma /app/apps/api/prisma
COPY apps/api/prisma.config.ts /app/apps/api/prisma.config.ts
COPY apps/api/package.json /app/apps/api/package.json
COPY apps/api/scripts /app/apps/api/scripts
COPY apps/api/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
EXPOSE 4000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
