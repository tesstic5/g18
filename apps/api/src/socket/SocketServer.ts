// apps/api/src/socket/SocketServer.ts — handshake auth, rooms, cleanup, aviator mutex.
// Canonical: v4 SOCKET.IO EVENT SPEC + docs/10 rules + docs/20 rule 6 + docs/22 §ws.
import { Server, Socket } from 'socket.io';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import jwt from 'jsonwebtoken';
import { prisma } from '../db/prisma';
import { redis, keys } from '../db/redis';
import { rateLimit, responsiblePlayGuard } from '../middleware';
import { getJwtPublicKey } from '../lib/jwt-keys';
import {
  JWT_ISSUER_USER,
  JWT_ISSUER_ADMIN_WS,
  JWT_ROLE_USER,
  JWT_ROLE_ADMIN_WS,
} from '../lib/jwt-claims';
import { CrashRoundManager } from '../engine/games/CrashRoundManager';
import { WingoRoundManager } from '../engine/games/WingoRoundManager';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { maskUsername } from '@casino/game-core/mask';
import { notifyUser } from '../services/notify';
import { serializeMessage, assertOwnUploadKey } from '../services/supportDesk';
import { MinioClient } from '../db/minio';
import { z } from 'zod';
import { amountSchema } from '@casino/shared/validators';
import { assertStakeWithinLimits } from '../services/stakeLimits';

/**
 * C-3: the socket bet path had no schema at all — `amountSchema` only ever ran
 * on the HTTP routes. Reusing it here means a negative, zero, NaN, Infinity or
 * over-precision stake is rejected before it can reach a wallet.
 */
export const wingoBetSchema = z.object({
  amount: amountSchema,
  requestId: z.string().uuid(),
  choice: z.union([
    z.number().int().min(0).max(9),
    z.enum(['green', 'red', 'violet', 'big', 'small']),
  ]),
});

interface SocketUser {
  userId: string;
  adminId?: string;
  role: 'guest' | 'user' | 'admin';
}
const roomMembers = new Map<string, Set<string>>(); // room -> socketIds

export const crashManagers = {
  aviator: new CrashRoundManager('aviator'),
  'crash-x': new CrashRoundManager('crash-x'),
};
// D-107: FOUR lottery times run continuously — 30s / 1min / 3min / 5min.
// All are the same WinGo game, just different round lengths. Each manager's
// loop chains forever whether or not anyone is betting.
export const wingoManagers: Record<'30s' | '60s' | '180s' | '300s', WingoRoundManager> =
  {
    '30s': new WingoRoundManager(30),
    '60s': new WingoRoundManager(60),
    '180s': new WingoRoundManager(180),
    '300s': new WingoRoundManager(300),
  };

/** Last observed count of connected authenticated users (presence gauge). */
export let activeSocketUsers = 0;

