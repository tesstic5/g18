// apps/web/src/components/admin/TowerLadderEditor.tsx — per-floor Tower × table.
// Each successful floor pays ladder[floor] × stake. The live climb
// (`towerSession` / `resolveTowerBoard`) reads this exact table.
'use client';
import { useMemo, useState } from 'react';
import {
  TOWER_FLOORS,
  TOWER_DIFFICULTY_IDS,
  DEFAULT_TOWER_DIFFS,
  DEFAULT_TOWER_LADDERS,
  fairTowerLadder,
  parseTowerLadder,
  towerHasConfiguredLadder,
  type TowerDifficulty,
} from '@casino/shared';

export type TowerLadders = Record<TowerDifficulty, number[]>;

export function laddersFromConfig(cj: Record<string, unknown>): TowerLadders {
  const diffs =
    typeof cj.difficulties === 'object' &&
    cj.difficulties &&
    !Array.isArray(cj.difficulties)
      ? (cj.difficulties as Record<string, unknown>)
      : {};
  const out = {} as TowerLadders;
  for (const id of TOWER_DIFFICULTY_IDS) {
    const d =
      typeof diffs[id] === 'object' && diffs[id] && !Array.isArray(diffs[id])
        ? (diffs[id] as Record<string, unknown>)
        : {};
    const nested = parseTowerLadder(d.payout_ladder);
    const top = parseTowerLadder(cj[`payout_ladder_${id}`]);
    out[id] = [...(nested ?? top ?? DEFAULT_TOWER_LADDERS[id])];
  }
  return out;
}

export function mergeTowerLadders(
  prev: Record<string, unknown>,
  ladders: TowerLadders
): Record<string, unknown> {
  const prevDiffs =
    typeof prev.difficulties === 'object' &&
    prev.difficulties &&
    !Array.isArray(prev.difficulties)
      ? (prev.difficulties as Record<string, unknown>)
      : {};
  const difficulties: Record<string, unknown> = {};
  for (const id of TOWER_DIFFICULTY_IDS) {
    const cur =
      typeof prevDiffs[id] === 'object' &&
      prevDiffs[id] &&
      !Array.isArray(prevDiffs[id])
        ? (prevDiffs[id] as Record<string, unknown>)
        : {};
    difficulties[id] = {
      columns_per_floor:
        cur.columns_per_floor ?? DEFAULT_TOWER_DIFFS[id].columns_per_floor,
      traps_per_floor: cur.traps_per_floor ?? DEFAULT_TOWER_DIFFS[id].traps_per_floor,
      payout_ladder: ladders[id],
    };
  }
  return {
    ...prev,
    floors: Number(prev.floors) || TOWER_FLOORS,
    difficulties,
    payout_ladder_easy: ladders.easy,
    payout_ladder_medium: ladders.medium,
    payout_ladder_hard: ladders.hard,
    payout_ladder_expert: ladders.expert,
  };
}

/** First blocking problem, or null if the tables are saveable. */
export function towerLadderIssue(ladders: TowerLadders): string | null {
  for (const id of TOWER_DIFFICULTY_IDS) {
    const { columns_per_floor: cols, traps_per_floor: traps } = DEFAULT_TOWER_DIFFS[id];
    const p = (cols - traps) / cols;
    const ladder = ladders[id];
    if (!Array.isArray(ladder) || ladder.length !== TOWER_FLOORS)
      return `${id}: need ${TOWER_FLOORS} floor multipliers`;
    for (let i = 0; i < ladder.length; i++) {
      const m = ladder[i]!;
      if (!Number.isFinite(m) || m <= 1)
        return `${id} floor ${i + 1}: multiplier must be greater than 1`;
      const rtp = Math.pow(p, i + 1) * m * 100;
      if (rtp > 99)
        return `${id} floor ${i + 1}: ${m}× is ${rtp.toFixed(1)}% RTP (max 99%)`;
    }
  }
  return null;
}

