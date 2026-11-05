// apps/web/src/components/games/individual/WheelGame.tsx — money wheel you BET on.
//
// Before: the wheel had no player decision at all. You tapped PLAY inside a
// popup, the wheel span, and it paid whatever it landed on. Nothing to choose,
// nothing to do — a slot pull.
//
// Now: the rim is split into colour tiers and you back one by TAPPING IT ON THE
// BOARD. Rarer colour = bigger payout, and each tier's payout is printed on the
// chip so the tradeoff is visible while choosing. The action button stays
// disabled with "Tap a colour to back it" until a pick exists.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { GameBackdrop, ResultBanner, Glass, CountUp, GOLD } from '../game-kit';
import { PickRow, PickPrompt } from '../board-kit';
import { useRoundFlow, animMs, flowFallbackMs } from '../useRoundFlow';
import { sound } from '../../../lib/sound';
import type { GameVisualProps, GameBetPanelProps } from '../types';

interface Tier {
  id: string;
  label: string;
  color: string;
  slices: number;
}

const DEFAULT_TIERS: Tier[] = [
  { id: 'yellow', label: '2×', color: '#f5c842', slices: 12 },
  { id: 'blue', label: '3×', color: '#4d9fff', slices: 8 },
  { id: 'green', label: '5×', color: '#00d97e', slices: 3 },
  { id: 'purple', label: 'JACKPOT', color: '#9b59ff', slices: 1 },
];

/** Mirrors buildRim() on the server so the rendered rim matches the result. */
export function buildRim(tiers: Tier[]): string[] {
  const total = tiers.reduce((s, t) => s + t.slices, 0);
  const rim: string[] = new Array(total);
  const ordered = [...tiers].sort((a, b) => a.slices - b.slices);
  const taken = new Set<number>();
  for (const t of ordered.slice(0, -1)) {
    const gap = total / t.slices;
    for (let i = 0; i < t.slices; i++) {
      let pos = Math.round(i * gap + gap / 2) % total;
      while (taken.has(pos)) pos = (pos + 1) % total;
      taken.add(pos);
      rim[pos] = t.id;
    }
  }
  const filler = ordered[ordered.length - 1]!;
  for (let i = 0; i < total; i++) if (!rim[i]) rim[i] = filler.id;
  return rim;
}

export const tierPayout = (t: Tier, total: number) =>
  +(0.96 / (t.slices / total)).toFixed(2);

const SPIN_MS = animMs('wheel');

