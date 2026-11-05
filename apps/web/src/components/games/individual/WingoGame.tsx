// apps/web/src/components/games/individual/WingoGame.tsx — WinGo, rebuilt to
// match the reference screenshots exactly (light "PAK Games" styling).
//
// Layout, top to bottom:
//   • wallet card (balance + Withdraw / Deposit)
//   • scrolling notice bar with a "Detail" chip
//   • four lottery-time tabs (WinGo 30sec / 1Min / 3Min / 5Min)
//   • red period banner: "How to play" · last-5 result balls · time remaining
//     (per-digit flip cards) · period number
//   • Green / Violet / Red bet buttons
//   • 0-9 ball grid (0 and 5 are dual-colour)
//   • Random + X1..X100 multiplier chips
//   • Big / Small pills
//   • Game history | Chart | My history tabs
//   • Statistic (last 100 Periods): Winning Numbers, Missing, Avg missing,
//     Frequency, Max consecutive
//   • trend rows: period + 0-9 dots with the winner filled, connected by a
//     polyline, and a B/S badge — with < page/total > pagination
//
// Betting locks in the final 5 seconds; the countdown turns red and the board
// is covered by the flip-card overlay exactly as in the reference.
'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { sound } from '../../../lib/sound';
import { socket } from '../../../lib/app';
import { http } from '../../../lib/api';
import { vibrate } from '../../../hooks';
import { useWalletStore, useAuthStore, useDisplayBalance } from '../../../stores';
import {
  COLOR_OF,
  PAYOUTS,
  choiceMultiplier,
  DURATIONS,
  WingoDuration,
  clampDuration,
  computeWingoStats,
  choiceWins,
  trendRowsFor,
  lastResultsFor,
} from './wingo-core';
import { WG, ballGradient, dotColor, sizeBadge } from './wingo-theme';
import type { GameVisualProps, GameBetPanelProps } from '../types';
import {
  wingoRoundsDto,
  wingoHistoryDto,
  wingoHistoryListDto,
  gameHistoryDto,
} from '../../../lib/dto';

interface HistoryEntry {
  number: number;
  color: string;
  period: string;
  at: number;
}
interface DurationRound {
  period: string | null;
  endsAt: number | null;
  remaining: number | null;
  lastResult: HistoryEntry | null;
}
const EMPTY_ROUND: DurationRound = {
  period: null,
  endsAt: null,
  remaining: null,
  lastResult: null,
};

interface WingoRoundStore {
  duration: WingoDuration;
  rounds: Record<number, DurationRound>;
  historyByDur: Record<number, HistoryEntry[]>;
  /** §9: payout table straight from the server (falls back to the compile-time
   *  defaults until the /rounds snapshot lands). */
  payouts: Record<string, number>;
  popupOpen: boolean;
  /**
   * My bets in the CURRENT period of each duration ("Red ₨10 · ⑦ ₨20").
   * Real WinGo is built around stacking several targets into the same period;
   * this strip is the player's receipt of what is riding on the draw. Cleared
   * when that duration's next period starts.
   */
  myBets: Record<
    number,
    Array<{ period: string; choice: string | number; amount: number }>
  >;
  setDuration: (d: WingoDuration) => void;
  setPayouts: (p: Record<string, number>) => void;
  setRound: (dur: number, p: Partial<DurationRound>) => void;
  appendResult: (dur: number, r: HistoryEntry) => void;
  setHistory: (dur: number, list: HistoryEntry[]) => void;
  setPopupOpen: (open: boolean) => void;
  addBet: (
    dur: number,
    bet: { period: string; choice: string | number; amount: number }
  ) => void;
  clearBets: (dur: number, newPeriod: string | null) => void;
}
/** Shared round state — the Visual drives it from socket events; the bet panel reads it. */
const useWingoRound = create<WingoRoundStore>((set) => ({
  duration: 30,
  rounds: {
    30: { ...EMPTY_ROUND },
    60: { ...EMPTY_ROUND },
    180: { ...EMPTY_ROUND },
    300: { ...EMPTY_ROUND },
  },
  historyByDur: { 30: [], 60: [], 180: [], 300: [] },
  payouts: PAYOUTS,
  popupOpen: false,
  myBets: { 30: [], 60: [], 180: [], 300: [] },
  setDuration: (d) => set({ duration: d }),
  setPayouts: (p) => set({ payouts: p }),
  setRound: (dur, p) =>
    set((s) => ({
      rounds: { ...s.rounds, [dur]: { ...(s.rounds[dur] ?? EMPTY_ROUND), ...p } },
    })),
  appendResult: (dur, r) =>
    set((s) => ({
      rounds: {
        ...s.rounds,
        [dur]: { ...(s.rounds[dur] ?? EMPTY_ROUND), lastResult: r },
      },
      historyByDur: {
        ...s.historyByDur,
        [dur]: [
          ...(s.historyByDur[dur] ?? []).filter((h) => h.period !== r.period),
          r,
        ].slice(-100),
      },
    })),
  setHistory: (dur, list) =>
    set((s) => ({ historyByDur: { ...s.historyByDur, [dur]: list.slice(-100) } })),
  setPopupOpen: (open) => set({ popupOpen: open }),
  addBet: (dur, bet) =>
    set((s) => {
      const list = (s.myBets[dur] ?? []).filter(
        (b) => !(b.period === bet.period && b.choice === bet.choice)
      );
      return { myBets: { ...s.myBets, [dur]: [...list, bet] } };
    }),
  clearBets: (dur, newPeriod) =>
    set((s) => ({
      myBets: {
        ...s.myBets,
        [dur]: (s.myBets[dur] ?? []).filter((b) => b.period === newPeriod),
      },
    })),
}));

/** Tab label exactly as the reference renders it ("WinGo 30sec", "WinGo 1Min"…). */
const tabLabel = (d: WingoDuration) =>
  d === 30 ? '30sec' : d === 60 ? '1Min' : d === 180 ? '3Min' : '5Min';

/** Countdown split into individual digits for the flip-card display. */
function clockDigits(sec: number | null): [string, string, string, string] {
  if (sec === null) return ['-', '-', '-', '-'];
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return [mm[0]!, mm[1]!, ss[0]!, ss[1]!];
}

const CURRENCY = () => process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨';

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational pieces
// ─────────────────────────────────────────────────────────────────────────────

/** A 0-9 lottery ball (0 and 5 are split-colour, as in real WinGo). */
function Ball({
  n,
  size = 46,
  dim = false,
}: {
  n: number;
  size?: number;
  dim?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-black text-white select-none"
      style={{
        width: size,
        height: size,
        background: ballGradient(n),
        fontSize: size * 0.46,
        opacity: dim ? 0.45 : 1,
        boxShadow:
          'inset 0 -3px 6px rgba(0,0,0,0.18), inset 0 3px 6px rgba(255,255,255,0.35), 0 2px 4px rgba(0,0,0,0.12)',
        textShadow: '0 1px 2px rgba(0,0,0,0.35)',
      }}
    >
      {n}
    </span>
  );
}

