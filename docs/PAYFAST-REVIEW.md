> **Historical review — superseded by the implementation described in [PAYFAST.md](PAYFAST.md).**
> POST IPNs, encrypted admin configuration, authenticated inquiry, launch-page CSP, deployment propagation, maintenance exemptions, disable-safe settlement, reconciliation, status polling and log redaction have since been implemented. Provider acceptance testing, deployment checks and real database race tests remain outstanding; see the current setup guide. The findings below describe the earlier version, not the current source.

# PayFast implementation review

Reviewed 2026-10-16. Verdict: **not ready to enable as-is**. This is a review of the PayFast integration and its surrounding application/deployment paths, not a line-by-line security audit of the entire casino platform. No application source changes made during this review.

## Checks executed

- API TypeScript: PASS.
- Web TypeScript: PASS.
- Prisma schema validation: PASS. Migration was not applied to a live database.
- API test run: 60 test files passed, 1 failed, 1 skipped; 931 tests passed, 29 skipped. Failure in panel-login-cookie.test.ts during real `prisma.adminUser.upsert()` setup; not a PayFast test failure. Root cause not established by this review.
- PayFast tests within API run: 14 passed.
- Web test run: all 15 files / 81 tests passed.
- Targeted ESLint: no errors, two warnings in existing effects in wallet/flows.tsx.
- git diff --check: PASS.
- No live PayFast credentials/transactions, browser checkout E2E, real PostgreSQL callback races, production build or deployed Compose test performed.

## Findings (priority order)

### 1. HIGH — existing CSP blocks the hosted form

`apps/web/src/lib/csp.ts:51` emits `form-action 'self'`; `apps/web/src/proxy.ts` applies this policy to responses. `apps/web/src/components/wallet/flows.tsx:99-110` creates and submits a cross-origin form to `https://ipguat.apps.net.pk/...`.

With this CSP enforced, the browser refuses checkout submission. The checkout deposit has already been created and remains pending. A successful API response or typecheck cannot detect this.

Fix: narrowly allow the exact UAT gateway origin in form-action. Verify any further required redirects with a real UAT browser test; do not weaken to a wildcard or disable CSP. Add a CSP/checkout regression test.

### 2. HIGH — Docker Compose does not inject PayFast configuration

`docker-compose.yml` API service uses an explicit environment list (around lines 87-150). None of PAYFAST_ENABLED, PAYFAST_MERCHANT_ID, PAYFAST_SECURED_KEY, PAYFAST_MERCHANT_NAME, PAYFAST_STORE_ID, PAYFAST_PUBLIC_API_URL is passed through.

Adding these to a Compose substitution .env alone does not put them inside the container. With the supplied Compose deployment, PayFast remains unavailable even when an operator follows the current setup document.

Fix: add explicit API-only variable mappings, disabled by default. Keep the secured key out of frontend build arguments and NEXT_PUBLIC variables.

### 3. HIGH — callback secret is browser-visible, not independent gateway authentication

`apps/api/src/routes/payfast.ts:139-145` includes CHECKOUT_URL with its per-order secret in fields returned to the client. Hidden HTML inputs are readable and mutable by the payer. The secret is therefore not a server-to-server credential. The guide hash still protects basket/error-code authenticity (assuming the merchant secured key remains secret), but does not authenticate transaction_id, amount, or currency.

Do not interpret this finding as a demonstrated ability to forge an arbitrary success hash: that was not established. It does invalidate the previous claim that the URL secret independently proves gateway origin. Equality against client-supplied unsigned fields does not independently verify those fields with the provider.

Fix: obtain PayFast's current authenticated inquiry or signed-callback specification and verify the transaction ID, merchant, basket, settled amount, currency and status before automatic credit. Follow the approved hosted-checkout security model. Do not invent an inquiry endpoint from this older guide. Correct the documentation's trust claims.

### 4. HIGH — maintenance mode blocks settlement of already-paid orders

`apps/api/src/server.ts:168-181` rejects almost all /api/v1 requests when maintenance_mode is enabled. PayFast callback/return routes have no exception. A payment started before maintenance may succeed at PayFast and receive 503 from this app. There is no implemented inquiry/reconciliation worker to recover it if notification retries stop.

Fix: keep authenticated/validated payment notifications and safe return handling available during maintenance while continuing to block new checkout creation. Add a full-server hook regression test.

