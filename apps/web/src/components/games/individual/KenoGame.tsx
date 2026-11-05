// apps/web/src/components/games/individual/KenoGame.tsx — 40-ball grid with draw animation (D-069)
'use client';
import React, { useEffect, useState } from 'react';
import { BetBar } from '../../BetBar';
import {
  GameBackdrop,
  ResultBanner,
  PulseDot,
  CountUp,
  GOLD,
  GREEN,
  RED,
} from '../game-kit';
import { useRoundFlow, animMs, flowFallbackMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import type { GameVisualProps, GameBetPanelProps } from '../types';

const N_BALLS = 40;

export function KenoVisual(props: GameVisualProps) {
  const { outcome, choices, setChoices, onRoundComplete } = props;
  // Hold the result back until the LAST BALL has landed — completion is the
  // draw's own `flow.complete()`, not a timer guessing at the draw's length.
  const flow = useRoundFlow(outcome, flowFallbackMs('keno'), onRoundComplete);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [drawn, setDrawn] = useState<number[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [lastDrawn, setLastDrawn] = useState<number | null>(null);
  // true once the player has started changing picks for the NEXT round
  const [dirty, setDirty] = useState(false);
  // flow.outcome (sticky), not the raw prop — it parks at null between rounds
  // and must not cancel a new round's draw for an identical result set.
  const res = flow.outcome as {
    drawn?: number[];
    matches?: number;
    picks?: number[];
    multiplier?: number;
    win?: boolean;
    partialRefund?: boolean;
  } | null;
  const picks: number[] = Array.isArray(choices.picks)
    ? (choices.picks as number[])
    : [];
  // WIN means the player got back MORE than the stake. Several Keno tables pay
  // consolation amounts below 1x (5 picks / 3 matches = 0.09x), which used to
  // show a green "YOU WIN" while the player lost 91% of their money.
  const finalWin = res?.win ?? (res?.multiplier ?? 0) >= 1;
  const shownWin = flow.revealed && finalWin;
  const partialRefund =
    res?.partialRefund ?? ((res?.multiplier ?? 0) > 0 && (res?.multiplier ?? 0) < 1);
  // During the draw show only matches from balls that have visibly landed.
  const matches = picks.filter((pick) => drawn.includes(pick)).length;

  // D-094: draw the 20 balls one-by-one into the machine tray (tick sound),
  // then flash the tray's last ball; matched picks pop on the grid.
  useEffect(() => {
    if (!res || !res.drawn || res.drawn.length === 0) return;
    setDirty(false); // a new result arrived: this card is now the live one
    setDrawn([]);
    setDrawing(true);
    const drawnArr = res.drawn;
    let i = 0;
    const iv = setInterval(
      () => {
        const n = drawnArr[i];
        if (n !== undefined) {
          setLastDrawn(n);
          setDrawn((d) => [...d, n]);
          sound.play(res.picks && res.picks.includes(n) ? 'plinko_peg' : 'coin_flip');
        }
        i += 1;
        if (i >= drawnArr.length) {
          clearInterval(iv);
          setDrawing(false);
          sound.play('cashout');
          // The machine's last ball has landed — the board declares the round
          // complete. No timer elsewhere guesses when the draw finished.
          flow.complete();
        }
      },
      Math.max(120, Math.floor((animMs('keno') - 600) / Math.max(1, drawnArr.length)))
    );
    return () => clearInterval(iv);
    // roundKey ensures a NEW round re-fires this even if it produced an identical outcome
  }, [flow.roundKey, res]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (n: number) => {
    // Locked only WHILE the balls are dropping. It used to be locked whenever a
    // result existed (`if (res || drawing)`) and nothing ever cleared that, so
    // after your first round the grid, Auto-5 and Clear were dead until you
    // reloaded the page.
    if (drawing) return;
    // first tap after a finished round starts a fresh card
    if (res && !dirty) {
      setDirty(true);
      setDrawn([]);
      setLastDrawn(null);
      const fresh = new Set<number>([n]);
      setSelected(fresh);
      setChoices({ ...choices, picks: [n] });
      return;
    }
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else if (next.size < 10) next.add(n);
    setSelected(next);
    setChoices({ ...choices, picks: [...next] });
  };

  const autoPick = () => {
    setDirty(true);
    setDrawn([]);
    setLastDrawn(null);
    const s = new Set<number>();
    while (s.size < 5) s.add(1 + Math.floor(Math.random() * N_BALLS));
    setSelected(s);
    setChoices({ ...choices, picks: [...s] });
  };

  const ballClass = (n: number): string => {
    const isSel = selected.has(n) || picks.includes(n);
    const isDrawn = drawn.includes(n);
    const isMatch = isSel && isDrawn;
    if (isMatch)
      return 'bg-[radial-gradient(circle_at_50%_35%,#00f090,#007040)] border-green text-[#003d20] scale-110 shadow-[0_0_14px_rgba(0,217,126,0.5)] z-10';
    if (isSel)
      return 'bg-[radial-gradient(circle_at_50%_35%,#ffe066,#c9a227)] border-gold text-[#3d2800] scale-105 shadow-[0_0_12px_rgba(245,200,66,0.4)] z-10';
    if (isDrawn)
      return 'bg-[radial-gradient(circle_at_50%_35%,#3a3a52,#22223a)] border-white/25 text-white/50';
    return 'bg-[radial-gradient(circle_at_50%_35%,#262640,#17172a)] border-white/10 text-white/55 hover:border-gold/50 hover:text-white hover:scale-105 transition-all';
  };

  return (
    <GameBackdrop accent={GOLD}>
      {/* D-096: scroll-safe wrapper */}
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-1.5 px-3 py-1">
          {/* header */}
          <div className="flex items-center gap-3 w-full max-w-sm justify-between">
            <div className="flex items-center gap-2">
              {drawing && <PulseDot color={GOLD} />}
              <span className="t-label-sm text-secondary">
                {drawing ? 'Drawing…' : `Pick ${picks.length}/10 numbers`}
              </span>
            </div>
            {lastDrawn !== null && (
              <span className="h-7 w-7 rounded-full bg-gold text-[#3d2800] font-black flex items-center justify-center animate-spring-in shadow-[0_0_16px_rgba(245,200,66,0.6)]">
                {lastDrawn}
              </span>
            )}
          </div>

          {/* D-094: ball machine output tray — 20 slots fill as the draw runs
            (D-096: compact so the game fits short phones) */}
          <div
            className="w-full max-w-[250px] sm:max-w-sm rounded-xl border border-white/10 bg-black/30 p-1 flex flex-wrap gap-1 justify-center min-h-[24px]"
            style={{ boxShadow: 'inset 0 0 18px rgba(0,0,0,0.5)' }}
          >
            {Array.from({ length: 20 }).map((_, i) => {
              const n = drawn[i];
              return (
                <span
                  key={i}
                  className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-200 ${n !== undefined ? (picks.includes(n) ? 'bg-[radial-gradient(circle_at_50%_35%,#00f090,#007040)] border border-green text-[#003d20] scale-105 shadow-[0_0_10px_rgba(0,217,126,0.6)] animate-spring-in' : 'bg-[radial-gradient(circle_at_50%_35%,#e8e8f0,#9aa0aa)] border border-white/40 text-[#1a1a2e]') : 'bg-white/[0.04] border border-white/8'}`}
                >
                  {n !== undefined ? n : ''}
                </span>
              );
            })}
          </div>

          {/* grid — D-096: 300px max so the 5 rows fit the canvas on short phones */}
          {/* The grid was capped at max-w-[250px] on a 378px-wide canvas, which made
            each of the 8 columns 28x28px — measured, 42 of Keno's 54 controls were
            under the 32px minimum, so picking the number you wanted was a lottery
            of its own. Using the width that is actually there takes them to ~44px,
            the published minimum touch target. */}
          <div className="grid grid-cols-8 gap-1.5 w-full max-w-[360px]">
            {Array.from({ length: N_BALLS }).map((_, i) => {
              const n = i + 1;
              return (
                <button
                  key={n}
                  onClick={() => toggle(n)}
                  className={`aspect-square min-h-[40px] rounded-full border flex items-center justify-center text-[13px] font-bold transition-all active:scale-90 ${ballClass(n)}`}
                >
                  {n}
                </button>
              );
            })}
          </div>

          {/* stats — D-096: compact */}
          <div className="px-3.5 py-1 rounded-full border border-white/10 bg-white/[0.04] flex items-center gap-3.5">
            <span className="t-label-sm text-white/70">
              Picks <b className="text-gold">{picks.length}/10</b>
            </span>
            <span className="t-label-sm text-white/70">
              Matched{' '}
              <b className={shownWin ? 'text-green' : 'text-white/70'}>
                <CountUp value={matches} decimals={0} duration={drawn.length * 190} />
              </b>
            </span>
            {flow.revealed && res && res.multiplier !== undefined && (
              <span
                className="t-num-md font-black"
                style={{ color: shownWin ? GREEN : RED }}
              >
                {shownWin ? `${res.multiplier}×` : '0×'}
              </span>
            )}
          </div>

          {/* actions — D-096: compact row */}
          <div className="flex gap-2">
            <button
              onClick={autoPick}
              disabled={drawing}
              className="h-6 px-3 rounded-full bg-white/5 border border-white/10 t-label-sm text-white/70 hover:border-gold/40 disabled:opacity-40"
            >
              🎲 Auto 5
            </button>
            <button
              onClick={() => {
                setDirty(true);
                setDrawn([]);
                setLastDrawn(null);
                setSelected(new Set());
                setChoices({ ...choices, picks: [] });
              }}
              disabled={drawing}
              className="h-6 px-3 rounded-full bg-white/5 border border-white/10 t-label-sm text-white/70 hover:border-red/40 disabled:opacity-40"
            >
              Clear
            </button>
          </div>

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            // the PAGE's result, not one synthesized from the sticky outcome —
            // synthesizing meant round 1's verdict stayed renderable through
            // the between-rounds window and merged into round 2
            result={props.result}
            multiplier={res?.multiplier}
            partialRefund={partialRefund}
          />
        </div>
      </div>
    </GameBackdrop>
  );
}

export function KenoBetPanel(props: GameBetPanelProps) {
  // Numbers are picked on the grid (they always were) — this panel only stakes.
  const picks: number[] = Array.isArray(props.choices.picks)
    ? (props.choices.picks as number[])
    : [];
  return (
    <BetBar
      minBet={props.minBet}
      balance={props.balance}
      onBet={props.onBet}
      isLoading={props.isLoading}
      actionLabel={`DRAW \u2014 ${picks.length} PICKED`}
      selection={
        picks.length
          ? `${picks.length} number${picks.length === 1 ? '' : 's'}: ${picks
              .slice()
              .sort((a, b) => a - b)
              .join(', ')}`
          : null
      }
      requirement={picks.length === 0 ? 'Tap numbers on the grid to pick them' : null}
    />
  );
}