export function WheelVisual({
  outcome,
  result,
  choices,
  setChoices,
  config,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the outcome back until the wheel has actually stopped. The reveal is
  // the board's own completion callback at the landing beat — not a guess timer.
  const flow = useRoundFlow(outcome, flowFallbackMs('wheel'), onRoundComplete);
  const [rotation, setRotation] = useState(0);
  /** the resting slice, tagged with the round it belongs to so a previous
   * round's landing can never paint into a new round's first frame */
  const [landed, setLanded] = useState<{ index: number; round: number } | null>(null);
  const [history, setHistory] = useState<
    Array<{ label: string; color: string; won: boolean }>
  >([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const configuredTiers = (config.configJson as { tiers?: Tier[] } | undefined)?.tiers;
  const tiers: Tier[] =
    (outcome as { tiers?: Tier[] })?.tiers ??
    (Array.isArray(configuredTiers) && configuredTiers.length
      ? configuredTiers
      : DEFAULT_TIERS);
  const rim: string[] = (outcome as { rim?: string[] })?.rim ?? buildRim(tiers);
  const total = rim.length;
  // flow.outcome (sticky), not the raw prop: the prop parks at null between
  // rounds and must not cancel a new round's spin for an identical winIndex.
  const winIndex = (flow.outcome as { index?: number })?.index ?? null;
  const picked = (choices.tier as string) ?? null;
  const byId = (id: string) => tiers.find((t) => t.id === id) ?? tiers[0]!;

  useEffect(() => {
    if (winIndex === null) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLanded(null);
    sound.play('wheel_spin');
    const seg = 360 / total;
    const target = 360 - (seg * winIndex + seg / 2);
    setRotation((r) => r + 4 * 360 + ((target - (r % 360) + 360) % 360));
    // ticks speed up as the wheel slows — the classic money-wheel sound
    const TICKS = 14;
    for (let i = 0; i < TICKS; i++) {
      const t = Math.pow(i / TICKS, 0.55) * (SPIN_MS - 250);
      timers.current.push(setTimeout(() => sound.play('wheel_tick'), 250 + t));
    }
    timers.current.push(
      setTimeout(() => {
        sound.stop('wheel_spin');
        sound.play('wheel_stop');
        setLanded({ index: winIndex, round: flow.roundKey });
        const t = byId(rim[winIndex]!);
        setHistory((h) =>
          [{ label: t.label, color: t.color, won: result === 'WIN' }, ...h].slice(0, 12)
        );
        // The wheel has stopped and the pointer is on the winning slice — the
        // board itself declares the round complete. No external timer guesses.
        flow.complete();
      }, SPIN_MS)
    );
    return () => {
      timers.current.forEach(clearTimeout);
      sound.stop('wheel_spin');
    };
    // roundKey ensures a NEW round re-fires this even if it produced an identical outcome
  }, [flow.roundKey, winIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only honor a landing that belongs to the round currently on screen —
  // round N's resting pose must not leak into round N+1's first frames.
  const landedNow =
    landed !== null && landed.round === flow.roundKey && winIndex !== null
      ? landed.index
      : null;
  const landedTier = landedNow !== null ? byId(rim[landedNow]!) : null;
  const spinning = winIndex !== null && landedNow === null;

  return (
    <GameBackdrop accent={GOLD}>
      <div className="relative w-full h-full overflow-y-auto">
        <div className="min-h-full w-full flex flex-col items-center justify-center gap-2.5 px-3 py-2">
          <PickPrompt show={!picked && !spinning}>
            Tap a colour below to back it
          </PickPrompt>

          {/* ── the wheel ─────────────────────────────────────────── */}
          <div className="relative w-[min(70vw,270px,32dvh)] aspect-square">
            <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 z-20">
              <div className="w-0 h-0 border-l-[11px] border-r-[11px] border-t-[18px] border-l-transparent border-r-transparent border-t-gold drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]" />
            </div>
            <div
              className="w-full h-full rounded-full overflow-hidden border-[5px] border-[#2a2a3a] shadow-[0_16px_48px_rgba(0,0,0,0.6)]"
              style={{
                transform: `rotate(${rotation}deg)`,
                transition: `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.62, 0.10, 1)`,
                background: `conic-gradient(${rim
                  .map(
                    (id, i) =>
                      `${byId(id).color} ${(360 / total) * i}deg ${(360 / total) * (i + 1)}deg`
                  )
                  .join(',')})`,
              }}
            >
              {/* dim every slice that is NOT the backed colour, so the player can
                  see their own bet on the rim while it spins */}
              {picked && (
                <div
                  className="absolute inset-0"
                  style={{
                    background: `conic-gradient(${rim
                      .map(
                        (id, i) =>
                          `${id === picked ? 'transparent' : 'rgba(0,0,0,0.55)'} ${(360 / total) * i}deg ${(360 / total) * (i + 1)}deg`
                      )
                      .join(',')})`,
                  }}
                />
              )}
            </div>
            {/* hub */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="h-16 w-16 rounded-full bg-gradient-to-b from-[#3a3a55] to-[#1a1a30] border-4 border-gold/50 flex items-center justify-center shadow-[0_0_24px_rgba(245,200,66,0.35)]">
                {landedTier ? (
                  <span
                    className="t-num-md font-black"
                    style={{ color: landedTier.color }}
                  >
                    {landedTier.label}
                  </span>
                ) : (
                  <span className="text-gold text-xl">◆</span>
                )}
              </div>
            </div>
            {landedTier && (
              <div
                className="absolute inset-0 rounded-full border-4 animate-spring-in pointer-events-none"
                style={{
                  borderColor: landedTier.color,
                  boxShadow: `0 0 40px ${landedTier.color}66`,
                }}
              />
            )}
          </div>

          {/* ── BACK A COLOUR — the actual bet, ON the board ────────── */}
          <PickRow
            columns={4}
            disabled={spinning}
            value={picked}
            onChange={(v) => {
              sound.play('bet_place');
              setChoices({ ...choices, tier: v });
            }}
            options={tiers.map((t) => ({
              value: t.id,
              label: t.label,
              sub: `${tierPayout(t, total)}× · ${Math.round((t.slices / total) * 100)}%`,
              color: t.color,
            }))}
          />

          {landedTier && (
            <Glass
              className="px-5 py-1.5 animate-spring-in"
              glow={result === 'WIN' ? landedTier.color : undefined}
            >
              <span
                className="t-label-lg font-black"
                style={{ color: result === 'WIN' ? landedTier.color : '#999' }}
              >
                {landedTier.label}
                {result === 'WIN' ? (
                  <>
                    {' '}
                    — WON{' '}
                    <CountUp
                      value={Number(
                        (outcome as { multiplier?: number })?.multiplier ?? 0
                      )}
                      decimals={2}
                      duration={700}
                    />
                    ×
                  </>
                ) : (
                  ' — missed'
                )}
              </span>
            </Glass>
          )}

          {history.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5 max-w-sm">
              {history.map((h, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 rounded-md text-[11px] font-bold border"
                  style={{
                    color: h.color,
                    borderColor: `${h.color}55`,
                    background: `${h.color}14`,
                  }}
                >
                  {h.label}
                </span>
              ))}
            </div>
          )}

          <ResultBanner
            result={result}
            ready={flow.revealed}
            roundKey={flow.roundKey}
            multiplier={(outcome as { multiplier?: number })?.multiplier}
            payout={(outcome as { payout?: number })?.payout}
            accent={GOLD}
          />
        </div>
      </div>
    </GameBackdrop>
  );
}

export function WheelBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  config,
}: GameBetPanelProps) {
  const picked = (choices.tier as string) ?? null;
  const configured = (config.configJson as { tiers?: Tier[] } | undefined)?.tiers;
  const tiers =
    Array.isArray(configured) && configured.length ? configured : DEFAULT_TIERS;
  const total = tiers.reduce((s, t) => s + t.slices, 0);
  const t = tiers.find((x) => x.id === picked);
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel="SPIN THE WHEEL"
      selection={
        t
          ? `Colour ${t.id.toUpperCase()} · pays ${tierPayout(t, total).toFixed(2)}\u00d7`
          : null
      }
      requirement={picked ? null : 'Tap a colour to back it'}
      multiplier={t ? tierPayout(t, total) : null}
    />
  );
}
