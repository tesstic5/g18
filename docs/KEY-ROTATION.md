# KEY ROTATION — every secret, in the order that avoids data loss

**Every command is a single line on purpose: paste it straight into a Linux terminal.**
The stack is a single `docker-compose.yml`, so no `-f` flag is needed. Replace `<domain>` with your host.

Rule of thumb: rotate **one** secret at a time, watch the site after each, and write down what you changed.
Rotating everything at once turns a five-minute job into an outage you cannot attribute.

---

## 1. ENCRYPTION_KEY (payout account details, mail password)

This is the one that can destroy data if done wrong, so it has a supported procedure. Old rows stay readable
while the retired key is still configured, and the re-encryption tool skips (and reports) anything no key can
open instead of overwriting it.

**Step 1 — generate a new key and put the old one in the previous slot** (both are 64 hex characters):

```
openssl rand -hex 32
```

Edit `.env` so that `ENCRYPTION_KEY=<new>` and `ENCRYPTION_KEY_PREVIOUS=<the old value>`, then recreate the API:

```
docker compose up -d --force-recreate api
```

**Step 2 — dry run** (nothing is written; it tells you how many rows are on the previous key):

```
docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/api/v1/panel/maintenance/rotate-encryption-key',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':process.env.CSRF_SECRET||''},body:JSON.stringify({apply:false})}).then(r=>r.text()).then(console.log)"
```

The supported route is `POST /panel/maintenance/rotate-encryption-key` (super-admin, requires step-up
re-authentication, body `{"apply":true|false}`). The command above calls it from inside the container. Read
the response before applying:

```json
{
  "apply": false,
  "previousKeyConfigured": true,
  "payoutAccounts": { "total": 12, "rotated": 0, "alreadyOnCurrentKey": 3, "unreadable": 0 },
  "smtpPassword": { "rotated": false },
  "failures": [],
  "next": "Dry run only. Repeat with { \"apply\": true } to perform the rotation."
}
```

`alreadyOnCurrentKey` is the number of rows that need no work, `unreadable` is the number that **no**
configured key could open (these are skipped and reported in `failures`, never overwritten). A dry run always
reports `rotated: 0`.

**Step 3 — apply** (same call with `"apply":true`). Re-run the dry run afterwards: it must report **zero** rows
left on the previous key.

**Step 4 — retire the previous key.** Remove `ENCRYPTION_KEY_PREVIOUS` from `.env` and recreate the API:

```
docker compose up -d --force-recreate api
```

**If something refuses to decrypt**: put `ENCRYPTION_KEY_PREVIOUS` back, recreate, and investigate before
trying again. Nothing is lost by going back at this point — the rows are still encrypted with a key you have.

---

## 2. JWT key pair (signs every access/admin token)

Rotating it signs **everyone** out, because old tokens cannot be verified with the new key. That is the point
if you suspect a leak; it is disruptive otherwise, so do it in a quiet window.

```
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out jwt-private.pem
```

```
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

```
base64 -w0 jwt-private.pem
```

```
base64 -w0 jwt-public.pem
```

Put the two base64 strings into `JWT_PRIVATE_KEY_B64` and `JWT_PUBLIC_KEY_B64`, then:

```
docker compose up -d --force-recreate api web worker
```

Sessions are dead. Player and admin sessions both require a fresh sign-in.

---

## 3. Database password

```
openssl rand -base64 24
```

1. Change it in Postgres first:

```
docker compose exec -T postgres psql -U casino -d postgres -c "ALTER USER casino WITH PASSWORD '<new-password>';"
```

2. Update `POSTGRES_PASSWORD` **and** the password inside `DATABASE_URL` in `.env`, then recreate the stack:

```
docker compose up -d --force-recreate api worker
```

3. Verify the API can still read:

```
docker compose exec -T api node -e "require('node:child_process')" && docker compose logs --since 2m api | tail -n 20
```

---

## 4. CSRF_SECRET / COOKIE_SECRET

Rotating these invalidates existing CSRF tokens and signed cookies; users re-fetch them automatically on the
next page load. Expect a few "please retry" errors on in-flight forms.

```
openssl rand -hex 32
```

Set both in `.env`, then:

```
docker compose up -d --force-recreate api web
```

---

## 5. SMTP password (mail/backup delivery)

Do not edit `.env` for this one — the panel owns it: **Panel → Settings → Mail**. Paste the new app password,
save, and use **Send test email** to confirm. The value is stored AES-256-GCM encrypted with
`ENCRYPTION_KEY`, so it moves with the rotation in §1.

---

## 6. MinIO / S3 credentials

Two credentials exist in a default deployment: the MinIO **root** user (console + bootstrap) and the
**application** credentials the API uses. Give the app its own access key so a leaked API credential cannot
manage the console:

```
docker compose exec -T minio mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
```

```
docker compose exec -T minio mc admin user add local casino-app "<new-secret-key>"
```

```
docker compose exec -T minio mc admin policy attach local readwrite --user casino-app
```

Then set `S3_ACCESS_KEY=casino-app` and `S3_SECRET_KEY=<new-secret-key>` in `.env` and recreate the API:

```
docker compose up -d --force-recreate api worker
```

Rotate the **root** credential only when the console itself may be compromised (it is also the bootstrap
credential, so the change must be made in `.env` and the container recreated):

```
docker compose up -d --force-recreate minio
```

---

## 7. Backup encryption passphrase / recipient key

See `BACKUP-STRATEGY.md`: the backup envelope has an X25519 recipient (private key offline) and a
passphrase-based fallback (scrypt). Rotate the recipient by generating a new key pair **on an offline machine**,
putting only the public key on the server, and keeping the old private key until the last backup made with it
has aged out of your retention window.

---

## Order of operations in a breach

1. `maintenance_mode` ON (panel) so no new money moves.
2. Database password (§3) and JWT key (§2) — these two stop an attacker from reading or impersonating.
3. `ENCRYPTION_KEY` (§1) if encrypted columns may have been read.
4. Storage credentials (§6), mail (§5), CSRF/COOKIE (§4).
5. Then follow `docs/INCIDENT-RESPONSE.md` §4 for evidence and rebuild.
