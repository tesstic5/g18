// apps/worker/src/index.ts — BullMQ worker (v7 §6 canonical; BullMQ 6 — QueueScheduler removed)
import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type WalletType } from '../../api/src/generated/prisma/client';
import { money } from '@casino/shared/utils/money';
import { applyLedgerChange } from '../../api/src/services/walletLedger';
import {
  addDays,
  dayKey,
  platformTimeZone,
  startOfWeek,
} from '../../api/src/lib/day-boundary';

export const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

export const queues = {
  scheduled: new Queue('scheduled', { connection }),
  reports: new Queue('reports', { connection }),
  notifications: new Queue('notifications', { connection }),
};

async function refundStaleGameSessions() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.gameRound.findMany({
    where: { result: 'PENDING', createdAt: { lt: cutoff } },
    take: 500,
  });
  let refunded = 0;
  for (const round of rows) {
    try {
      const state = ((round.mappedOutcome as Record<string, unknown>)?.session ??
        null) as {
        deductedFrom?: Array<{ type: WalletType; amount: string }>;
        demo?: boolean;
      } | null;
      await prisma.$transaction(async (tx) => {
        const claim = await tx.gameRound.updateMany({
          where: { id: round.id, result: 'PENDING' },
          data: {
            result: 'PUSH',
            payoutMultiplier: '1',
            payoutAmount: round.betAmount.toFixed(2),
            mappedOutcome: {
              ...(round.mappedOutcome as Record<string, unknown>),
              interrupted: true,
              refundReason: 'Session expired after 24 hours',
            } as never,
          },
        });
        if (claim.count !== 1 || round.demo) return;
        const funding = state?.deductedFrom?.length
          ? state.deductedFrom
          : [{ type: round.walletTypeUsed, amount: round.betAmount.toFixed(2) }];
        for (const part of funding) {
          if (part.type === 'LOCKED') continue;
          await applyLedgerChange(
            tx,
            round.userId,
            part.type,
            money(part.amount),
            'REFUND',
            {
              referenceType: 'game_round',
              referenceId: round.id,
              description: 'Expired game session refunded',
            }
          );
        }
      });
      refunded += 1;
    } catch (error) {
      console.error(
        `[worker] stale session refund failed for ${round.id}:`,
        (error as Error).message
      );
    }
  }
  console.log(`[worker] stale game sessions: ${refunded}/${rows.length} refunded`);
}

// ── JOB IMPLEMENTATIONS (docs/19 §16 + docs/20 §6) ─────────────────────────
async function processWeeklyRakeback() {
  const setting = await prisma.setting.findUnique({
    where: { key: 'rakeback_percent' },
  });
  // The setting is stored as a plain scalar (e.g. 5.0), not an object.
  const pct = Number(setting?.value ?? 5) || 5;
  const enabled = await prisma.setting.findUnique({
    where: { key: 'ENABLE_RAKEBACK' },
  });
  if (enabled?.value === false) return;

  // H-12: this job fires Sunday 00:01. The old arithmetic set the window to
  // [thisMonday, nextMonday) — that pays out a week whose FINAL two days (the
  // very Saturday the job runs near, plus all of Sunday) haven't happened yet,
  // and those days are never counted by any run. Pay the LAST COMPLETE
  // Monday–Sunday week instead.
  const thisMonday = startOfWeek();
  const weekStart = addDays(thisMonday, -7); // previous Monday, platform day
  const weekEnd = thisMonday;

  // H-12b: REFUND-ed stakes must be netted out like WIN credits — an
  // interrupted round (shared-round refund) otherwise still earns rakeback on
  // money the player never actually lost.
  const rows = await prisma.$queryRaw<Array<{ userId: string; lost: string }>>`
    SELECT "userId", SUM(CASE WHEN type='BET' THEN amount ELSE -amount END)::text as lost
    FROM "Transaction"
    WHERE "walletType"='REAL' AND type IN ('BET','WIN','REFUND')
      AND "createdAt" >= ${weekStart} AND "createdAt" < ${weekEnd}
    GROUP BY "userId" HAVING SUM(CASE WHEN type='BET' THEN amount ELSE -amount END) > 0`;

  let paid = 0;
  for (const row of rows) {
    const netLoss = money(row.lost);
    const rakeback = netLoss.mul(pct).div(100).toDecimalPlaces(2);
    if (rakeback.lt(1)) continue; // minimum payout (docs/19 §16)

    try {
      await prisma.$transaction(async (tx) => {
        // Idempotency: the unique (userId, weekStart) index means a re-run of
        // the job cannot double-pay. Create the record FIRST so a duplicate
        // aborts before any money moves.
        await tx.rakebackRecord.create({
          data: {
            userId: row.userId,
            weekStart,
            weekEnd,
            totalLost: netLoss.toFixed(2),
            rakeback: rakeback.toFixed(2),
            paidAt: new Date(),
          },
        });
        await applyLedgerChange(tx, row.userId, 'BONUS', rakeback, 'BONUS_RAKEBACK', {
          referenceType: 'rakeback',
          referenceId: `${row.userId}:${weekStart.toISOString().slice(0, 10)}`,
          description: `Weekly rakeback — ${pct}% of ${netLoss.toFixed(2)} losses`,
        });
      });
      paid++;
    } catch (e) {
      // Unique-constraint violation = already paid this week; anything else is
      // logged but must not abort the remaining users.
      const code = (e as { code?: string }).code;
      if (code !== 'P2002')
        console.error(
          `[worker] rakeback failed for ${row.userId}:`,
          (e as Error).message
        );
    }
  }
  console.log(`[worker] rakeback done: ${paid} paid / ${rows.length} eligible`);
}

