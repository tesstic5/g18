// packages/game-core/src/provably-fair.ts — canonical (v4 PROVABLY FAIR SYSTEM)
// Pure functions: used by api (server seeds) AND web (verifier page). No side effects.
import crypto from 'crypto';

export interface VerifyParams {
  serverSeed: string; // revealed after rotation
  serverSeedHash: string; // committed before any bets
  clientSeed: string;
  nonce: number;
  expectedRawOutcome: number;
}

export interface VerificationResult {
  hashMatches: boolean;
  rawMatches: boolean;
  valid: boolean;
  computedHash: string;
  computedRaw: number;
}

export const PROVABLY_FAIR = {
  /** 64-char hex server seed (crypto.randomBytes — NEVER Math.random). */
  generateServerSeed(): string {
    return crypto.randomBytes(32).toString('hex');
  },

  hashServerSeed(serverSeed: string): string {
    return crypto.createHash('sha256').update(serverSeed).digest('hex');
  },

  /** Raw outcome: HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`) → first 8 hex chars ÷ 2³² (D-004). */
  generateRawOutcome(serverSeed: string, clientSeed: string, nonce: number): number {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}`);
    const hash = hmac.digest('hex');
    return parseInt(hash.substring(0, 8), 16) / 0x100000000;
  },

  /** Player-side verification (also the /provably-fair page engine). */
  verify(params: VerifyParams): VerificationResult {
    const computedHash = this.hashServerSeed(params.serverSeed);
    const hashMatches = computedHash === params.serverSeedHash;
    const computedRaw = this.generateRawOutcome(
      params.serverSeed,
      params.clientSeed,
      params.nonce
    );
    const rawMatches = Math.abs(computedRaw - params.expectedRawOutcome) < 1e-10;
    return {
      hashMatches,
      rawMatches,
      valid: hashMatches && rawMatches,
      computedHash,
      computedRaw,
    };
  },
};
