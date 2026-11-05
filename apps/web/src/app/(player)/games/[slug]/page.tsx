// apps/web/src/app/(player)/games/[slug]/page.tsx — game page via the game registry (all 20 games)
'use client';
import React, { useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { http, uuid } from '../../../../lib/api';
import {
  useAuthStore,
  useWalletStore,
  useGameStore,
  useUIStore,
  useBalanceHolds,
} from '../../../../stores';
import { useDemoStore } from '../../../../lib/demo';
import { useGame, useSessionGame, type SessionView } from '../../../../hooks';
import { GameShell } from '../../../../components/GameShell';
import { gameRegistry } from '../../../../components/games/registry';
import { ErrorBoundary, Skeleton } from '../../../../components/ui';
import { notify } from '../../../../lib/toast';
import { socket } from '../../../../lib/app';
import { useEffect } from 'react';
import { CountUp } from '../../../../components/games/game-kit';
import {
  LastResultChip,
  type LastRound,
} from '../../../../components/games/LastResultChip';
import { animMs } from '../../../../components/games/useRoundFlow';
import { setMyCrashBet } from '../../../../lib/crash-bet';
import { gameDetailDto, parseDto, activeSeedDto } from '../../../../lib/dto';
import { plinkoChargedStake } from '@casino/shared';

interface GameDetail {
  slug: string;
  displayName: string;
  description?: string | null;
  baseRtp: number;
  minBet: number;
  maxBet?: number;
  maxWinMultiplier: number;
  configJson?: Record<string, unknown>;
  demoEnabled?: boolean;
}

/**
 * The bet is handed to the board the INSTANT the server replies.
 *
 * There used to be a 1500ms artificial hold here ("minimum suspense"). It was
 * added before the games had real animations, and it became the single worst
 * thing about the feel of every game: because each board starts animating from
 * `outcome`, holding the outcome back also held the ANIMATION back. Filmed at
 * 150ms intervals, a dice roll looked like this:
 *
 *     0ms .. 1400ms   frozen die, a dash, and a "BETTING..." spinner
 *     2000ms          the die finally starts tumbling
 *
 * So the player tapped ROLL and watched a dead screen for a second and a half.
 * The wheel was identical: four consecutive frames of a motionless wheel.
 *
 * The hold is no longer needed for its original purpose either — the result is
 * kept secret by useRoundFlow (the board animates for its full duration before
 * the verdict is allowed on screen), not by delaying the data.
 */
const CALLBACK_COMPLETION_GAMES = new Set([
  'dice',
  'coin-flip',
  'wheel',
  'ring-of-fortune',
  'limbo',
  'keno',
  'lucky-number',
  'scratch-card',
  'thimbles',
  'plinko',
  'roulette',
  'baccarat',
  'dragon-tiger',
]);

// v1.3.5·§4: rapid stacked WinGo bets must QUEUE, not drop. The page used to
// return SKIPPED for any tap that landed while the previous bet's ack was in
// flight (~100-300ms, longer on weak networks) — players tapped three targets
// and one silently vanished ("stacking often doesn't work"). Serializing the
// socket placements keeps every tap, preserves requestId semantics, and the
// server's per-choice dedupe still makes double-taps free.
let wingoBetChain: Promise<unknown> = Promise.resolve();
function enqueueWingoBet<T>(task: () => Promise<T>): Promise<T> {
  const run = wingoBetChain.then(task, task);
  wingoBetChain = run.catch(() => undefined);
  return run;
}

export default function GamePageRoute() {
  const { slug } = useParams<{ slug: string }>();
  return <GamePage key={slug} slug={slug} />;
}

function GamePage({ slug }: { slug: string }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const toggleSound = useUIStore((s) => s.toggleSound);
  // D-100: the app is "loading session" until the restore settles — never
  // show the login-required panel (or demo mode) during that window, or a
  // logged-in user would see "Log in to play" flash (or stick) until refresh.
  const hydrated = useAuthStore((s) => s.hydrated);
  const balance = useWalletStore((s) => s.real);
  const demoBalance = useDemoStore((s) => s.balance);
  const demoReset = useDemoStore((s) => s.reset);
  const [round, setRound] = useState<{
    mappedOutcome: Record<string, unknown> | null;
    result: 'WIN' | 'LOSE' | 'CASHOUT' | 'BUST' | 'PUSH' | null;
  }>({ mappedOutcome: null, result: null });
  const [pending, setPending] = useState(false);
  // Step 6 — round memory. The result banner is on screen for 2.6s and then
  // gone for ever; a player who blinked had no record of what happened. This
  // survives the banner and drives the one-tap repeat.
  const [lastRound, setLastRound] = useState<LastRound | null>(null);
  /** the stake of the round currently in flight, so the memory can show profit */
  const stakeRef = useRef(0);
  /** what the server actually paid back for that round (0 on a total loss) */
  const payoutRef = useRef(0);
  /** re-place the same stake — set once a bet has been made on this game */
  const [repeatBet, setRepeatBet] = useState<(() => void) | null>(null);
  const revealTokenRef = useRef(0);
  const gameModule = gameRegistry[slug];

  const { data: game, isLoading } = useQuery({
    queryKey: ['game', slug],
    queryFn: async () =>
      parseDto(
        gameDetailDto,
        await http.get<unknown>(`/games/${slug}`),
        'Game detail'
      ) as GameDetail,
    enabled: !!slug,
  });

  // Demo mode (docs/20 §9): automatic when signed out on a demo-enabled game;
  // optional toggle for signed-in players.
  const [demoToggled, setDemoToggled] = useState(false);
  const demoMode = !!game?.demoEnabled && hydrated && (!user || demoToggled);

  // D-088: the client seed MUST match the server's ACTIVE seed pair — the
  // server rejects bets whose clientSeed differs ("Client seed mismatch").
  // Fetch the real seed from /provably-fair/active-seed (the localStorage
  // fallback was never populated → every bet was rejected).
  const { data: seedInfo } = useQuery({
    queryKey: ['game-client-seed'],
    queryFn: () =>
      http.get<{ clientSeed: string; nonce: number }>('/provably-fair/active-seed', {
        schema: activeSeedDto,
      }),
    enabled: !!user && !demoMode,
    staleTime: 60_000,
  });
  const clientSeed = seedInfo?.clientSeed ?? 'player-default-seed';

  // per-game document title
  useEffect(() => {
    if (game?.displayName)
      document.title = `${game.displayName} · ${process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play'}`;
  }, [game?.displayName]);
  const { placeBet, completeRound, state } = useGame(
    slug,
    clientSeed,
    demoMode,
    null,
    seedInfo?.nonce
  );
  // D-092: session games — one bet per round, steps advance the multiplier
  const {
    session,
    busy: sessionBusy,
    start: startSession,
    step: stepSession,
    cashout: cashoutSession,
    reset: resetSession,
  } = useSessionGame(slug, demoMode);
  const isSessionGame = !!gameModule?.session;

  // D-090: shared-round games (aviator / crash-x / wingo) settle via socket —
  // wire their events into the page state so the screen ALWAYS reflects the
  // server-truth result:
  //   {slug}:my-result  → YOUR bet settled (CASHOUT/BUST) — shows "CASHED OUT
  //                       ✓ ₨X @ M×" / "BUSTED" exactly as the server paid it.
  //   {slug}:round-start→ clear the previous round's overlay for the new round.
  //   {slug}:crash | {slug}:result → the round ended → re-enable betting for
  //                       the next round (state machine → IDLE).
  useEffect(() => {
    if (!slug) return;
    const onMyResult = (r: {
      result?: 'WIN' | 'LOSE' | 'PUSH' | 'CASHOUT' | 'BUST' | 'REFUND';
      multiplier?: number;
      payout?: number;
      number?: number;
      color?: string;
      roundId?: string;
    }) => {
      if (!r?.result) return;
      // Balance-hold announce: this event IS the win/lose announcement, so
      // settle + release the hold for the round that just paid out. Wingo
      // holds are keyed by the round the bet joined (4 durations can ride at
      // once); crash holds by slug.
      const vh = useBalanceHolds.getState();
      if (slug === 'wingo') {
        const key = `wingo:round:${r.roundId ?? 'unknown'}`;
        vh.settleBet(key, Number(r.payout ?? 0));
        // server order: my-result → wallet write → balance:update (~ms later)
        setTimeout(() => vh.releaseBet(key), 400);
      } else {
        vh.settleBet(`bet:${slug}`, Number(r.payout ?? 0));
        setTimeout(() => vh.releaseBet(`bet:${slug}`), 400);
      }
      setRound({
        mappedOutcome:
          r.multiplier !== undefined
            ? {
                multiplier: r.multiplier,
                payout: r.payout ?? 0,
                ...(r.number !== undefined ? { number: r.number } : {}),
                ...(r.color !== undefined ? { color: r.color } : {}),
              }
            : null,
        // §8: REFUND (stake returned) informs the generic reveal state as
        // PUSH — the wingo popup renders the exact REFUND wording itself.
        result: r.result === 'REFUND' ? 'PUSH' : r.result,
      });
    };
    // D-106: only clear the previous round's display when no bet is in flight —
    // a wingo round boundary firing right after MY bet used to wipe the banner
    // before it was ever shown (state machine is IDLE when nothing is pending).
    const onRoundStart = () => {
      if (useGameStore.getState().state === 'IDLE')
        setRound({ mappedOutcome: null, result: null });
    };
    const onRoundEnd = () => {
      // give the crash/bust overlay ~2s on screen, then free the Play button
      setTimeout(() => {
        const st = useGameStore.getState();
        if (st.state === 'PLAYING') st.setState('IDLE');
      }, 2000);
    };
    socket.on(`${slug}:my-result`, onMyResult);
    socket.on(`${slug}:round-start`, onRoundStart);
    socket.on(`${slug}:crash`, onRoundEnd);
    socket.on(`${slug}:result`, onRoundEnd);
    return () => {
      socket.off(`${slug}:my-result`, onMyResult);
      socket.off(`${slug}:round-start`, onRoundStart);
      socket.off(`${slug}:crash`, onRoundEnd);
      socket.off(`${slug}:result`, onRoundEnd);
    };
  }, [slug]);

  // GamePageRoute keys this component by slug, so all local round/choice state is
  // recreated rather than leaking across dynamic-route navigation.
  const [choices, setChoices] = useState<Record<string, unknown>>(
    () => gameModule?.defaultChoices?.() ?? {}
  );
  useEffect(
    () => () => {
      revealTokenRef.current += 1;
      useGameStore.getState().setState('IDLE');
    },
    []
  );

  // Step 6 — remember the round AFTER its animation has finished.
  //
  // The delay matters: this chip states the outcome in words, so writing it the
  // moment the server replies would spoil the answer in the corner of the
  // screen while the wheel was still turning — exactly the bug we just fixed in
  // the banner. It waits out the same animation budget the board uses.
  useEffect(() => {
    if (!round.result || CALLBACK_COMPLETION_GAMES.has(slug)) return;
    const mo = (round.mappedOutcome ?? {}) as { multiplier?: number; payout?: number };
    const wait = animMs(slug);
    const timer = setTimeout(() => {
      setLastRound({
        result: round.result as LastRound['result'],
        multiplier: typeof mo.multiplier === 'number' ? mo.multiplier : undefined,
        payout: typeof mo.payout === 'number' ? mo.payout : payoutRef.current,
        stake: stakeRef.current,
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [round.result, round.mappedOutcome, slug]);

  const handleVisualRoundComplete = React.useCallback(() => {
    completeRound();
    // Balance-hold announce for one-shot games: the reveal animation has
    // JUST shown the result on screen — now the balance may move
    // (crash/wingo/session holds already released at their own announce).
    if (slug) useBalanceHolds.getState().releaseBet(`bet:${slug}`);
    if (!round.result) return;
    const mapped = (round.mappedOutcome ?? {}) as {
      multiplier?: number;
      payout?: number;
    };
    setLastRound({
      result: round.result,
      multiplier: typeof mapped.multiplier === 'number' ? mapped.multiplier : undefined,
      payout: typeof mapped.payout === 'number' ? mapped.payout : payoutRef.current,
      stake: stakeRef.current,
    });
    // The board resets to a FRESH set of options after every result. The
    // previous pick staying highlighted read as "the game won't let me select
    // anything in round 2" (user report — the pick was actually still active
    // under the checkmark, but that's indistinguishable from a dead board).
    // Session games keep their in-progress config (mines layout, tower rows…)
    // and multiStep games keep their reveal state — only one-shot games reset.
    if (!isSessionGame && !gameModule?.multiStep) {
      setChoices(gameModule?.defaultChoices?.() ?? {});
    }
  }, [completeRound, round, isSessionGame, gameModule]);

  // D-092: session games — starting a round returns the session (board appears);
  // steps and cashout settle it. Terminal steps set the result banner.
  const onSessionStep = async (action: Record<string, unknown>) => {
    try {
      const res = await stepSession(action);
      if (res?.terminal) {
        if (res.view.status === 'CASHOUT') {
          const payout = Number(res.view.betAmount) * res.view.currentMultiplier;
          setRound({
            mappedOutcome: {
              ...res.stepResult,
              multiplier: res.view.currentMultiplier,
              payout,
            },
            result: 'WIN',
          });
        } else {
          setRound({ mappedOutcome: res.stepResult, result: 'LOSE' });
        }
      }
      return res;
    } catch (e) {
      notify.error((e as { message?: string }).message || 'Something went wrong');
      return null;
    }
  };
  const onSessionCashout = async () => {
    try {
      const res = await cashoutSession();
      if (res) {
        setRound({
          mappedOutcome: {
            ...res.mappedOutcome,
            multiplier: res.multiplier,
            payout: Number(res.payout),
          },
          result: 'WIN',
        });
      }
      return res;
    } catch (e) {
      notify.error((e as { message?: string }).message || 'Something went wrong');
      return null;
    }
  };
  const onSessionReset = () => {
    resetSession();
    setRound({ mappedOutcome: null, result: null });
    useGameStore.getState().setState('IDLE');
  };

  const onBet = async (amount: number, choicesOverride?: Record<string, unknown>) => {
    if (!user && !demoMode) {
      router.push(`/login?redirect=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    // Step 6 — remember what this round cost (for the profit figure) and make
    // "do that again" possible without re-typing the stake. Capture the exact
    // choices AT BET TIME: the board is intentionally reset to default picks
    // after every result (players asked for a fresh board each round), and the
    // repeat chip must replay the ORIGINAL wager, not whatever the board looks
    // like now.
    // Plinko N balls = N × this stake. Last-round profit must use the total.
    stakeRef.current =
      slug === 'plinko'
        ? plinkoChargedStake(amount, choicesOverride ?? choices)
        : amount;
    payoutRef.current = 0;
    const choicesSnapshot = { ...choices };
    setRepeatBet(() => () => {
      void onBet(amount, choicesSnapshot);
    });
    if (isSessionGame) {
      // D-092: start a session round — wallet debited ONCE, board appears
      setPending(true);
      try {
        const s = await startSession(amount, choicesOverride ?? choices, clientSeed);
        setPending(false);
        return s ? { result: 'SESSION_STARTED' } : null;
      } catch (e) {
        setPending(false);
        const err = e as { code?: string; message?: string };
        if (err.code === 'WAL_001' || err.message === 'Insufficient balance') {
          notify.info(
            demoMode
              ? 'Demo balance out — use Reset for more virtual coins'
              : 'Insufficient balance — top up from your Wallet to keep playing'
          );
          return null;
        }
        if (err.code === 'AUTH_002') return null;
        notify.error(err.message || 'Something went wrong');
        return null;
      }
    }
    // D-107: WinGo real-money bets join the SHARED lottery round (socket) —
    // pick a time (30s/1min/3min/5min), the round settles at the draw and the
    // result arrives via wingo:my-result. Demo stays on the provably-fair REST path.
    if (slug === 'wingo' && user && !demoMode) {
      // v1.3.5·§4: queue taps instead of SKIPPED-dropping them (see the module
      // helper) — stacking Red + 7 + Big in quick succession now keeps all three.
      return enqueueWingoBet(async () => {
        const st = useGameStore.getState();
        // With the serial queue this is nearly impossible, but another flow may
        // legitimately hold BETTING (e.g. a slow previous ack) — brief poll
        // instead of the old instant SKIPPED.
        for (let i = 0; i < 40 && useGameStore.getState().state === 'BETTING'; i++)
          await new Promise((r) => setTimeout(r, 50));
        st.setState('BETTING');
        const { optimisticDeduct, rollback, setBalance } = useWalletStore.getState();
        // Balance-hold: the stake must not visibly leave the balance until the
        // draw announces. Held under a per-request key, then moved onto the
        // roundId of the period it actually joined once the server accepts it.
        const holdTempKey = `wingo:pending:${uuid()}`;
        const betRequestId = uuid(); // §2: recovery handle if the ack is lost
        useBalanceHolds.getState().holdBet(holdTempKey, amount);
        const walletBefore = optimisticDeduct(amount);
        setPending(false); // the round's own countdown is the suspense
        setRound({ mappedOutcome: null, result: null }); // clear the previous round's banner
        const durationSec = Number(choices.durationSec ?? 30);
        try {
          type WingoAck = {
            success?: boolean;
            roundId?: string;
            message?: string;
            newBalance?: {
              real: number | string;
              bonus: number | string;
              gifted: number | string;
              locked: number | string;
            };
          };
          const ack = await new Promise<WingoAck>((resolve) => {
            let done = false;
            const finish = (r: WingoAck) => {
              if (!done) {
                done = true;
                resolve(r);
              }
            };
            // Omit roundId entirely rather than sending ''. The WinGo board never
            // sets `choices.roundId`, so this always sent an empty string; the
            // server's guard is `if (roundId && round.roundId !== roundId)`, so
            // an empty string happened to fall through — but any future tightening
            // of that check would have silently rejected every bet on the game.
            // Omitting it says what we mean: bet on whatever round is live now.
            const payload: Record<string, unknown> = {
              durationSec,
              choice: choices.choice,
              amount,
              requestId: betRequestId,
            };
            if (typeof choices.roundId === 'string' && choices.roundId)
              payload.roundId = choices.roundId;
            socket.emit('wingo:bet', payload, (a: WingoAck) =>
              finish(a ?? { success: false, message: 'No response from server' })
            );
            setTimeout(
              () =>
                finish({ success: false, message: 'Betting timed out — please retry' }),
              8000
            );
          });
          if (!ack?.success) {
            // §2: the ack may have died on the wire AFTER the server debited the
            // stake — never guess. Ask the server what actually happened with
            // THIS requestId before touching the optimistic balance.
            try {
              const status = await http.get<{
                found: boolean;
                roundId?: string;
                status?: string;
              }>(`/games/wingo/bet-status?requestId=${betRequestId}`);
              if (status?.found && status.status && status.status !== 'REFUNDED') {
                // The bet LANDED — keep the deduction, ride the round.
                useBalanceHolds
                  .getState()
                  .renameHold(
                    holdTempKey,
                    `wingo:round:${status.roundId ?? 'unknown'}`
                  );
                st.setState('PLAYING');
                notify.info('Connection hiccup — your bet went through ✓');
                return { status: 'PLACED' };
              }
            } catch {
              /* status check failed too — fall through to the safe rollback */
            }
            rollback(walletBefore);
            useBalanceHolds.getState().releaseBet(holdTempKey);
            st.setState('IDLE');
            notify.info(
              ack?.message === 'Insufficient balance'
                ? 'Insufficient balance — top up from your Wallet to keep playing'
                : ack?.message || 'Betting is closed — wait for the next round'
            );
            return null;
          }
          if (ack.newBalance) setBalance(ack.newBalance);
          // From here the hold is keyed by the round it joined — the draw's
          // wingo:my-result settles & releases it (payload carries roundId).
          useBalanceHolds
            .getState()
            .renameHold(holdTempKey, `wingo:round:${ack.roundId ?? 'unknown'}`);
          st.setState('PLAYING');
          return { status: 'PLACED' };
        } catch (e) {
          // §2: even on a transport catch, the bet may have landed — same rule.
          try {
            const status = await http.get<{
              found: boolean;
              roundId?: string;
              status?: string;
            }>(`/games/wingo/bet-status?requestId=${betRequestId}`);
            if (status?.found && status.status && status.status !== 'REFUNDED') {
              useBalanceHolds
                .getState()
                .renameHold(holdTempKey, `wingo:round:${status.roundId ?? 'unknown'}`);
              st.setState('PLAYING');
              notify.info('Connection hiccup — your bet went through ✓');
              return { status: 'PLACED' };
            }
          } catch {
            /* safe rollback below */
          }
          rollback(walletBefore);
          useBalanceHolds.getState().releaseBet(holdTempKey);
          st.setState('IDLE');
          notify.error((e as Error).message || 'Something went wrong');
          return null;
        }
      });
    }
    const token = ++revealTokenRef.current;
    setPending(true);
    // D-095: crash games — record MY bet so the visual can ride the curve
    if (slug === 'aviator' || slug === 'crash-x') {
      setMyCrashBet({ amount });
    }
    // D-090: clear the previous round's display so every new bet re-triggers the
    // result banner (consecutive identical results were previously swallowed).
    setRound({ mappedOutcome: null, result: null });
    try {
      const res = await placeBet(amount, choicesOverride ?? choices);
      if (!res) return null; // error path — message already shown / rollback done
      const status = (res as { status?: string }).status;
      if (status === 'SKIPPED') {
        setPending(false);
        return res;
      } // double-tap guard
      if (status === 'PLACED') {
        setPending(false);
        return res;
      } // crash/wingo — socket-driven
      // Hand the outcome to the board immediately. The board owns reveal timing
      // and calls onRoundComplete after its visible animation actually ends.
      if (revealTokenRef.current !== token) return res;
      setPending(false);
      const paid = Number((res as { payoutAmount?: number }).payoutAmount ?? 0);
      payoutRef.current = Number.isFinite(paid) ? paid : 0;
      setRound({
        mappedOutcome:
          (res as { mappedOutcome?: Record<string, unknown> }).mappedOutcome ?? null,
        result: (res as { result: 'WIN' | 'LOSE' | 'CASHOUT' | 'BUST' | 'PUSH' })
          .result,
      });
      return res;
    } catch (e) {
      setPending(false);
      // D-072: friendly, actionable messages instead of a raw error
      const err = e as { code?: string; message?: string };
      if (err.code === 'WAL_001' || err.message === 'Insufficient balance') {
        notify.info(
          demoMode
            ? 'Demo balance out — use Reset for more virtual coins'
            : 'Insufficient balance — top up from your Wallet to keep playing'
        );
        return null;
      }
      if (err.code === 'AUTH_002') return null; // session handled by providers
      notify.error(err.message || 'Something went wrong');
      return null;
    }
  };

  if (isLoading)
    return (
      <div className="min-h-dvh p-6 space-y-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-[50vh]" />
        <Skeleton className="h-52" />
      </div>
    );
  if (!game)
    return (
      <div className="p-6 text-center t-label-lg text-secondary">Game not found</div>
    );
  if (!gameModule)
    return (
      <div className="p-6 text-center t-label-lg text-secondary">
        Game UI not registered
      </div>
    );

  const config = {
    minBet: Number(game.minBet),
    maxBet: Number(game.maxBet ?? 0),
    maxWinMultiplier: Number(game.maxWinMultiplier),
    configJson: {
      ...(game.configJson ?? {}),
      round_duration_sec:
        (game as { roundDurationSec?: number }).roundDurationSec ?? 30,
    },
  };
  const { Visual, BetPanel } = gameModule;

  // D-073: demo master switch OFF + guest → show a clean "Log in to play"
  // panel instead of a bet bar (and never a raw error).
  // D-100: only decide AFTER the session restore settled (hydrated) — during
  // the restore a loading placeholder is shown instead.
  const loginRequired = hydrated && !user && !demoMode;

  // Full-bleed games (WinGo) paint their own page chrome — header, wallet card,
  // bet board and confirmation sheet — so they must NOT be nested inside the
  // standard dark GameShell.
  if (gameModule.fullBleed) {
    return (
      <ErrorBoundary>
        <div
          className="fixed inset-0 z-[60] flex flex-col"
          style={{ background: '#f2f3f7' }}
        >
          {/* app bar */}
          <header
            className="shrink-0 h-14 flex items-center justify-between px-3 text-white"
            style={{ background: 'linear-gradient(180deg,#fb8f7d 0%,#f4513d 100%)' }}
          >
            <button
              aria-label="Back"
              onClick={() => history.back()}
              className="w-9 h-9 text-2xl leading-none active:scale-90 transition-transform"
            >
              ‹
            </button>
            <h1 className="font-black tracking-wide text-[17px]">{game.displayName}</h1>
            <div className="flex items-center gap-1">
              <a
                href="/support"
                aria-label="Support"
                className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-[15px]"
              >
                🎧
              </a>
              <button
                aria-label="Sound"
                onClick={toggleSound}
                className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-[15px]"
              >
                ♪
              </button>
            </div>
          </header>

          <main className="flex-1 min-h-0">
            {!hydrated ? (
              <div className="h-full flex items-center justify-center gap-2">
                <span
                  className="inline-block w-4 h-4 border-2 border-black/10 rounded-full animate-spin"
                  style={{ borderTopColor: '#f4513d' }}
                />
                <span className="text-[13px]" style={{ color: '#8a90a0' }}>
                  Loading your session…
                </span>
              </div>
            ) : (
              <Visual
                outcome={round.mappedOutcome}
                result={round.result}
                config={config}
                choices={choices}
                setChoices={setChoices}
                eventPrefix={game.slug}
                onRoundComplete={handleVisualRoundComplete}
              />
            )}
          </main>

          {/* the bet sheet renders itself as a fixed overlay when a target is picked */}
          {hydrated && !loginRequired && (
            <BetPanel
              onBet={onBet}
              minBet={config.minBet}
              balance={demoMode ? demoBalance : balance}
              // WinGo (the only fullBleed game) settles via the round clock, so
              // the in-flight lock must only cover the socket ACK — keeping the
              // sheet disabled for the whole round blocked stacking more than
              // one bet per period, which is core WinGo play.
              isLoading={state === 'BETTING'}
              config={config}
              choices={choices}
              setChoices={setChoices}
              slug={game.slug}
            />
          )}

          {/* guests: a light login prompt matching the theme */}
          {hydrated && loginRequired && (
            <div
              className="shrink-0 bg-white px-4 py-3 text-center"
              style={{ boxShadow: '0 -1px 4px rgba(0,0,0,0.06)' }}
            >
              <p className="text-[13px] mb-2" style={{ color: '#8a90a0' }}>
                Log in to play {game.displayName} for real money.
              </p>
              <div className="flex gap-2">
                <a
                  href={`/login?redirect=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/games')}`}
                  className="flex-1 h-11 rounded-full flex items-center justify-center font-bold text-white"
                  style={{ background: '#f4513d' }}
                >
                  Log in
                </a>
                <a
                  href="/signup"
                  className="flex-1 h-11 rounded-full flex items-center justify-center font-bold text-white"
                  style={{ background: '#22b573' }}
                >
                  Sign up
                </a>
              </div>
            </div>
          )}
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <GameShell
        slug={game.slug}
        title={game.displayName}
        onRulesOpen={() => {}}
        rules={{
          description: game.description,
          baseRtp: game.baseRtp,
          minBet: game.minBet,
          maxWinMultiplier: game.maxWinMultiplier,
        }}
        demo={
          demoMode
            ? {
                active: true,
                balance: demoBalance,
                onReset: demoReset,
                signedIn: !!user,
                onExit: user ? () => setDemoToggled(false) : undefined,
              }
            : undefined
        }
        betPanel={
          !hydrated ? (
            /* D-100: session still restoring — neutral placeholder, never a
             wrong "Log in to play" / guest flash for a logged-in user */
            <div className="flex items-center gap-3">
              <div className="flex-1 h-14 rounded-xl bg-layer-elevated border border-white/10 flex items-center justify-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-white/15 border-t-gold rounded-full animate-spin" />
                <span className="t-label-sm text-white/50">Loading your session…</span>
              </div>
              <div className="h-14 w-24 rounded-xl bg-white/5 animate-pulse" />
            </div>
          ) : loginRequired ? (
            <div className="rounded-2xl border border-gold/25 bg-gradient-to-br from-[#2a2008] via-layer-surface to-layer-void p-5 text-center">
              <p className="text-3xl mb-2">🔐</p>
              <p className="t-label-lg text-primary mb-1">
                Log in to play {game.displayName}
              </p>
              <p className="t-body text-secondary mb-4">
                Demo mode is off — create a free account or log in to play for real
                money.
              </p>
              <div className="flex gap-2">
                <a
                  href={`/login?redirect=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/games')}`}
                  className="btn-primary flex-1"
                >
                  Log in
                </a>
                <a href="/signup" className="btn-outline-gold flex-1">
                  Sign up
                </a>
              </div>
            </div>
          ) : isSessionGame && session?.status === 'ACTIVE' ? (
            /* D-092: mid-round control bar — current multiplier + CASH OUT */
            <SessionStatusBar
              session={session}
              busy={sessionBusy}
              onCashout={onSessionCashout}
            />
          ) : (
            <BetPanel
              onBet={onBet}
              minBet={config.minBet}
              balance={demoMode ? demoBalance : balance}
              isLoading={state === 'BETTING' || state === 'PLAYING' || sessionBusy}
              config={config}
              choices={choices}
              setChoices={setChoices}
              slug={game.slug}
            />
          )
        }
      >
        <div className="relative w-full h-full">
          {/* Step 6 — round memory: what the last round paid, and a one-tap
              repeat. Absolutely positioned so it costs no vertical space. */}
          <LastResultChip
            last={lastRound}
            busy={
              pending ||
              state === 'BETTING' ||
              state === 'PLAYING' ||
              (isSessionGame && session?.status === 'ACTIVE')
            }
            onRepeat={isSessionGame ? null : repeatBet}
          />
          {/*
            A small "placing bet" pill, shown ONLY while we are still waiting on
            the network — and parked at the top of the board, not across it.

            It used to be a full-board overlay reading "BETTING..." in the dead
            centre. Combined with the old 1500ms outcome hold, that meant the
            first 1.5 seconds of every round were a motionless board behind a
            spinner. Once the outcome arrives the board animates, and the board
            is the thing worth looking at — so this gets out of the way.
          */}
          {pending && !isSessionGame && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
              <div className="flex items-center gap-1.5 rounded-full bg-black/55 border border-gold/25 px-3 py-1 backdrop-blur-sm">
                <span className="inline-block w-3 h-3 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                <span className="t-label-sm text-gold/90 tracking-wide">
                  PLACING BET
                </span>
              </div>
            </div>
          )}
          <Visual
            outcome={round.mappedOutcome}
            result={round.result}
            config={config}
            choices={choices}
            setChoices={setChoices}
            eventPrefix={game.slug}
            session={session}
            onSessionStep={onSessionStep}
            onSessionCashout={onSessionCashout}
            onSessionReset={onSessionReset}
            sessionBusy={sessionBusy}
            onRoundComplete={handleVisualRoundComplete}
          />
        </div>
      </GameShell>
    </ErrorBoundary>
  );
}

/** D-092: compact mid-round bar shown instead of the bet panel while a
 * session round is live: live multiplier count-up + pulsing CASH OUT. */
function SessionStatusBar({
  session,
  busy,
  onCashout,
}: {
  session: SessionView;
  busy: boolean;
  onCashout: () => Promise<unknown>;
}) {
  const payout = Number(session.betAmount) * session.currentMultiplier;
  return (
    /* Four lines of text used to be crammed into a fixed h-14 bar, so
       "Payout if you cash out" overlapped the multiplier underneath it
       (screenshotted on Tower). The bar is now auto-height with two clean
       columns, and the money — the number the player is deciding on — is the
       biggest thing in it. */
    <div className="flex items-stretch gap-2 sm:gap-3">
      <div className="flex-1 min-w-0 rounded-xl bg-layer-elevated border border-gold/20 px-2.5 sm:px-3 py-1.5 sm:py-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="t-label-sm text-muted leading-none mb-1">Current</p>
          <p className="t-num-lg text-gold tabular-nums leading-none">
            <CountUp value={session.currentMultiplier} decimals={2} duration={500} />×
          </p>
          <p className="t-label-sm text-muted leading-none mt-1">
            next {session.nextMultiplier.toFixed(2)}×
          </p>
        </div>
        <div className="text-right shrink-0 min-w-0">
          <p className="t-label-sm text-muted leading-none mb-1">Cash out now</p>
          <p className="t-num-lg text-green tabular-nums leading-none">
            {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
            {payout.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>
      <button
        onClick={() => void onCashout()}
        disabled={busy}
        className="btn-primary h-14 px-6 rounded-xl shadow-[0_4px_24px_rgba(0,217,126,0.45)] animate-pulse-slow disabled:opacity-50"
      >
        {busy ? '…' : '💰 CASH OUT'}
      </button>
      <style>{`@keyframes pulseSlow { 0%,100% { box-shadow: 0 4px 24px rgba(0,217,126,0.45) } 50% { box-shadow: 0 4px 34px rgba(0,217,126,0.75) } } .animate-pulse-slow { animation: pulseSlow 1.6s ease-in-out infinite }`}</style>
    </div>
  );
}
