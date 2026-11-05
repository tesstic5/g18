// apps/api/src/engine/games/BaccaratGame.ts — Player/Banker/Tie with the FULL
// standard third-card drawing rules (D-093). Card VALUES: Ace=1, 2-9=face,
// 10/J/Q/K=0. (D-093 fixes a real bug: J/Q/K were counted as 1/2/3 points,
// which skewed every hand and the RTP.)
import { BaseGame, ResolveParams, GameHandlerResult } from './BaseGame';
import { mulberry32 } from './MinesGame';

/** Baccarat card value: 1-13 raw → 0..9 (10/J/Q/K = 0, Ace = 1). */
export function baccaratValue(raw: number): number {
  return raw >= 10 ? 0 : raw;
}
export function baccaratPoint(cards: number[]): number {
  return cards.reduce((s, c) => (s + baccaratValue(c)) % 10, 0);
}

/** Standard third-card drawing decision (infinite-deck baccarat). */
export function bankerDrawsDecision(
  bankerPoint: number,
  playerDrew: boolean,
  playerThird: number
): boolean {
  if (bankerPoint >= 7) return false; // banker stands on 7
  if (!playerDrew) return bankerPoint <= 5; // player stands → banker ≤5 draws
  if (bankerPoint <= 2) return true; // banker ≤2 always draws
  switch (bankerPoint) {
    case 3:
      return playerThird !== 8;
    case 4:
      return ![0, 1, 8, 9].includes(playerThird);
    case 5:
      return ![0, 1, 2, 3, 8, 9].includes(playerThird);
    case 6:
      return playerThird === 6 || playerThird === 7;
    default:
      return false;
  }
}

/** Deal one hand with the standard rules. Returns the full card sequence. */
export function dealBaccarat(rng: () => number): {
  player: number[];
  banker: number[];
  playerDraws: boolean;
  bankerDraws: boolean;
  playerPoint: number;
  bankerPoint: number;
} {
  const draw = () => 1 + Math.floor(rng() * 13); // 1..13 (ace..king)
  const player = [draw(), draw()];
  const banker = [draw(), draw()];
  let p = baccaratPoint(player);
  let b = baccaratPoint(banker);

  const natural = p >= 8 || b >= 8;
  const playerDraws = !natural && p <= 5;
  let playerThird = -1;
  if (playerDraws) {
    player.push(draw());
    p = baccaratPoint(player);
    playerThird = baccaratValue(player[2]!);
  }
  const bankerDraws = !natural && bankerDrawsDecision(b, playerDraws, playerThird);
  if (bankerDraws) {
    banker.push(draw());
    b = baccaratPoint(banker);
  }
  return { player, banker, playerDraws, bankerDraws, playerPoint: p, bankerPoint: b };
}

/** Measured over 200k deals with THIS exact deal logic (matches 8-deck shoe):
 *  player 44.74% / banker 45.79% / tie 9.47%. */
export const BACCARAT_CHANCES = { player: 0.4474, banker: 0.4579, tie: 0.0947 };

export class BaccaratGame extends BaseGame {
  readonly slug = 'baccarat';

  override fairWinChance(choices: Record<string, unknown>): number {
    const bet = (choices as { bet?: 'player' | 'banker' | 'tie' }).bet ?? 'player';
    // Player/banker bets PUSH on a tie — the profit chance is just P(win).
    return BACCARAT_CHANCES[bet];
  }

  resolve(params: ResolveParams): GameHandlerResult {
    return this.resolveDecided(params);
  }

  protected override sampleOutcome({
    rawOutcome,
    config,
    choices,
  }: ResolveParams): GameHandlerResult {
    const rng = mulberry32(Math.floor(rawOutcome * 0xffffffff));
    const { player, banker, playerDraws, bankerDraws, playerPoint, bankerPoint } =
      dealBaccarat(rng);

    const outcome =
      playerPoint > bankerPoint
        ? 'player'
        : bankerPoint > playerPoint
          ? 'banker'
          : 'tie';
    const bet = (choices as { bet?: 'player' | 'banker' | 'tie' }).bet ?? 'player';
    // Payout multipliers are TOTAL RETURN (stake included), not "x to 1".
    // The tie default was 8, i.e. 8× total on a 9.47%-probability event = 76%
    // RTP, ~21 points worse than every other bet on the platform. Measured over
    // 200k deals with this exact deal logic: player 44.74% / banker 45.79% /
    // tie 9.47% (matches real 8-deck baccarat). Fair tie for a 96% target is
    // 0.96 / 0.0947 = 10.13×.
    const payouts = (
      config.configJson as { payouts?: { player: number; banker: number; tie: number } }
    ).payouts ?? { player: 1.95, banker: 1.9, tie: 10.13 };
    // D-089: player/banker bets PUSH (stake returned) on a tie.
    const isTiePush = outcome === 'tie' && bet !== 'tie';
    const won = bet === outcome || isTiePush;
    const multiplier = isTiePush ? 1 : won ? payouts[outcome] : 0;
    return {
      result: isTiePush ? 'PUSH' : won ? 'WIN' : 'LOSE',
      payoutMultiplier: Math.min(multiplier, Number(config.maxWinMultiplier)),
      mappedOutcome: {
        playerCards: player,
        bankerCards: banker,
        playerDraws,
        bankerDraws,
        playerPoint,
        bankerPoint,
        outcome,
        bet,
        win: won,
        isPush: isTiePush,
        multiplier: won ? multiplier : 0,
      },
    };
  }
}
