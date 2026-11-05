// apps/web/src/components/admin/GameConfigEditor.tsx — real-time validated odds editor
// (v4 GAME CONTROLS + docs/19 §17 two-column layout) + UserDetail + AdminLiveFeed.
'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { socket } from '../../lib/app';
import { validateConfig } from '../../../../../packages/shared/src/utils/validateConfig';
import { notify } from '../../lib/toast';
import { adminGameDto, parseDto } from '../../lib/dto';
import {
  TowerLadderEditor,
  laddersFromConfig,
  mergeTowerLadders,
  towerLadderIssue,
  type TowerLadders,
} from './TowerLadderEditor';
import { DEFAULT_TOWER_LADDERS } from '@casino/shared';

interface Config {
  slug: string;
  displayName: string;
  isActive?: boolean;
  baseRtp: number | string;
  winRate: number | string;
  maxWinMultiplier: number | string;
  configJson: Record<string, unknown>;
  totalRounds: number;
  totalWagered: number | string;
  totalPaidOut: number | string;
  effectiveRtp: number | string | null;
  forceOverride?: 'NONE' | 'FORCE_WIN' | 'FORCE_LOSE';
  forceRoundsLeft?: number;
  forceMaxPayout?: string | number | null;
  outcomeOverridesEnabled?: boolean;
  difficultyCapable?: boolean;
  /** Per-game difficulty override; null = follow the platform default. */
  difficulty?: 'easy' | 'normal' | 'hard' | 'impossible' | null;
}

