// Slug → lazily loaded game components. Each game is emitted as its own client
// chunk; opening Dice no longer downloads all 20 boards (including WinGo's large
// UI and every canvas implementation).
import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { GameModule, GameVisualProps, GameBetPanelProps } from './types';

const visual = (load: () => Promise<ComponentType<GameVisualProps>>) =>
  dynamic(load, { ssr: false });
const panel = (load: () => Promise<ComponentType<GameBetPanelProps>>) =>
  dynamic(load, { ssr: false });

const DiceVisual = visual(() =>
  import('./individual/DiceGame').then((m) => m.DiceGameVisual)
);
const DicePanel = panel(() =>
  import('./individual/DiceGame').then((m) => m.DiceGameBetPanel)
);
const AviatorVisual = visual(() =>
  import('./individual/AviatorGame').then((m) => m.AviatorVisual)
);
const AviatorPanel = panel(() =>
  import('./individual/AviatorGame').then((m) => m.AviatorBetPanel)
);
const CrashXVisual = visual(() =>
  import('./individual/CrashXGame').then((m) => m.CrashXVisual)
);
const CrashXPanel = panel(() =>
  import('./individual/CrashXGame').then((m) => m.CrashXBetPanel)
);
const PlinkoVisual = visual(() =>
  import('./individual/PlinkoGame').then((m) => m.PlinkoVisual)
);
const PlinkoPanel = panel(() =>
  import('./individual/PlinkoGame').then((m) => m.PlinkoBetPanel)
);
const WingoVisual = visual(() =>
  import('./individual/WingoGame').then((m) => m.WingoVisual)
);
const WingoPanel = panel(() =>
  import('./individual/WingoGame').then((m) => m.WingoBetPanel)
);
const MinesVisual = visual(() =>
  import('./individual/MinesGame').then((m) => m.MinesVisual)
);
const MinesPanel = panel(() =>
  import('./individual/MinesGame').then((m) => m.MinesBetPanel)
);
const WheelVisual = visual(() =>
  import('./individual/WheelGame').then((m) => m.WheelVisual)
);
const WheelPanel = panel(() =>
  import('./individual/WheelGame').then((m) => m.WheelBetPanel)
);
const CoinVisual = visual(() =>
  import('./individual/CoinFlipGame').then((m) => m.CoinFlipVisual)
);
const CoinPanel = panel(() =>
  import('./individual/CoinFlipGame').then((m) => m.CoinFlipBetPanel)
);
const TowerVisual = visual(() =>
  import('./individual/TowerGame').then((m) => m.TowerVisual)
);
const TowerPanel = panel(() =>
  import('./individual/TowerGame').then((m) => m.TowerBetPanel)
);
const StairsVisual = visual(() =>
  import('./individual/StairsGame').then((m) => m.StairsVisual)
);
const StairsPanel = panel(() =>
  import('./individual/StairsGame').then((m) => m.StairsBetPanel)
);
const HiLoVisual = visual(() =>
  import('./individual/HiLoGame').then((m) => m.HiLoVisual)
);
const HiLoPanel = panel(() =>
  import('./individual/HiLoGame').then((m) => m.HiLoBetPanel)
);
const LimboVisual = visual(() =>
  import('./individual/LimboGame').then((m) => m.LimboVisual)
);
const LimboPanel = panel(() =>
  import('./individual/LimboGame').then((m) => m.LimboBetPanel)
);
const KenoVisual = visual(() =>
  import('./individual/KenoGame').then((m) => m.KenoVisual)
);
const KenoPanel = panel(() =>
  import('./individual/KenoGame').then((m) => m.KenoBetPanel)
);
const DragonVisual = visual(() =>
  import('./individual/DragonTigerGame').then((m) => m.DragonTigerVisual)
);
const DragonPanel = panel(() =>
  import('./individual/DragonTigerGame').then((m) => m.DragonTigerBetPanel)
);
const RouletteVisual = visual(() =>
  import('./individual/RouletteGame').then((m) => m.RouletteVisual)
);
const RoulettePanel = panel(() =>
  import('./individual/RouletteGame').then((m) => m.RouletteBetPanel)
);
const BaccaratVisual = visual(() =>
  import('./individual/BaccaratGame').then((m) => m.BaccaratVisual)
);
const BaccaratPanel = panel(() =>
  import('./individual/BaccaratGame').then((m) => m.BaccaratBetPanel)
);
const ThimblesVisual = visual(() =>
  import('./individual/ThimblesGame').then((m) => m.ThimblesVisual)
);
const ThimblesPanel = panel(() =>
  import('./individual/ThimblesGame').then((m) => m.ThimblesBetPanel)
);
const RingVisual = visual(() =>
  import('./individual/RingOfFortuneGame').then((m) => m.RingOfFortuneVisual)
);
const RingPanel = panel(() =>
  import('./individual/RingOfFortuneGame').then((m) => m.RingOfFortuneBetPanel)
);
const ScratchVisual = visual(() =>
  import('./individual/ScratchCardGame').then((m) => m.ScratchCardVisual)
);
const ScratchPanel = panel(() =>
  import('./individual/ScratchCardGame').then((m) => m.ScratchCardBetPanel)
);
const LuckyVisual = visual(() =>
  import('./individual/LuckyNumberGame').then((m) => m.LuckyNumberVisual)
);
const LuckyPanel = panel(() =>
  import('./individual/LuckyNumberGame').then((m) => m.LuckyNumberBetPanel)
);