async function snapshotLeaderboard() {
  // daily snapshot from Redis sorted sets → LeaderboardEntry (docs/19 §13)
  const today = dayKey();
  const tz = platformTimeZone();
  // Quoted identifiers (see rakeback note). Demo rounds are excluded so the
  // leaderboard reflects real play only.
  const rows = await prisma.$queryRaw<
    Array<{
      userId: string;
      score: string;
      won: string;
      biggest: string;
      rounds: bigint;
    }>
  >`
    SELECT "userId",
           SUM("betAmount")::text as score,
           SUM("payoutAmount")::text as won,
           MAX("payoutAmount")::text as biggest,
           COUNT(*) as rounds
    FROM "GameRound"
    WHERE to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}, 'YYYY-MM-DD') = ${today} AND demo = false
      AND "result" <> 'PENDING'
    GROUP BY "userId" ORDER BY SUM("betAmount") DESC LIMIT 50`;
  let rank = 0;
  for (const row of rows) {
    rank++;
    const netProfit = money(row.won).minus(money(row.score)).toFixed(2);
    await prisma.leaderboardEntry.upsert({
      where: {
        userId_period_periodKey: {
          userId: row.userId,
          period: 'DAILY',
          periodKey: today,
        },
      },
      create: {
        userId: row.userId,
        period: 'DAILY',
        periodKey: today,
        totalWagered: row.score,
        totalWon: row.won,
        netProfit,
        biggestWin: row.biggest ?? '0',
        roundsPlayed: Number(row.rounds),
        rank,
      },
      update: {
        totalWagered: row.score,
        totalWon: row.won,
        netProfit,
        biggestWin: row.biggest ?? '0',
        roundsPlayed: Number(row.rounds),
        rank,
      },
    });
  }
  console.log(`[worker] leaderboard snapshot: ${rows.length} entries`);
}

async function cleanupDemoUsers() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: 'demo:' }, createdAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
  });
  for (const { id } of users) {
    await prisma.$transaction(async (tx) => {
      await tx.gameRound.deleteMany({ where: { userId: id } });
      await tx.sharedRoundBet.deleteMany({ where: { userId: id } });
      await tx.transaction.deleteMany({ where: { userId: id } });
      await tx.seedPair.deleteMany({ where: { userId: id } });
      await tx.wallet.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
    });
  }
  console.log(`[worker] demo cleanup: purged ${users.length} expired demo users`);
}

async function sessionCleanup() {
  // Refresh-token families are durable rows in Postgres now, so expired ones
  // must actually be reaped or the table grows without bound.
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const { count } = await prisma.refreshTokenFamily.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  console.log(`[worker] session cleanup: purged ${count} expired token families`);
}

async function syncGameStats() {
  // Redis rolling window → GameConfig cached stats (docs/20 §10 rebuild path)
  const games = await prisma.gameConfig.findMany({ select: { slug: true } });
  for (const g of games) {
    const agg = await prisma.gameRound.aggregate({
      where: { gameSlug: g.slug, demo: false, result: { not: 'PENDING' } },
      _sum: { betAmount: true, payoutAmount: true },
      _count: true,
    });
    const w = Number(agg._sum.betAmount || 0);
    await prisma.gameConfig.update({
      where: { slug: g.slug },
      data: {
        totalWagered: (agg._sum.betAmount ?? 0).toString(),
        totalPaidOut: (agg._sum.payoutAmount ?? 0).toString(),
        totalRounds: agg._count,
        effectiveRtp: w
          ? Number(((Number(agg._sum.payoutAmount || 0) / w) * 100).toFixed(2))
          : null,
      },
    });
  }
  console.log(`[worker] game stats synced (${games.length} games)`);
}