/** One digit of the countdown, rendered as a white flip card. */
function ClockCard({ ch }: { ch: string }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-[5px] bg-white font-black tabular-nums"
      style={{
        width: 22,
        height: 30,
        color: WG.text,
        fontSize: 19,
        boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
      }}
    >
      {ch}
    </span>
  );
}

/** Rolling digits shown while the server draws the period's winning number —
 * the real game never leaves the board dead-tappable during the draw. */
function RollingDigits() {
  const [digits, setDigits] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const iv = setInterval(
      () => setDigits([Math.floor(Math.random() * 10), Math.floor(Math.random() * 10)]),
      70
    );
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="flex items-center justify-center gap-3">
      {digits.map((d, i) => (
        <span
          key={i}
          className="inline-flex items-center justify-center rounded-2xl bg-white font-black"
          style={{ width: 96, height: 128, color: WG.red, fontSize: 74 }}
        >
          {d}
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual
// ─────────────────────────────────────────────────────────────────────────────

type ViewTab = 'history' | 'chart' | 'my';
/** A settled bet belonging to me, from `wingo:my-result` (one per bet). */
type MySettleRow = {
  choice: string | number;
  betAmount: number;
  result: string;
  multiplier: number;
  payout: number;
  number: number;
  color: string;
};
/** All my settled bets of one round, aggregated — stacked targets each get a line. */
type MySettle = {
  key: string;
  dur: number;
  period: string;
  rows: MySettleRow[];
  shownAt: number;
};

export function WingoVisual({ outcome, choices, setChoices }: GameVisualProps) {
  const duration = useWingoRound((s) => s.duration);
  const setDuration = useWingoRound((s) => s.setDuration);
  const roundsAll = useWingoRound((s) => s.rounds);
  const round = roundsAll[duration] ?? EMPTY_ROUND;
  const history = useWingoRound((s) => s.historyByDur[duration] ?? []);
  const setRound = useWingoRound((s) => s.setRound);
  const appendResult = useWingoRound((s) => s.appendResult);
  const setHistory = useWingoRound((s) => s.setHistory);
  const setPopupOpen = useWingoRound((s) => s.setPopupOpen);

  // Balance-hold display rule: stay frozen while bets await their draw.
  const balance = useDisplayBalance();
  const user = useAuthStore((s) => s.user);

  const [howTo, setHowTo] = useState(false);
  const [viewTab, setViewTab] = useState<ViewTab>('chart');
  const [listPage, setListPage] = useState(1);
  const listPageRef = useRef(listPage);
  listPageRef.current = listPage;
  const [list, setList] = useState<{
    rows: HistoryEntry[];
    total: number;
    pages: number;
  }>({ rows: [], total: 0, pages: 1 });
  const [myHistory, setMyHistory] = useState<Array<Record<string, unknown>> | null>(
    null
  );
  /** Result overlay: the reference covers the board with two huge flip cards. */
  const [reveal, setReveal] = useState<{ number: number } | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRevealKey = useRef<string | null>(null);
  const res = (outcome as { number?: number } | null) || null;

  const showReveal = (number: number, key: string) => {
    if (lastRevealKey.current === key) return;
    lastRevealKey.current = key;
    if (revealTimer.current) clearTimeout(revealTimer.current);
    setReveal({ number });
    sound.play('wheel_stop');
    vibrate([25, 35, 25]);
    revealTimer.current = setTimeout(() => setReveal(null), 2600);
  };

  // WIN / LOSE announcement. The server emits one `wingo:my-result` per settled
  // bet — stacked targets aggregate here so the banner ALWAYS tells the truth
  // even when you bet Green AND a number in the same period. Auto-clears when
  // that duration's next round starts.
  const [mySettle, setMySettle] = useState<MySettle | null>(null);
  const mySettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onMy = (r: {
      roundId?: string;
      period?: string;
      durationSec?: number;
      choice?: string | number;
      betAmount?: number;
      result?: string;
      multiplier?: number;
      payout?: number;
      number?: number;
      color?: string;
    }) => {
      if (!r?.result || !r.roundId) return;
      const row: MySettleRow = {
        choice: r.choice ?? '—',
        betAmount: Number(r.betAmount ?? 0),
        result: r.result,
        multiplier: Number(r.multiplier ?? 0),
        payout: Number(r.payout ?? 0),
        number: Number(r.number ?? 0),
        color: String(r.color ?? ''),
      };
      // §8: a REFUND is neither a win nor a loss — soft tick, no lose sting.
      sound.play(
        r.result === 'WIN'
          ? row.payout >= 50
            ? 'win_big'
            : 'win'
          : r.result === 'REFUND'
            ? 'click'
            : 'lose'
      );
      vibrate(r.result === 'WIN' ? [25, 40, 25] : 15);
      const key = String(r.roundId);
      // v1.3.4 — the banner previously cleared on the NEXT round-start, which
      // lands ~250ms after settle (the chain timer fires right when the old
      // period ends). Result: the WIN/LOSE card flashed for a quarter of a
      // second and vanished — "wingo doesn't show win or lose properly". Now
      // the card owns an 8-second lifetime (well inside the next 30s+ period)
      // and only a NEWER settle of my own replaces it sooner.
      if (mySettleTimer.current) clearTimeout(mySettleTimer.current);
      mySettleTimer.current = setTimeout(() => {
        setMySettle((prev) => (prev && prev.key === key ? null : prev));
      }, 8000);
      setMySettle((prev) =>
        prev && prev.key === key
          ? { ...prev, rows: [...prev.rows, row] }
          : {
              key,
              dur: clampDuration(r.durationSec),
              period: String(r.period ?? ''),
              rows: [row],
              shownAt: Date.now(),
            }
      );
    };
    socket.on('wingo:my-result', onMy);
    return () => {
      socket.off('wingo:my-result', onMy);
    };
  }, []);

  // Live rounds for all four times + a single ticker driving every countdown.
  useEffect(() => {
    // `serverNow` is the server's clock at the moment the round started. The
    // countdown is driven from (endsAt - serverNow), i.e. how long the round has
    // LEFT according to the server, rather than from the browser's own clock —
    // a device with a skewed clock previously showed the wrong time instantly.
    const onStart = (r: {
      roundId: string;
      period?: string;
      durationSec?: number;
      endsAt: number;
      serverNow?: number;
    }) => {
      const dur = clampDuration(r.durationSec);
      setRound(dur, {
        period: r.period ?? null,
        endsAt: r.endsAt,
        remaining: Math.max(
          0,
          Math.ceil((r.endsAt - (r.serverNow ?? Date.now())) / 1000)
        ),
      });
      // New period → drop last period's "my bets" chips (they belong to the
      // draw that just resolved).
      useWingoRound.getState().clearBets(dur, r.period ?? null);
    };
    const onResult = (r: {
      result: number;
      color: string;
      period?: string;
      durationSec?: number;
    }) => {
      const dur = clampDuration(r.durationSec);
      appendResult(dur, {
        number: r.result,
        color: r.color,
        period: r.period ?? '',
        at: Date.now(),
      });
      if (dur === duration) {
        showReveal(r.result, `${r.period}-${r.result}`);
        // v1.3.4: grow the page-1 trend grid live with each settled period —
        // it previously stayed frozen at whatever the REST fetch returned
        // when the tab was opened, so the chart ignored every draw until you
        // paged or re-switched lottery times.
        setList((prev) => {
          if (useWingoRound.getState().duration !== dur) return prev;
          if (listPageRef.current !== 1) return prev; // older pages stay put

          const total = prev.total + 1;
          return {
            rows: [
              {
                number: r.result,
                color: r.color,
                period: r.period ?? '',
                at: Date.now(),
              },
              ...prev.rows.filter((row) => row.period !== (r.period ?? '')),
            ].slice(0, 10),
            total,
            pages: Math.max(prev.pages, Math.max(1, Math.ceil(total / 10))),
          };
        });
      }
    };
    socket.on('wingo:round-start', onStart);
    socket.on('wingo:result', onResult);

    http
      .get<Array<{ period: string; durationSec: number; endsAt: number }>>(
        '/games/wingo/rounds',
        { schema: wingoRoundsDto }
      )
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        for (const r of rows) {
          setRound(clampDuration(r.durationSec), {
            period: r.period,
            endsAt: r.endsAt,
            remaining: Math.max(0, Math.ceil((r.endsAt - Date.now()) / 1000)),
          });
        }
        // §9: prices come from the server — an odds edit shows up without an
        // app rebuild (rows now carry the live payout table).
        const live = (rows as Array<{ payouts?: Record<string, number> }>).find(
          (r) => r.payouts && typeof r.payouts === 'object'
        );
        if (live?.payouts)
          useWingoRound.getState().setPayouts({ ...PAYOUTS, ...live.payouts });
      })
      .catch(() => {
        /* rounds arrive via socket */
      });

    const iv = setInterval(() => {
      const now = Date.now();
      useWingoRound.setState((s) => {
        const rounds = { ...s.rounds };
        for (const d of DURATIONS) {
          const rd = rounds[d];
          if (rd?.endsAt) {
            const left = Math.max(0, Math.ceil((rd.endsAt - now) / 1000));
            if (rd.remaining !== left) rounds[d] = { ...rd, remaining: left };
          }
        }
        return { rounds };
      });
    }, 250);

    return () => {
      socket.off('wingo:round-start', onStart);
      socket.off('wingo:result', onResult);
      clearInterval(iv);
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [duration, appendResult, setRound]);

  // Per-time history (trend + statistics).
  useEffect(() => {
    // §6/minor-c: switching lottery times must not flash the previous board's
    // rows — clear the paginated state first, so the grace fallback renders
    // THIS board's live strip until its own fetch lands.
    setList({ rows: [], total: 0, pages: 1 });
    setMyHistory(null);
    http
      .get<HistoryEntry[]>(`/games/wingo/recent?duration=${duration}`, {
        schema: wingoHistoryDto,
      })
      .then((rows) => {
        if (Array.isArray(rows)) setHistory(duration, rows);
      })
      .catch(() => {
        /* fills from live rounds */
      });
    setListPage(1);
  }, [duration, setHistory]);

  // Paginated trend list.
  const listFetchSeq = useRef(0);
  useEffect(() => {
    const seq = ++listFetchSeq.current;
    http
      .get<{ data: HistoryEntry[]; total: number; pages: number }>(
        `/games/wingo/history-list?duration=${duration}&page=${listPage}&pageSize=10`,
        { schema: wingoHistoryListDto }
      )
      .then((r) => {
        // §6: a slower earlier response must never overwrite a newer one —
        // without this token, flipping boards quickly showed the WRONG
        // board's rows ("histories mix up for a second").
        if (seq !== listFetchSeq.current) return;
        if (r && Array.isArray(r.data))
          setList({ rows: r.data, total: r.total, pages: Math.max(1, r.pages ?? 1) });
      })
      .catch(() => {
        /* keep previous page */
      });
  }, [duration, listPage]);

  // "My history" tab.
  useEffect(() => {
    if (viewTab !== 'my') return;
    http
      .get<{ data: Array<Record<string, unknown>> }>(
        // v1.3.3: per-board history — the reference game's My-history shows
        // only the selected lottery time, not a mix of all four.
        `/games/wingo/history?page=1&pageSize=10&duration=${duration}`,
        { schema: gameHistoryDto }
      )
      .then((r) => setMyHistory(r?.data ?? []))
      .catch(() => setMyHistory([]));
  }, [viewTab, duration]);

  // My own settled bet also triggers the reveal overlay.
  useEffect(() => {
    if (res?.number !== undefined)
      showReveal(res.number, `own-${res.number}-${round.period ?? ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res?.number]);

  const stats = useMemo(() => computeWingoStats(history), [history]);
  const pay = useWingoRound((s) => s.payouts); // §9 live odds (server truth)
  // Newest result leftmost — reads exactly like the chart's top rows
  // (chart is newest-at-top; strip is newest-at-left).
  const last5 = useMemo(() => lastResultsFor(history), [history]);
  const remaining = round.remaining;
  // `remaining > 0 && <= 5` is the verified final-5s lock window. `remaining
  // === 0` is the DRAW window: the period ended, the server is drawing the
  // winning number, and the next round-start has not arrived — bets tapped in
  // this gap used to open the sheet only to be server-rejected ("Round is
  // drawing"). Show the rolling reveal, like the real game does.
  const locked = remaining !== null && remaining > 0 && remaining <= 5;
  const drawing = remaining !== null && remaining <= 0;
  const myBets = useWingoRound((s) => s.myBets[duration] ?? []).filter(
    (b) => !round.period || b.period === round.period
  );
  const [d1, d2, d3, d4] = clockDigits(remaining);

  const tapTarget = (c: string | number) => {
    if (locked || drawing) return;
    setChoices({ choice: c, durationSec: duration });
    sound.play('bet_place');
    vibrate(6);
    setPopupOpen(true);
  };

  /** Trend rows: newest first, matching the reference ordering. */
  // NEWEST PERIOD AT TOP, everywhere (reference parity) — see trendRowsFor
  // in wingo-core: the /history-list page and the /recent fallback used to
  // disagree about direction, so whichever fetch landed second visibly
  // flipped the grid on every reload ("the chart changes every time").
  const trendRows = useMemo(
    () => trendRowsFor(list.rows, history),
    [list.rows, history]
  );

  return (
    <div className="w-full h-full overflow-y-auto" style={{ background: WG.pageBg }}>
      <div className="mx-auto w-full max-w-[520px] px-3 pb-6">
        {/* ── WALLET CARD ─────────────────────────────────────────────── */}
        <div
          className="rounded-2xl bg-white mt-3 px-4 py-4 text-center"
          style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
        >
          <div className="flex items-center justify-center gap-2">
            <span className="font-black" style={{ color: WG.text, fontSize: 22 }}>
              {CURRENCY()}
              {balance.toFixed(2)}
            </span>
            <button
              aria-label="Refresh balance"
              onClick={() => {
                sound.play('click');
                window.location.reload();
              }}
              style={{ color: WG.textMuted }}
              className="text-sm active:scale-90 transition-transform"
            >
              ⟳
            </button>
          </div>
          <p
            className="mt-1 inline-flex items-center gap-1.5 text-[13px]"
            style={{ color: WG.textMuted }}
          >
            <span style={{ color: WG.red }}>▮</span> Wallet balance
          </p>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <a
              href="/wallet"
              className="h-11 rounded-full flex items-center justify-center font-bold text-white text-[15px] active:scale-[0.98] transition-transform"
              style={{ background: WG.red }}
            >
              Withdraw
            </a>
            <a
              href="/wallet"
              className="h-11 rounded-full flex items-center justify-center font-bold text-white text-[15px] active:scale-[0.98] transition-transform"
              style={{ background: WG.green }}
            >
              Deposit
            </a>
          </div>
        </div>

        {/* ── NOTICE BAR ──────────────────────────────────────────────── */}
        <div
          className="mt-3 rounded-full bg-white flex items-center gap-2 pl-3 pr-1.5 py-1.5"
          style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
        >
          <span style={{ color: WG.red }}>🔊</span>
          <p
            className="flex-1 text-[12px] leading-tight truncate"
            style={{ color: WG.text }}
          >
            All recharge payment methods are only available in the Recharge section.
          </p>
          <button
            onClick={() => setHowTo(true)}
            className="shrink-0 h-7 px-3 rounded-full text-[12px] font-bold text-white inline-flex items-center gap-1"
            style={{ background: WG.red }}
          >
            🔥 Detail
          </button>
        </div>

        {/* ── LOTTERY-TIME TABS ───────────────────────────────────────── */}
        <div
          className="mt-3 rounded-2xl bg-white p-2 grid grid-cols-4 gap-2"
          style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
        >
          {DURATIONS.map((d) => {
            const active = d === duration;
            return (
              <button
                key={d}
                onClick={() => {
                  setDuration(d);
                  sound.play('click');
                }}
                className="rounded-xl py-2.5 flex flex-col items-center gap-1 transition-all active:scale-95"
                style={{
                  background: active ? WG.red : 'transparent',
                  boxShadow: active ? '0 4px 10px rgba(244,81,61,0.35)' : undefined,
                }}
              >
                <span
                  className="inline-flex items-center justify-center rounded-full"
                  style={{
                    width: 34,
                    height: 34,
                    background: active ? 'rgba(255,255,255,0.22)' : '#eef0f4',
                    color: active ? '#fff' : WG.textMuted,
                    fontSize: 17,
                  }}
                >
                  ⏱
                </span>
                <span
                  className="text-[11px] font-bold leading-tight text-center"
                  style={{ color: active ? '#fff' : WG.textMuted }}
                >
                  WinGo
                  <br />
                  {tabLabel(d)}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── PERIOD / COUNTDOWN BANNER ───────────────────────────────── */}
        <div
          className="mt-3 rounded-2xl px-4 py-3 text-white relative overflow-hidden"
          style={{ background: WG.bannerGrad }}
        >
          {/* ticket notches + dashed split (reference styling) */}
          <span
            aria-hidden
            className="absolute rounded-full"
            style={{
              width: 16,
              height: 16,
              background: WG.pageBg,
              left: '50%',
              top: -8,
              transform: 'translateX(-50%)',
            }}
          />
          <span
            aria-hidden
            className="absolute rounded-full"
            style={{
              width: 16,
              height: 16,
              background: WG.pageBg,
              left: '50%',
              bottom: -8,
              transform: 'translateX(-50%)',
            }}
          />
          <span
            aria-hidden
            className="absolute"
            style={{
              left: '50%',
              top: 12,
              bottom: 12,
              borderLeft: '1.5px dashed rgba(255,255,255,0.45)',
            }}
          />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <button
                onClick={() => {
                  setHowTo(true);
                  sound.play('click');
                }}
                className="h-8 px-3 rounded-full bg-white/95 inline-flex items-center gap-1.5 text-[12px] font-bold active:scale-95 transition-transform"
                style={{ color: WG.text }}
              >
                📋 How to play
              </button>
              <p className="mt-2 text-[13px] font-semibold opacity-95">
                WinGo {tabLabel(duration)}
              </p>
              {/* last five results */}
              <div className="mt-2 flex items-center gap-1.5">
                {last5.length === 0
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <span
                        key={i}
                        className="rounded-full bg-white/25"
                        style={{ width: 26, height: 26 }}
                      />
                    ))
                  : last5.map((h, i) => (
                      <Ball key={`${h.period || h.at}-${i}`} n={h.number} size={26} />
                    ))}
              </div>
            </div>

            <div className="text-right shrink-0">
              <p className="text-[12px] opacity-95">Time remaining</p>
              <div className="mt-1 flex items-center gap-1 justify-end">
                <ClockCard ch={d1} />
                <ClockCard ch={d2} />
                <span className="font-black" style={{ fontSize: 18 }}>
                  :
                </span>
                <ClockCard ch={d3} />
                <ClockCard ch={d4} />
              </div>
              <p className="mt-1.5 text-[13px] font-bold tabular-nums">
                {round.period ?? '----------'}
              </p>
            </div>
          </div>
        </div>

        {/* ── MY BETS THIS PERIOD — what is riding on this draw. Real WinGo
              players stack several targets per period; this strip is the
              receipt, and each chip flips to ✓/✗ the moment the draw lands. ── */}
        {myBets.length > 0 && (
          <div
            className="mt-3 rounded-2xl bg-white px-3 py-2.5 flex flex-wrap items-center gap-2"
            style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
          >
            <span
              className="text-[11px] font-bold uppercase tracking-wide"
              style={{ color: WG.textMuted }}
            >
              My bets
            </span>
            {myBets.map((b, i) => {
              const settled =
                round.lastResult !== null && b.period === round.lastResult?.period;
              const won = settled
                ? choiceWins(b.choice, round.lastResult!.number)
                : null;
              const col =
                typeof b.choice === 'number'
                  ? dotColor(b.choice)
                  : b.choice === 'green'
                    ? WG.green
                    : b.choice === 'red'
                      ? WG.redBall
                      : b.choice === 'violet'
                        ? WG.violet
                        : b.choice === 'big'
                          ? WG.big
                          : WG.small;
              const name =
                typeof b.choice === 'number'
                  ? `${b.choice}`
                  : b.choice.charAt(0).toUpperCase() + b.choice.slice(1);
              return (
                <span
                  key={`${b.period}-${String(b.choice)}-${i}`}
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold text-white"
                  style={{ background: col, opacity: won === false ? 0.75 : 1 }}
                >
                  {name} · {CURRENCY()}
                  {b.amount}
                  {won === true && <span aria-label="won"> ✓</span>}
                  {won === false && <span aria-label="lost"> ✗</span>}
                </span>
              );
            })}
          </div>
        )}

        {/* ── RESULT ANNOUNCEMENT — tells me plainly whether I won or lost,
                with the amount. Aggregates every bet of the round (stacked
                targets), because real WinGo settles several at once. ── */}
        {mySettle && mySettle.dur === duration && (
          <div
            className="mt-3 rounded-2xl overflow-hidden wg-pop"
            style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.18)' }}
          >
            {(() => {
              const stake = mySettle.rows.reduce((a, r) => a + r.betAmount, 0);
              const won = mySettle.rows.reduce((a, r) => a + r.payout, 0);
              const refunded = mySettle.rows.reduce(
                (a, r) => a + (r.result === 'REFUND' ? r.betAmount : 0),
                0
              );
              const allRefund =
                mySettle.rows.length > 0 &&
                mySettle.rows.every((r) => r.result === 'REFUND');
              const isWin = won > 0;
              const bg = allRefund ? '#5a6372' : isWin ? WG.green : WG.red;
              return (
                <>
                  <div
                    className="px-4 py-3 text-white text-center"
                    style={{ background: bg }}
                  >
                    <p className="text-[18px] font-black tracking-wide">
                      {allRefund
                        ? `ROUND INTERRUPTED — ${CURRENCY()}${refunded.toFixed(2)} RETURNED`
                        : isWin
                          ? `CONGRATULATIONS! YOU WON ${CURRENCY()}${won.toFixed(2)}`
                          : `YOU LOST ${CURRENCY()}${stake.toFixed(2)}`}
                    </p>
                    <p className="text-[12px] opacity-95 mt-0.5 tabular-nums">
                      Period {mySettle.period} · drew{' '}
                      <b className="text-[13px]">{mySettle.rows[0]?.number ?? '—'}</b> (
                      {mySettle.rows[0]?.color ?? ''})
                    </p>
                  </div>
                  {mySettle.rows.length > 1 && (
                    <div className="bg-white px-3 py-2">
                      {mySettle.rows.map((r, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between py-1 text-[12px] font-bold"
                          style={{
                            color: r.result === 'WIN' ? WG.green : WG.textMuted,
                            borderTop: i ? `1px solid ${WG.rowBorder}` : undefined,
                          }}
                        >
                          <span className="capitalize">{String(r.choice)}</span>
                          <span className="tabular-nums">
                            {r.result === 'WIN'
                              ? `${r.multiplier}× → +${CURRENCY()}${r.payout.toFixed(2)}`
                              : r.result === 'REFUND'
                                ? `+${CURRENCY()}${r.betAmount.toFixed(2)} returned`
                                : `−${CURRENCY()}${r.betAmount.toFixed(2)}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ── BET BOARD (covered by the reveal overlay while a result shows) ── */}
        <div
          className="mt-3 rounded-2xl bg-white p-3 relative overflow-hidden"
          style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
        >
          {/* Green | Violet | Red */}
          <div className="grid grid-cols-3 gap-2.5">
            {(
              [
                ['green', WG.green, 'Green'],
                ['violet', WG.violet, 'Violet'],
                ['red', WG.redBall, 'Red'],
              ] as const
            ).map(([key, color, label]) => (
              <button
                key={key}
                onClick={() => tapTarget(key)}
                disabled={locked || drawing}
                className="h-11 rounded-lg font-bold text-white text-[15px] active:scale-95 transition-transform disabled:opacity-60"
                style={{
                  background: color,
                  // the reference squares off the inner corners of the trio
                  borderTopRightRadius: key === 'green' ? 4 : undefined,
                  borderBottomRightRadius: key === 'green' ? 4 : undefined,
                  borderTopLeftRadius: key === 'red' ? 4 : undefined,
                  borderBottomLeftRadius: key === 'red' ? 4 : undefined,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 0-9 balls */}
          <div className="mt-3 grid grid-cols-5 gap-y-3 justify-items-center">
            {Array.from({ length: 10 }).map((_, n) => (
              <button
                key={n}
                onClick={() => tapTarget(n)}
                disabled={locked || drawing}
                className="active:scale-90 transition-transform disabled:opacity-60"
                style={{ opacity: choices.choice === n ? 1 : undefined }}
              >
                <Ball n={n} size={58} />
              </button>
            ))}
          </div>

          {/* Random + multiplier chips */}
          <div className="mt-3 flex items-center gap-1.5">
            <button
              onClick={() => {
                const opts: Array<string | number> = [
                  'green',
                  'violet',
                  'red',
                  'big',
                  'small',
                  0,
                  1,
                  2,
                  3,
                  4,
                  5,
                  6,
                  7,
                  8,
                  9,
                ];
                tapTarget(opts[Math.floor(Math.random() * opts.length)]!);
              }}
              disabled={locked || drawing}
              className="h-9 px-3 rounded-full text-[13px] font-bold bg-white disabled:opacity-60"
              style={{ color: WG.red, border: `1px solid ${WG.red}` }}
            >
              Random
            </button>
            {[1, 5, 10, 20, 50, 100].map((m, i) => (
              <button
                key={m}
                onClick={() => {
                  setChoices({ ...choices, multiplier: m });
                  sound.play('click');
                }}
                className="h-9 flex-1 rounded-md text-[13px] font-bold transition-all active:scale-95"
                style={
                  (choices.multiplier ?? 1) === m
                    ? { background: WG.green, color: '#fff' }
                    : { background: '#eef0f4', color: WG.textMuted }
                }
              >
                X{m}
                {i === -1 ? '' : ''}
              </button>
            ))}
          </div>

          {/* Big | Small */}
          <div className="mt-2.5 grid grid-cols-2">
            <button
              onClick={() => tapTarget('big')}
              disabled={locked || drawing}
              className="h-11 font-bold text-white text-[15px] active:scale-[0.98] transition-transform disabled:opacity-60"
              style={{ background: WG.big, borderRadius: '22px 4px 4px 22px' }}
            >
              Big
            </button>
            <button
              onClick={() => tapTarget('small')}
              disabled={locked || drawing}
              className="h-11 font-bold text-white text-[15px] active:scale-[0.98] transition-transform disabled:opacity-60"
              style={{ background: WG.small, borderRadius: '4px 22px 22px 4px' }}
            >
              Small
            </button>
          </div>

          {/* Draw overlay — the real game rolls the winning digits over the
              board while the period is being drawn, instead of leaving a dead,
              tap-able board between the last second and the next round. */}
          {drawing && !reveal && (
            <div
              className="absolute inset-0 z-[15] flex flex-col items-center justify-center gap-2"
              style={{ background: 'rgba(20,20,25,0.72)' }}
            >
              <RollingDigits />
              <span className="text-[12px] font-bold text-white/80 tracking-wide">
                Drawing the winning number…
              </span>
            </div>
          )}

          {/* Result overlay — two oversized flip cards, exactly as the reference */}
          {reveal && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center gap-3"
              style={{ background: 'rgba(20,20,25,0.55)' }}
            >
              {[Math.floor(reveal.number / 10), reveal.number % 10].map((d, i) => (
                <span
                  key={i}
                  className="inline-flex items-center justify-center rounded-2xl bg-white font-black wg-pop"
                  style={{
                    width: 96,
                    height: 128,
                    color: WG.red,
                    fontSize: 74,
                    animationDelay: `${i * 90}ms`,
                  }}
                >
                  {d}
                </span>
              ))}
            </div>
          )}

          {/* Betting-closed veil */}
          {locked && !reveal && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.55)' }}
            >
              <span
                className="px-4 py-2 rounded-full text-[13px] font-bold text-white"
                style={{ background: WG.red }}
              >
                🔒 Betting closed
              </span>
            </div>
          )}
        </div>

        {/* ── VIEW TABS ───────────────────────────────────────────────── */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(
            [
              ['history', 'Game history'],
              ['chart', 'Chart'],
              ['my', 'My history'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setViewTab(key);
                sound.play('click');
              }}
              className="h-11 rounded-xl text-[14px] font-bold transition-all active:scale-95"
              style={
                viewTab === key
                  ? {
                      background: WG.red,
                      color: '#fff',
                      boxShadow: '0 4px 10px rgba(244,81,61,0.3)',
                    }
                  : { background: '#fff', color: WG.textMuted }
              }
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── CHART TAB: statistics + trend rows ──────────────────────── */}
        {viewTab === 'chart' && (
          <div
            className="mt-3 rounded-2xl bg-white overflow-hidden"
            style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
          >
            {/* header */}
            <div
              className="grid grid-cols-[146px_1fr] items-center px-3 py-2.5 text-white text-[14px] font-bold"
              style={{ background: WG.red }}
            >
              <span>Period</span>
              <span className="text-center">Number</span>
            </div>

            {/* Statistic block */}
            <div className="px-3 pt-3 pb-1">
              <div className="grid grid-cols-[118px_1fr] items-start gap-1">
                <span className="text-[13px] font-bold" style={{ color: WG.text }}>
                  Statistic
                </span>
                <span className="text-[12px]" style={{ color: WG.textMuted }}>
                  (last 100 Periods)
                </span>
              </div>

              <StatRow label="Winning Numbers">
                <div className="flex items-center justify-between">
                  {/* uniform red outline — matches the reference, which does NOT
                      colour these by digit (the trend dots below do that) */}
                  {Array.from({ length: 10 }).map((_, n) => (
                    <span
                      key={n}
                      className="inline-flex items-center justify-center rounded-full text-[11px] font-bold"
                      style={{
                        width: 21,
                        height: 21,
                        border: `1.5px solid ${WG.red}`,
                        color: WG.red,
                      }}
                    >
                      {n}
                    </span>
                  ))}
                </div>
              </StatRow>

              {(
                [
                  ['Missing', stats.missing],
                  ['Avg missing', stats.avgMissing],
                  ['Frequency', stats.frequency],
                  ['Max consecutive', stats.maxConsecutive],
                ] as Array<[string, number[]]>
              ).map(([label, vals]) => (
                <StatRow key={label} label={label}>
                  <div className="flex items-center justify-between">
                    {vals.map((v, n) => (
                      <span
                        key={n}
                        className="text-center text-[12px] tabular-nums"
                        style={{ width: 21, color: WG.textMuted }}
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </StatRow>
              ))}
            </div>

            {/* trend rows — the zig-zag ends exactly on the winning digits.
              The old one drew a single overlay across the WHOLE list and
              hand-computed its X/Y in pixels (fixed 146px period column +
              assumed 41px rows + % dots); nothing matched the actual
              justify-between dots or the 42px rows, so lines landed under the
              wrong digits on any width that wasn't the tuning width (the
              user's screenshot). Now each row owns its own connector segment,
              drawn INSIDE that row's 10-equal-column digits grid — the
              endpoint at (n+0.5)·10% of THIS strip IS the dot's centre by
              construction, at every width, and y is the fixed 42px row
              height (also shared by the grid below matching the strip). */}
            <div className="relative">
              {trendRows.length === 0 && (
                <p
                  className="text-center text-[13px] py-6"
                  style={{ color: WG.textFaint }}
                >
                  Waiting for the first round…
                </p>
              )}
              {trendRows.map((h, idx) => {
                const badge = sizeBadge(h.number);
                const nextNum = trendRows[idx + 1]?.number;
                return (
                  <div
                    key={`${h.period || h.at}-${idx}`}
                    className="grid items-center px-2 h-[42px] relative"
                    style={{
                      gridTemplateColumns: 'clamp(108px, 30vw, 146px) 1fr 26px',
                      borderTop: `1px solid ${WG.rowBorder}`,
                    }}
                  >
                    <span
                      className="text-[11.5px] tabular-nums truncate"
                      style={{ color: WG.text }}
                    >
                      {h.period}
                    </span>
                    <div className="relative grid grid-cols-10 h-full items-center">
                      {Array.from({ length: 10 }).map((_, n) => {
                        const hit = n === h.number;
                        return (
                          <span key={n} className="flex items-center justify-center">
                            <span
                              className="relative inline-flex items-center justify-center rounded-full font-bold z-[1] aspect-square"
                              style={
                                hit
                                  ? {
                                      width: 'clamp(16px, 4.4vw, 21px)',
                                      fontSize: 11,
                                      background: dotColor(n),
                                      color: '#fff',
                                    }
                                  : {
                                      width: 'clamp(16px, 4.4vw, 21px)',
                                      fontSize: 11,
                                      color: WG.textFaint,
                                    }
                              }
                            >
                              {n}
                            </span>
                          </span>
                        );
                      })}
                      {nextNum !== undefined && (
                        <svg
                          aria-hidden
                          className="absolute inset-0 h-[42px] pointer-events-none z-0"
                          style={{ overflow: 'visible' }}
                          width="100%"
                          height="42"
                          preserveAspectRatio="none"
                        >
                          <line
                            x1={`${(h.number + 0.5) * 10}%`}
                            y1={21}
                            x2={`${(nextNum + 0.5) * 10}%`}
                            y2={63}
                            stroke="rgba(244,81,61,0.75)"
                            strokeWidth={1.5}
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </div>
                    <span
                      className="justify-self-end inline-flex items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ width: 21, height: 21, background: badge.color }}
                    >
                      {badge.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* pagination */}
            <div
              className="flex items-center justify-center gap-6 py-4"
              style={{ borderTop: `1px solid ${WG.rowBorder}` }}
            >
              <button
                onClick={() => {
                  if (listPage > 1) {
                    setListPage(listPage - 1);
                    sound.play('click');
                  }
                }}
                disabled={listPage <= 1}
                className="w-14 h-10 rounded-lg text-[18px] font-bold disabled:opacity-40"
                style={{ background: '#eef0f4', color: WG.textMuted }}
              >
                ‹
              </button>
              <span className="text-[14px] tabular-nums" style={{ color: WG.text }}>
                {listPage}/{list.pages || 1}
              </span>
              <button
                onClick={() => {
                  if (listPage < (list.pages || 1)) {
                    setListPage(listPage + 1);
                    sound.play('click');
                  }
                }}
                disabled={listPage >= (list.pages || 1)}
                className="w-14 h-10 rounded-lg text-[18px] font-bold text-white disabled:opacity-40"
                style={{ background: WG.red }}
              >
                ›
              </button>
            </div>
          </div>
        )}

        {/* ── GAME HISTORY TAB ────────────────────────────────────────── */}
        {viewTab === 'history' && (
          <div
            className="mt-3 rounded-2xl bg-white overflow-hidden"
            style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
          >
            <div
              className="grid grid-cols-[1fr_70px_60px_50px] px-3 py-2.5 text-white text-[13px] font-bold"
              style={{ background: WG.red }}
            >
              <span>Period</span>
              <span className="text-center">Number</span>
              <span className="text-center">Big/Small</span>
              <span className="text-center">Colour</span>
            </div>
            {trendRows.length === 0 && (
              <p
                className="text-center text-[13px] py-6"
                style={{ color: WG.textFaint }}
              >
                No rounds yet.
              </p>
            )}
            {trendRows.map((h, i) => {
              const badge = sizeBadge(h.number);
              return (
                <div
                  key={`${h.period || i}-${i}`}
                  className="grid grid-cols-[1fr_70px_60px_50px] items-center px-3 py-2.5"
                  style={{ borderTop: `1px solid ${WG.rowBorder}` }}
                >
                  <span className="text-[12px] tabular-nums" style={{ color: WG.text }}>
                    {h.period}
                  </span>
                  <span
                    className="text-center font-black text-[17px]"
                    style={{ color: dotColor(h.number) }}
                  >
                    {h.number}
                  </span>
                  <span
                    className="text-center text-[12px] font-bold"
                    style={{ color: badge.color }}
                  >
                    {h.number >= 5 ? 'Big' : 'Small'}
                  </span>
                  <span className="flex items-center justify-center">
                    <span
                      className="rounded-full"
                      style={{ width: 12, height: 12, background: dotColor(h.number) }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── MY HISTORY TAB ──────────────────────────────────────────── */}
        {viewTab === 'my' && (
          <div
            className="mt-3 rounded-2xl bg-white overflow-hidden"
            style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
          >
            <div
              className="px-3 py-2.5 text-white text-[14px] font-bold"
              style={{ background: WG.red }}
            >
              My history
            </div>
            {!user ? (
              <p
                className="text-center text-[13px] py-6"
                style={{ color: WG.textFaint }}
              >
                Log in to see your bets.
              </p>
            ) : myHistory === null ? (
              <p
                className="text-center text-[13px] py-6"
                style={{ color: WG.textFaint }}
              >
                Loading…
              </p>
            ) : myHistory.length === 0 ? (
              <p
                className="text-center text-[13px] py-6"
                style={{ color: WG.textFaint }}
              >
                You haven&apos;t placed a bet yet.
              </p>
            ) : (
              myHistory.map((m, i) => {
                const mo = (m.mappedOutcome ?? {}) as {
                  number?: number;
                  choice?: string | number;
                };
                const win = m.result === 'WIN';
                return (
                  <div
                    key={i}
                    className="flex items-center justify-between px-3 py-2.5"
                    style={{ borderTop: `1px solid ${WG.rowBorder}` }}
                  >
                    <div className="min-w-0">
                      <p
                        className="text-[13px] font-semibold"
                        style={{ color: WG.text }}
                      >
                        {typeof mo.choice === 'number'
                          ? `Number ${mo.choice}`
                          : String(mo.choice ?? '—').replace(/^\w/, (c) =>
                              c.toUpperCase()
                            )}
                      </p>
                      <p className="text-[11px]" style={{ color: WG.textMuted }}>
                        {new Date(String(m.createdAt)).toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right">
                      {mo.number !== undefined && (
                        <span
                          className="inline-flex items-center justify-center rounded-full text-[11px] font-bold text-white mb-0.5"
                          style={{
                            width: 21,
                            height: 21,
                            background: dotColor(mo.number),
                          }}
                        >
                          {mo.number}
                        </span>
                      )}
                      <p
                        className="text-[13px] font-bold"
                        style={{ color: win ? WG.green : WG.redBall }}
                      >
                        {win
                          ? `+${CURRENCY()}${Number(m.payoutAmount ?? 0).toFixed(2)}`
                          : `-${CURRENCY()}${Number(m.betAmount ?? 0).toFixed(2)}`}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ── HOW TO PLAY ─────────────────────────────────────────────── */}
      {howTo && (
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center p-5"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setHowTo(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="px-4 py-3 text-white font-bold"
              style={{ background: WG.red }}
            >
              How to play
            </div>
            <div className="p-4 text-[13px] leading-relaxed" style={{ color: WG.text }}>
              <p className="mb-2">A number from 0-9 is drawn every round.</p>
              <ul className="space-y-1" style={{ color: WG.textMuted }}>
                <li>
                  <b style={{ color: WG.green }}>Green</b> — 1, 3, 7, 9 →{' '}
                  {pay.green ?? PAYOUTS.green}×
                </li>
                <li>
                  <b style={{ color: WG.redBall }}>Red</b> — 2, 4, 6, 8 →{' '}
                  {pay.red ?? PAYOUTS.red}×
                </li>
                <li>
                  <b style={{ color: WG.violet }}>Violet</b> — 0, 5 →{' '}
                  {pay.violet ?? PAYOUTS.violet}×
                </li>
                <li>
                  <b style={{ color: WG.big }}>Big</b> — 5-9 → {pay.big ?? PAYOUTS.big}×
                </li>
                <li>
                  <b style={{ color: WG.small }}>Small</b> — 0-4 →{' '}
                  {pay.small ?? PAYOUTS.small}×
                </li>
                <li>
                  <b>Exact number</b> → {pay.number ?? PAYOUTS.number}×
                </li>
              </ul>
              <p className="mt-3" style={{ color: WG.textMuted }}>
                Betting closes for the last 5 seconds of each round. Every result is
                provably fair.
              </p>
            </div>
            <button
              className="w-full h-12 font-bold text-white"
              style={{ background: WG.red }}
              onClick={() => setHowTo(false)}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes wgPop { 0% { transform: translateY(-16px) scale(0.82); opacity: 0 } 60% { transform: translateY(0) scale(1.06); opacity: 1 } 100% { transform: translateY(0) scale(1); opacity: 1 } }
        .wg-pop { animation: wgPop 420ms cubic-bezier(0.2,0.9,0.3,1.3) both }
      `}</style>
    </div>
  );
}

/** Statistic row: fixed-width label + a 10-column value strip. */
function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[118px_1fr] items-center py-1">
      <span className="text-[12.5px] whitespace-nowrap" style={{ color: WG.text }}>
        {label}
      </span>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bet panel — the confirmation sheet that appears after picking a target
// ─────────────────────────────────────────────────────────────────────────────

export function WingoBetPanel({
  onBet,
  minBet,
  balance,
  isLoading,
  choices,
  setChoices,
}: GameBetPanelProps) {
  const duration = useWingoRound((s) => s.duration);
  const round = useWingoRound((s) => s.rounds[duration] ?? EMPTY_ROUND);
  const popupOpen = useWingoRound((s) => s.popupOpen);
  const setPopupOpen = useWingoRound((s) => s.setPopupOpen);

  const choice = (choices.choice as string | number | null | undefined) ?? null;
  // Amount presets must respect minBet — the sheet used to default to Rs1
  // while wingo's minBet is Rs10, which disabled the confirm button with no
  // explanation and made the whole game feel broken on first use.
  const amountPresets = [1, 10, 100, 1000].filter((v) => v >= minBet);
  if (amountPresets.length === 0) amountPresets.push(minBet);
  const [baseAmount, setBaseAmount] = useState(() =>
    Math.max(minBet, amountPresets[0]!)
  );
  const [agreed, setAgreed] = useState(true);
  const multiplier = Number(choices.multiplier ?? 1);

  useEffect(() => {
    setAgreed(true);
    setBaseAmount((v) => Math.max(minBet, amountPresets[0]!, v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, minBet]);

  const total = Math.round(baseAmount * multiplier * 100) / 100;
  const remaining = round.remaining;
  const bettingClosed = remaining !== null && remaining > 0 && remaining <= 5;
  // Period over, draw in progress, next round not yet announced — the bet
  // would be server-rejected in this gap, so hold the sheet closed.
  const drawing = remaining !== null && remaining <= 0;
  const insufficient = total > balance;
  const canConfirm =
    choice !== null &&
    total >= minBet &&
    !insufficient &&
    agreed &&
    // §4: `isLoading` is deliberately NOT here — the page-level bet queue
    // serializes placement, so repeated taps no longer die while the previous
    // bet's ack is in flight. Same-tap double-fire is impossible (the sheet
    // closes on confirm) and same-target dupes are free server-side.
    !bettingClosed &&
    !drawing;

  const label =
    choice === null
      ? ''
      : typeof choice === 'number'
        ? `Number ${choice}`
        : String(choice).replace(/^\w/, (c) => c.toUpperCase());
  const accent =
    choice === null
      ? WG.red
      : typeof choice === 'number'
        ? dotColor(choice)
        : choice === 'green'
          ? WG.green
          : choice === 'red'
            ? WG.redBall
            : choice === 'violet'
              ? WG.violet
              : choice === 'big'
                ? WG.big
                : WG.small;

  const confirm = async () => {
    if (!canConfirm || choice === null) return;
    setChoices({ ...choices, choice, durationSec: duration });
    sound.play('bet_place');
    vibrate(12);
    setPopupOpen(false);
    const r = (await onBet(total)) as { status?: string } | null;
    // The bet rides the current shared period — keep its receipt on the board
    // ("My bets" strip) until the period's draw settles it. Only on a real
    // PLACED ack: SKIPPED/rejected retries must not add phantom chips.
    if (r && r.status === 'PLACED' && choice !== null) {
      useWingoRound.getState().addBet(duration, {
        period: useWingoRound.getState().rounds[duration]?.period ?? '',
        choice,
        amount: total,
      });
    }
  };

  if (!popupOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={() => setPopupOpen(false)}
    >
      <div
        className="w-full max-w-[520px] rounded-t-2xl bg-white overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header shows the picked target */}
        <div
          className="px-4 py-3 text-white text-center font-bold"
          style={{ background: accent }}
        >
          WinGo {tabLabel(duration)} — {label}
        </div>

        <div className="p-4">
          {/* base amount */}
          <div className="flex items-center justify-between">
            <span className="text-[13px]" style={{ color: WG.textMuted }}>
              Amount
            </span>
            <div className="flex items-center gap-1.5">
              {amountPresets.map((a) => (
                <button
                  key={a}
                  onClick={() => {
                    setBaseAmount(a);
                    sound.play('click');
                  }}
                  className="h-9 px-3 rounded-md text-[13px] font-bold"
                  style={
                    baseAmount === a
                      ? { background: accent, color: '#fff' }
                      : { background: '#eef0f4', color: WG.textMuted }
                  }
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* quantity multiplier */}
          <div className="flex items-center justify-between mt-3">
            <span className="text-[13px]" style={{ color: WG.textMuted }}>
              Quantity
            </span>
            <div className="flex items-center gap-1.5">
              {[1, 5, 10, 20, 50, 100].map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setChoices({ ...choices, multiplier: m });
                    sound.play('click');
                  }}
                  className="h-9 px-2.5 rounded-md text-[12px] font-bold"
                  style={
                    multiplier === m
                      ? { background: WG.green, color: '#fff' }
                      : { background: '#eef0f4', color: WG.textMuted }
                  }
                >
                  X{m}
                </button>
              ))}
            </div>
          </div>

          {/* payout preview */}
          <div
            className="mt-3 rounded-xl px-3 py-2.5 flex items-center justify-between"
            style={{ background: '#f7f8fb' }}
          >
            <span className="text-[13px]" style={{ color: WG.textMuted }}>
              Total
            </span>
            <span className="text-[15px] font-black" style={{ color: WG.text }}>
              {CURRENCY()}
              {total.toFixed(2)}
              <span className="ml-2 text-[12px] font-bold" style={{ color: accent }}>
                win {CURRENCY()}
                {(total * (choiceMultiplier(choice) ?? 0)).toFixed(2)}
              </span>
            </span>
          </div>

          <label
            className="mt-3 flex items-center gap-2 text-[12px]"
            style={{ color: WG.textMuted }}
          >
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ accentColor: WG.red }}
            />
            I agree to the pre-sale rules
          </label>

          {insufficient && (
            <p className="mt-2 text-[12px] font-bold" style={{ color: WG.redBall }}>
              Insufficient balance.
            </p>
          )}
          {total < minBet && (
            <p className="mt-2 text-[12px] font-bold" style={{ color: WG.redBall }}>
              Minimum bet is {CURRENCY()}
              {minBet} — raise the Amount or Quantity.
            </p>
          )}
          {bettingClosed && (
            <p className="mt-2 text-[12px] font-bold" style={{ color: WG.redBall }}>
              Betting is closed for this round.
            </p>
          )}
          {drawing && (
            <p className="mt-2 text-[12px] font-bold" style={{ color: WG.redBall }}>
              This period is drawing — your bet would miss it.
            </p>
          )}
        </div>

        <div className="grid grid-cols-[110px_1fr]">
          <button
            onClick={() => setPopupOpen(false)}
            className="h-13 py-3.5 font-bold text-[15px]"
            style={{ background: '#eef0f4', color: WG.textMuted }}
          >
            Cancel
          </button>
          <button
            onClick={() => void confirm()}
            disabled={!canConfirm}
            className="py-3.5 font-bold text-[15px] text-white disabled:opacity-50"
            style={{ background: canConfirm ? accent : '#9aa3b2' }}
          >
            {total < minBet
              ? `Minimum bet is ${CURRENCY()}${minBet}`
              : bettingClosed
                ? 'Betting closed — next round soon'
                : drawing
                  ? 'Drawing… wait for the next round'
                  : `Total amount ${CURRENCY()}${total.toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
