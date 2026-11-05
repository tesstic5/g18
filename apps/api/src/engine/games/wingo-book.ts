// apps/api/src/engine/games/wingo-book.ts — lock-time ball picker + flat 1.96× pay.
//
// WinGo is one ball for the whole room. Difficulty cannot re-judge per player.
// After betting locks we score each digit 0–9 by the STAKE that would win if
// that digit is drawn (color + big/small + exact number). Then:
//
//   easy / normal  HMAC uniform 0–9 (ignore the book)
//   hard           80% cheapest digit, 20% HMAC uniform
//   impossible     always the cheapest digit
//
// Empty book → every digit scores 0 → cheapest set is {0…9} → uniform HMAC.
// A lone Red ticket → cheapest = not-red → they lose on hard/impossible.
import type { DifficultyLevel } from '../difficulty';

export function colorOf(n: number): 'red' | 'green' | 'violet' {
  if (n === 0 || n === 5) return 'violet';
  return n % 2 === 1 ? 'green' : 'red';
}

export function isBig(n: number): boolean {
  return n >= 5;
}

/** 2× minus 2% house. Every bet type pays this — color, violet, number, size. */
export const WINGO_PAYOUT = 1.96;
export const HARD_FADE_PROB = 0.8;

export interface WingoPayouts {
  red: number;
  green: number;
  violet: number;
  number: number;
  big: number;
  small: number;
}

export const DEFAULT_WINGO_PAYOUTS: WingoPayouts = {
  red: WINGO_PAYOUT,
  green: WINGO_PAYOUT,
  violet: WINGO_PAYOUT,
  number: WINGO_PAYOUT,
  big: WINGO_PAYOUT,
  small: WINGO_PAYOUT,
};

export function wingoMultiplier(
  choice: string | number,
  payouts: WingoPayouts
): number {
  if (typeof choice === 'number') return payouts.number;
  if (typeof choice === 'string' && /^[0-9]$/.test(choice)) return payouts.number;
  return payouts[choice as keyof WingoPayouts] ?? 0;
}

/** Does this ticket win if the ball is `n`? */
export function choiceHits(choice: unknown, n: number): boolean {
  if (typeof choice === 'number') return choice === n;
  if (typeof choice === 'string' && /^[0-9]$/.test(choice)) return Number(choice) === n;
  if (choice === 'big') return isBig(n);
  if (choice === 'small') return !isBig(n);
  if (choice === 'red' || choice === 'green' || choice === 'violet') {
    return colorOf(n) === choice;
  }
  return false;
}

/** Winning stake (rupees) if the ball is each digit 0–9. */
export function winningStakeByNumber(
  bets: Array<{ choice: unknown; amount: unknown }>
): number[] {
  const scores = Array.from({ length: 10 }, () => 0);
  for (const b of bets) {
    const amt = Number(b.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    for (let n = 0; n < 10; n++) {
      if (choiceHits(b.choice, n)) scores[n] = (scores[n] ?? 0) + amt;
    }
  }
  return scores;
}

export function cheapestDigits(stake: number[]): number[] {
  let min = Infinity;
  for (let n = 0; n < 10; n++) {
    const v = stake[n] ?? 0;
    if (v < min) min = v;
  }
  const out: number[] = [];
  for (let n = 0; n < 10; n++) {
    if ((stake[n] ?? 0) === min) out.push(n);
  }
  return out.length ? out : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
}

/** Same threshold as `drawNumber` on uniform weights — HMAC 0.10 lands on 0. */
export function uniformDigit(u: number): number {
  if (!Number.isFinite(u) || u < 0) return 0;
  if (u >= 1) return 9;
  const total = 10;
  let cumulative = 0;
  for (let n = 0; n < 10; n++) {
    cumulative += 1 / total;
    if (u <= cumulative) return n;
  }
  return 9;
}

export function pickFromCandidates(candidates: number[], u: number): number {
  if (candidates.length === 0) return uniformDigit(u);
  const x = !Number.isFinite(u) || u < 0 ? 0 : u >= 1 ? 0.999999 : u;
  const i = Math.min(candidates.length - 1, Math.floor(x * candidates.length));
  return candidates[i]!;
}

export function pickWingoNumber(opts: {
  level: DifficultyLevel;
  winningStake: number[];
  uGate: number;
  uPick: number;
}): number {
  const { level, winningStake, uGate, uPick } = opts;
  if (level === 'easy' || level === 'normal') return uniformDigit(uGate);
  const cheap = cheapestDigits(winningStake);
  if (level === 'hard' && uGate >= HARD_FADE_PROB) return uniformDigit(uPick);
  return pickFromCandidates(cheap, uPick);
}
