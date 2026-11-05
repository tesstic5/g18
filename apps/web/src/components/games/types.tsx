// apps/web/src/components/games/types.ts — shared contracts for game components (docs/21 deliverable #1/#2)
import type { ComponentType } from 'react';
import type { SettledRoundResult } from '@casino/shared/types';

/** Player-facing verdict (PENDING never reaches a banner). */
export type RoundResult = SettledRoundResult;

export interface SessionView {
  roundId: string;
  slug: string;
  betAmount: string;
  status: 'ACTIVE' | 'CASHOUT' | 'BUST';
  stepIndex: number;
  currentMultiplier: number;
  nextMultiplier: number;
  steps: unknown[];
  extra: Record<string, unknown>;
}

export interface GameVisualProps {
  outcome: Record<string, unknown> | null; // server mappedOutcome (animation_data)
  result: RoundResult | null;
  config: {
    minBet: number;
    maxWinMultiplier: number;
    configJson?: Record<string, unknown>;
  };
  /** game-specific choices state shared between visual + bet panel */
  choices: Record<string, unknown>;
  setChoices: (c: Record<string, unknown>) => void;
  /** socket event prefix for shared-round games (aviator | crash-x) */
  eventPrefix?: string;
  /** D-092: session games — the active session (mines/tower/stairs/hi-lo) */
  session?: SessionView | null;
  onSessionStep?: (action: Record<string, unknown>) => Promise<unknown>;
  onSessionCashout?: () => Promise<unknown>;
  onSessionReset?: () => void;
  sessionBusy?: boolean;
  /** One-shot board calls this only when its visible animation/reveal is complete. */
  onRoundComplete?: () => void;
}

export interface GameBetPanelProps {
  onBet: (amount: number) => Promise<unknown> | unknown;
  minBet: number;
  balance: number;
  isLoading: boolean;
  config: {
    minBet: number;
    maxWinMultiplier: number;
    configJson?: Record<string, unknown>;
  };
  choices: Record<string, unknown>;
  setChoices: (c: Record<string, unknown>) => void;
  slug?: string;
}

export interface GameModule {
  Visual: ComponentType<GameVisualProps>;
  BetPanel: ComponentType<GameBetPanelProps>;
  /** default choices for a fresh round */
  defaultChoices?: () => Record<string, unknown>;
  /** D-090: multi-step games (mines/tower/stairs) accumulate reveals across
   * bets — their outcome must NOT be cleared between steps. */
  multiStep?: boolean;
  /** D-092: session-based game (one bet per round; steps advance the
   * multiplier; cashout settles bet × multiplier). */
  session?: boolean;
  /** The game renders its OWN full-page chrome (header, wallet, bet controls)
   * and must not be wrapped in the standard dark GameShell — used by WinGo,
   * whose reference design is a light full-bleed lottery screen. */
  fullBleed?: boolean;
}

/** Small helper for game-specific segmented controls (docs/18 category-pill styling). */
export function Segment<T extends string | number>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {options.map((o) => (
        <button
          key={String(o)}
          onClick={() => onChange(o)}
          className={`h-9 px-4 rounded-full t-label-md transition-all ${value === o ? 'bg-gold/15 border border-gold/35 text-gold font-semibold' : 'bg-white/5 border border-white/8 text-white/60'}`}
        >
          {labels ? (labels[String(o)] ?? String(o)) : String(o)}
        </button>
      ))}
    </div>
  );
}
