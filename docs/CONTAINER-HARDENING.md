# CONTAINER HARDENING — what is locked down, and the staged path to non-root

Companion to `SECURITY.md`. This file covers the *runtime* hardening of the containers in
`docker-compose*.yml` and the Dockerfiles: what is already in place, what each setting actually buys you, and
the one remaining migration (running every container as a non-root user) written so it can be done without a
backup/restore outage.

---

## 1. What is applied to every service, today

Added to each service in all five compose files (`docker-compose.yml`, `.prod`, `.dokploy`,
`.dokploy-external-db`, `.coolify`):

```yaml
security_opt:
  - no-new-privileges:true
logging:
  driver: json-file
  options:
    max-size: '10m'
    max-file: '3'
```

* **`no-new-privileges`** — the containerised process can never gain privileges through a setuid/setgid
  binary. Costs nothing, breaks nothing, removes a whole class of container escape that depends on an
  in-image binary being executable with elevated bits.
* **Bounded logs** — a chatty container writing to the default unbounded json-file driver is a documented way
  to fill the host disk, which first takes out Postgres and then everything else. 10 MB × 3 files per service
  keeps `docker logs` useful (`--since`, `--tail`) without being able to eat the volume.

### Ports

* In the **prod** stack only `nginx` publishes ports (80/443). `web`, `api`, `minio`, `postgres` and `redis`
  are reachable only on the compose network — verify with `docker compose ps`
  (look for `0.0.0.0:` mappings; there should be none on app containers).
* In the **local dev** stack every port is bound to `127.0.0.1` (not `0.0.0.0`), so a laptop on a café
  network is not serving the casino.

### Images

* `node:22.14-alpine` / `postgres:17.6-alpine` / `redis:7.4-alpine` / `nginx:1.29-alpine` / MinIO pinned by
  digest in the prod stack — a `:latest` tag turning into a different image overnight is an unreviewed change
  to your production surface.
* The web image already runs as the unprivileged `nextjs` user (`USER nextjs` in `apps/web/Dockerfile`).

---

## 2. What is deliberately NOT applied

| Option | Why it is off |
|---|---|
| `read_only: true` (root filesystem) | The **api** container runs `prisma migrate deploy` at boot and writes an ephemeral `.env`/generated client; the **worker** writes backup files and `tsx` caches; **postgres** and **minio** write their data directories. Read-only would need a tail of `tmpfs:` mounts and per-service testing. Worth doing per-service, not globally. |
| `cap_drop: [ALL]` | Would be correct for `web`/`api`/`worker`, but Postgres needs `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID` on first initialisation and MinIO needs `SETUID`/`SETGID`. Applying it per service needs a real boot test per image. |
| `mem_limit` / `cpus` | A hard memory cap on the **database** turns a traffic spike into an OOM kill on the money ledger. Resource limits belong on a host with measured headroom, not as a copy-paste default. |
| `user: 1000:1000` on api/worker | See §3 — this is a code change, not a compose flag. |

---

## 3. Running the API and worker as non-root (staged, do it in a window)

Both images currently run as **root** inside the container. The API only needs to read its code and write
almost nothing; the worker is the one that writes (backup files, job state). The blockers are specific:

1. `apps/api/docker-entrypoint.sh` runs `prisma migrate deploy` and, on first boot, seeds — it needs to own
   nothing special, but the generated Prisma client and `/app/node_modules` must be readable by the new user.
2. The API writes an `.env`-derived runtime file in some deployment shapes (Dokploy/Coolify inject env at
   runtime) — anything the entrypoint writes must be in a volume or `tmpfs` the new user can write.
3. The **worker** writes backups to `BACKUP_DIR`. Point that at a host volume owned by the app user.

The change, per image:

```dockerfile
RUN addgroup -S app && adduser -S -G app app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build     --chown=app:app /app/apps/api/dist ./apps/api/dist
COPY --from=build     --chown=app:app /app/apps/api/prisma ./apps/api/prisma
USER app
```

Then in compose, for each of `api` and `worker`:

```yaml
    user: '1000:1000'
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
```

Keep the **database and MinIO privileged** (they are stateful daemons with their own hardening story); the
point of this migration is the two containers that run *your* code and hold *your* secrets.

**Test it before you believe it** (single lines, run on the host):

```
docker compose build api worker && docker compose up -d api worker && docker compose logs --since 3m api worker | grep -iE 'permission denied|eacces|readonly|error'
```

```
docker compose exec -T api sh -c 'id && touch /app/probe && rm /app/probe && echo writable'
```

Expect: `uid=1000`, and a permission-denied on the write probe when `read_only: true` is on (that is the
point). The entrypoint must still complete migrations — watch for `migrate deploy` in the logs.

---

## 4. Hardening checklist for the host itself

The containers are only half of it. On the VPS:

- SSH: keys only, no root login, non-default port optional — `PermitRootLogin no`, `PasswordAuthentication no`.
- Firewall: allow 22/80/443 only; the compose network publishes nothing else in the prod stack.
- Automatic security updates enabled (`unattended-upgrades` on Debian/Ubuntu).
- Docker socket not mounted into any container, and no container runs with `privileged: true`.
- Host disk alerts — the watchdog emails on stale backups; add a host-level disk check too.
- `.env` readable only by the deploying user (`chmod 600 .env`), never in git (CI scans for it).
