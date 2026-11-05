# INCIDENT RESPONSE — what to do, in order, when something has gone wrong

**Every command below is a single line on purpose: paste it straight into a Linux terminal.**

The stack is defined in a single `docker-compose.yml`, so no `-f` is needed. If you are on
Dokploy/Coolify, run the equivalent action in their UI, or run the commands on the host with the same
`docker compose -f <file>` prefix.

---

## 0. The first five minutes (any incident)

1. **Write down the time and what you saw.** Everything below is auditable, but only if you can say when it
   started.
2. **Do not delete anything.** Logs, alerts and audit rows are the evidence.
3. **Decide the blast radius**: money (payouts/credits), accounts (logins), data (exports/backups), or
   availability (is the site up?).
4. **Freeze money movement if money may be involved** (see §3). Reversible, and it stops the bleeding while
   you investigate.

Useful first commands (each is one line):

```
docker compose ps
```

```
docker compose logs --since 2h api | tail -n 200
```

```
docker compose logs --since 2h worker | tail -n 200
```

Panel state (open alerts, watchdog checks, parked credits) is on the **Monitoring** page, and every admin
action is on **Audit Log**.

---

## 1. A secret has leaked (JWT key, database password, S3 key, SMTP password)

Treat the leaked secret as public from the moment it left your control.

1. Rotate that one secret following `docs/KEY-ROTATION.md` (do not rotate everything at once unless you must).
2. Restart the services that read it:

```
docker compose up -d --force-recreate api web worker
```

3. If the **JWT private key** leaked, every issued token must be considered forged. Rotating the key already
   invalidates them all (a new key cannot verify old tokens), so users are signed out — expect a wave of
   re-logins and support messages.
4. If the **database password** leaked, rotate it, then check for rows you did not create:

```
docker compose exec -T postgres psql -U casino -d casino -c "SELECT username, \"lastLoginAt\" FROM \"AdminUser\" ORDER BY \"lastLoginAt\" DESC NULLS LAST;"
```

5. If the **S3/MinIO key** leaked, rotate the app credentials (see the note in `docs/KEY-ROTATION.md`), and
   assume uploads were readable — check the bucket policy and object listing.

---

## 2. An admin account is compromised (or a panel session was stolen)

1. **Neutralise the session immediately** — signing out bumps that admin's session version, so a cookie copied
   off the machine stops working at once:

```
docker compose exec -T postgres psql -U casino -d casino -c "UPDATE \"AdminUser\" SET \"sessionVersion\" = \"sessionVersion\" + 1 WHERE username = '<their-username>';"
```

2. **Rotate their password** (the panel has no self-service admin password change; the operator does it in the
   database with a bcrypt hash) or **delete the account** if it should not exist:

```
docker compose exec -T postgres psql -U casino -d casino -c "DELETE FROM \"AdminUser\" WHERE username = '<their-username>';"
```

3. **Read the audit log** for what they did, by admin and time:

```
docker compose exec -T postgres psql -U casino -d casino -c "SELECT \"createdAt\", action, \"targetType\", \"targetId\" FROM \"AdminAuditLog\" WHERE \"adminId\" = (SELECT id FROM \"AdminUser\" WHERE username = '<their-username>') ORDER BY \"createdAt\" DESC LIMIT 100;"
```

4. **Review money**: payouts they approved, and any wallet adjustments they cleared or parked. Every approve
   that mattered went through step-up and (above the threshold) a second admin, so look for pairs.

```
docker compose exec -T postgres psql -U casino -d casino -c "SELECT id, status, amount, \"reviewedBy\", \"firstApprovedBy\", \"secondApprovedBy\", \"createdAt\" FROM \"Withdrawal\" WHERE \"reviewedBy\" = '<their-id>' OR \"secondApprovedBy\" = '<their-id>' ORDER BY \"createdAt\" DESC LIMIT 100;"
```

5. **Sign every player session out** if you suspect player accounts were touched (same version bump, per user):

