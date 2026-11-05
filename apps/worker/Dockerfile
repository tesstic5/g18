# apps/worker/Dockerfile — BullMQ worker.
#
# Minimal production image (pending item #4): pre-compiled bundle + production
# dependencies only (see apps/api/Dockerfile for the pattern).
FROM node:22.14-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/game-core/package.json packages/game-core/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
# The worker needs the api's generated Prisma client at BUILD time only.
RUN cd apps/api && pnpm exec prisma generate
RUN pnpm --filter @casino/worker build

FROM base AS prod-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/game-core/package.json packages/game-core/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --prod --filter @casino/worker...

FROM node:22.14-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/worker/node_modules /app/apps/worker/node_modules
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/game-core/package.json /app/packages/game-core/package.json
COPY apps/worker/package.json /app/apps/worker/package.json
COPY --from=build /app/apps/worker/dist /app/apps/worker/dist
CMD ["node", "apps/worker/dist/index.js"]