export function TowerLadderEditor({
  ladders,
  onChange,
  configJson,
  onSave,
  saving,
  saveDisabled,
}: {
  ladders: TowerLadders;
  onChange: (next: TowerLadders) => void;
  configJson: Record<string, unknown>;
  onSave?: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
}) {
  const [tab, setTab] = useState<TowerDifficulty>('medium');
  const liveFair = TOWER_DIFFICULTY_IDS.some(
    (id) => !towerHasConfiguredLadder(configJson, id)
  );
  const { columns_per_floor: cols, traps_per_floor: traps } = DEFAULT_TOWER_DIFFS[tab];
  const p = (cols - traps) / cols;
  const ladder = ladders[tab];
  const issue = useMemo(() => towerLadderIssue(ladders), [ladders]);

  const setRung = (index: number, raw: string) => {
    const n = Number(raw);
    onChange({
      ...ladders,
      [tab]: ladders[tab].map((v, i) => (i === index ? n : v)),
    });
  };

  return (
    <section className="rounded-xl bg-layer-surface border border-white/8 p-5">
      <h3 className="t-label-lg text-primary mb-2">🗼 FLOOR PAYOUTS</h3>
      <p className="t-label-sm text-muted mb-3">
        Each successful floor pays this × the stake. Cash-out RTP is P(survive that far)
        × multiplier — keep every row at or under 99%. Harder modes have fewer safe
        tiles, so the same number is a bigger giveaway on Easy than on Expert.
      </p>
      {liveFair && (
        <p className="t-label-sm mb-3 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-gold">
          Live game is still on the fair exponential table (expert floor 10 ≈ 9.4
          million ×) until you save. The numbers below are the recommended operator
          table.
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {TOWER_DIFFICULTY_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`h-9 px-3 rounded-full t-label-md ${
              tab === id
                ? 'bg-gold/15 border border-gold/40 text-gold'
                : 'bg-white/5 text-white/60'
            }`}
          >
            {id.toUpperCase()}
          </button>
        ))}
      </div>
      <p className="t-label-sm text-muted mb-2">
        {tab.toUpperCase()} · {cols} columns · {traps} trap{traps === 1 ? '' : 's'} ·
        survive {(p * 100).toFixed(0)}% per floor
      </p>
      <div className="rounded-lg border border-white/8 overflow-hidden mb-3">
        <div className="grid grid-cols-[56px_1fr_88px] bg-white/5 px-3 py-2 t-label-sm uppercase tracking-wide text-muted">
          <span>Floor</span>
          <span>Pays</span>
          <span>Cashout RTP</span>
        </div>
        {ladder.map((m, i) => {
          const rtp = Math.pow(p, i + 1) * (Number.isFinite(m) ? m : 0) * 100;
          const hot = rtp > 99 || !Number.isFinite(m) || m <= 1;
          return (
            <div
              key={i}
              className="grid grid-cols-[56px_1fr_88px] items-center px-3 py-1.5 border-t border-white/5"
            >
              <span className="t-num-sm text-white/60">{i + 1}</span>
              <label className="flex items-center gap-1">
                <input
                  type="number"
                  min={1.01}
                  step={0.05}
                  value={Number.isFinite(m) ? m : ''}
                  onChange={(e) => setRung(i, e.target.value)}
                  className="w-24 h-9 rounded bg-layer-elevated px-2 t-num-md text-white"
                />
                <span className="t-label-sm text-muted">×</span>
              </label>
              <span className={`t-num-sm ${hot ? 'text-red' : 'text-white/60'}`}>
                {Number.isFinite(rtp) ? `${rtp.toFixed(1)}%` : '—'}
              </span>
            </div>
          );
        })}
      </div>
      {issue && (
        <p className="t-label-sm text-red mb-3 px-3 py-2 rounded-lg bg-red/10 border border-red/30">
          {issue}
        </p>
      )}
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          onClick={() =>
            onChange({ ...ladders, [tab]: [...DEFAULT_TOWER_LADDERS[tab]] })
          }
          className="t-label-md text-gold"
        >
          Recommended table
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({
              ...ladders,
              [tab]: fairTowerLadder(cols, traps),
            })
          }
          className="t-label-md text-white/50"
        >
          Fair (high ×)
        </button>
      </div>
      {onSave && (
        <button
          type="button"
          disabled={saveDisabled || saving}
          onClick={onSave}
          className={`btn-primary w-full ${saveDisabled ? '!bg-white/5 !text-white/25 !shadow-none !border-white/10 cursor-not-allowed' : ''}`}
        >
          {saving ? 'SAVING…' : 'SAVE FLOOR PAYOUTS'}
        </button>
      )}
    </section>
  );
}
