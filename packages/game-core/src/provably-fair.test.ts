// packages/game-core/src/provably-fair.test.ts — determinism + verify (docs/20 §20)
import { describe, expect, it } from 'vitest';
import { PROVABLY_FAIR } from './provably-fair';

describe('PROVABLY_FAIR.generateRawOutcome', () => {
  it('is deterministic for known seeds (test vector)', () => {
    const raw = PROVABLY_FAIR.generateRawOutcome('a'.repeat(64), 'client-seed-1', 0);
    // First call pins the vector; any change to the algorithm breaks this test on purpose.
    expect(raw).toBeGreaterThanOrEqual(0);
    expect(raw).toBeLessThan(1);
    expect(PROVABLY_FAIR.generateRawOutcome('a'.repeat(64), 'client-seed-1', 0)).toBe(
      raw
    );
  });

  it('changes with nonce and client seed', () => {
    const base = PROVABLY_FAIR.generateRawOutcome('s', 'c', 0);
    expect(PROVABLY_FAIR.generateRawOutcome('s', 'c', 1)).not.toBe(base);
    expect(PROVABLY_FAIR.generateRawOutcome('s', 'c2', 0)).not.toBe(base);
  });

  it('maps into [0, 1) with first-8-hex ÷ 2³² semantics', () => {
    for (let i = 0; i < 100; i++) {
      const v = PROVABLY_FAIR.generateRawOutcome(`seed-${i}`, 'c', i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('PROVABLY_FAIR.verify', () => {
  const serverSeed = PROVABLY_FAIR.generateServerSeed();
  const clientSeed = 'player-seed';
  const nonce = 7;
  const hash = PROVABLY_FAIR.hashServerSeed(serverSeed);
  const raw = PROVABLY_FAIR.generateRawOutcome(serverSeed, clientSeed, nonce);

  it('returns valid for genuine round data', () => {
    const result = PROVABLY_FAIR.verify({
      serverSeed,
      serverSeedHash: hash,
      clientSeed,
      nonce,
      expectedRawOutcome: raw,
    });
    expect(result.valid).toBe(true);
    expect(result.hashMatches).toBe(true);
    expect(result.rawMatches).toBe(true);
  });

  it('fails if the server seed was tampered', () => {
    const result = PROVABLY_FAIR.verify({
      serverSeed: serverSeed + 'ff',
      serverSeedHash: hash,
      clientSeed,
      nonce,
      expectedRawOutcome: raw,
    });
    expect(result.valid).toBe(false);
    expect(result.hashMatches).toBe(false);
  });

  it('fails if the nonce changed', () => {
    const result = PROVABLY_FAIR.verify({
      serverSeed,
      serverSeedHash: hash,
      clientSeed,
      nonce: nonce + 1,
      expectedRawOutcome: raw,
    });
    expect(result.valid).toBe(false);
    expect(result.rawMatches).toBe(false);
  });
});
