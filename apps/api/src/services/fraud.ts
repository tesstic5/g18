// apps/api/src/services/fraud.ts — write + read side of FraudSignal (docs/20 §18).
//
// Detectors run on signup / login / deposit / withdrawal and are fail-open:
// fraud detection must never block a legitimate action. The admin panel is
// the only place a human reviews, ignores, or manually flags.
import { prisma } from '../db/prisma';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { hashFingerprint, type Fingerprint } from './auth';

export type FraudSignalType =
  | 'NEW_ACCOUNT_WITHDRAWAL'
  | 'MULTIPLE_ACCOUNTS_SAME_DEVICE'
  | 'MULTIPLE_ACCOUNTS_SAME_IP'
  | 'RAPID_WITHDRAWAL_AFTER_DEPOSIT'
  | 'LARGE_WITHDRAWAL'
  | 'WITHDRAWAL_TO_NEW_ACCOUNT'
  | 'SHARED_SENDER_ACCOUNT'
  | 'RAPID_DEPOSITS'
  | 'ADMIN_FLAG'
  // Account recovery console (routes/recovery.ts)
  | 'ACCOUNT_RECOVERY_REQUEST'
  | 'ACCOUNT_RECOVERY_APPROVED'
  | 'RECOVERY_FREEZE_OVERRIDE';

export type Severity = 'low' | 'medium' | 'high';

const DAY = 24 * 3600 * 1000;

