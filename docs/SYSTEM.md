# System map — casino games platform

This file is the operator/engineer memory of how the stack actually works.
Code paths named below are the source of truth; if they disagree with this
file, the code wins and this file must be updated.

Skipped on purpose (operator/legal + Admin 2FA): counsel, terms, dual-control
staffing, `ENABLE_2FA_ADMIN`. Do not implement those here.

---

## Layout

| Path                     | Role                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `apps/api`               | Fastify REST + Socket.IO. Wallet ledger, game engines, Prisma.     |
| `apps/web`               | Next.js 16 player site + `/panel` admin console.                   |
| `apps/worker`            | BullMQ scheduled jobs (rakeback, leaderboard, refunds, reconcile). |
| `packages/shared`        | Money helpers, error codes, `RoundResult`, validators.             |
| `packages/game-core`     | HMAC / seed hashing for provably fair.                             |
| `nginx/nginx.conf`       | TLS edge. **Does not set CSP** — Next middleware does.             |
| `scripts/integration.sh` | Real Postgres+Redis integration; **fails** if the stack is down.   |
| `scripts/reconcile.ts`   | Read-only ledger vs wallet check; non-zero exit on drift.          |

Root scripts `db:migrate` / `db:seed` / `db:studio` filter **`@casino/api`**
(the package name). `pnpm --filter api` does not match.

---

## Money path (the only sanctioned write)

Every balance mutation goes through `apps/api/src/services/walletLedger.ts`:

1. `lockWalletRow(userId, tx)` — `SELECT … FROM "Wallet" FOR UPDATE`.
2. Version-guarded `updateMany` (`where: { userId, version }`). Conflict → `WAL_004` 409.
3. Insert a `Transaction` ledger row.

`wallet.ts` `applyBalanceChange` is a thin wrapper around `applyLedgerChange`.
`lockWallet` **delegates** to `lockWalletRow` — do not duplicate the SQL.

The worker imports `applyLedgerChange` directly so it does not open a second
API Prisma pool. `decimal.js` is a direct worker dependency and is also
folded into the bundle (`tsup` `noExternal`) so rakeback/refund arithmetic
never hits an unresolved import at runtime.

Spend order (AUTO bets): BONUS → GIFTED → REAL. LOCKED is never spent.
Wins credit **pro rata** back to the wallets that funded the stake
(`creditWinProRata`) so bonus cannot be cashed out as real.

---

## Round results

Canonical union lives in `packages/shared/src/types/index.ts` and matches the
Prisma `RoundResult` enum:

`WIN | LOSE | CASHOUT | BUST | PUSH | PENDING`

- `PUSH` — stake returned exactly (table-game tie, capped payout = stake). Does
  **not** advance win streaks.
- `PENDING` — session/shared-round in flight. Excluded from leaderboards,
  dashboard volume, player session-stats, reports, and worker snapshots.
- Player UI types re-export `SettledRoundResult` (no `PENDING`).

---

## Leftover handlers (checked — not live money)

These classes stay registered in `BaseGame.ensureGamesRegistered()`. **Real-money
HTTP never reaches their `resolve()`.** Do not delete them: tests and
`verifyRound` still import helpers (`mulberry32`, `colorOf`, crash math).