```
docker compose exec -T postgres psql -U casino -d casino -c "UPDATE \"User\" SET \"sessionVersion\" = \"sessionVersion\" + 1 WHERE id = '<user-id>';"
```

---

## 3. Money looks wrong (duplicate payout, unintended credit, frozen money)

1. **Freeze the account's payouts** (the recovery console's freeze is the audited way; for an emergency the
   direct write is this):

```
docker compose exec -T postgres psql -U casino -d casino -c "UPDATE \"User\" SET \"withdrawalFrozenUntil\" = now() + interval '48 hours' WHERE id = '<user-id>';"
```

2. **Park further admin credits** by lowering the dual-control threshold so nothing large moves without a
   second signature: **Panel → Settings → Security → Dual control over admin credits**.

3. **Reconcile wallet vs ledger** — balances must always equal the sum of their transactions:

```
docker compose exec -T api node -e "console.log('see scripts/reconcile.ts')"
```

```
docker compose exec -T api npx tsx scripts/reconcile.ts
```

4. **Correct a mis-credit with a ledgered entry**, never by editing `Wallet` — use **Panel → Users → Adjust
   balance** (which is itself dual-controlled above the threshold) so the correction is traceable.
5. If a payout was released twice, check the claim transaction in `AdminAuditLog` (`withdrawal.*`) and the
   withdrawal row's `firstApprovedBy` / `secondApprovedBy` — the two signatures are recorded separately.

---

## 4. Database or server breach (data exfiltration suspected)

1. **Take the platform down** rather than serving from a compromised host: set `maintenance_mode` ON in the
   panel (or stop the containers) — the panel and `/auth/login` stay reachable, the player site shows 503.
2. **Rotate every credential** in `docs/KEY-ROTATION.md`, starting with the database password and the JWT key.
3. **Preserve evidence**: take a database dump and the container logs before rebuilding.

```
docker compose exec -T postgres pg_dump -U casino -d casino -Fc -f /tmp/incident.dump
```

4. **Rebuild from a known-good image** rather than patching the running host, then restore the backup into a
   clean database (see `BACKUP-STRATEGY.md`).
5. **Tell the people affected** — which data, when, and what they should do (change password; their sessions
   are already dead because the JWT key changed).

---

## 5. The site is down (availability)

1. Is it the edge, the API, or the database?

```
docker compose ps
```

```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/health
```

2. The watchdog alerts on exactly this (service checks, stalled queues, stale backups) — read the last alerts:

```
docker compose exec -T postgres psql -U casino -d casino -c "SELECT \"createdAt\", kind, severity, message, status FROM \"SecurityAlert\" ORDER BY \"createdAt\" DESC LIMIT 20;"
```

3. Put the platform into maintenance mode before debugging a broken money path — a slow site is better than a
   wrong ledger.
4. After recovery, verify money first (`scripts/reconcile.ts`), then turn maintenance off.

---

## 6. A player account was taken over

1. The recovery console is the audited path: **Panel → Account Recovery**. Approving a request requires
   evidence, a second super-admin, revokes sessions and freezes payouts for 24–48 h. Follow
   `RECOVERY-CONSOLE.md`.
2. While a request is open, money cannot leave the account (the freeze is enforced on the payout route,
   regardless of who is asking). A super-admin pushing a payout through an active freeze is audited and
   raises a fraud signal — that is deliberate.
3. Re-check the account's devices and login events after the reset:

```
docker compose exec -T postgres psql -U casino -d casino -c "SELECT ip, \"ipCountry\", \"loginCount\", \"lastSeenAt\" FROM \"UserLoginEvent\" WHERE \"userId\" = '<user-id>' ORDER BY \"lastSeenAt\" DESC LIMIT 20;"
```

---

## 7. After any incident — within 48 hours

1. Write a one-page timeline: detection, decision, action, verification.
2. Ask why the control that should have caught it did not, and fix the *control*, not the symptom.
3. If no alert fired, add the check to `apps/api/src/services/watchdog.ts` — that file exists so the next
   incident is loud instead of quiet.
4. If money moved, reconcile and document the ledger correction.
