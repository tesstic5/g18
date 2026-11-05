// apps/web/src/components/games/individual/RingOfFortuneGame.tsx — prize ring you BET on.
//
// Before: no player decision whatsoever — tap PLAY, watch the ring, take what it
// gives you. Now you back a prize tier by tapping it on the board; rarer tier =
// bigger payout, printed on the chip.
'use client';
import React, { useEffect, useRef, useState } from 'react';
import { BetBar } from '../../BetBar';
import { GameBackdrop, ResultBanner, Glass, CountUp, GOLD } from '../game-kit';
import { useRoundFlow, animMs, flowFallbackMs } from '../useRoundFlow';
import { PickRow, PickPrompt } from '../board-kit';
import { buildRim, tierPayout } from './WheelGame';
import { sound } from '../../../lib/sound';
import type { GameVisualProps, GameBetPanelProps } from '../types';

interface Tier {
  id: string;
  label: string;
  color: string;
  slices: number;
}

const RING_TIERS: Tier[] = [
  { id: 'bronze', label: 'BRONZE', color: '#c98b4b', slices: 18 },
  { id: 'silver', label: 'SILVER', color: '#c7d0dd', slices: 9 },
  { id: 'gold', label: 'GOLD', color: '#f5c842', slices: 6 },
  { id: 'ruby', label: 'RUBY', color: '#ff3b5c', slices: 2 },
  { id: 'jackpot', label: 'JACKPOT', color: '#9b59ff', slices: 1 },
];

export function RingOfFortuneVisual({
  outcome,
  result,
  choices,
  setChoices,
  config,
  onRoundComplete,
}: GameVisualProps) {
  // Hold the result back until the ring has actually stopped — completion is
  // the board's explicit call at the landing beat, not a guess timer.
  const flow = useRoundFlow(
    outcome,
    flowFallbackMs('ring-of-fortune'),
    onRoundComplete
  );
  const [rotation, setRotation] = useState(0);
  /** resting slice, tagged with its round so the previous round's landing can
   * never paint into a new round's first frame */
  const [landed, setLanded] = useState<{ index: number; round: number } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const configuredTiers = (config.configJson as { tiers?: Tier[] } | undefined)?.tiers;
  const tiers: Tier[] =
    (outcome as { tiers?: Tier[] })?.tiers ??
    (Array.isArray(configuredTiers) && configuredTiers.length
      ? configuredTiers
      : RING_TIERS);
  const rim: string[] = (outcome as { rim?: string[] })?.rim ?? buildRim(tiers);
  const total = rim.length;
  // flow.outcome (sticky), not the raw prop — the prop parks at null between
  // rounds and must not cancel a new round's spin for an identical winIndex.
  const winIndex = (flow.outcome as { index?: number })?.index ?? null;
  const picked = (choices.tier as string) ?? null;
  const byId = (id: string) => tiers.find((t) => t.id === id) ?? tiers[0]!;

  useEffect(() => {
    if (winIndex === null) return;
    const round = flow.roundKey;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    sound.play('wheel_spin');
    const seg = 360 / total;
    const target = 360 - (seg * winIndex + seg / 2);
    setRotation((r) => r + 5 * 360 + ((target - (r % 360) + 360) % 360));
    for (let i = 0; i < 7; i++)
      timers.current.push(setTimeout(() => sound.play('wheel_tick'), 300 + i * 380));
    timers.current.push(
      setTimeout(() => {
        sound.stop('wheel_spin');
        sound.play('wheel_stop');
        setLanded({ index: winIndex, round });
        // The ring has stopped on the pointer — the board declares completion.
        flow.complete();
      }, animMs('ring-of-fortune'))
    );
    return () => {
      timers.current.forEach(clearTimeout);
      sound.stop('wheel_spin');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.roundKey, winIndex]);

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
            Tap a prize below to back it
          </PickPrompt>

          {/* ── the ring (hollow centre) ───────────────────────────── */}
          <div className="relative w-[min(68vw,260px,31dvh)] aspect-square">
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 z-20">
              <div className="w-0 h-0 border-l-[10px] border-r-[10px] border-t-[17px] border-l-transparent border-r-transparent border-t-gold" />
            </div>
            <div
              className="w-full h-full rounded-full border-[4px] border-[#2a2a3a] shadow-[0_16px_44px_rgba(0,0,0,0.6)] relative overflow-hidden"
              style={{
                transform: `rotate(${rotation}deg)`,
                transition: `transform ${animMs('ring-of-fortune')}ms cubic-bezier(0.08, 0.7, 0.15, 1)`,
                background: `conic-gradient(${rim.map((id, i) => `${byId(id).color} ${(360 / total) * i}deg ${(360 / total) * (i + 1)}deg`).join(',')})`,
              }}
            >
              {picked && (
                <div
                  className="absolute inset-0"
                  style={{
                    background: `conic-gradient(${rim.map((id, i) => `${id === picked ? 'transparent' : 'rgba(0,0,0,0.58)'} ${(360 / total) * i}deg ${(360 / total) * (i + 1)}deg`).join(',')})`,
                  }}
                />
              )}
              {/* hollow middle makes it a RING rather than a disc */}
              <div className="absolute inset-[26%] rounded-full bg-[#10101c] border border-white/10" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              {landedTier ? (
                <span
                  className="t-label-lg font-black text-center leading-tight"
                  style={{ color: landedTier.color }}
                >
                  {landedTier.label}
                </span>
              ) : (
                <span className="text-gold/70 text-2xl">◈</span>
              )}
            </div>
          </div>

          {/* ── BACK A PRIZE ───────────────────────────────────────── */}
          <PickRow
            columns={5}
            disabled={spinning}
            value={picked}
            onChange={(v) => {
              sound.play('bet_place');
              setChoices({ ...choices, tier: v });
            }}
            options={tiers.map((t) => ({
              value: t.id,
              label: t.label === 'JACKPOT' ? 'JACK' : t.label.slice(0, 6),
              sub: `${tierPayout(t as never, total)}×`,
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

          <ResultBanner
            ready={flow.revealed}
            roundKey={flow.roundKey}
            result={result}
            multiplier={(outcome as { multiplier?: number })?.multiplier}
            payout={(outcome as { payout?: number })?.payout}
            accent={GOLD}
          />
        </div>
      </div>
    </GameBackdrop>
  );
}

export function RingOfFortuneBetPanel({
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
    Array.isArray(configured) && configured.length ? configured : RING_TIERS;
  const total = tiers.reduce((s, t) => s + t.slices, 0);
  const t = tiers.find((x) => x.id === picked);
  return (
    <BetBar
      minBet={minBet}
      maxBet={(config as { maxBet?: number } | undefined)?.maxBet}
      balance={balance}
      onBet={onBet}
      isLoading={isLoading}
      actionLabel="SPIN THE RING"
      selection={
        t
          ? `Prize ${t.id.toUpperCase()} · pays ${tierPayout(t, total).toFixed(2)}\u00d7`
          : null
      }
      requirement={picked ? null : 'Tap a prize to back it'}
      multiplier={t ? tierPayout(t as never, total) : null}
    />
  );
}