/** Loopback / RFC1918 / link-local — never cluster accounts on these. */
export function isRoutableIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim().toLowerCase();
  if (!v || v === 'unknown' || v === '::1' || v === '127.0.0.1') return false;
  if (v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.'))
    return false;
  if (v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.')) return false;
  const m = v.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  return true;
}

export function clientIpCountry(headers: {
  [k: string]: string | string[] | undefined;
}): string | null {
  const raw =
    headers['cf-ipcountry'] ??
    headers['x-vercel-ip-country'] ??
    headers['x-country-code'];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase() ?? '';
  if (/^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1') return v;
  return null;
}

export function clientUserAgent(headers: {
  [k: string]: string | string[] | undefined;
}): string | null {
  const raw = headers['user-agent'];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return v ? v.slice(0, 512) : null;
}

/** Create a signal + push it to the admin live feed. Never throws. Dedupes
 *  the same (user, signal) pair inside 24h so a busy device doesn't flood. */
export async function raiseFraudSignal(
  userId: string,
  signal: FraudSignalType,
  severity: Severity,
  data: Record<string, unknown>,
  opts?: { dedupe?: boolean }
): Promise<void> {
  try {
    if (opts?.dedupe !== false) {
      const recent = await prisma.fraudSignal.findFirst({
        where: {
          userId,
          signal,
          createdAt: { gte: new Date(Date.now() - DAY) },
        },
        select: { id: true },
      });
      if (recent) return;
    }
    const notes =
      typeof data.notes === 'string' ? data.notes.trim().slice(0, 500) : undefined;
    await prisma.fraudSignal.create({
      data: {
        userId,
        signal,
        severity,
        data: data as never,
        status: 'new',
        notes: notes || undefined,
      },
    });
    emitAdmin('fraud-signal', {
      kind: 'fraud',
      at: Date.now(),
      userId: shortId(userId),
      signal,
      severity,
    });
  } catch (e) {
    console.error('[fraud] failed to record signal:', (e as Error).message);
  }
}

/**
 * Persist the device + login event, update last-seen IP/country, then run
 * same-device / same-IP detectors. Called from signup and login. Fail-open.
 */
export async function recordPlayerSession(opts: {
  userId: string;
  fingerprint?: Fingerprint | null;
  ip: string;
  headers: { [k: string]: string | string[] | undefined };
}): Promise<void> {
  try {
    const fp = opts.fingerprint ? hashFingerprint(opts.fingerprint) : null;
    const ip = (opts.ip || '').slice(0, 64) || 'unknown';
    const ipCountry = clientIpCountry(opts.headers);
    const userAgent =
      opts.fingerprint?.userAgent?.slice(0, 512) || clientUserAgent(opts.headers);
    const screen = opts.fingerprint?.screenRes?.slice(0, 32) ?? null;
    const timezone = opts.fingerprint?.timezone?.slice(0, 64) ?? null;
    const language = opts.fingerprint?.language?.slice(0, 16) ?? null;

    await prisma.user.update({
      where: { id: opts.userId },
      data: {
        lastLoginIp: ip,
        lastLoginCountry: ipCountry,
      },
    });

    await prisma.userLoginEvent.create({
      data: {
        userId: opts.userId,
        ip,
        ipCountry,
        userAgent,
        fingerprintHash: fp,
        timezone,
        language,
        screen,
      },
    });

    if (fp) {
      await prisma.userDevice.upsert({
        where: {
          userId_fingerprintHash: { userId: opts.userId, fingerprintHash: fp },
        },
        create: {
          userId: opts.userId,
          fingerprintHash: fp,
          userAgent,
          screen,
          timezone,
          language,
          firstIp: ip,
          lastIp: ip,
          ipCountry,
          loginCount: 1,
        },
        update: {
          lastIp: ip,
          ipCountry: ipCountry ?? undefined,
          userAgent: userAgent ?? undefined,
          screen: screen ?? undefined,
          timezone: timezone ?? undefined,
          language: language ?? undefined,
          lastSeenAt: new Date(),
          loginCount: { increment: 1 },
        },
      });
      await checkSameDevice(opts.userId, fp);
    }
    if (isRoutableIp(ip)) await checkSameIp(opts.userId, ip);
  } catch (e) {
    console.error('[fraud] session record failed:', (e as Error).message);
  }
}

async function checkSameDevice(userId: string, fingerprintHash: string): Promise<void> {
  const accountsOnDevice = await prisma.user.count({
    where: {
      OR: [{ fingerprintHash }, { devices: { some: { fingerprintHash } } }],
    },
  });
  if (accountsOnDevice >= 3) {
    await raiseFraudSignal(
      userId,
      'MULTIPLE_ACCOUNTS_SAME_DEVICE',
      accountsOnDevice >= 5 ? 'high' : 'medium',
      { accountsOnDevice, fingerprintHash: fingerprintHash.slice(0, 12) }
    );
  }
}

async function checkSameIp(userId: string, ip: string): Promise<void> {
  const since = new Date(Date.now() - 7 * DAY);
  const rows = await prisma.userLoginEvent.findMany({
    where: { ip, createdAt: { gte: since } },
    distinct: ['userId'],
    select: { userId: true },
  });
  const accountsOnIp = rows.length;
  if (accountsOnIp >= 8) {
    await raiseFraudSignal(userId, 'MULTIPLE_ACCOUNTS_SAME_IP', 'medium', {
      accountsOnIp,
      ip,
      windowDays: 7,
    });
  }
}

/** Signup: flag when several accounts share one device fingerprint. */
export async function checkSignupFraud(
  userId: string,
  fingerprintHash: string
): Promise<void> {
  if (!fingerprintHash) return;
  try {
    await checkSameDevice(userId, fingerprintHash);
  } catch (e) {
    console.error('[fraud] signup check failed:', (e as Error).message);
  }
}

/** Deposit-time: shared sender account across users, burst of requests. */
export async function checkDepositFraud(
  userId: string,
  input: { senderAccount?: string | null; amount: number; depositId: string }
): Promise<void> {
  try {
    const sender = (input.senderAccount || '').trim();
    if (sender.length >= 6) {
      const others = await prisma.deposit.findMany({
        where: {
          senderAccount: sender,
          userId: { not: userId },
        },
        distinct: ['userId'],
        select: { userId: true },
        take: 10,
      });
      if (others.length >= 1) {
        await raiseFraudSignal(userId, 'SHARED_SENDER_ACCOUNT', 'high', {
          senderAccount: sender,
          otherAccounts: others.length,
          depositId: input.depositId,
          amount: input.amount,
        });
      }
    }
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    const burst = await prisma.deposit.count({
      where: {
        userId,
        createdAt: { gte: hourAgo },
        status: { in: ['PENDING', 'APPROVED', 'COMPLETED'] },
      },
    });
    if (burst >= 3) {
      await raiseFraudSignal(userId, 'RAPID_DEPOSITS', 'medium', {
        depositsLastHour: burst,
        amount: input.amount,
      });
    }
  } catch (e) {
    console.error('[fraud] deposit check failed:', (e as Error).message);
  }
}

/**
 * Withdrawal-time checks (docs/20 §18):
 *  • brand-new account cashing out
 *  • deposit → withdrawal turnaround with little or no play
 *  • unusually large amount vs. the player's own history
 *  • payout account added in the last 24h
 */
export async function checkWithdrawalFraud(
  userId: string,
  amount: number,
  payoutAccountAgeMs: number
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    if (!user) return;

    const accountAgeMs = Date.now() - user.createdAt.getTime();

    if (accountAgeMs < 2 * DAY) {
      await raiseFraudSignal(userId, 'NEW_ACCOUNT_WITHDRAWAL', 'high', {
        accountAgeHours: Math.round(accountAgeMs / 3600_000),
        amount,
      });
    }

    if (payoutAccountAgeMs < DAY) {
      await raiseFraudSignal(userId, 'WITHDRAWAL_TO_NEW_ACCOUNT', 'medium', {
        payoutAccountAgeHours: Math.round(payoutAccountAgeMs / 3600_000),
        amount,
      });
    }

    const [recentDeposit, wagered] = await Promise.all([
      prisma.deposit.findFirst({
        where: {
          userId,
          status: { in: ['APPROVED', 'COMPLETED'] },
          createdAt: { gte: new Date(Date.now() - DAY) },
        },
        orderBy: { createdAt: 'desc' },
        select: { amount: true },
      }),
      prisma.gameRound.aggregate({
        where: { userId, demo: false, createdAt: { gte: new Date(Date.now() - DAY) } },
        _sum: { betAmount: true },
      }),
    ]);
    const deposited = Number(recentDeposit?.amount ?? 0);
    const totalWagered = Number(wagered._sum.betAmount ?? 0);
    if (deposited > 0 && totalWagered < deposited * 0.2) {
      await raiseFraudSignal(userId, 'RAPID_WITHDRAWAL_AFTER_DEPOSIT', 'high', {
        depositedLast24h: deposited,
        wageredLast24h: totalWagered,
        amount,
      });
    }

    const history = await prisma.withdrawal.aggregate({
      where: { userId, status: 'COMPLETED' },
      _avg: { amount: true },
      _count: true,
    });
    const avg = Number(history._avg.amount ?? 0);
    if (history._count >= 3 && avg > 0 && amount > avg * 5) {
      await raiseFraudSignal(userId, 'LARGE_WITHDRAWAL', 'medium', {
        amount,
        previousAverage: Math.round(avg * 100) / 100,
      });
    }
  } catch (e) {
    console.error('[fraud] withdrawal check failed:', (e as Error).message);
  }
}

export interface LinkedAccount {
  id: string;
  phone: string;
  displayName: string | null;
  status: string;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  lastLoginCountry: string | null;
}

export interface UserRiskProfile {
  fingerprintHash: string | null;
  lastLoginIp: string | null;
  lastLoginCountry: string | null;
  devices: Array<{
    id: string;
    fingerprintHash: string;
    userAgent: string | null;
    screen: string | null;
    timezone: string | null;
    language: string | null;
    firstIp: string | null;
    lastIp: string | null;
    ipCountry: string | null;
    loginCount: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
  }>;
  logins: Array<{
    id: string;
    ip: string;
    ipCountry: string | null;
    userAgent: string | null;
    fingerprintHash: string | null;
    timezone: string | null;
    language: string | null;
    screen: string | null;
    createdAt: Date;
  }>;
  linkedByDevice: LinkedAccount[];
  linkedByIp: LinkedAccount[];
  signals: Array<{
    id: string;
    signal: string;
    severity: string;
    status: string;
    data: unknown;
    notes: string | null;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
  }>;
}

const LINKED_SELECT = {
  id: true,
  phone: true,
  displayName: true,
  status: true,
  lastLoginAt: true,
  lastLoginIp: true,
  lastLoginCountry: true,
} as const;

export async function getUserRiskProfile(userId: string): Promise<UserRiskProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      fingerprintHash: true,
      lastLoginIp: true,
      lastLoginCountry: true,
    },
  });
  const [devices, logins, signals] = await Promise.all([
    prisma.userDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      take: 20,
    }),
    prisma.userLoginEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    prisma.fraudSignal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ]);

  const fps = [
    ...new Set(
      [user?.fingerprintHash, ...devices.map((d) => d.fingerprintHash)].filter(
        (x): x is string => !!x
      )
    ),
  ];
  const ips = [
    ...new Set(
      [
        user?.lastLoginIp,
        ...devices.map((d) => d.lastIp),
        ...logins.map((l) => l.ip),
      ].filter(isRoutableIp)
    ),
  ] as string[];

  const [linkedByDevice, linkedByIp] = await Promise.all([
    fps.length
      ? prisma.user.findMany({
          where: {
            id: { not: userId },
            OR: [
              { fingerprintHash: { in: fps } },
              { devices: { some: { fingerprintHash: { in: fps } } } },
            ],
          },
          select: LINKED_SELECT,
          take: 25,
        })
      : Promise.resolve([]),
    ips.length
      ? prisma.user.findMany({
          where: {
            id: { not: userId },
            OR: [
              { lastLoginIp: { in: ips } },
              { devices: { some: { lastIp: { in: ips } } } },
            ],
          },
          select: LINKED_SELECT,
          take: 25,
        })
      : Promise.resolve([]),
  ]);

  return {
    fingerprintHash: user?.fingerprintHash ?? null,
    lastLoginIp: user?.lastLoginIp ?? null,
    lastLoginCountry: user?.lastLoginCountry ?? null,
    devices,
    logins,
    linkedByDevice,
    linkedByIp,
    signals,
  };
}