export function initializeSocketServer(io: Server) {
  // v1.3.8: register the io handle for lib/admin-feed.ts — until now it was
  // only ever set by the TEST suite, so EVERY emitAdmin() call silently
  // no-oped in production and admins never saw deposit/withdrawal pings.
  // Registering here is what makes admin toasts + sidebar badges real.
  const g = globalThis as { __io?: Server };
  if (!g.__io) g.__io = io;
  // start shared-round loops (single-process; HA: only one instance runs loops — see docs/22 §redis-ha)
  void crashManagers['aviator'].start(io);
  void crashManagers['crash-x'].start(io);
  for (const m of Object.values(wingoManagers)) void m.start(io);
  // auth + ws rate limit on handshake (docs/14: 5 conn/min/IP)
  io.use(async (socket, next) => {
    try {
      await rateLimit(
        { headers: {}, ip: socket.handshake.address, method: 'GET' } as never,
        'ws',
        socket.handshake.address
      );
    } catch (rlErr) {
      // H-16: the deliberate 429 was swallowed, making the ws connection limit
      // a no-op. Only Redis-unavailability is tolerated (fail-open); the
      // intended GEN_RATE_LIMITED rejection now genuinely rejects.
      const code = (rlErr as { code?: string })?.code;
      if (code === ERROR_CODES.GEN_RATE_LIMITED) {
        next(new Error('rate-limited'));
        return;
      }
    }
    const token = socket.handshake.auth?.token as string;
    // H-16: access tokens in the QUERY STRING leak into proxy/access logs —
    // refuse them outright; the client must use the auth map.
    if (socket.handshake.query?.token) {
      next(new Error('token must not be sent in the URL — use auth.token'));
      return;
    }
    // D-099: guests (no token) may connect to WATCH live rounds — crash/wingo
    // broadcast globally, so anonymous viewers see the countdown → flight →
    // crash exactly like a real casino. They get NO user rooms and can't bet
    // (betting still requires REST auth). Invalid tokens are still rejected.
    if (token) {
      try {
        const payload = jwt.verify(token, getJwtPublicKey(), {
          algorithms: ['RS256'],
        }) as { sub: string; role?: string; iss?: string };

        if (payload.iss === JWT_ISSUER_USER && payload.role === JWT_ROLE_USER) {
          const user = await prisma.user.findUnique({
            where: { id: payload.sub },
            select: { id: true, status: true, selfExcludedUntil: true },
          });
          if (
            !user ||
            user.status !== 'ACTIVE' ||
            (user.selfExcludedUntil && user.selfExcludedUntil > new Date())
          ) {
            throw new Error('inactive user');
          }
          Object.assign(socket.data as SocketUser, {
            userId: user.id,
            role: 'user' as const,
          });
          await redis.set(`ws:user:${user.id}`, socket.id, 'EX', 60 * 60 * 24);
          next();
          return;
        }

        if (payload.iss === JWT_ISSUER_ADMIN_WS && payload.role === JWT_ROLE_ADMIN_WS) {
          const admin = await prisma.adminUser.findUnique({
            where: { id: payload.sub },
            select: { id: true },
          });
          if (!admin) throw new Error('admin not found');
          Object.assign(socket.data as SocketUser, {
            userId: '',
            adminId: admin.id,
            role: 'admin' as const,
          });
          next();
          return;
        }

        throw new Error('wrong token role');
      } catch {
        next(new Error('unauthorized'));
      }
    } else {
      Object.assign(socket.data as SocketUser, { userId: '', role: 'guest' as const });
      next();
    }
  });

  io.on('connection', (socket) => {
    const socketUser = socket.data as SocketUser;
    const userId = socketUser.userId;
    if (socketUser.role === 'admin') socket.join('admins');

    // D-083: join the user's PRIVATE room so server→user events actually
    // arrive: `user:{id}` receives balance:update, notification:new, and
    // deposit:status. (Before this, io.to(`user:${id}`) went nowhere — users
    // never got real-time notifications or balance updates.) Guests (D-099)
    // have no userId → no private room, but still receive global broadcasts.
    if (userId) socket.join(`user:${userId}`);

    // H-16: guest-event payloads were unvalidated — a client could join
    // arbitrary rooms (e.g. another user's helpdesk) or flood presence. Joins
    // are limited to known game slugs and throttled per socket.
    const joinCounts = new Map<string, number>();
    socket.on('game:join', (payload: { slug?: unknown }) => {
      const slug = typeof payload?.slug === 'string' ? payload.slug : '';
      if (!/^[a-z0-9-]{2,32}$/.test(slug)) return;
      const now = Date.now();
      const last = joinCounts.get('t') ?? 0;
      if (now - last < 500) return; // max ~2 joins/sec/socket
      joinCounts.set('t', now);
      const room = `game:${slug}`;
      socket.join(room);
      addMember(room, socket.id);
    });
    socket.on('game:leave', (payload: { slug: string }) => {
      socket.leave(`game:${payload.slug}`);
      removeMember(`game:${payload.slug}`, socket.id);
    });
    socket.on(
      'seed:change-client',
      async (payload: { newClientSeed: string }, ack?: (r: unknown) => void) => {
        // Guests have no seed pair — an unauthenticated call used to run
        // updateMany({ userId: '' }). Also enforce the same 128-char bound the
        // REST endpoint applies.
        if (!userId) {
          ack?.({ ok: false, error: 'Not authenticated' });
          return;
        }
        const seed = String(payload?.newClientSeed ?? '').trim();
        if (!seed || seed.length > 128) {
          ack?.({ ok: false, error: 'Invalid client seed' });
          return;
        }
        try {
          await prisma.seedPair.updateMany({
            where: { userId, status: 'ACTIVE' },
            data: { clientSeed: seed },
          });
          ack?.({ ok: true });
        } catch (e) {
          ack?.({ ok: false, error: (e as Error).message });
        }
      }
    );
    socket.on(
      'chat:join',
      async (payload: { conversationId: string }, ack?: (r: unknown) => void) => {
        // D-079: join the conversation room so messages echo in real time.
        // Players: own conversation only. Admins (permChat socket): any ticket.
        try {
          const convoId = String(payload?.conversationId ?? '');
          if (!convoId) {
            ack?.({ ok: false, error: 'Conversation not found' });
            return;
          }
          if (socketUser.role === 'admin') {
            const convo = await prisma.supportConversation.findUnique({
              where: { id: convoId },
              select: { id: true },
            });
            if (!convo) {
              ack?.({ ok: false, error: 'Conversation not found' });
              return;
            }
            socket.join(`chat:${convoId}`);
            ack?.({ ok: true });
            return;
          }
          const convo = await prisma.supportConversation.findFirst({
            where: { id: convoId, userId },
            select: { id: true },
          });
          if (!convo) {
            ack?.({ ok: false, error: 'Conversation not found' });
            return;
          }
          socket.join(`chat:${convoId}`);
          ack?.({ ok: true });
        } catch (e) {
          ack?.({ ok: false, error: (e as Error).message });
        }
      }
    );
    // M-06 throttle state (per socket connection, in-memory)
    let chatSendWindow: number[] = [];
    socket.on(
      'chat:send',
      async (
        payload: {
          conversationId: string;
          message?: string;
          attachmentObjectKey?: string;
        },
        ack?: (r: unknown) => void
      ) => {
        try {
          const nowMs = Date.now();
          chatSendWindow = chatSendWindow.filter((t) => nowMs - t < 10_000);
          if (chatSendWindow.length >= 8) {
            ack?.({ ok: false, error: 'Slow down — too many messages' });
            return;
          }
          chatSendWindow.push(nowMs);
          const body = String(payload?.message ?? '')
            .slice(0, 2000)
            .trim();
          const attachKey =
            typeof payload?.attachmentObjectKey === 'string'
              ? payload.attachmentObjectKey.trim()
              : '';
          if (!body && !attachKey) {
            ack?.({ ok: false, error: 'Message is required' });
            return;
          }
          const convoId = String(payload?.conversationId ?? '');
          const isAdmin = socketUser.role === 'admin' && !!socketUser.adminId;
          const convo = isAdmin
            ? await prisma.supportConversation.findUnique({
                where: { id: convoId },
                select: { id: true, status: true, userId: true },
              })
            : await prisma.supportConversation.findFirst({
                where: { id: convoId, userId },
                select: { id: true, status: true, userId: true },
              });
          if (!convo) {
            ack?.({ ok: false, error: 'Conversation not found' });
            return;
          }
          if (convo.status === 'CLOSED') {
            ack?.({ ok: false, error: 'This conversation is closed' });
            return;
          }
          let attachmentUrl: string | null = null;
          if (attachKey) {
            if (isAdmin) {
              ack?.({ ok: false, error: 'Agents send text — players attach photos' });
              return;
            }
            if (!assertOwnUploadKey(userId, attachKey)) {
              ack?.({ ok: false, error: 'Invalid attachment' });
              return;
            }
            const bucket = process.env.S3_BUCKET_DEPOSITS || 'deposit-proofs';
            const stat = await MinioClient.statObject(bucket, attachKey).catch(
              () => null
            );
            if (!stat) {
              ack?.({ ok: false, error: 'Photo not found — upload it again' });
              return;
            }
            attachmentUrl = attachKey;
          }
          const msg = await prisma.supportMessage.create({
            data: isAdmin
              ? {
                  conversationId: convoId,
                  senderType: 'ADMIN',
                  senderId: socketUser.adminId!,
                  userId: null,
                  body,
                }
              : {
                  conversationId: convoId,
                  senderType: 'USER',
                  userId,
                  body,
                  attachmentUrl,
                },
          });
          await prisma.supportConversation.update({
            where: { id: convoId },
            data: isAdmin
              ? { updatedAt: new Date(), adminLastReadAt: new Date() }
              : { updatedAt: new Date(), playerLastReadAt: new Date() },
          });
          const packed = serializeMessage(msg);
          io.to(`chat:${convoId}`).emit('chat:message', {
            conversationId: convoId,
            message: packed,
          });
          ack?.({ ok: true, message: packed });
          if (isAdmin) {
            if (convo.userId)
              void notifyUser(
                convo.userId,
                'New support reply 💬',
                (body || 'Photo').slice(0, 140),
                'support',
                '/support'
              );
          } else {
            emitAdmin('chat-message', {
              conversationId: convoId,
              userId: shortId(userId),
              message: (body || '📎 Photo').slice(0, 120),
              at: Date.now(),
            });
          }
        } catch (e) {
          ack?.({ ok: false, error: (e as Error).message });
        }
      }
    );
    let lastTypingEmit = 0;
    socket.on('chat:typing', (payload: { conversationId?: unknown }) => {
      const conversationId = String(payload?.conversationId ?? '');
      const isAdmin = socketUser.role === 'admin';
      if ((!userId && !isAdmin) || !/^[a-zA-Z0-9-]{2,64}$/.test(conversationId)) return;
      const now = Date.now();
      if (now - lastTypingEmit < 1500) return;
      lastTypingEmit = now;
      socket.to(`chat:${conversationId}`).emit('chat:typing', {
        conversationId,
        userId: isAdmin ? 'admin' : userId,
        from: isAdmin ? 'ADMIN' : 'USER',
      });
    });

    // ── AVIATOR/CRASHX CASHOUT — exact race resolution (docs/20 rule 6) ──
    socket.on(
      'aviator:cashout',
      async (payload: { roundId: string }, ack?: (r: unknown) => void) => {
        await handleCashout(socket, payload.roundId, 'aviator', ack, io);
      }
    );
    socket.on(
      'crash-x:cashout',
      async (payload: { roundId: string }, ack?: (r: unknown) => void) => {
        await handleCashout(socket, payload.roundId, 'crash-x', ack, io);
      }
    );

    // ── WINGO BET (socket per v4 spec) — D-107: pick the lottery time ─────
    socket.on(
      'wingo:bet',
      async (
        payload: {
          roundId?: string;
          durationSec?: number;
          choice: string | number;
          amount: number;
          requestId: string;
        },
        ack?: (r: unknown) => void
      ) => {
        try {
          // C-3 (money-minting). This handler had NO authentication and NO amount
          // validation, and it bypasses the HTTP `amountSchema` entirely.
          //
          // A negative amount inverted every check on the way down:
          //   `spendable < amount`  ->  50 < -1000  ->  false, so the guard passed
          //   deductBet() applies amount.neg() as `{ increment: delta }`
          //   -> increment: +1000, balance 50 becomes 1050
          // and it wrote an ordinary-looking BET row, so it would not even stand
          // out in a payout report. Verified against the real code path.
          //
          // Three independent fixes, because this is the worst class of bug there
          // is: authenticate, validate the amount, and validate the choice.
          if (!userId) {
            ack?.({ success: false, message: 'Log in to place a bet' });
            return;
          }
          // Socket bets must obey the same account status, self-exclusion, and
          // daily-loss limits as HTTP bets. A long-lived socket previously bypassed
          // an exclusion/suspension until its JWT expired.
          await responsiblePlayGuard(userId);
          const parsedAmount = wingoBetSchema.safeParse({
            amount: payload.amount,
            choice: payload.choice,
            requestId: payload.requestId,
          });
          if (!parsedAmount.success) {
            ack?.({
              success: false,
              message: parsedAmount.error.issues[0]?.message ?? 'Invalid bet',
            });
            return;
          }
          const durationSec = payload.durationSec ?? 30;
          const dur =
            durationSec === 60
              ? '60s'
              : durationSec === 180
                ? '180s'
                : durationSec === 300
                  ? '300s'
                  : '30s';
          const manager = wingoManagers[dur];
          if (!manager) {
            ack?.({ success: false, message: 'That round length is not available' });
            return;
          }
          // H-1 also applies over the socket — the HTTP route is not the only way in.
          try {
            await assertStakeWithinLimits('wingo', parsedAmount.data.amount, false);
          } catch (e) {
            ack?.({ success: false, message: (e as Error).message });
            return;
          }
          const res = await manager.placeBet(
            userId,
            parsedAmount.data.choice,
            parsedAmount.data.amount,
            parsedAmount.data.requestId,
            payload.roundId
          );
          ack?.({
            success: res.ok,
            roundId: res.roundId,
            message: res.message,
            newBalance: res.newBalance,
          });
        } catch (e) {
          ack?.({ success: false, message: (e as Error).message });
        }
      }
    );

    // ── CLEANUP on disconnect (docs/22 §ws — room sweep, presence) ───────
    socket.on('disconnect', () => {
      for (const room of socket.rooms) removeMember(room, socket.id);
      // Guests have no userId — deleting `ws:user:` (empty suffix) was a no-op
      // on a bogus key.
      if (userId) void redis.del(`ws:user:${userId}`).catch(() => {});
    });
  });

  // Heartbeat/presence gauge (docs/20 §17).
  // Uses SCAN, not KEYS: KEYS blocks the whole Redis server for the duration of
  // the sweep, which on a large keyspace stalls every bet/session command.
  setInterval(() => {
    void (async () => {
      try {
        const prefix = process.env.REDIS_KEY_PREFIX || 'casino:';
        let cursor = '0';
        let count = 0;
        do {
          const [next, batch] = await redis.scan(
            cursor,
            'MATCH',
            `${prefix}ws:user:*`,
            'COUNT',
            500
          );
          cursor = next;
          count += batch.length;
        } while (cursor !== '0');
        activeSocketUsers = count;
      } catch {
        /* presence is observational — never throw from the heartbeat */
      }
    })();
  }, 30_000);
}