export function GameConfigEditor({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const {
    data: cfg,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['admin-game', slug],
    queryFn: async () =>
      parseDto(
        adminGameDto,
        await http.get<unknown>(`/panel/games/${slug}`),
        'Admin game configuration'
      ) as Config,
  });
  const [winRate, setWinRate] = useState(45);
  const [weights, setWeights] = useState<Array<{ multiplier: number; weight: number }>>(
    []
  );
  const [force, setForce] = useState<{
    mode: 'NONE' | 'FORCE_WIN' | 'FORCE_LOSE';
    rounds: number;
    maxPayout: number;
  }>({ mode: 'NONE', rounds: 0, maxPayout: 0 });
  const [jsonTab, setJsonTab] = useState(false);
  const [advancedJson, setAdvancedJson] = useState('{}');
  const [difficulty, setDifficulty] = useState<
    'platform' | 'easy' | 'normal' | 'hard' | 'impossible'
  >('platform');
  const [towerLadders, setTowerLadders] = useState<TowerLadders>({
    easy: [...DEFAULT_TOWER_LADDERS.easy],
    medium: [...DEFAULT_TOWER_LADDERS.medium],
    hard: [...DEFAULT_TOWER_LADDERS.hard],
    expert: [...DEFAULT_TOWER_LADDERS.expert],
  });

  useEffect(() => {
    if (!cfg) return;
    setWinRate(Number(cfg.winRate));
    const w = (
      cfg.configJson as {
        payout_weights?: Array<{ multiplier: number; weight: number }>;
      }
    )?.payout_weights ?? [{ multiplier: 2, weight: 1 }];
    setWeights(w);
    setAdvancedJson(JSON.stringify(cfg.configJson, null, 2));
    // Reflect the force state that is actually live, otherwise the panel always
    // opened on "NONE" and an admin could not see that a force was still running.
    setForce({
      mode: cfg.forceOverride ?? 'NONE',
      rounds: Number(cfg.forceRoundsLeft ?? 0),
      maxPayout: Number(cfg.forceMaxPayout ?? 0),
    });
    setDifficulty(cfg.difficulty ?? 'platform');
    if (slug === 'tower') setTowerLadders(laddersFromConfig(cfg.configJson));
  }, [cfg, slug]);

  // Crash games settle from HMAC + crash_distribution, never payout_weights.
  // Seeded Aviator weights compute ~213% RTP and used to disable SAVE (and
  // hide/show) even though the engine never reads them.
  const crashGame = slug === 'aviator' || slug === 'crash-x';
  const towerGame = slug === 'tower';
  const validation = useMemo(
    () =>
      crashGame
        ? {
            valid: true,
            calculatedRtp: 96.5,
            houseEdge: 3.5,
            error: undefined as string | undefined,
          }
        : validateConfig({
            winRate,
            payoutWeights: weights.length ? weights : [{ multiplier: 2, weight: 1 }],
            maxWinMultiplier: Number(cfg?.maxWinMultiplier ?? 25),
          }),
    [crashGame, winRate, weights, cfg]
  );

  const live = cfg
    ? {
        forceOverride: cfg.forceOverride ?? 'NONE',
        forceRoundsLeft: Number(cfg.forceRoundsLeft ?? 0),
      }
    : null;

  /**
   * Force override posts to its OWN endpoint.
   *
   * PATCH /panel/games/:slug rewrites the odds config; the force controls sat in
   * a separate card with no button of their own, so the only way to apply them
   * was the odds save button in the section above — which is not where anyone
   * looks, and which also rewrites the payout table as a side effect.
   * /force is the dedicated route and it busts the config cache, so the change
   * lands on the very next bet.
   */
  const applyForce = useMutation({
    mutationFn: () =>
      http.patch(`/panel/games/${slug}/force`, {
        forceOverride: force.mode,
        rounds: force.mode === 'NONE' ? 0 : force.rounds,
        maxPayout: force.mode === 'NONE' ? undefined : force.maxPayout || undefined,
      }),
    onSuccess: () => {
      notify.success(
        force.mode === 'NONE'
          ? 'Force override turned off'
          : `${force.mode.replace('_', ' ')} applied to everyone for ${force.rounds} round${force.rounds === 1 ? '' : 's'}`
      );
      void qc.invalidateQueries({ queryKey: ['admin-game', slug] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const saveDifficulty = useMutation({
    mutationFn: () =>
      http.patch(`/panel/games/${slug}`, {
        difficulty: difficulty === 'platform' ? null : difficulty,
      }),
    onSuccess: () => {
      notify.success(
        difficulty === 'platform'
          ? 'Game follows the platform difficulty again'
          : `Difficulty set to ${difficulty.toUpperCase()} for this game`
      );
      qc.invalidateQueries({ queryKey: ['admin-game', slug] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        winRate,
        configJson: jsonTab
          ? JSON.parse(advancedJson)
          : towerGame
            ? mergeTowerLadders(cfg?.configJson ?? {}, towerLadders)
            : { ...(cfg?.configJson ?? {}), payout_weights: weights },
      };
      if (towerGame && !jsonTab) {
        const top = Math.max(...Object.values(towerLadders).flatMap((rungs) => rungs));
        body.maxWinMultiplier = Math.max(
          Number(cfg?.maxWinMultiplier ?? 0),
          Math.ceil(top)
        );
      }
      return http.patch(`/panel/games/${slug}`, body);
    },
    onSuccess: () => {
      notify.success(
        towerGame
          ? 'Floor payouts saved — next climb uses the new table'
          : 'Saved — effective RTP ' + validation.calculatedRtp.toFixed(2) + '%'
      );
      void qc.invalidateQueries({ queryKey: ['admin-game', slug] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const toggleVisible = useMutation({
    mutationFn: () =>
      http.patch(`/panel/games/${slug}`, { isActive: !(cfg?.isActive ?? true) }),
    onSuccess: () => {
      notify.success(
        cfg?.isActive
          ? 'Hidden from lobby — players cannot open it'
          : 'Visible in lobby'
      );
      void qc.invalidateQueries({ queryKey: ['admin-game', slug] });
      void qc.invalidateQueries({ queryKey: ['panel-games'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  if (isLoading) {
    return (
      <div
        className="h-64 skeleton rounded-xl"
        aria-label="Loading game configuration"
      />
    );
  }
  if (error || !cfg) {
    return (
      <div className="rounded-xl bg-red/10 border border-red/30 p-5">
        <h2 className="t-label-lg text-red">Could not load game configuration</h2>
        <p className="t-label-sm text-white/60 mt-1">
          {(error as Error | null)?.message ?? 'The game was not found.'}
        </p>
        <button onClick={() => void refetch()} className="btn-ghost h-10 px-4 mt-4">
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="grid lg:grid-cols-[3fr_2fr] gap-6">
      {/* LEFT — controls (docs/19 §17) */}
      <div className="space-y-6">
        <section className="rounded-xl bg-layer-surface border border-white/8 p-5">
          <h3 className="t-label-lg text-primary mb-2">Visibility</h3>
          <p className="t-label-sm text-muted mb-3">
            Hidden games leave the lobby and reject new bets. The Games list Visible
            toggle does the same thing.
          </p>
          <button
            type="button"
            onClick={() => toggleVisible.mutate()}
            disabled={toggleVisible.isPending}
            className={`h-10 px-4 rounded-lg t-label-md ${
              cfg.isActive ? 'bg-green/15 text-green' : 'bg-white/5 text-white/40'
            }`}
          >
            {cfg.isActive ? 'Visible' : 'Hidden'}
          </button>
        </section>
        {towerGame && (
          <TowerLadderEditor
            ladders={towerLadders}
            onChange={setTowerLadders}
            configJson={cfg.configJson}
            onSave={() => save.mutate()}
            saving={save.isPending}
            saveDisabled={!validation.valid}
          />
        )}
        <section className="rounded-xl bg-layer-surface border border-white/8 p-5">
          <h3 className="t-label-lg text-primary mb-4">🎛️ ODDS CONFIGURATION</h3>
          <label className="block mb-2">
            <span className="t-label-md text-secondary block mb-2">
              Win Rate: <b className="text-primary">{winRate.toFixed(2)}%</b>
            </span>
            <input
              type="range"
              min={1}
              max={98}
              step={0.01}
              value={winRate}
              disabled
              className="w-full accent-gold opacity-50 cursor-not-allowed"
            />
          </label>
          <p className="t-label-sm text-muted mb-4">
            Legacy reporting field (read-only). The server does not search or replace
            committed seed outcomes to hit a target win rate. Each legal player choice
            keeps its own audited probability and payout table.
          </p>

          {/* PAYOUT WEIGHT TABLE — unused by Tower (per-floor ladders below). */}
          {!towerGame && (
            <>
              <p className="t-label-md text-secondary mb-2">Payout Weights</p>
              {crashGame && (
                <p className="t-label-sm text-muted mb-2">
                  Aviator / CrashX pay from the crash curve, not this table. Hide/show
                  the game from the Games list (Visible). Advanced JSON holds
                  <span className="t-mono"> crash_distribution</span>.
                </p>
              )}
              <div className="rounded-lg border border-white/8 overflow-hidden mb-3">
                <div className="grid grid-cols-[1fr_1fr_1fr_32px] bg-white/5 px-3 py-2 t-label-sm uppercase tracking-wide text-muted">
                  <span>Multiplier</span>
                  <span>Weight</span>
                  <span>Prob</span>
                  <span />
                </div>
                {weights.map((w, i) => {
                  const total = weights.reduce((s, x) => s + x.weight, 0) || 1;
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_1fr_1fr_32px] items-center px-3 py-1.5 border-t border-white/5"
                    >
                      <input
                        value={w.multiplier}
                        onChange={(e) =>
                          setWeights((ws) =>
                            ws.map((x, j) =>
                              j === i ? { ...x, multiplier: +e.target.value } : x
                            )
                          )
                        }
                        className="w-20 h-9 rounded bg-layer-elevated px-2 t-num-md"
                      />
                      <input
                        value={w.weight}
                        onChange={(e) =>
                          setWeights((ws) =>
                            ws.map((x, j) =>
                              j === i ? { ...x, weight: +e.target.value } : x
                            )
                          )
                        }
                        className="w-16 h-9 rounded bg-layer-elevated px-2 t-num-md"
                      />
                      <span className="t-num-sm text-white/60">
                        {((w.weight / total) * 100).toFixed(2)}%
                      </span>
                      <button
                        onClick={() => setWeights((ws) => ws.filter((_, j) => j !== i))}
                        className="text-red/60"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={() =>
                  setWeights((ws) => [...ws, { multiplier: 1, weight: 1 }])
                }
                className="t-label-md text-gold mb-4"
              >
                + Add Payout Row
              </button>
            </>
          )}
          {towerGame && (
            <p className="t-label-sm text-muted mb-4">
              Tower pays the per-floor table in the card below, not this weight list.
              Save Floor Payouts to change what each successful step pays.
            </p>
          )}

          {/* LIVE VALIDATION (docs/19 §17 — blocks >99%, shows calc) */}
          <div
            className={`rounded-lg p-3 mb-4 t-label-md ${validation.valid ? 'bg-green/10 border border-green/30 text-green' : 'bg-red/10 border border-red/30 text-red'}`}
          >
            {towerGame ? (
              validation.valid ? (
                <>✅ Floor table is within the 99% RTP ceiling. Save to apply.</>
              ) : (
                <>❌ {validation.error}</>
              )
            ) : validation.valid ? (
              <>
                ✅ Calculated RTP: <b>{validation.calculatedRtp.toFixed(2)}%</b> · House
                Edge: {validation.houseEdge.toFixed(2)}% · Within 99% ceiling
              </>
            ) : (
              <>❌ {validation.error}</>
            )}
          </div>
          <button
            disabled={!validation.valid || save.isPending}
            onClick={() => save.mutate()}
            className={`btn-primary w-full ${!validation.valid ? '!bg-white/5 !text-white/25 !shadow-none !border-white/10 cursor-not-allowed' : ''}`}
          >
            {towerGame ? 'SAVE FLOOR PAYOUTS' : 'SAVE ODDS CONFIG'}
          </button>
        </section>

        {/* PLAYER DIFFICULTY — per-game override of the platform default.
            Session games (mines/tower/stairs/hi-lo) can't be steered mid-round
            (player owns each move), so the control stays hidden for them.
            Crash steers via takeoff-survival; WinGo via lock-time book fade —
            hidden ONLY where the API marks difficultyCapable=false. */}
        {cfg.difficultyCapable ? (
          <section className="rounded-xl bg-layer-surface border border-white/8 p-5">
            <h3 className="t-label-lg text-primary mb-3">🎚️ PLAYER DIFFICULTY</h3>
            <p className="t-label-sm text-muted mb-1">
              Scales how often players WIN on this game — payouts never change. Applied
              ONLY to this game; other games are untouched.
            </p>
            {slug === 'wingo' && (
              <p className="t-label-sm text-muted mb-3">
                WinGo — one 1.96× table for all four durations. Easy and Normal draw
                HMAC 0–9 (ignore the book). Hard usually fades the cheapest
                winning-stake digit (~80%) and is fair the rest of the time. Impossible
                always fades. Same pick for one player or many.
              </p>
            )}
            {slug !== 'wingo' && (
              <p className="t-label-sm text-muted mb-3">
                The win banner, wallet and game animation always agree: a round is drawn
                first, then shown exactly as it landed.
              </p>
            )}
            <div className="flex flex-wrap gap-2 mb-4">
              {(
                [
                  [
                    'platform',
                    'Platform default',
                    slug === 'wingo' ? 'follows Settings (HMAC)' : 'follows Settings',
                  ],
                  [
                    'easy',
                    'Easy',
                    slug === 'wingo' ? 'HMAC fair draw' : '×1.5 win chance',
                  ],
                  [
                    'normal',
                    'Normal',
                    slug === 'wingo' ? 'HMAC fair draw' : 'the configured odds',
                  ],
                  [
                    'hard',
                    'Hard',
                    slug === 'wingo' ? 'usually fade the book' : '×0.5 win chance',
                  ],
                  [
                    'impossible',
                    'Impossible',
                    slug === 'wingo' ? 'always fade the book' : '×0.1 win chance',
                  ],
                ] as const
              ).map(([value, label, sub]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDifficulty(value)}
                  className={`min-w-28 rounded-xl border px-3 py-2.5 text-left transition-all ${
                    difficulty === value
                      ? value === 'platform'
                        ? 'bg-blue/15 border-blue/50 text-blue'
                        : 'bg-gold/15 border-gold/50 text-gold'
                      : 'bg-white/5 border-white/10 text-white/60 hover:border-white/25'
                  }`}
                >
                  <span className="t-label-md block">{label}</span>
                  <span className="t-label-sm opacity-70">{sub}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => saveDifficulty.mutate()}
              disabled={saveDifficulty.isPending}
              className="btn-primary w-full disabled:opacity-40"
            >
              SAVE DIFFICULTY
            </button>
          </section>
        ) : null}

        {/* Force overrides are a production operator feature: they steer real
            money rounds (with audit trail + per-player liability caps), so the
            UI copy must be precise about that. */}
        {cfg.outcomeOverridesEnabled ? (
          <section className="rounded-xl bg-layer-surface border border-white/8 p-5">
            <h3 className="t-label-lg text-primary mb-3">⚡ FORCE OVERRIDE</h3>
            <div className="flex gap-2 mb-3">
              {(['NONE', 'FORCE_WIN', 'FORCE_LOSE'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setForce((f) => ({ ...f, mode: m }))}
                  className={`h-9 px-4 rounded-full t-label-md ${force.mode === m ? 'bg-gold/15 border-gold/40 text-gold' : 'bg-white/5 text-white/60'}`}
                >
                  {m.replace('_', ' ')}
                </button>
              ))}
            </div>
            <p className="t-label-sm text-muted mb-3">
              Applies to <b className="text-white/80">everyone</b> playing this game,
              for the next N rounds. The screen shows exactly what happened and the
              wallet matches — a forced round is a real, verifiable round, not a payout
              stapled on afterwards. It switches itself off when the rounds run out.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="t-label-sm text-secondary">
                Rounds
                <input
                  type="number"
                  min={0}
                  value={force.rounds}
                  onChange={(e) => setForce((f) => ({ ...f, rounds: +e.target.value }))}
                  className="w-full h-10 mt-1 rounded bg-layer-elevated px-2 t-num-md text-white"
                />
              </label>
              <label className="t-label-sm text-secondary">
                Max payout / win
                <input
                  type="number"
                  min={0}
                  value={force.maxPayout}
                  onChange={(e) =>
                    setForce((f) => ({ ...f, maxPayout: +e.target.value }))
                  }
                  className="w-full h-10 mt-1 rounded bg-layer-elevated px-2 t-num-md text-white"
                />
              </label>
            </div>

            {/* Force had NO apply button of its own — the only way to save it was
              the "SAVE ODDS CONFIG" button in the section above, which is not
              where anyone would look for it, and which also rewrites the payout
              table. It now posts to the dedicated /force endpoint, which busts
              the config cache so the change takes effect on the very next bet. */}
            <button
              onClick={() => applyForce.mutate()}
              disabled={
                applyForce.isPending || (force.mode !== 'NONE' && force.rounds < 1)
              }
              className={`w-full h-11 mt-4 rounded-xl t-label-md font-black tracking-wide transition-all ${
                force.mode === 'FORCE_WIN'
                  ? 'bg-green/20 border border-green/50 text-green'
                  : force.mode === 'FORCE_LOSE'
                    ? 'bg-red/20 border border-red/50 text-red'
                    : 'bg-white/5 border border-white/10 text-white/70'
              } disabled:opacity-40`}
            >
              {applyForce.isPending
                ? 'APPLYING…'
                : force.mode === 'NONE'
                  ? 'TURN FORCE OFF'
                  : force.mode === 'FORCE_WIN'
                    ? `FORCE EVERYONE TO WIN · ${force.rounds} ROUNDS`
                    : `FORCE EVERYONE TO LOSE · ${force.rounds} ROUNDS`}
            </button>

            {live && live.forceOverride !== 'NONE' && (
              <p className="t-label-sm mt-3 px-3 py-2 rounded-lg bg-gold/10 border border-gold/30 text-gold">
                ⚡ Live now: <b>{live.forceOverride.replace('_', ' ')}</b> for{' '}
                {live.forceRoundsLeft} more round{live.forceRoundsLeft === 1 ? '' : 's'}
              </p>
            )}
          </section>
        ) : (
          <section className="rounded-xl bg-layer-surface border border-white/8 p-5">
            <h3 className="t-label-lg text-primary mb-2">Outcome overrides</h3>
            <p className="t-label-sm text-muted">
              Disabled for real-money and production environments. Results are derived
              from the committed seed and the player’s selection only.
            </p>
          </section>
        )}

        {/* ADVANCED (docs/19 §17 — collapsed JSON/visual tab) */}
        <section className="rounded-xl bg-layer-surface border border-white/8 p-5">
          <button
            className="t-label-lg text-primary"
            onClick={() => setJsonTab((t) => !t)}
          >
            ⚙️ ADVANCED CONFIG {jsonTab ? '▼' : '▶'}
          </button>
          {jsonTab && (
            <textarea
              value={advancedJson}
              onChange={(e) => setAdvancedJson(e.target.value)}
              rows={14}
              className="w-full mt-3 rounded-lg bg-layer-elevated p-3 t-mono text-white/80 outline-none"
            />
          )}
        </section>
      </div>

      {/* RIGHT — live stats (docs/19 §17) */}
      <aside className="rounded-xl bg-layer-surface border border-white/8 p-5 h-fit space-y-3">
        <h3 className="t-label-lg text-primary">LIVE STATS (all time)</h3>
        <Row
          k="Effective RTP"
          v={
            cfg.effectiveRtp != null && Number.isFinite(Number(cfg.effectiveRtp))
              ? `${Number(cfg.effectiveRtp).toFixed(2)}%`
              : '—'
          }
        />
        <Row k="Target RTP" v={`${Number(cfg.baseRtp).toFixed(2)}%`} />
        <Row k="Total rounds" v={String(cfg.totalRounds)} />
        <Row k="Total wagered" v={`$${Number(cfg.totalWagered).toLocaleString()}`} />
        <Row k="Total paid out" v={`$${Number(cfg.totalPaidOut).toLocaleString()}`} />
        <Row
          k="House profit"
          v={`$${(Number(cfg.totalWagered) - Number(cfg.totalPaidOut)).toLocaleString()}`}
          gold
        />
        <p className="t-label-sm text-muted pt-2 border-t border-white/5">
          Force override:{' '}
          {force.mode === 'NONE'
            ? '● None active'
            : `● ${force.mode} (${force.rounds} rounds left)`}
        </p>
      </aside>
    </div>
  );
}
function Row({ k, v, gold }: { k: string; v: string; gold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="t-label-md text-secondary">{k}</span>
      <span className={`t-num-md ${gold ? 'text-gold' : 'text-primary'}`}>{v}</span>
    </div>
  );
}

// ── USER DETAIL (v4) ───────────────────────────────────────────────────────
export function UserDetail({ userId }: { userId: string }) {
  const { data: user } = useQuery({
    queryKey: ['admin-user', userId],
    queryFn: () =>
      http.get<{
        id: string;
        displayName?: string;
        phone: string;
        status: string;
        wallet: { real: number; bonus: number; gifted: number };
      }>(`/panel/users/${userId}`),
  });
  const fund = useMutation({
    mutationFn: (v: { walletType: string; amount: number }) =>
      http.post(`/panel/users/${userId}/fund`, v),
    onSuccess: () => notify.success('Funded — audit logged'),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-layer-surface border border-white/8 p-4 flex items-center justify-between">
        <div>
          <p className="t-label-lg text-primary">{user?.displayName || 'Player'}</p>
          <p className="t-label-sm text-secondary">
            {user?.phone} · {user?.status}
          </p>
        </div>
        <button
          className="h-9 px-4 rounded-lg bg-red/15 border border-red/30 t-label-md text-red"
          onClick={() => http.patch(`/panel/users/${userId}`, { status: 'SUSPENDED' })}
        >
          Suspend
        </button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {(['real', 'bonus', 'gifted'] as const).map((t) => (
          <div
            key={t}
            className="rounded-xl bg-layer-surface border border-white/8 p-4"
          >
            <p className="t-label-sm text-secondary capitalize">{t}</p>
            <p className="t-num-lg text-primary">${user?.wallet[t] ?? 0}</p>
            <button
              onClick={() => fund.mutate({ walletType: t, amount: 100 })}
              className="t-label-sm text-gold mt-2"
            >
              + Fund 100
            </button>
          </div>
        ))}
      </div>
      {/* tabs: transactions / game rounds / deposits / withdrawals / activity — fetch per tab via /panel/users/:id/:tab */}
    </div>
  );
}

// ── ADMIN LIVE FEED (v4 + v4 socket spec) ──────────────────────────────────
export function AdminLiveFeed() {
  const [rows, setRows] = useState<
    Array<{
      userId_masked: string;
      game: string;
      betAmount: number;
      result: string;
      payoutAmount: number;
    }>
  >([]);
  useEffect(() => {
    const onBet = (r: unknown) => setRows((rows) => [r as never, ...rows].slice(0, 50));
    const onDep = (d: unknown) =>
      setRows((rows) =>
        [
          {
            userId_masked: 'NEW DEPOSIT',
            game: 'deposits',
            betAmount: (d as { amount: number }).amount,
            result: 'pending',
            payoutAmount: 0,
          } as never,
          ...rows,
        ].slice(0, 50)
      );
    socket.on('admin:live-bet', onBet);
    socket.on('admin:new-deposit', onDep);
    return () => {
      socket.off('admin:live-bet', onBet);
      socket.off('admin:new-deposit', onDep);
    };
  }, []);
  return (
    <div className="rounded-xl bg-layer-surface border border-white/8 overflow-hidden">
      <p className="t-label-md text-secondary px-4 py-3 border-b border-white/5">
        LIVE FEED
      </p>
      <div className="max-h-96 overflow-y-auto">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-3 px-4 py-2 text-sm border-b border-white/5">
            <span className="t-label-md text-white/70 w-24 truncate">
              {r.userId_masked}
            </span>
            <span className="t-label-sm text-white/40">{r.game}</span>
            <span className="t-num-md text-white/60 ml-auto">${r.betAmount}</span>
            <span
              className={`t-num-md ${r.result === 'win' ? 'text-green' : 'text-white/40'}`}
            >
              {r.result}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="t-label-sm text-muted p-4">Waiting for live bets…</p>
        )}
      </div>
    </div>
  );
}
