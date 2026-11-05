# PayFast — admin-configurable hosted checkout + verified settlement

## What you can configure later

Open **Admin → Finance → PayFast Gateway** (`/panel/payfast`) as a super-admin.
You can save incomplete settings now and complete them later without editing application code.
New checkout cannot be enabled until required fields pass the readiness checklist.

The implemented protocol is the combination of the provided hosted-checkout/IPN PDFs and the REST inquiry contract at https://premierpayfast.com/developers/.
Configuration is not a substitute for confirming that your merchant account supports that combination.
If PayFast supplies a different authentication method, endpoint path or response structure beyond dot-separated JSON fields, an adapter code change may still be needed.

### Admin fields

| Field                                            | What to enter                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Environment                                      | UAT first; production only after acceptance testing                                        |
| Merchant ID, name, secured key                   | Issued/approved by PayFast; blank key preserves existing key                               |
| Store ID                                         | Optional approved outlet ID                                                                |
| Public API origin                                | Public HTTPS origin, e.g. `https://api.yourdomain.com`, no path                            |
| Website origin                                   | Public HTTPS origin, e.g. `https://yourdomain.com`                                         |
| Hosted token endpoint                            | Exact `GetAccessToken` URL supplied by PayFast                                             |
| Hosted checkout POST endpoint                    | Exact `PostTransaction` URL supplied by PayFast                                            |
| Inquiry authentication endpoint                  | Exact REST `/token` URL supplied by PayFast                                                |
| Inquiry REST base URL                            | Base before `/transaction/basket_id/{basketId}`                                            |
| Access-token response field                      | `token` per public REST docs; confirm for your account                                     |
| Inquiry status/basket/transaction fields         | `status_code`, `basket_id`, `transaction_id` per public examples                           |
| Inquiry original merchant amount/currency fields | Obtain actual inquiry response field names from PayFast; do not infer from IPN             |
| Final success codes                              | Exact provider-confirmed paid/captured codes, comma separated; leading zeroes matter       |
| Optional final failure codes                     | Only irrevocable final failures confirmed by PayFast; empty is safer until confirmed       |
| Provider confirmation checkbox                   | Confirm compatibility, use-case approval, response semantics and environment certification |
| Enable new checkout                              | Independent from settlement of existing orders                                             |

Nested inquiry responses are supported using paths such as `data.merchant_amount`.
Amount must be a decimal string with at most two fractional places; currency must be `PKR`.
Status, basket and transaction identifiers must be nonempty strings. The integration intentionally rejects incomplete or mismatched data rather than guessing.
Do NOT map transaction_amount to original merchant amount unless PayFast explicitly confirms that meaning for inquiry. The supplied IPN example has merchant_amount=2.00 and transaction_amount=3.98.

The inquiry test accepts a known basket and original expected amount, performs real authenticated requests using saved configuration, and changes no balances. It reports only sanitized outcomes, not tokens or raw provider bodies.

## Deployment setup (one-time)

1. Back up the database, then deploy migrations before starting the updated API:
   ```sh
   pnpm --filter @casino/api exec prisma migrate deploy
   pnpm --filter @casino/api prisma:generate
   ```
   Two migrations add callback metadata, encrypted order snapshots, launch capabilities and a unique provider transaction ID.
   They have been schema-validated but not applied to your production database during development.
2. Maintain `ENCRYPTION_KEY` (or supported AES_ENCRYPTION_KEY) securely and include it in your disaster-recovery/key-retention process. Admin configuration, order credential snapshots and transient checkout fields are AES-GCM encrypted using the existing encryption utility.
3. Set API-only `PAYFAST_ALLOWED_ORIGINS` to comma-separated **exact HTTPS origins confirmed by PayFast**. Default is `https://ipguat.apps.net.pk` only. Keep old provider origins while old orders remain unsettled. A new production hostname requires changing this deployment variable/restarting the API, but no source-code edit.
   This out-of-band allowlist prevents a compromised admin session from sending merchant secrets to arbitrary endpoints.
4. Docker Compose passes the allowlist and optional credential bootstrap variables into the API, not the browser. Credentials can instead be entered entirely in admin. Bootstrap environment values do not auto-enable checkout.
5. Keep Redis and at least one API instance running. The API starts reconciliation on readiness. `PAYFAST_RECONCILIATION_DISABLED=true` intentionally disables automatic checks; normally leave it false.
6. Configure PayFast's POST IPN URL to `<publicApiOrigin>/api/v1/payfast/ipn` if their portal requires registering it. The same URL is sent as CHECKOUT_URL. JSON and application/x-www-form-urlencoded IPNs are accepted.
7. Redact/disable `/api/v1/payfast/*` and `/api/v1/panel/payfast/*` access/APM/body logs in your external TLS proxy (Dokploy/Traefik, etc.). Reference nginx access-log filtering and API request/error redaction are included. Provider keys and launch URLs must never be shared in logs. Review external proxy error logs as well.
8. Complete admin fields, save with checkout off, test a known inquiry, complete UAT and only then enable new checkouts. Production URLs are intentionally not guessed.

## Payment flow and controls

