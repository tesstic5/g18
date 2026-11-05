# Dependency Hygiene — M-21 Resolution (2026-08-20)

Policy + decisions record. Run `pnpm audit` before every fixpack.

## Current audit state (2026-09-17)

`pnpm audit` (full scope incl. dev): **18 vulnerabilities — 0 critical, 11 high, 7 moderate.**
`pnpm audit --prod`: **14 vulnerabilities — 0 critical, 9 high, 5 moderate.**

New advisories since the 2026-08-20 pass (which was prod-clean) are triaged
below. CI hard-gates on **critical** (`pnpm audit --prod --audit-level
critical`) and always prints the full report.

## Resolutions applied 2026-09-17

| Advisory                                                                         | Path                             | Action                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js RCE GHSA-p293-qw3h-jr36 + GHSA-2xp9-vwfh-vxw4 (critical, `next <16.3.3`) | `apps/web > next@16.3.0`         | **Fixed** — bumped to `next@16.3.5` (+ `@next/eslint-plugin-next` 16.3.5). Also cleared the transitive `sharp` libheif high. Typecheck, web tests, `next build`, live smoke re-verified.                                |
| `sharp` libheif GHSA-g89c-p67h-r497 + GHSA-2jg2-4ch7-h545 (high)                 | `apps/web > next > sharp@0.35.3` | **Fixed** — resolved by the Next 16.3.5 bump (pulls `sharp >=0.35.4`).                                                                                                                                                  |
| `fast-uri` SSRF + host-confusion ×3 advisories (high, 8 instances)               | `apps/api > fastify@5.11.3 > …`  | **Accepted — track upstream.** Transitive URI parser; no user-controlled server-side fetch flows through it in this codebase. Re-audit on every Fastify bump; do not hand-patch.                                        |
| `fastify` schema-validation bypass + X-Forwarded-* spoofing (moderate)           | `apps/api > fastify@5.11.3`      | **Accepted with mitigation — track upstream.** Spoofing requires trusting attacker headers: `TRUST_PROXY` is explicit CIDRs (never `*`/untrust-all) in every compose file, and direct-to-API traffic stays on loopback. |
| `stream-json` filter bypass (moderate), `decode-uri-component` DoS (moderate)    | `apps/api > minio@8.0.7 > …`     | **Migrate away.** The `minio` npm client is unmaintained (same Sep 2026 archival as the server). Durable fix: move the API to AWS SDK v3 S3 client together with the server migration (FIX-PLAN.md §C).                 |
| `mysql2` auth downgrade (high) + zlib inflate (moderate)                         | `apps/api > prisma > mysql2`     | **Accepted — unreachable.** Prisma CLI toolchain only; the app connects to Postgres exclusively. Re-check at each audit.                                                                                                |

## Previous audit state (2026-08-20)

`pnpm audit` (full scope incl. dev): **1 vulnerability — extract-zip (high)**, accepted (below).
`pnpm audit --prod`: **0 vulnerabilities**.

## Resolutions applied in M-21

| Advisory                                                                                | Path                                                                         | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| esbuild GHSA-g7r4-m6w7-qqqr (`>=0.27.3 <0.28.1`, low — dev-server file read on Windows) | tsup / vite (API toolchain only; apps/web uses Next/Turbopack's own bundler) | **Fixed** — `pnpm.overrides: { "esbuild": ">=0.28.1" }` in root `package.json`; API + worker tsup builds re-verified green on esbuild 0.28.x; audit clean for this advisory.                                                                                                                                                                                                                                                                                     |
| extract-zip ≤2.0.1 symlink path traversal (high)                                        | `apps/web > puppeteer-core > @puppeteer/browsers`                            | **Accepted — dev-only.** Upstream has **no patched release** (`patched: <0.0.0`). The vulnerable code only runs when puppeteer downloads a Chromium archive during local e2e setup; it is a `devDependency` and **never ships** — the production web image copies only Next standalone output (`apps/web/Dockerfile` runner stage), and puppeteer is not in runtime dependencies anywhere. Re-check at each audit; drop this note when upstream publishes a fix. |
| `@types/matter-js`                                                                      | apps/web devDependencies                                                     | **Removed** — zero imports of `matter-js` anywhere in `apps/web/src` (dead stub). Web `tsc --noEmit` re-verified clean after removal.                                                                                                                                                                                                                                                                                                                            |

## Room notes

- Fresh installs: `pnpm install --frozen-lockfile --ignore-scripts` in all Dockerfiles; postinstall hooks only run Prisma codegen in dev.
- Web `next build` (Turbopack, Next 16) needs >2 GB RAM; build on the deployment host (Dokploy/CI), not on small dev boxes. Sandbox verification substitutes: `tsc --noEmit`, ESLint, and runtime config parse (each build attempt loaded `next.config.ts` successfully before the runner OOM).
