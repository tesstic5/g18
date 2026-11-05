# apps/web/Dockerfile — Next.js standalone output (Optimized & Hardened)
# NEXT_PUBLIC_* are inlined at BUILD time by Next.js, so they must be passed
# as build args (Dokploy/VPS/CI: set them in the build configuration).
FROM node:22.14-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/game-core/package.json packages/game-core/package.json
# BuildKit cache mount prevents re-downloading packages on every build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
# ── public URLs baked at build time (docs/20 §5) ───────────────────────────
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_PLATFORM_NAME
ARG NEXT_PUBLIC_PLATFORM_TAGLINE
ARG NEXT_PUBLIC_CURRENCY_SYMBOL
# INTERNAL_API_URL is read by next.config.ts AT BUILD TIME (the production
# same-origin rewrite proxies /api/v1 → this). It MUST be a build arg, not just
# a runtime env — otherwise the rewrite bakes the localhost fallback.
ARG INTERNAL_API_URL
# ENV values are Docker-interpolated. Each assignment is QUOTED so defaults with
# spaces ("Play. Win. Repeat.") parse correctly (unquoted spaces break ENV).
ENV NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-}" \
    NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL:-}" \
    NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-https://2win2play.com}" \
    NEXT_PUBLIC_PLATFORM_NAME="${NEXT_PUBLIC_PLATFORM_NAME:-YourBrand}" \
    NEXT_PUBLIC_PLATFORM_TAGLINE="${NEXT_PUBLIC_PLATFORM_TAGLINE:-Play. Win. Repeat.}" \
    NEXT_PUBLIC_CURRENCY_SYMBOL="${NEXT_PUBLIC_CURRENCY_SYMBOL:-₨}" \
    INTERNAL_API_URL="${INTERNAL_API_URL:-http://api:4000/api/v1}"
COPY . .

# Cache the Next.js compilation cache between builds.
#
# Next 16 builds with Turbopack: much faster, but hungrier for RAM than webpack.
# On a small VPS (2 GB total, no swap) the build can be OOM-killed — Docker
# then reports "returned a non-zero code: 137" and names this RUN line. Set the
# build arg NEXT_BUILD_WEBPACK=1 to build with webpack instead (slower, fits in
# roughly 1 GB). The default is unchanged: Turbopack.
ARG NEXT_BUILD_WEBPACK=0
RUN --mount=type=cache,target=/app/apps/web/.next/cache \
    cd apps/web && if [ "$NEXT_BUILD_WEBPACK" = "1" ]; then pnpm exec next build --webpack; else pnpm exec next build; fi

FROM node:22.14-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# CRITICAL: Next standalone binds to process.env.HOSTNAME, and Docker injects
# HOSTNAME=<container-id> — which makes the server bind to the container's
# internal hostname instead of 0.0.0.0 → Traefik/Dokploy gets 502 Bad Gateway.
# Force 0.0.0.0 here AND in compose (compose env overrides the daemon default).
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Security: run as unprivileged user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Next 16 monorepo standalone preserves the apps/web path: copy the whole
# standalone tree (its node_modules/.pnpm + relative symlinks must stay intact),
# then static + public under apps/web/. Verified working layout (D-047).
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