function addMember(room: string, socketId: string) {
  const set = roomMembers.get(room) ?? new Set<string>();
  set.add(socketId);
  roomMembers.set(room, set);
}
function removeMember(room: string, socketId: string) {
  const set = roomMembers.get(room);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) roomMembers.delete(room); // empty rooms released (no leak)
}

/** Cashout handler shared by aviator + crash-x (Redis-timestamp mutex, docs/20 rule 6). */
async function handleCashout(
  socket: Socket,
  roundId: string,
  slug: 'aviator' | 'crash-x',
  ack?: (r: unknown) => void,
  io?: Server
) {
  const userId = (socket.data as SocketUser).userId;
  try {
    if (!userId) {
      ack?.({ success: false, message: 'Log in to cash out' });
      return;
    }
    // 'current' → resolve to the live round (client reconnected mid-round)
    if (roundId === 'current') {
      const raw = await redis.get(keys.crashRound(slug));
      const state = raw ? (JSON.parse(raw) as { roundId: string }) : null;
      if (state) roundId = state.roundId;
    }
    const receivedAt = Date.now(); // server receive time — never client time
    const result = await crashManagers[slug].cashOut(userId, roundId, receivedAt);
    if (!result.success) {
      ack?.({
        success: false,
        code: 'GAME_006',
        message: 'Too late — round crashed or already cashed out',
      });
      return;
    }
    ack?.({ ...result });
    // Mask the DISPLAY NAME, not the raw user id (which leaked cuid fragments).
    let label = `Player${userId.slice(-4)}`;
    try {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true },
      });
      if (u?.displayName) label = u.displayName;
    } catch {
      /* fall back to the pseudonym */
    }
    io?.to(`game:${slug}`).emit(`${slug}:player-cashout`, {
      userId_masked: maskUsername(label),
      amount: Number(result.payout),
      at: result.multiplier,
    });
  } catch (e) {
    ack?.({ success: false, message: (e as Error).message });
  }
}

// maskUsername lives in @casino/game-core/mask — this file used to carry a
// verbatim duplicate (a third copy also existed in routes/games.ts).
export { maskUsername } from '@casino/game-core/mask';