export const gameLoaders: Record<
  string,
  () => Promise<{
    Visual: ComponentType<GameVisualProps>;
    BetPanel: ComponentType<GameBetPanelProps>;
  }>
> = {
  dice: () =>
    import('./individual/DiceGame').then((m) => ({
      Visual: m.DiceGameVisual,
      BetPanel: m.DiceGameBetPanel,
    })),
  aviator: () =>
    import('./individual/AviatorGame').then((m) => ({
      Visual: m.AviatorVisual,
      BetPanel: m.AviatorBetPanel,
    })),
  'crash-x': () =>
    import('./individual/CrashXGame').then((m) => ({
      Visual: m.CrashXVisual,
      BetPanel: m.CrashXBetPanel,
    })),
  plinko: () =>
    import('./individual/PlinkoGame').then((m) => ({
      Visual: m.PlinkoVisual,
      BetPanel: m.PlinkoBetPanel,
    })),
  wingo: () =>
    import('./individual/WingoGame').then((m) => ({
      Visual: m.WingoVisual,
      BetPanel: m.WingoBetPanel,
    })),
  mines: () =>
    import('./individual/MinesGame').then((m) => ({
      Visual: m.MinesVisual,
      BetPanel: m.MinesBetPanel,
    })),
  wheel: () =>
    import('./individual/WheelGame').then((m) => ({
      Visual: m.WheelVisual,
      BetPanel: m.WheelBetPanel,
    })),
  'coin-flip': () =>
    import('./individual/CoinFlipGame').then((m) => ({
      Visual: m.CoinFlipVisual,
      BetPanel: m.CoinFlipBetPanel,
    })),
  tower: () =>
    import('./individual/TowerGame').then((m) => ({
      Visual: m.TowerVisual,
      BetPanel: m.TowerBetPanel,
    })),
  stairs: () =>
    import('./individual/StairsGame').then((m) => ({
      Visual: m.StairsVisual,
      BetPanel: m.StairsBetPanel,
    })),
  'hi-lo': () =>
    import('./individual/HiLoGame').then((m) => ({
      Visual: m.HiLoVisual,
      BetPanel: m.HiLoBetPanel,
    })),
  limbo: () =>
    import('./individual/LimboGame').then((m) => ({
      Visual: m.LimboVisual,
      BetPanel: m.LimboBetPanel,
    })),
  keno: () =>
    import('./individual/KenoGame').then((m) => ({
      Visual: m.KenoVisual,
      BetPanel: m.KenoBetPanel,
    })),
  'dragon-tiger': () =>
    import('./individual/DragonTigerGame').then((m) => ({
      Visual: m.DragonTigerVisual,
      BetPanel: m.DragonTigerBetPanel,
    })),
  roulette: () =>
    import('./individual/RouletteGame').then((m) => ({
      Visual: m.RouletteVisual,
      BetPanel: m.RouletteBetPanel,
    })),
  baccarat: () =>
    import('./individual/BaccaratGame').then((m) => ({
      Visual: m.BaccaratVisual,
      BetPanel: m.BaccaratBetPanel,
    })),
  thimbles: () =>
    import('./individual/ThimblesGame').then((m) => ({
      Visual: m.ThimblesVisual,
      BetPanel: m.ThimblesBetPanel,
    })),
  'ring-of-fortune': () =>
    import('./individual/RingOfFortuneGame').then((m) => ({
      Visual: m.RingOfFortuneVisual,
      BetPanel: m.RingOfFortuneBetPanel,
    })),
  'scratch-card': () =>
    import('./individual/ScratchCardGame').then((m) => ({
      Visual: m.ScratchCardVisual,
      BetPanel: m.ScratchCardBetPanel,
    })),
  'lucky-number': () =>
    import('./individual/LuckyNumberGame').then((m) => ({
      Visual: m.LuckyNumberVisual,
      BetPanel: m.LuckyNumberBetPanel,
    })),
};