async function resetStaleWinStreaks() {
  // win streak resets after 24h without a win (docs/19 §16)
  // H-13: reset the milestone flags too. A streak whose flags stay paid means
  // the player's NEXT legitimate streak silently re-awards nothing.
  await prisma.$executeRaw`
    UPDATE "WinStreak" SET "currentStreak" = 0,
      "milestone5Paid" = false, "milestone10Paid" = false, "milestone25Paid" = false
    WHERE "lastWinAt" IS NOT NULL AND "lastWinAt" < now() - interval '24 hours'`;
  console.log('[worker] stale win streaks reset');
}

async function reconciliationCheck() {
  const [walletDiffs] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    WITH ledger AS (
      SELECT "userId", "walletType", SUM(CASE
        WHEN type IN ('BET','WITHDRAWAL','GIFT_SENT','ADMIN_DEBIT') THEN -amount
        ELSE amount END) AS balance
      FROM "Transaction" GROUP BY "userId", "walletType"
    ), wallets AS (
      SELECT "userId", 'REAL'::"WalletType" AS type, "realBalance" AS balance FROM "Wallet"
      UNION ALL SELECT "userId", 'BONUS'::"WalletType", "bonusBalance" FROM "Wallet"
      UNION ALL SELECT "userId", 'GIFTED'::"WalletType", "giftedBalance" FROM "Wallet"
      UNION ALL SELECT "userId", 'LOCKED'::"WalletType", "lockedBalance" FROM "Wallet"
    )
    SELECT COUNT(*) AS count FROM wallets w LEFT JOIN ledger l
      ON l."userId"=w."userId" AND l."walletType"=w.type
    WHERE w.balance <> COALESCE(l.balance,0)`;
  const staleShared = await prisma.sharedRoundBet.count({
    where: {
      status: { in: ['PLACED', 'SETTLING'] },
      createdAt: { lt: new Date(Date.now() - 10 * 60_000) },
    },
  });
  const diffs = Number(walletDiffs?.count ?? 0);
  const issues = diffs + staleShared;
  if (issues > 0) {
    const payload = {
      source: 'casino-worker',
      job: 'reconciliation-check',
      walletDiffs: diffs,
      staleShared,
      at: new Date().toISOString(),
    };
    console.error(
      `[worker] RECONCILIATION ALERT: walletDiffs=${diffs}, staleShared=${staleShared}`
    );
    const hook = process.env.RECONCILE_WEBHOOK_URL;
    if (hook) {
      try {
        await fetch(hook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error('[worker] reconcile webhook failed:', (err as Error).message);
      }
    }
    throw new Error(
      `reconciliation failed: walletDiffs=${diffs}, staleShared=${staleShared}`
    );
  }
  console.log('[worker] reconciliation check: clean');
}

async function dailyBackup() {
  // H-11: the scheduled job used to only LOG a line and rely on an
  // unconfigured host cron for pg_dump — the platform had NO working scheduled
  // backup at all. Export the same encrypted JSON the panel restore consumes,
  // dated and retained for the newest 14.
  //
  // D-062b: BACKUP_DIR MUST be a mounted volume. It defaults to /app/backups,
  // which is inside the container's writable layer — a redeploy silently threw
  // every backup away. All compose files now mount `backup_data` there.
  const dir = process.env.BACKUP_DIR || '/app/backups';
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(dir, { recursive: true });
    const { exportJson } = await import('../../api/src/services/backup');
    const payload = await exportJson();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let data = Buffer.from(JSON.stringify(payload));
    let file = path.join(dir, `backup-${stamp}.json`);

    // Optional second seal: encrypt for the operator's PUBLIC key so this host
    // can never read its own backups back, even if it is compromised. Set
    // BACKUP_RECIPIENT_PUBKEY (base64) or BACKUP_RECIPIENT_PUBKEY_FILE.
    let pubKey = process.env.BACKUP_RECIPIENT_PUBKEY?.trim();
    const pubKeyFile = process.env.BACKUP_RECIPIENT_PUBKEY_FILE;
    if (!pubKey && pubKeyFile && fs.existsSync(pubKeyFile)) {
      pubKey = fs.readFileSync(pubKeyFile, 'utf8').trim();
    }
    if (pubKey) {
      const { encryptForRecipient } = await import('../../api/src/lib/backupEnvelope');
      data = Buffer.from(JSON.stringify(encryptForRecipient(data, pubKey)));
      file = path.join(dir, `backup-${stamp}.cbk`);
    }

    fs.writeFileSync(file, data);

    // Retention: keep the newest 14 of EITHER format.
    const files = fs
      .readdirSync(dir)
      .filter((f: string) => /^backup-.*\.(json|cbk)$/.test(f))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - 14))) {
      fs.unlinkSync(path.join(dir, stale));
    }
    console.log(`[worker] db-backup written: ${file} (${data.length} bytes)`);

    // Email the encrypted file when SMTP + BACKUP_EMAIL_TO are configured.
    // Best-effort by design: a mail outage must never fail the backup itself.
    const { emailBackup } = await import('../../api/src/services/backupDelivery');
    const delivery = await emailBackup({ filePath: file, bytes: data.length });
    console.log(
      `[worker] backup delivery: ${delivery.status}` +
        (delivery.detail ? ` (${delivery.detail})` : '') +
        (delivery.accepted?.length ? ` -> ${delivery.accepted.join(', ')}` : '')
    );
  } catch (err) {
    console.error('[worker] db-backup FAILED:', (err as Error).message);
    throw err;
  }
}

// ── SECURITY WATCHDOG (security hardening) ─────────────────────────────────
// The section of this file that ANSWERS "is anything wrong?" — backup
// freshness, database/Redis health, stalled dual-control approvals, fraud
// spikes, locked-out players waiting, and an unfinished key rotation.
//
// Lives in the worker because that is the process with BOTH the database and
// the backup volume mounted.
async function securityWatchdog() {
  const { runWatchdogChecks } = await import('../../api/src/services/watchdog');
  const report = await runWatchdogChecks();
  for (const check of report.checks) {
    console.log(`[watchdog] ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  return report;
}

