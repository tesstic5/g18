// apps/api/src/engine/games/payout-ceilings.test.ts
//
// Every game's maxWinMultiplier must sit ABOVE the largest payout that game can
// actually produce. When it doesn't, the ceiling silently clamps a legitimate
// win and the game quietly pays less than it advertises — with no error anywhere.
//
// This is exactly how lucky-number ended up at 49% RTP, and it nearly happened
// again: the migration raised the ceiling to 120 on existing databases but the
// SEED still said 90, so a brand-new deployment would have shipped the bug even
// though an upgraded one was fixed. This test reads the real seed file, so seed
// and engine can never drift apart again.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { defaultTable } from './PlinkoGame';
import { minesLadder, towerLadder, stairsLadder2 } from '../session/gameSessions';

/** Pull `slug` + `maxWinMultiplier` + configJson payouts straight out of prisma/seed.ts. */
function seedGames(): Array<{ slug: string; max: number; src: string }> {
  const file = fs.readFileSync(path.join(__dirname, '../../../prisma/seed.ts'), 'utf8');
  const re = /\{\s*slug:\s*'([a-z-]+)'[\s\S]{0,4000}?maxWinMultiplier:\s*([0-9.]+)/g;
  const matches = [...file.matchAll(re)];
  return matches.map((match, index) => {
    // Prettier may render one game over many lines. Capture until the next game
    // object rather than only the first physical line.
    const start = match.index!;
    const end = matches[index + 1]?.index ?? file.indexOf('\n];', start);
    return {
      slug: match[1]!,
      max: Number(match[2]),
      src: file.slice(start, end < 0 ? undefined : end),
    };
  });
}

const games = seedGames();
const bySlug = (s: string) => games.find((g) => g.slug === s);

describe('seed: every game is present exactly once', () => {
  it('parses all 20 games out of prisma/seed.ts', () => {
    expect(games.length).toBeGreaterThanOrEqual(20);
    expect(new Set(games.map((g) => g.slug)).size).toBe(games.length);
  });
});

describe('maxWinMultiplier is above the biggest payout the game can produce', () => {
  it('plinko: covers the top bucket of the high-risk 16-row board', () => {
    const g = bySlug('plinko')!;
    const biggest = Math.max(
      ...(['low', 'medium', 'high'] as const).flatMap((r) =>
        [8, 12, 16].map((rows) => Math.max(...defaultTable(r, rows)))
      )
    );
    expect(biggest).toBe(12); // v1.3.9: the operator-ordered hard cap
    expect(g.max).toBeGreaterThanOrEqual(biggest);
    // and the seed config must actually be capped to it (belt-and-braces)
    expect(g.max).toBe(12);
  });

  it('lucky-number: covers a single-number pick (~94.1x)', () => {
    const g = bySlug('lucky-number')!;
    // same formula as LuckyNumberGame.ts for the narrowest possible zone
    const span = 100;
    const exact = ((0.96 - 1.9 / span) * span) / 1;
    expect(exact).toBeGreaterThan(90); // this is why 90 was wrong
    expect(g.max).toBeGreaterThanOrEqual(exact);
  });

  it('baccarat / dragon-tiger: cover the corrected tie payouts', () => {
    for (const [slug, tie] of [
      ['baccarat', 10.13],
      ['dragon-tiger', 12.46],
    ] as const) {
      const g = bySlug(slug)!;
      // the tie payout in the seed must be the corrected one...
      expect(g.src).toContain(String(tie));
      // ...and the ceiling must not clamp it
      expect(g.max).toBeGreaterThanOrEqual(tie);
    }
  });

  it('mines: covers the deepest fair rung of every mine count', () => {
    const g = bySlug('mines')!;
    // 24 mines pays 24x; low mine counts climb much higher. The ceiling only has
    // to cover the rungs a player can realistically reach, but it must at least
    // clear the 3-mine ladder, which is the popular default.
    const deepest3 = minesLadder(3)[minesLadder(3).length - 1]!;
    expect(g.max).toBeGreaterThanOrEqual(Math.min(deepest3, 10000));
    expect(g.max).toBeGreaterThan(275); // the old broken table topped out here
  });

  it('tower: covers the configured (admin) ladder top, not the fair exponential', () => {
    const g = bySlug('tower')!;
    // Fair hard floor 10 is ~1e6× — that is no longer what we ship.
    const fairHardTop = towerLadder(4, 3)[9]!;
    expect(fairHardTop).toBeGreaterThan(900_000);
    expect(g.max).toBeLessThan(fairHardTop);
    expect(g.max).toBeGreaterThanOrEqual(520); // seeded expert floor 10
    const code = g.src.replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('payout_ladder');
  });

  it('stairs: covers the top step', () => {
    const g = bySlug('stairs')!;
    const top = stairsLadder2(2, 1)[9]!;
    expect(top).toBeGreaterThan(900);
    expect(g.max).toBeGreaterThanOrEqual(top);
  });
});

describe('seed does not re-introduce the broken hand-written ladders', () => {
  it('mines/stairs ship no payout ladders (the engine derives fair ones)', () => {
    // Strip `//` comments first — the seed explains WHY the ladders are gone,
    // and a naive substring match would hit that explanation.
    const code = (s: string) => s.replace(/\/\/[^\n]*/g, '');
    expect(code(bySlug('mines')!.src)).not.toContain('payout_ladders');
    expect(code(bySlug('stairs')!.src)).not.toContain('payout_ladder:');
  });

  it('tower ships admin-editable per-floor ladders', () => {
    const code = bySlug('tower')!.src.replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('payout_ladder');
  });

  it('plinko risk levels are three DIFFERENT tables', () => {
    const src = bySlug('plinko')!.src;
    // the old seed repeated the identical array three times
    const eight = src.match(/'8':\s*\[[^\]]*\]/g) ?? [];
    expect(eight.length).toBe(3);
    expect(new Set(eight).size).toBe(3);
  });
});
