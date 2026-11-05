// apps/api/src/lib/jwt-claims.ts — canonical JWT issuer/role claims.
//
// Player tokens, refresh tokens and admin tokens are all signed with the SAME
// RSA private key (see lib/jwt-keys.ts). The key therefore does NOT separate
// the trust domains — the `issuer` + `role` claims do. Every verifier must
// assert BOTH, otherwise an admin token authenticates as a player (and a
// refresh token as an access token).
//
// Kept in its own module so routes/services/middleware can share them without
// importing each other (avoids import cycles).

export const JWT_ISSUER_USER = 'casino';
export const JWT_ISSUER_REFRESH = 'casino-refresh';
export const JWT_ISSUER_ADMIN = 'casino-admin';
export const JWT_ISSUER_ADMIN_WS = 'casino-admin-ws';
export const JWT_ISSUER_REFERRAL = 'casino-referral';

export const JWT_ROLE_USER = 'user';
export const JWT_ROLE_REFRESH = 'refresh';
export const JWT_ROLE_ADMIN = 'admin';
export const JWT_ROLE_ADMIN_WS = 'admin-ws';
export const JWT_ROLE_REFERRAL = 'referral';
