// apps/api/src/routes/auth.ts — signup/login/logout/refresh/me (docs/19 §4 + docs/14)
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { loginSchema, signupSchema } from '@casino/shared/validators';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { AppError, ok } from '../lib/core';
import { getJwtPublicKey } from '../lib/jwt-keys';
import { normalizePhone } from '@casino/shared/utils/phone';
import { authMiddleware, rateLimitFactory } from '../middleware';
import { JWT_ISSUER_REFRESH } from '../lib/jwt-claims';
import * as authService from '../services/auth';
import { prisma } from '../db/prisma';
import { getNumericSetting, getSetting } from '../services/settings';
import { notifyUser } from '../services/notify';
import { checkPassword } from '../services/securityPolicy';
import bcrypt from 'bcrypt';
import { emitAdmin, shortId } from '../lib/admin-feed';
import { maskPhone } from '@casino/game-core/mask';
import { checkSignupFraud, recordPlayerSession } from '../services/fraud';
import {
  mintCsrf,
  ensureCsrf,
  clearCsrfCookie,
  PLAYER_CSRF_MAX_AGE,
} from '../lib/csrf';
import { cookieSecureFor } from '../lib/cookies';

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/signup — 3/hour/IP (docs/14)
  app.post(
    '/signup',
    { preHandler: [rateLimitFactory('signup', (r) => r.ip)] },
    async (request, reply) => {
      // The `registration_open` kill-switch is exposed in the admin panel but was
      // never enforced — turning it OFF did nothing and new accounts kept being
      // created. Operators need this to actually work (incident response, KYC
      // pauses, closing signups in a restricted region).
      if (!(await getSetting<boolean>('registration_open'))) {
        throw new AppError(
          ERROR_CODES.GEN_MAINTENANCE,
          403,
          'New registrations are temporarily closed. Please check back soon.'
        );
      }
      const parsed = signupSchema.parse(request.body);
      const phone = normalizePhone(parsed.phone);
      if (!phone)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Enter a valid Pakistani mobile number (e.g. 0300 1234567)'
        );
      const { accessToken, refreshToken, referralApplied } = await authService.signup({
        ...parsed,
        phone,
      });
      setAuthCookies(request, reply, refreshToken);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
      emitAdmin('new-signup', {
        kind: 'signup',
        at: Date.now(),
        userId: shortId(user.id),
        phone: maskPhone(user.phone),
      });
      // Multi-account-per-device detection (fire-and-forget).
      void recordPlayerSession({
        userId: user.id,
        fingerprint: parsed.fingerprint,
        ip: request.ip,
        headers: request.headers,
      });
      if (user.fingerprintHash) void checkSignupFraud(user.id, user.fingerprintHash);
      const csrfToken = mintCsrf(reply, PLAYER_CSRF_MAX_AGE, request);
      return ok(
        {
          accessToken,
          csrfToken,
          // false when the player arrived with an invite code we could not
          // match — they are registered anyway, and the UI tells them the
          // invite was not applied rather than blocking the signup.
          referralApplied,
          user: { id: user.id, phone: user.phone, displayName: user.displayName },
        },
        request.requestId!
      );
    }
  );

  // POST /auth/login — 5/15min/IP
  app.post(
    '/login',
    { preHandler: [rateLimitFactory('login', (r) => r.ip)] },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const phone = normalizePhone(body.phone);
      if (!phone)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Enter a valid Pakistani mobile number (e.g. 0300 1234567)'
        );
      const { accessToken, refreshToken } = await authService.login(
        phone,
        body.password,
        body.fingerprint
      );
      setAuthCookies(request, reply, refreshToken);
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
      void recordPlayerSession({
        userId: user.id,
        fingerprint: body.fingerprint,
        ip: request.ip,
        headers: request.headers,
      });
      const csrfToken = mintCsrf(reply, PLAYER_CSRF_MAX_AGE, request);
      return ok(
        {
          accessToken,
          csrfToken,
          user: { id: user.id, phone: user.phone, displayName: user.displayName },
        },
        request.requestId!
      );
    }
  );

  // POST /auth/refresh-token — rotation + family invalidation (docs/14)
  app.post('/refresh-token', async (request, reply) => {
    const refresh = request.cookies?.refresh_token;
    if (!refresh)
      throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401, 'No refresh token');
    const { accessToken, refreshToken } = await authService.refreshTokens(refresh);
    setAuthCookies(request, reply, refreshToken);
    return ok({ accessToken }, request.requestId!);
  });

  // POST /auth/logout
  app.post('/logout', async (request, reply) => {
    let family: string | undefined;
    if (request.cookies?.refresh_token) {
      try {
        const payload = jwt.verify(request.cookies.refresh_token, getJwtPublicKey(), {
          algorithms: ['RS256'],
          issuer: JWT_ISSUER_REFRESH,
        }) as { fam: string };
        family = payload.fam;
      } catch {
        /* expired — still clear cookies */
      }
    }
    await authService.logout(family);
    reply.clearCookie('refresh_token', { path: '/api/v1/auth' });
    clearCsrfCookie(reply);
    return ok({ loggedOut: true }, request.requestId!);
  });

  // ── POST /auth/change-password (security hardening) ─────────────────────
  // Until now a player had NO way to change their password: only signup and the
  // admin "create manager" path ever hashed one. The only recovery was a manual
  // database edit — or the agent-mediated recovery console added earlier.
  //
  // Requires the CURRENT password (a stolen session alone must not be able to
  // take the account over), enforces the same policy as signup, refuses reuse
  // of the last N passwords, and revokes every OTHER session while keeping the
  // caller signed in.
  app.post(
    '/change-password',
    { preHandler: [authMiddleware, rateLimitFactory('passwordChange', (r) => r.user!.id)] },
    async (request, reply) => {
      const body = request.body as { currentPassword?: string; newPassword?: string } | undefined;
      const currentPassword = String(body?.currentPassword ?? '');
      const newPassword = String(body?.newPassword ?? '');
      if (!currentPassword || !newPassword)
        throw new AppError(
          ERROR_CODES.GEN_VALIDATION_ERROR,
          422,
          'Enter your current password and a new one'
        );

      const userId = request.user!.id;
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, phone: true, displayName: true, passwordHash: true },
      });
      if (!(await bcrypt.compare(currentPassword, user.passwordHash)))
        throw new AppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401, 'Your current password is incorrect');

      const [policy, historyDepth] = await Promise.all([
        authService.loadPasswordPolicy(),
        getNumericSetting('password_history_depth', 3, { min: 0 }),
      ]);
      const check = checkPassword(newPassword, {
        ...policy,
        phone: user.phone,
        displayName: user.displayName,
      });
      if (!check.ok) throw new AppError(check.code ?? ERROR_CODES.AUTH_PASSWORD_WEAK, 422, check.reason!);
      if (await authService.isPasswordReused(userId, newPassword, historyDepth))
        throw new AppError(
          ERROR_CODES.AUTH_PASSWORD_REUSED,
          422,
          `You have used this password before — pick one you have not used in your last ${historyDepth} passwords`
        );

      const passwordHash = await bcrypt.hash(newPassword, 12);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      });
      await authService.recordPasswordHistory(userId, user.passwordHash, historyDepth);
      await authService.recordPasswordHistory(userId, passwordHash, historyDepth);

      // Revoke everything, then hand THIS session a fresh pair so the player is
      // not signed out of the device they are standing at.
      const revoked = await authService.revokeAllSessions(userId, 'password_changed');
      const tokens = await authService.issueTokens(userId);
      setAuthCookies(request, reply, tokens.refreshToken);

      const csrfToken = ensureCsrf(request, reply, PLAYER_CSRF_MAX_AGE);
      await notifyUser(
        userId,
        'Password changed',
        'Your password was changed and all other devices were signed out. If this was not you, contact support immediately.',
        'security',
        '/profile'
      );
      emitAdmin('password-changed', { userId: shortId(userId), at: Date.now() });
      return ok(
        { ok: true, sessionsRevoked: revoked, accessToken: tokens.accessToken, csrfToken },
        request.requestId!
      );
    }
  );

  // ── POST /auth/logout-all (security hardening) ──────────────────────────
  // "Someone else is in my account" had no answer: a player could clear their
  // own cookies but every other device kept its refresh family. This kills all
  // of them.
  app.post('/logout-all', { preHandler: [authMiddleware] }, async (request, reply) => {
    const revoked = await authService.revokeAllSessions(request.user!.id, 'logout_all');
    reply.clearCookie('refresh_token', { path: '/api/v1/auth' });
    clearCsrfCookie(reply);
    await notifyUser(
      request.user!.id,
      'Signed out everywhere',
      'Every device was signed out of your account. If this was not you, change your password immediately.',
      'security',
      '/profile'
    );
    emitAdmin('logout-all', { userId: shortId(request.user!.id), revoked, at: Date.now() });
    return ok({ ok: true, sessionsRevoked: revoked }, request.requestId!);
  });

  // GET /auth/me
  app.get('/me', { preHandler: [authMiddleware] }, async (request, reply) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.id },
      select: {
        id: true,
        phone: true,
        displayName: true,
        language: true,
        theme: true,
        status: true,
        favorites: true,
        onboardingStep: true,
        onboardingDone: true,
        dailyLossLimit: true,
        dailyDepositLimit: true,
        sessionReminderMin: true,
        selfExcludedUntil: true,
        kycStatus: true,
      },
    });
    // Echo or mint. Always return csrfToken in JSON — cross-origin deploys
    // cannot read the API host cookie via document.cookie.
    const csrfToken = ensureCsrf(request, reply, PLAYER_CSRF_MAX_AGE);
    return ok({ ...user, csrfToken }, request.requestId!);
  });
}

function setAuthCookies(
  request: { protocol?: string },
  reply: { setCookie: (n: string, v: string, o?: Record<string, unknown>) => void },
  refreshToken: string
) {
  reply.setCookie('refresh_token', refreshToken, {
    httpOnly: true,
    // Same rule as the panel cookie: follow the scheme the request arrived on,
    // so a local http run is not silently logged out on every reload.
    secure: cookieSecureFor(request),
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 3600,
  });
}