1. Authenticated, CSRF-protected checkout enforces min/max limits, daily limits under a user-row lock, active account status and package price. Package credit/bonus terms are saved server-side.
2. The order saves its encrypted merchant/endpoint configuration and customer IP. This allows old orders to reconcile after new checkout is disabled, the admin changes environments or credentials change for new orders. Keep old credentials valid with PayFast until these orders settle.
3. A server-side form-encoded hosted token request binds basket, PKR currency and exact amount.
4. Browser receives only the order ID and a short-lived random launch URL. Top-level navigation opens a dedicated API page with an exact-provider CSP; the main site's `form-action 'self'` stays unchanged. Next's proxy exempts only the gateway launch path from the application CSP.
5. Launch capability is stored as SHA256, consumed atomically once, and expires after five minutes. Payment fields are encrypted at rest, HTML-escaped in the launch page, and never cached. Refreshing a used link fails safely.
6. POST IPN validates the documented basket/merchant/error SHA256 signature and schedules reconciliation durably by resetting the order's next-check timestamp. HTTP 200 acknowledges receipt; IPN amount/transaction fields are NOT authority to credit a wallet. No callback URL secret is treated as provider authentication.
7. The reconciler obtains a REST bearer token with merchant_id, secured_key, grant_type=client_credentials and the saved customer_ip. It then requests `/transaction/basket_id/{serverOrderId}`. Redirects are rejected and endpoint origins checked against the deployment allowlist. Runtime response validation enforces token types and all configured payment fields.
8. Only an authenticated inquiry with matching basket, original amount, PKR currency, transaction ID and configured final-success status can settle the order. The deposit row is locked; status, unique transaction ID, real/package bonus credits and canonical ledger entries commit in one transaction. Referral handling uses the existing service. Retries see the final state and cannot credit twice.
9. Wallet events/notification run after commit. Browser returns carry only a non-authoritative order reference; ownership-checked status polling restores the pending/completed screen and refreshes balances.

## Reconciliation and operational behavior

- Automatic checks run every minute, at most four orders per pass. Normally an order is rechecked no more often than five minutes; a valid IPN makes it eligible for the next pass. Capacity is bounded (about 240 checks/hour maximum across replicas) and must be reviewed against expected merchant traffic. A Redis lease prevents replicas running the same sweep concurrently; DB row locks remain the money-safety boundary.
- Super-admins can view the oldest 50 pending payments, last verification outcome/time, and trigger a provider verification now. Financial setup/test/recheck actions use existing password step-up, CSRF and permission controls. No admin button blindly approves an unverified PayFast payment.
- Maintenance and disabling new checkout do not stop IPN receipt, return handling, existing-order status or reconciliation. Some other wallet APIs may remain unavailable during platform maintenance.
- A failed token request rejects its never-launched order. Expired launch links that were never consumed are rejected by the sweep: no payment form was exposed, so releasing their daily-limit reservation is safe.
- Once the launch is consumed, ambiguous, pending, timeout or unrecognized provider states remain PENDING and reserve daily-limit headroom. They are NOT blindly expired: the customer may have paid. An authenticated, matching inquiry with an explicitly configured irrevocable failure code can reject the order and release its reservation.
- Reconciliation errors are sanitized. No raw provider response, secret or URL is persisted in error fields. Duplicate gateway transaction IDs leave the conflicting order pending for investigation rather than crediting twice.
- First-implementation legacy orders without encrypted credential snapshots fail closed and require provider-assisted reconciliation. No credentials are guessed for those orders.
- Correcting response mappings after an order has been created does not alter its configuration snapshot. Settle/reconcile existing orders using their original provider configuration; for a provider contract change, obtain an explicit migration/reconciliation plan rather than silently rewriting financial history.
- Existing encryption-key rotation now includes PayFast settings and order/launch snapshots. Do not remove old keys until rotation reports no failures. Backups contain encrypted credentials and still require access control and secure key storage. Review retention of completed-order credential snapshots/customer IP under your security/privacy policy.
- Refunds, disputes/chargebacks, recurring billing and withdrawals are not implemented by this deposit integration. Do not represent them as supported gateway features.

## Validation performed

- API and web TypeScript checks passed.
- API and web production builds passed.
- Prisma schema validation and git diff whitespace check passed.
- 49 PayFast API tests passed (settings encryption, masking, readiness, provider allowlist, token request, inquiry matching, POST IPNs, checkout creation/failure/limits, launch CSP/expiry, status ownership, disabled checkout and settlement logic).
- Two web proxy/CSP regression tests passed; full web suite: 83 passed.
- Full API suite: 966 passed, 29 skipped; one existing panel-login-cookie suite fails at real database setup (`adminUser.upsert`). It was also failing before these changes. No PayFast suite failed.

**Not certified here:** real PayFast UAT/production transactions, browser-to-provider E2E, deployed proxy behavior, PostgreSQL concurrency/rollback under parallel callbacks, production migration, provider business-category approval or operational scale. Unit tests mock DB/wallet boundaries; passing them is not a substitute for these acceptance checks. Production activation remains your responsibility after those checks and confirmed provider details.
