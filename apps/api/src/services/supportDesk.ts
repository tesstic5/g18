// apps/api/src/services/supportDesk.ts — ticket list DTOs, unread, wait, attachment tokens.
import jwt from 'jsonwebtoken';
import { prisma } from '../db/prisma';
import { getJwtPrivateKey } from '../lib/jwt-keys';
import { JWT_ISSUER_ADMIN } from '../lib/jwt-claims';
import {
  isSupportCategory,
  supportCategoryFromSubject,
  supportSubject,
  type SupportCategoryId,
} from '@casino/shared';
import type {
  SenderType,
  SupportConversation,
  SupportMessage,
} from '../generated/prisma/client';

export const SUPPORT_ATTACHMENT_SCOPE = 'support-attachment';

export function resolveCategory(input: { category?: unknown; subject?: unknown }): {
  category: SupportCategoryId;
  subject: string;
} {
  if (isSupportCategory(input.category)) {
    return { category: input.category, subject: supportSubject(input.category) };
  }
  const subject =
    typeof input.subject === 'string' && input.subject.trim()
      ? input.subject.trim().slice(0, 120)
      : 'General';
  const category = supportCategoryFromSubject(subject);
  return {
    category,
    subject: subject === 'General' ? supportSubject(category) : subject,
  };
}

export function signSupportAttachment(objectKey: string): string {
  return jwt.sign(
    { scope: SUPPORT_ATTACHMENT_SCOPE, k: objectKey },
    getJwtPrivateKey(),
    { algorithm: 'RS256', expiresIn: '10m', issuer: JWT_ISSUER_ADMIN }
  );
}

export function attachmentViewUrl(objectKey: string | null | undefined): string | null {
  if (!objectKey) return null;
  if (
    objectKey.startsWith('http://') ||
    objectKey.startsWith('https://') ||
    objectKey.startsWith('/')
  )
    return objectKey;
  const st = signSupportAttachment(objectKey);
  return `/api/v1/support/attachments/${objectKey}?st=${encodeURIComponent(st)}`;
}

export function serializeMessage(m: SupportMessage) {
  return {
    id: m.id,
    senderType: m.senderType,
    body: m.body,
    attachmentUrl: m.attachmentUrl,
    attachmentViewUrl: attachmentViewUrl(m.attachmentUrl),
    createdAt: m.createdAt,
  };
}

type LastMsg = {
  body: string;
  senderType: SenderType;
  createdAt: Date;
  attachmentUrl: string | null;
};

export function waitMsFromLast(last: LastMsg | null, now = Date.now()): number {
  if (!last || last.senderType !== 'USER') return 0;
  return Math.max(0, now - last.createdAt.getTime());
}

export function unreadCount(opts: {
  last: LastMsg | null;
  lastReadAt: Date | null | undefined;
  from: SenderType;
}): number {
  if (!opts.last || opts.last.senderType !== opts.from) return 0;
  if (!opts.lastReadAt) return 1;
  return opts.last.createdAt.getTime() > opts.lastReadAt.getTime() ? 1 : 0;
}

export async function lastMessagesByConvo(
  ids: string[]
): Promise<Map<string, LastMsg>> {
  const map = new Map<string, LastMsg>();
  if (ids.length === 0) return map;
  const rows = await prisma.supportMessage.findMany({
    where: { conversationId: { in: ids } },
    orderBy: { createdAt: 'desc' },
    take: 2000,
    select: {
      conversationId: true,
      body: true,
      senderType: true,
      createdAt: true,
      attachmentUrl: true,
    },
  });
  for (const r of rows) {
    if (map.has(r.conversationId)) continue;
    map.set(r.conversationId, {
      body: r.body,
      senderType: r.senderType,
      createdAt: r.createdAt,
      attachmentUrl: r.attachmentUrl,
    });
  }
  return map;
}

export function previewOf(last: LastMsg | null): string {
  if (!last) return '';
  const text = last.body.trim();
  if (text) return text.slice(0, 140);
  if (last.attachmentUrl) return '📎 Photo';
  return '';
}

export function playerConvoDto(c: SupportConversation, last: LastMsg | null) {
  const category =
    (c.category as SupportCategoryId | null) ?? supportCategoryFromSubject(c.subject);
  return {
    id: c.id,
    subject: c.subject,
    category,
    status: c.status,
    referenceType: c.referenceType,
    referenceId: c.referenceId,
    updatedAt: c.updatedAt,
    createdAt: c.createdAt,
    lastMessage: last
      ? {
          body: previewOf(last),
          senderType: last.senderType,
          createdAt: last.createdAt,
        }
      : null,
    unreadCount: unreadCount({ last, lastReadAt: c.playerLastReadAt, from: 'ADMIN' }),
  };
}

export async function loadPlayerContext(userId: string) {
  const [user, wallet, deposits, withdrawals, fraudOpen] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        displayName: true,
        phone: true,
        status: true,
        kycStatus: true,
        createdAt: true,
      },
    }),
    prisma.wallet.findUnique({
      where: { userId },
      select: {
        realBalance: true,
        bonusBalance: true,
        giftedBalance: true,
        lockedBalance: true,
      },
    }),
    prisma.deposit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: {
        id: true,
        amount: true,
        status: true,
        referenceNumber: true,
        createdAt: true,
      },
    }),
    prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: {
        id: true,
        amount: true,
        netAmount: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.fraudSignal.count({ where: { userId, status: 'new' } }),
  ]);
  return {
    user,
    wallet: wallet
      ? {
          real: wallet.realBalance.toString(),
          bonus: wallet.bonusBalance.toString(),
          gifted: wallet.giftedBalance.toString(),
          locked: wallet.lockedBalance.toString(),
        }
      : { real: '0', bonus: '0', gifted: '0', locked: '0' },
    deposits: deposits.map((d) => ({
      id: d.id,
      amount: d.amount.toString(),
      status: d.status,
      referenceNumber: d.referenceNumber,
      createdAt: d.createdAt,
    })),
    withdrawals: withdrawals.map((w) => ({
      id: w.id,
      amount: w.amount.toString(),
      netAmount: w.netAmount.toString(),
      status: w.status,
      createdAt: w.createdAt,
    })),
    fraudOpen,
  };
}

export function assertOwnUploadKey(userId: string, key: string): boolean {
  return (
    key.startsWith(`deposits/${userId}/`) && !key.includes('..') && key.length < 500
  );
}