// ── DATA RETENTION (security hardening) ────────────────────────────────────
// Keeps personal data from accumulating forever: login events, read
// notifications and closed recovery cases are purged past their configured
// window. Financial rows are NEVER touched — they are the audit trail.
async function retentionPurge() {
  const { runRetentionPurge } = await import('../../api/src/services/watchdog');
  const result = await runRetentionPurge();
  const summary = Object.entries(result)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  console.log(`[retention] purged ${summary || 'nothing'}`);
  return result;
}

// ── SCHEDULED WORKER ───────────────────────────────────────────────────────
const worker = new Worker(
  'scheduled',
  async (job) => {
    switch (job.name) {
      case 'weekly-rakeback':
        await processWeeklyRakeback();
        break;
      case 'leaderboard-snapshot':
        await snapshotLeaderboard();
        break;
      case 'session-cleanup':
        await sessionCleanup();
        break;
      case 'stale-game-session-refund':
        await refundStaleGameSessions();
        break;
      case 'demo-user-cleanup':
        await cleanupDemoUsers();
        break;
      case 'game-stats-sync':
        await syncGameStats();
        break;
      case 'win-streak-check':
        await resetStaleWinStreaks();
        break;
      case 'db-backup':
        await dailyBackup();
        break;
      case 'reconciliation-check':
        await reconciliationCheck();
        break;
      case 'security-watchdog':
        await securityWatchdog();
        break;
      case 'retention-purge':
        await retentionPurge();
        break;
      case 'daily-checkin-reset':
      default:
        console.log(`[worker] ${job.name}`);
        break;
    }
  },
  { connection, concurrency: 1 }
);

// ── CRON REGISTRATION (BullMQ 6 — repeatable via queue.add) ────────────────
async function registerCrons() {
  const jobs: Array<[string, string]> = [
    ['weekly-rakeback', '1 0 * * 0'],
    ['leaderboard-snapshot', '59 23 * * *'],
    ['session-cleanup', '0 * * * *'],
    ['stale-game-session-refund', '15 * * * *'],
    ['demo-user-cleanup', '30 2 * * *'],
    ['game-stats-sync', '*/5 * * * *'],
    ['win-streak-check', '0 * * * *'],
    ['db-backup', '0 3 * * *'],
    ['reconciliation-check', '0 4 * * *'],
    ['daily-checkin-reset', '0 0 * * *'],
    // Daily, 01:00: pay referral agents their % of referred users' net spend.
    ['referral-commission', '0 1 * * *'],
    // Hourly: is anything wrong? (alerts are deduped inside the service)
    ['security-watchdog', '25 * * * *'],
    // Daily, just after the 03:00 backup: trim personal data past its window.
    ['retention-purge', '40 3 * * *'],
  ];
  for (const [name, cron] of jobs) {
    // BullMQ 6: job schedulers replace repeatable add()
    await queues.scheduled.upsertJobScheduler(name, { pattern: cron }, { name });
  }
  console.log('[worker] crons registered');
}

registerCrons().catch(console.error);
worker.on('completed', (job) => console.log(`[worker] ${job.name} completed`));
worker.on('failed', (job, err) =>
  console.error(`[worker] ${job?.name} failed:`, err.message)
);
console.log('[worker] listening on queue "scheduled"');