export const gameRegistry: Record<string, GameModule> = {
  dice: {
    Visual: DiceVisual,
    BetPanel: DicePanel,
    defaultChoices: () => ({ over: true, target: 50.5 }),
  },
  aviator: {
    Visual: AviatorVisual,
    BetPanel: AviatorPanel,
    defaultChoices: () => ({}),
  },
  'crash-x': {
    Visual: CrashXVisual,
    BetPanel: CrashXPanel,
    defaultChoices: () => ({}),
  },
  plinko: {
    Visual: PlinkoVisual,
    BetPanel: PlinkoPanel,
    defaultChoices: () => ({ rows: 12, risk: 'medium', balls: 1 }),
  },
  wingo: {
    Visual: WingoVisual,
    BetPanel: WingoPanel,
    fullBleed: true,
    defaultChoices: () => ({ multiplier: 1 }),
  },
  mines: {
    Visual: MinesVisual,
    BetPanel: MinesPanel,
    session: true,
    defaultChoices: () => ({ mineCount: 3 }),
  },
  wheel: { Visual: WheelVisual, BetPanel: WheelPanel, defaultChoices: () => ({}) },
  'coin-flip': { Visual: CoinVisual, BetPanel: CoinPanel, defaultChoices: () => ({}) },
  tower: {
    Visual: TowerVisual,
    BetPanel: TowerPanel,
    session: true,
    defaultChoices: () => ({ difficulty: 'medium' }),
  },
  stairs: {
    Visual: StairsVisual,
    BetPanel: StairsPanel,
    session: true,
    defaultChoices: () => ({}),
  },
  'hi-lo': {
    Visual: HiLoVisual,
    BetPanel: HiLoPanel,
    session: true,
    defaultChoices: () => ({ guess: 'higher' }),
  },
  limbo: {
    Visual: LimboVisual,
    BetPanel: LimboPanel,
    defaultChoices: () => ({ target: 2 }),
  },
  keno: {
    Visual: KenoVisual,
    BetPanel: KenoPanel,
    defaultChoices: () => ({ picks: [] }),
  },
  'dragon-tiger': {
    Visual: DragonVisual,
    BetPanel: DragonPanel,
    defaultChoices: () => ({}),
  },
  roulette: {
    Visual: RouletteVisual,
    BetPanel: RoulettePanel,
    defaultChoices: () => ({}),
  },
  baccarat: {
    Visual: BaccaratVisual,
    BetPanel: BaccaratPanel,
    defaultChoices: () => ({}),
  },
  thimbles: {
    Visual: ThimblesVisual,
    BetPanel: ThimblesPanel,
    defaultChoices: () => ({}),
  },
  'ring-of-fortune': {
    Visual: RingVisual,
    BetPanel: RingPanel,
    defaultChoices: () => ({}),
  },
  'scratch-card': {
    Visual: ScratchVisual,
    BetPanel: ScratchPanel,
    defaultChoices: () => ({}),
  },
  'lucky-number': {
    Visual: LuckyVisual,
    BetPanel: LuckyPanel,
    defaultChoices: () => ({ betMin: 40, betMax: 60 }),
  },
};