### 5. MEDIUM — turning checkout off also turns settlement off

`payfastConfig()` in `apps/api/src/services/payfast.ts:16-23` requires PAYFAST_ENABLED=true. Callback and return handlers use the same function. Disabling the checkout switch also rejects outstanding callbacks, preventing settlement of earlier payments.

Fix: distinguish configuration needed for settling existing orders from the flag allowing new checkout creation. Define credential rotation behavior for outstanding orders.

### 6. MEDIUM — abandoned/failed checkouts reserve daily limit indefinitely without a recovery flow

The callback acknowledges non-success statuses but leaves the deposit PENDING (`routes/payfast.ts:200-202`). Abandonments likewise stay pending. Daily-limit aggregation counts them. The panel explicitly blocks all manual review of PayFast rows, and no inquiry-backed resolution/expiry workflow exists.

A player can be unable to retry a genuine payment after an abandoned attempt consumes their limit. Same-day failures/abandonments reserve headroom until the day boundary; stale rows remain pending beyond it.

Fix: implement provider-backed reconciliation and an auditable resolution workflow. Do not blindly expire pending orders while a delayed payment may still settle. Record the latest provider failure/reconciliation state.

### 7. MEDIUM — callback URL still leaks through the global error logger

The callback uses logLevel: silent, but `apps/api/src/lib/core.ts:120-122` logs `request.url` through the global error handler. `server.ts` binds that handler to the root logger. Rejected notifications therefore can log the full secret path, validation hash and payment query fields regardless of route logging level.

Fix: centrally redact sensitive callback path/query data in error/access/APM logs, not just route request logging. Review proxy logs as well.

### 8. MEDIUM — no durable return/status experience or callback balance event

The browser return always redirects to /wallet without an order reference. The new checkout ignores the returned deposit ID. Its pending state is not restored after navigation. Callback settlement does not emit the existing deposit:status event or send the normal approval notification. The wallet refreshes on mount; if the backend notification arrives later, there is no new PayFast-specific status poll/event to update it immediately.

Fix: preserve an order reference, provide an ownership-checked status lookup, and restore/poll status after return. Emit notifications/events only after database commit. Show pending/failure accurately; never trust a browser success parameter for credit.

### 9. MEDIUM — test coverage is too isolated to establish correctness

The PayFast route tests register only payfastRoutes and mock auth, rate limits, transactions and wallet ledger operations. They do not execute buildServer hooks, checkout creation, CSRF, real row locks, unique-transaction rollback, the frontend form or CSP. This explains why passing tests missed the above issues.

Add: checkout success/token failure/limits/package mismatch tests; full-server auth/CSRF/maintenance tests; real PostgreSQL parallel callback and rollback tests; duplicate transaction ID across orders; delayed success/failure ordering; and browser UAT checkout/return testing.

### 10. LOW — configuration and token response validation are incomplete

`payfastConfig()` validates only HTTPS, not that PAYFAST_PUBLIC_API_URL is an origin without a path/query/fragment/userinfo. The setup document requires an origin, but malformed values pass readiness and produce broken callback URLs. `payfastToken()` uses a TypeScript cast rather than runtime validation of a non-empty string token.

Fix: enforce the documented origin contract and validate token JSON with a runtime schema. Return no-store on checkout responses containing payment tokens and callback fields.

## Controls that are implemented correctly in structure

- Merchant secured key stays server-side; access token request uses form encoding and a nonempty User-Agent.
- Guide SHA256 example matches and comparison is timing-safe for expected valid-length hashes.
- Server validates package/price and snapshots real credits/bonus; client cannot choose arbitrary package credit values.
- New orders enforce min/max and matured daily limits under a user-row lock.
- Callback settlement locks the deposit row and writes status + canonical ledger changes within one transaction.
- A unique PayFast transaction ID adds a cross-order reuse guard. Real database race/rollback behavior remains untested.
- Browser return handler never directly credits money.
- Package bonuses use BONUS rather than REAL balance.
- Manual approval guard prevents normal panel approval from bypassing PayFast settlement.

## Recommendation

Keep PAYFAST_ENABLED=false. First fix CSP, Compose propagation, maintenance/disable settlement behavior and logging. Obtain the current provider verification contract, implement reconciliation, then extend full-stack tests and complete actual UAT before enabling automatic payment credit. Existing green unit tests are useful but are not an end-to-end acceptance result.
