// apps/web/src/components/games/crash-hud.test.ts
//
// The Aviator / CrashX HUD renders numbers that arrive over a socket, and it
// calls .toFixed() on them on every animation frame. A single missing or
// malformed field used to put `undefined`/`null` into state, and the very next
// render threw:
//
//   TypeError: Cannot read properties of null (reading 'toFixed')
//
// That unmounts the whole game behind the error boundary — mid-round, while the
// player has money on the table. This locks in the defensive coercion.
import { describe, it, expect } from 'vitest';

/** Mirror of the `num()` helper in AviatorGame.tsx. */
const num = (v: unknown, fallback: number): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};

describe('crash HUD number coercion', () => {
  it('survives every shape a broken socket payload can take', () => {
    const nasty: unknown[] = [
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      '',
      'abc',
      {},
      [],
      true,
      false,
    ];
    for (const v of nasty) {
      const out = num(v, 1);
      expect(Number.isFinite(out)).toBe(true);
      // the real crash: this call must never throw
      expect(() => out.toFixed(2)).not.toThrow();
    }
  });

  it('passes real values through untouched', () => {
    expect(num(1.234, 1)).toBe(1.234);
    expect(num(0, 5)).toBe(0); // 0 is valid, must NOT fall back
    expect(num('2.5', 1)).toBe(2.5); // socket.io can deliver numeric strings
    expect(num(136.39, 1)).toBe(136.39);
  });

  it('uses the fallback only when the value is unusable', () => {
    expect(num(undefined, 1)).toBe(1);
    expect(num(null, 5)).toBe(5);
    expect(num(NaN, 1)).toBe(1);
    expect(num(Infinity, 1)).toBe(1); // Infinity.toFixed() renders "Infinity×"
    // a bare Number() would make these 0 / 0 / 1 and render a WRONG value
    expect(num('', 7)).toBe(7);
    expect(num(true, 7)).toBe(7);
    expect(num([], 7)).toBe(7);
  });

  it('infers taxi vs climb growth from elapsed (HUD must not use ln(m)/total)', () => {
    const TAXI = 2500;
    const infer = (m: number, elapsedMs: number): number | null => {
      if (!(elapsedMs > 0) || !Number.isFinite(m)) return null;
      if (elapsedMs < TAXI) return Math.log(10) / TAXI;
      if (m > 1) {
        const g = Math.log(m) / (elapsedMs - TAXI);
        return Number.isFinite(g) && g > 0 ? g : null;
      }
      return null;
    };
    const taxiG = infer(0.4, 800);
    expect(taxiG).toBeCloseTo(Math.log(10) / TAXI, 8);
    // After taxi, growth is ln(m)/(elapsed-taxi), NOT ln(m)/elapsed.
    const climbG = infer(2, TAXI + Math.log(2) / 0.00016);
    expect(climbG).toBeCloseTo(0.00016, 6);
    const naive = Math.log(2) / (TAXI + Math.log(2) / 0.00016);
    expect(Math.abs((climbG ?? 0) - naive)).toBeGreaterThan(0.00004);
  });

  it('a tick with no multiplier keeps the previous value rather than resetting', () => {
    // onTick does setMult(m => num(t?.multiplier, m)) — a dropped field must not
    // snap the live multiplier back to 1 mid-flight.
    let mult = 4.2;
    const onTick = (t: { multiplier?: number }) => {
      mult = num(t?.multiplier, mult);
    };
    onTick({}); // malformed
    expect(mult).toBe(4.2);
    onTick({ multiplier: 4.9 }); // good
    expect(mult).toBe(4.9);
  });
});