| Leftover                                                                | Live path                                                                                                  | Still used for                                                                                                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MinesGame` / `TowerGame` / `StairsGame` / `HiLoGame` `.resolve()`      | `POST /:slug/session` → `SessionManager` / `gameSessions.ts`. `/bet` **400s** these slugs (demo included). | Unit tests; `mulberry32` re-export. PF replay is `SESSION_GAME_LOGIC`, not `.resolve()`.                                                                                   |
| `WingoGame.resolve()`                                                   | Real money: socket/`POST /bet` → `WingoRoundManager` (house clock, 1.96×).                                 | **Demo** WinGo is still the one-shot HMAC path (GamePage: “Demo stays on the REST path”). `colorOf` / `isBig`. Legacy PF rows without `wingo-hmac-v1`.                     |
| `AviatorGame.resolve()` / `CrashXGame`                                  | Real money: `CrashRoundManager`.                                                                           | **Demo** crash is a solo “pick a target” resolve (not the shared plane). Live math (`crashMultiplierAt`, `generateCrashPoint`, `crashPointV2`) is shared with the manager. |
| `OutcomeEngine.computeAdjustedWinThreshold` / `selectPayoutFromWeights` | **Never called** from `processOutcome`. Decision is `fairWinChance × difficulty`.                          | Unit tests only.                                                                                                                                                           |
| `winRateSteering.isSteerable()`                                         | Always `false`.                                                                                            | Fail-closed stub so old callers cannot search HMAC candidates.                                                                                                             |

Demo rounds are `demo=true`, no wallet movement, excluded from GGR. A guest
cannot smuggle real money onto these leftover resolvers: crash/wingo shared
branches are `!demo`; session slugs never hit `processOutcome`.

---

## Admin reports & dashboard metrics

One definition everywhere (`panel.ts` dashboard + user-stats, `reports.ts`
preview/CSV, `StatisticsTracker`). Never mix ledger `Transaction` BET−WIN into
GGR — a PUSH writes BET + REFUND, so BET−WIN would count the stake as house
profit. Source of truth is `GameRound`.

**Settled real-money row**

`demo = false AND result <> 'PENDING'`

**Formulas**

| Metric                  | Formula                                    |
| ----------------------- | ------------------------------------------ |
| Volume / wagered        | `SUM(betAmount)`                           |
| Payout / paid_out / won | `SUM(payoutAmount)`                        |
| GGR (house)             | volume − payout                            |
| Player net              | payout − volume (= −GGR)                   |
| RTP                     | payout / volume                            |
| Win rate                | count(`WIN` or `CASHOUT`) / settled rounds |

PUSH returns the stake (`payoutAmount = betAmount`) → GGR 0, not a win.
CASHOUT (crash/mines/tower) is a win for hit-rate; BUST/LOSE are losses.

**Day buckets** — `GameRound.createdAt` is `TIMESTAMP(3)` naive UTC. Group with
`to_char("createdAt", 'YYYY-MM-DD')`. Dashboard zero-fill keys are
`Date.toISOString().slice(0, 10)` (also UTC). Do not use `DATE(timestamptz)`
(session TZ) against those JS keys.

**Where it shows**

| Surface                         | Notes                                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| `/panel/dashboard/stats`        | today / week / all-time volume & GGR                             |
| `/dashboard/revenue-trend`      | daily volume, payout, GGR                                        |
| `/dashboard/game-performance`   | per-game volume, GGR, RTP                                        |
| `/dashboard/top-players`        | `net` = **player** P&L (green profit / red loss)                 |
| `/users/:id/stats` `rounds.net` | **house** GGR; UI label “Net to house”                           |
| Reports `type=revenue`          | daily rounds, wagered, paid_out, GGR, unique players             |
| Reports `type=games`            | wagered, paid_out, GGR, win_rate, RTP                            |
| Reports `type=players`          | `net` player P&L, `ggr` house                                    |
| Reports `type=deposits`         | status × method counts (includes PENDING — it is a queue report) |
| Reports `type=transactions`     | ledger dump, not GGR                                             |

Preview and CSV share `runReport()` so they cannot drift. Players export is
capped at 100, transactions at 5000.

---

## Game clocks

Three families:

1. **One-shot** (dice, wheel, …) — `OutcomeEngine.processOutcome`. One
   transaction: debit → `GameRound` → nonce claim → credit.
2. **Session** (mines, tower, stairs, hi-lo) — debit once on start, steps
   mutate state, cashout/bust settles. Stale PENDING refunded by the worker
   after 24h.
3. **House-clock** (WinGo, Aviator, Crash X) — Redis is the clock, Postgres
   `SharedRoundBet` is the debt. `RoundLeaderLease` elects **one** API replica
   as the clock owner (`SET NX` + Lua renew).

Crash failover (`crash-salvage.ts`), in order:

| Redis state                                   | Action                                              |
| --------------------------------------------- | --------------------------------------------------- |
| `CRASHED` or `crashedAt` set                  | **settle** leftover stakes at the known crash point |
| `FLYING` and multiplier already ≥ crash point | **settle**                                          |
| `FLYING` and still below crash point          | **resume** the taxi/flight                          |
| `WAITING` / `BETTING` (never took off)        | **refund**                                          |

Never refund a committed crash. WinGo salvage is the same idea: settle a
round that already has a result before `refundOpenSharedBets`. If the round
had reached lock without a ball, salvage commits the lock-time pick first.

### WinGo difficulty (lock-time book fade)

Winners always get **1.96×**, every bet type. Difficulty is how often the
room loses, not how much a win pays. After the 5s lock, each digit 0–9 is
scored by the **stake that would win** (color + size + exact). Then:

| Level         | Ball                               |
| ------------- | ---------------------------------- |
| easy / normal | HMAC uniform 0–9 (ignore the book) |
| hard          | 80% cheapest digit, 20% HMAC       |
| impossible    | always the cheapest digit          |

Ties among cheapest digits are HMAC. Empty book → uniform HMAC. Seed hash
is published at round open; the ball is not pre-drawn. Code:
`apps/api/src/engine/games/wingo-book.ts`. Placement does **not** emit
`wingo:bet-placed` (choice + amount would let anyone rebuild the book
during the betting window). The better still gets a private ack; the
room still shares one ball. After settle, PF `bookStake` is on the
transcript — that is after the draw. `placeBet` returns the real
`AppError` (loss limit, insufficient balance); it must not collapse
every failure into “Insufficient balance or duplicate bet”.

Crash HUD uses the same taxi curve as the server (`crashMultiplierAt` /
`growthRateFromConfig`) so a mid-round refresh does not jump. Between ticks
the client infers growth from the taxi (0.10→1.00 over 2500ms) then
`ln(m)/(elapsed − taxi)` — never `ln(m)/totalElapsed`.

### Aviator admin hide

`PATCH /panel/games/:slug` `{ isActive }` is the Visible toggle on
`/panel/games`. Hiding must **not** run odds validation: Aviator's seeded
`payout_weights` compute ~213% RTP and are unused by the crash engine, so
every hide/Hot/difficulty save 422'd. Operational patches
(`isActive`, `tags`, name, …) skip both the generic ceiling and the strict
schema. Crash slugs also skip the generic `winRate × weights` check when
odds _are_ edited; `crash_distribution` still goes through C-06.

When `isActive` is false the crash clock idles (no new rounds, live Redis
key dropped, `placeBet` 403s). Re-enable starts the next round on the
existing 5s loop. Lobby already filters `isActive: true`; detail 403s.

### Tower (per-floor payouts + phone board)

Live path is `towerSession` in `apps/api/src/engine/session/gameSessions.ts`,
not `TowerGame.resolve()`. A successful pick on floor _f_ (1-based) pays
`ladder[f-1] × stake`. Admin owns that table:

| Where     | Key                                                                            |
| --------- | ------------------------------------------------------------------------------ |
| Preferred | `configJson.difficulties.{easy,medium,hard,expert}.payout_ladder` (10 numbers) |
| Legacy    | `configJson.payout_ladder_{easy,medium,hard,expert}`                           |
| Fallback  | fair `0.96 / P(survive f)` — expert floor 10 ≈ 9.4 million ×                   |

`resolveTowerBoard` in `packages/shared/src/constants/tower.ts` is the single
reader. Client (`TowerGame.tsx`) and server (`towerDiff`) both call it, so
the chips on the board match cashout.

Panel: `/panel/games/tower` → **Floor payouts**. Each row is that floor’s ×
plus cashout RTP `P(survive)^f × multiplier`. Save writes both nested and
top-level keys and raises `maxWinMultiplier` to cover the top rung. Seeded
defaults (easy 10.5× … expert 520×, `maxWinMultiplier` 1000) replace the
old fair-exponential millions.

C-06 rejects a rung ≤ 1×, a short table, RTP > 99%, or a top rung above
`maxWinMultiplier`. Missing ladders still validate against the fair top
(so an empty config needs a huge cap).

Phone board: `GameBackdrop fit={false}` + 10 `flex-1` floors (`min-h-[26px]`)
so tiles stay thumb-sized instead of FitToCanvas shrinking the whole tower
to ~0.5. Cash-out bar is `h-12` on small screens.

### Plinko multi-ball stake

`body.amount` is **per ball**. N balls are N independent full bets:

- Debit = `amount × balls` (`plinkoChargedStake` in `packages/shared`).
- Engine payoutMultiplier is still the **mean** of bucket multipliers, so
  credit = debit × mean = per-ball × Σ multipliers.
- Per-ball must be ≥ minBet; total must be ≤ maxBet.
- UI: selecting 4/8/16 toasts “we'll charge N× your stake”; BetBar and the
  confirm sheet show `N balls × stake = total`. A client that only sends
  `amount` cannot get 16 drops for the price of 1.

### Thimbles replay (do not disable cups after reveal)

Server still draws the ball at bet time (HMAC). The shuffle is only a
reveal animation; `useRoundFlow.outcome` / `roundKey` stay sticky after
`complete()` so a mid-flight `outcome=null` cannot cancel the timers.

GamePage `handleVisualRoundComplete` then `setChoices({})`, so BetBar
requires a new cup tap. Cups used to be `disabled={shuffling || revealed}`
with `revealed = revealedRound === flow.roundKey && ballCup !== null` —
that stayed true after complete, the CTA said “Tap a cup”, and a reload
was the only reset.

Cups lock only while the round is animating (`shuffling || flow.playing`).
A tap after reveal resets `revealedRound` / `ballOut` / `positions` then
sets `cup` to that slot (CoinFlip: disable only during toss). Do not
change shuffle timing or the server cup draw.

### Deposit create vs admin feed

`POST /deposits/create` commits the row, then notifies admin (`emitAdmin`)
and runs `checkDepositFraud`. Those two are **after** commit. The fraud
helper lives in `apps/api/src/services/fraud.ts` and **must be imported**
in `deposits.ts` — a missing import threw `ReferenceError` after the row
existed, so admin saw the request while the player got 500 “An unexpected
error occurred”. Side effects are try/caught; they must never fail the
HTTP response.

### Withdraw confirm screen

`WithdrawFlow` must **not** `setStep(1)` after a successful create. That
dumped the player back on the amount field as if nothing happened. Show
`WithdrawStatusCard` (pending → approved/paid/rejected), same pattern as
deposits. Admin review emits `withdrawal:status` to the player socket.

### Daily bonus claim → wallet

`POST /bonuses/daily-checkin` credits the **BONUS** wallet (not REAL) via
`applyBalanceChange` (`BONUS_CHECKIN` ledger). It returns `newBalance` and
emits `balance:update` so the header chip and wallet cards move immediately.

The wallet history used to treat every non-WIN/DEPOSIT type as a debit, so a
successful claim rendered as `−₨5` with an outgoing icon — it looked like
the bonus never arrived. Credit types (`BONUS_*`, `DEPOSIT`, `WIN`,
`REFUND`, `GIFT_RECEIVED`, `ADMIN_CREDIT`) show as green `+`. Bonus is
playable (spent first) and not withdrawable.

Claim UI (`HomeCheckin`, `DailyCheckinCalendar`) applies `newBalance` via
`applyServerBalance` and invalidates `checkin` + `transactions`.

---

## Support desk (slice 1)

Players can keep **many** tickets. Closed stays closed (composer off, no reopen).
Same user + `referenceType`/`referenceId` reuses an OPEN/ASSIGNED ticket.

| Piece        | Path                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema       | `SupportConversation.category`, `referenceType/Id`, `playerLastReadAt`, `adminLastReadAt`                                                                                                                                 |
| Categories   | `@casino/shared` `SUPPORT_CATEGORIES`                                                                                                                                                                                     |
| Player API   | `apps/api/src/routes/support.ts`                                                                                                                                                                                          |
| Admin API    | `GET/PATCH /panel/support/conversations`, `GET …/:id` (player rail), messages, reply                                                                                                                                      |
| Live rooms   | `SocketServer` `chat:join` / `send` / `typing` — **admins** (`role=admin`) may join any ticket. Players still own-only.                                                                                                   |
| Admin socket | `AdminNotificationsProvider` owns `io` via `/panel/auth/ws-token` (15m, refreshed on reconnect). Expose `socket` on context. **Do not** use player `lib/app.ts` socket in the inbox — `userId` is empty so join/send 404. |
| Attachments  | Player `uploadProof` → key `deposits/{userId}/…`. Chat GET is `/api/v1/support/attachments/*?st=` (admin-issuer JWT, scope `support-attachment`, 10m). Deposit `/proof/*` still 404s keys that are not a Deposit row.     |
| Widget       | Lists threads + New conversation; closed banner; paperclip.                                                                                                                                                               |
| Wallet       | `/support?topic=deposit\|withdraw&refType=deposit\|withdrawal&refId=` from status cards. Seeds first message.                                                                                                             |
| i18n         | `support.*` in `en.ts` / `ur.ts`.                                                                                                                                                                                         |

HTTP reply is the fallback when the admin socket is not ready (ack timeout 2.5s).

### FAQs (admin-owned)

Operators add / edit / hide / delete **categories** and **articles**. Categories are
not the ticket-topic enum — they are first-class rows.

| Piece    | Path                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Schema   | `FaqCategory` (slug, nameEn/nameUr, sort, isActive), `Faq` (question/answer en+ur, sort, isPublished)                            |
| Public   | `GET /api/v1/support/faqs` — active categories that have ≥1 published article. No auth.                                          |
| Admin    | `GET/POST/PATCH/DELETE /panel/faq-categories`, same for `/panel/faqs`. `permChat`. Delete category with FAQs needs `?cascade=1`. |
| Panel UI | `/panel/faqs` — left categories, right articles, recategorise on edit.                                                           |
| Player   | Accordion on `/support` (guests too) and the chat widget picker. Urdu fields if the player language is `ur`, else English.       |
| Backup   | `FaqCategory` then `Faq` in TABLES; wipe `Faq` then `FaqCategory`.                                                               |

English question + answer are required. Urdu is optional. Answers are plain text (newlines kept), not HTML.

Not in this pass: macros, CSAT, SLA.

---

## CSRF (double-submit)

State-changing `/api/v1/panel/*`, `/deposits`, `/withdrawals` require cookie
`csrf_token` **and** header `X-CSRF-Token` to match (`csrfMiddleware`).
Auth paths are exempt.

The cookie is **not** httpOnly (JS must read it on same-origin). Flags:
`sameSite=lax`, `secure` in production, `path=/`. Player maxAge 7d; admin 8h
(matches `admin_token`).

**Why Approve used to 403 `CSRF_INVALID`:** the panel cookie was `sameSite=strict`
with no maxAge, `/panel/auth/me` never re-issued it, and on split-domain
deploys (`games.` vs `api.`) `document.cookie` cannot see the API host cookie
even though the browser sends it. Header was empty → mismatch.

**Heal path:** login and `/auth/me` / `/panel/auth/me` mint or echo the token,
return it as `csrfToken` in JSON and `X-CSRF-Token` on the response. The web
client keeps it in memory and retries **once** on `CSRF_INVALID`.

Helper: `apps/api/src/lib/csrf.ts`. Client: `rememberCsrf` in `apps/web/src/lib/api.ts`.

## Deposit credit (exactly once)

`PATCH /panel/deposits/:id` claims with `updateMany where status=PENDING`. A
second Accept is `409 GAME_007`. The UI treats 409 as “already processed” and
refreshes. Credit also skips if a `DEPOSIT` ledger row already exists for that
deposit id. Partial unique index `Transaction_deposit_credit_uniq` (migration
`20260829180000_fraud_devices_csrf`) is the DB backstop when no historical
duplicates exist.

## Fraud review

Write-side (`apps/api/src/services/fraud.ts`), fail-open:

| Signal                                                                                                         | When                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `MULTIPLE_ACCOUNTS_SAME_DEVICE`                                                                                | ≥3 accounts share a fingerprint (signup + login) |
| `MULTIPLE_ACCOUNTS_SAME_IP`                                                                                    | ≥8 accounts on the same **public** IP in 7 days  |
| `SHARED_SENDER_ACCOUNT`                                                                                        | Deposit sender account used by another user      |
| `RAPID_DEPOSITS`                                                                                               | ≥3 deposits in 1 hour                            |
| `NEW_ACCOUNT_WITHDRAWAL` / `WITHDRAWAL_TO_NEW_ACCOUNT` / `RAPID_WITHDRAWAL_AFTER_DEPOSIT` / `LARGE_WITHDRAWAL` | withdrawal checks                                |
| `ADMIN_FLAG`                                                                                                   | manual flag from the player drawer               |

Each login/signup writes `UserDevice` + `UserLoginEvent` and `User.lastLoginIp` /
`lastLoginCountry` (CDN country header, **not GPS**). Private IPs are never
clustered. Same `(user, signal)` is deduped for 24h except manual flags.

Admin: `/panel/fraud-signals` (filter new/reviewed/ignored) and player drawer
tab **Device & fraud** (phone, IP, country, devices, logins, linked accounts,
signals). `POST /panel/users/:id/fraud-flag`. Permission: `permUsers`.

## Auth

All JWTs are **RS256** (RSA-2048). There is no HMAC `JWT_ACCESS_SECRET` /
`JWT_ADMIN_SECRET` and no Ed25519. Trust domains are `issuer` + `role`
(`apps/api/src/lib/jwt-claims.ts`).

Generate:

```bash
openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
# Dokploy one-liner:
base64 -w0 jwt-private.pem   # JWT_PRIVATE_KEY_B64
```

---

## KYC

`User.kycStatus`: `NONE | PENDING | APPROVED | REJECTED` (default `NONE`).

- Player `POST /api/v1/user/kyc/submit` — `NONE`/`REJECTED` → `PENDING`.
- Admin `PATCH /api/v1/panel/users/:id` `{ kycStatus }` — allow-listed.
- When setting `ENABLE_KYC` is true, `POST /withdrawals/create` requires
  `APPROVED` (403 otherwise).
- `GET /auth/me` returns `kycStatus`.

Admin 2FA is **not** implemented (`ENABLE_2FA_ADMIN` is a settings flag only).

---

## Player chrome (theme + lobby names)

Light theme is unfinished. The player site is **always dark**:

- `apps/web/src/app/layout.tsx` stamps `data-theme="dark"`.
- `useUIStore.theme` is hard-wired to `'dark'`; `setTheme` ignores `'light'`
  and rewrites stored `theme` to dark.
- Profile no longer has a Dark-theme checkbox (`pages-extras.tsx`).
- `GameShell` stamps `data-theme="dark"` (does not read the store).

Lobby card titles (home + `/games`, both `LobbyClient`):

- Setting `lobby_show_game_names` (boolean, **default false**).
- Lives in shared `DEFAULT_SETTINGS`, seed `DEFAULT_SETTINGS`,
  `validateSettingsPatch` BOOLEAN list, Admin → Settings → General toggle
  “Show game names on lobby”.
- Player client cannot hit `/panel/settings`. It reads
  `GET /games/lobby-ui` → `{ showGameNames }`. Fail closed = hide names.
- When off: grid / hot / recently-played overlays and the bottom gradient
  are omitted so thumbnail art (which already has the title) is unobstructed.
  Search still matches `displayName`. Featured banner keeps Play now; the
  large title hides with the same flag.

---

## CSP

`apps/web/src/proxy.ts` (Next 16 proxy convention) mints a per-request nonce and sets

`script-src 'self' 'nonce-…' 'strict-dynamic'`

`'unsafe-inline'` is **not** on `script-src`. `style-src` still allows
`'unsafe-inline'` because Next/font and Tailwind inject styles.

The root layout reads `x-nonce` so Next can stamp its hydration scripts.
nginx **must not** add a second `Content-Security-Policy` (browsers AND
policies; a static `'unsafe-inline'` would undo the nonce).

---

## Worker jobs (`apps/worker/src/index.ts`)

| Job                       | Cron (UTC)    | Notes                                            |
| ------------------------- | ------------- | ------------------------------------------------ |
| weekly-rakeback           | `1 0 * * 0`   | Last complete Mon–Sun; `applyLedgerChange` BONUS |
| leaderboard-snapshot      | `59 23 * * *` | Excludes `demo` and `PENDING`                    |
| stale-game-session-refund | `15 * * * *`  | PENDING > 24h → PUSH + REFUND                    |
| reconciliation-check      | `0 4 * * *`   | Wallet vs ledger; webhook + **throw** on drift   |
| db-backup                 | `0 3 * * *`   | Encrypted JSON, keep 14                          |

`RECONCILE_WEBHOOK_URL` — optional POST target for alerts.
`pnpm reconcile` runs `scripts/reconcile.ts` against `DATABASE_URL`.

---

## CI and git hooks

- `.github/workflows/ci.yml` — format, lint, typecheck, unit+integration
  (Postgres 17.6 + Redis 7.4 services), API/worker/web builds, `pnpm audit --prod`.
  Sets `INTEGRATION_REQUIRED=1`. Integration tests **must not skip**.
- `.husky/pre-commit` — `pnpm exec lint-staged` (eslint + prettier).
- `scripts/integration.sh` waits ≤30s for pg/redis then **exits 1** if they
  never become ready.

Local `pnpm test` without Docker still skips integration (no
`INTEGRATION_REQUIRED`). That skip is not a pass.

CSV formula neutralization lives in `apps/api/src/lib/csv.ts` (`csvCell` /
`toCSV`). reports.ts and panel backup CSV import it. Do not re-introduce a
local helper.

---

## Environment

- Root `.env.example` and `apps/api/.env.example` — RS256 only.
- `ENCRYPTION_KEY` / `AES_ENCRYPTION_KEY` — AES-256-GCM for payout accounts.
  Rotating it after go-live makes saved accounts unreadable.
- Production `checkEnvironment()` fails closed on missing JWT, encryption,
  frontend URL, and example passwords.

---

## Deploy

See `DEPLOY-DOKPLOY.md`. Compose files pin image tags. Public API URLs must
include `/api/v1`. Do not cache game HTML/RSC as immutable media.

Do **not** `pnpm install` inside a size-limited workspace copy — install on
the build host / CI runner. Prisma client is gitignored; run
`pnpm --filter @casino/api exec prisma generate` after clone.

### Web image (`apps/web/Dockerfile`)

Build: `cd apps/web && pnpm exec next build` (Turbopack compile **then** `tsc`).
Broken JSX and missing names fail the image. Import workspace helpers from
`@casino/shared` (e.g. `plinkoChargedStake`) — a deep `../../packages/shared/...`
path from `app/(player)/games/[slug]` does not resolve.

### API image (`apps/api/Dockerfile`)

Build stage: `prisma generate`, then `pnpm --filter @casino/api build`
(`tsup` / esbuild, **no `tsc`**). A syntax error fails the image; a type-only
error does not. `@casino/shared` and `@casino/game-core` are `noExternal`
(folded into `dist/`).

Aviator/Crash X `runRound` must `redis.set(keys.crashRound)` and emit
`{slug}:round-start` **before** the waiting sleep. Without that, `placeBet`
409s (“No round available”). Leader takeover uses `crashSalvageKind` from
`crash-salvage.ts` (settle a known crash, resume an in-flight round, refund
only a round that never took off).
