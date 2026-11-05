// apps/web/src/hooks/index.ts — useGame (bet lifecycle),
// useAppLifecycle (wake lock / visibility / vibration), useMultiTab, useLazyImage,
// useNetworkStatus.
//
// NOTE: auto-play / multi-bet was removed by product decision — every bet is an
// explicit, deliberate user action. Do not reintroduce a loop that places bets
// on the player's behalf.
import { useCallback, useEffect, useRef, useState } from 'react';
import { plinkoChargedStake } from '@casino/shared';
import type { SettledRoundResult } from '@casino/shared/types';
import {
  useGameStore,
  useWalletStore,
  useBalanceHolds,
  refreshBalance,
} from '../stores';
import { api, betStatus, ApiError, uuid } from '../lib/api';
import {
  betRoundDto,
  sessionStartDto,
  sessionRecoverDto,
  sessionStepDto,
  sessionCashoutDto,
} from '../lib/dto';
import { invalidate } from '../lib/app';
import { useDemoStore } from '../lib/demo';

interface BetRoundResponse {
  roundId: string;
  // absent on shared-round PLACED accepts (crash/wingo settle via socket)
  result?: 'WIN' | 'LOSE' | 'CASHOUT' | 'BUST' | 'PUSH';
  payoutAmount?: number;
  newBalance?: {
    real: number | string;
    bonus: number | string;
    gifted: number | string;
    locked: number | string;
  };
  mappedOutcome?: Record<string, unknown> | null;
  nonce?: number;
  seedHash?: string;
  status?: 'PLACED' | 'SKIPPED'; // crash/wingo: joined shared round; SKIPPED: duplicate bet attempt
  joinMultiplier?: number; // crash: the multiplier this bet joined at (1 = take-off)
}

// ── useGame — the complete bet lifecycle (docs/19 §7) ──────────────────────
export function useGame(
  slug: string,
  clientSeed: string,
  demo = false,
  resultHoldMs: number | ((choices: unknown) => number) | null = 2900,
  initialNonce?: number
) {
  const store = useGameStore();
  const nonceRef = useRef(Number.isInteger(initialNonce) ? initialNonce! : 0);
  useEffect(() => {
    if (Number.isInteger(initialNonce) && initialNonce! >= 0)
      nonceRef.current = initialNonce!;
  }, [initialNonce]);
  const betTokenRef = useRef(0); // D-090: guards the delayed IDLE reset

  const placeBet = useCallback(
    async (amount: number, choices: unknown, requestId?: string) => {
      // D-090: re-entry guard — a bet is already in flight (or a crash/wingo
      // round is live) → ignore the tap so double-taps can't place 2 bets.
      const st = useGameStore.getState().state;
      if (st === 'BETTING' || st === 'PLAYING') {
        return { status: 'SKIPPED' } as BetRoundResponse;
      }
      const token = ++betTokenRef.current;
      const scheduleIdle = (ms: number) => {
        setTimeout(() => {
          if (
            betTokenRef.current === token &&
            useGameStore.getState().state !== 'BETTING'
          ) {
            useGameStore.getState().setState('IDLE');
          }
        }, ms);
      };

      const { optimisticDeduct, rollback, setBalance } = useWalletStore.getState();
      const demoStore = useDemoStore.getState();
      const nonce = nonceRef.current;
      const requestedHold =
        typeof resultHoldMs === 'function' ? resultHoldMs(choices) : resultHoldMs;
      const holdMs =
        requestedHold === null
          ? null
          : Math.max(0, Number.isFinite(requestedHold) ? requestedHold : 2900);
      // D-090: BETTING synchronously — closes the bet popup instantly (isLoading)
      // and disables the Play button for the whole round-trip.
      store.setState('BETTING');
      // Plinko: `amount` is per ball; the server debits amount × balls. Hold
      // and optimistic deduct must match that total or the chip undershoots.
      const charged = slug === 'plinko' ? plinkoChargedStake(amount, choices) : amount;
      // Balance-hold (display rule): the rendered balance must not move until
      // the result is announced. Hold the stake FIRST so the optimistic
      // deduction and the server's balance are invisible to the player.
      useBalanceHolds.getState().holdBet(`bet:${slug}`, charged);
      const walletBefore = demo ? null : optimisticDeduct(charged);
      if (demo) demoStore.deduct(charged);

      // M-08: keep the exact idempotency key we are about to send — timeout
      // recovery below queries by THIS id, not the guessable (seed, nonce).
      const sentRequestId = requestId ?? uuid();
      try {
        const round = await api<BetRoundResponse>(`/games/${slug}/bet`, {
          method: 'POST',
          body: { amount, choices, clientSeed, requestId: sentRequestId },
          timeoutMs: 8000, // docs/19 §7 step 3
          demo,
          skipAuth: demo, // demo runs on the shared demo user — no login needed (docs/20 §9)
          schema: betRoundDto, // uniform response validation (docs/19 §21)
        });

        // Crash games: bet PLACED on the shared round — the round settles via socket
        if (round.status === 'PLACED') {
          if (round.newBalance) setBalance(round.newBalance);
          store.setState('PLAYING');
          // shared-round (crash): the bet rides the flight — its hold is
          // settled/released by {slug}:my-result on the page, at the exact
          // moment the win/bust banner appears.
          return round;
        }

        // instant rounds always carry result+payout+nonce (only shared-round
        // PLACED accepts lack them — that branch returned above).
        // settled — record the payout against the hold so the balance display
        // STAYS frozen through the reveal animation; the page releases it in
        // onRoundComplete, the instant the result shows on screen.
        useBalanceHolds
          .getState()
          .settleBet(`bet:${slug}`, Number(round.payoutAmount ?? 0));
        const settled = round as Required<
          Pick<BetRoundResponse, 'result' | 'payoutAmount' | 'nonce'>
        > &
          BetRoundResponse;
        nonceRef.current = settled.nonce + 1;
        if (demo) demoStore.credit(settled.payoutAmount);
        else if (settled.newBalance) setBalance(settled.newBalance);
        store.setState('PLAYING');
        store.setState(
          settled.result === 'WIN' || settled.result === 'CASHOUT'
            ? 'RESULT_WIN'
            : 'RESULT_LOSE'
        );
        store.recordResult({
          betAmount: charged,
          payout: settled.payoutAmount,
          result:
            settled.result === 'WIN' || settled.result === 'CASHOUT' ? 'WIN' : 'LOSE',
        });
        if (!demo) {
          invalidate.gameHistory(slug);
          invalidate.sessionStats();
        }
        // Keep the control locked until this board's declared animation has
        // completed. A universal 2.9s timer re-enabled Wheel/Keno/Roulette while
        // their 3.6–4.4s animations were still running, so round two cancelled or
        // overwrote round one. Multi-ball Plinko supplies a choice-aware duration.
        if (holdMs !== null) scheduleIdle(holdMs);
        return round;
      } catch (e) {
        if (e instanceof ApiError && e.status === 408 && !demo) {
          // timeout — DON'T assume; query bet-status (docs/19 §7 4c)
          try {
            const status = await betStatus(slug, {
              requestId: sentRequestId,
              clientSeed,
              nonce,
            });
            if (status?.round) {
              const recovered = status.round;
              const won = recovered.result === 'WIN' || recovered.result === 'CASHOUT';
              nonceRef.current = recovered.nonce + 1;
              setBalance(recovered.newBalance);
              store.setState(won ? 'RESULT_WIN' : 'RESULT_LOSE');
              store.recordResult({
                betAmount: amount,
                payout: recovered.payoutAmount,
                result: won ? 'WIN' : 'LOSE',
              });
              invalidate.gameHistory(slug);
              invalidate.sessionStats();
              if (holdMs !== null) scheduleIdle(holdMs);
              return recovered as BetRoundResponse;
            }
          } catch {
            /* fall through to rollback */
          }
          if (walletBefore) rollback(walletBefore);
          useBalanceHolds.getState().releaseBet(`bet:${slug}`);
          store.setState('ERROR');
          scheduleIdle(1600);
          return null;
        }
        if (demo) demoStore.credit(amount);
        else if (walletBefore) rollback(walletBefore);
        useBalanceHolds.getState().releaseBet(`bet:${slug}`);
        store.setState('ERROR');
        scheduleIdle(1600);
        throw e;
      }
    },
    [slug, clientSeed, store, demo, resultHoldMs]
  );

  const completeRound = useCallback(() => {
    const current = useGameStore.getState().state;
    if (
      current === 'RESULT_WIN' ||
      current === 'RESULT_LOSE' ||
      current === 'PLAYING'
    ) {
      useGameStore.getState().setState('IDLE');
    }
  }, []);

  return { placeBet, completeRound, state: store.state };
}

// ── useAppLifecycle — wake lock during crash round, visibility pause, haptics
// (docs/22 §wake/§visibility/§vibration)
export function useAppLifecycle(isGameActive: boolean) {
  // Screen wake lock: prevent sleep during live crash rounds
  useEffect(() => {
    if (!isGameActive) return;
    let lock: { release: () => Promise<void> } | null = null;
    (
      navigator as unknown as {
        wakeLock?: {
          request: (t: string) => Promise<{ release: () => Promise<void> }>;
        };
      }
    ).wakeLock
      ?.request('screen')
      .then((l) => {
        lock = l;
      })
      .catch(() => {});
    return () => {
      lock?.release().catch(() => {});
    };
  }, [isGameActive]);

  // Visibility: pause game loops when hidden, resume + resync (docs/22 §visibility)
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        (window as unknown as { __pauseGame?: () => void }).__pauseGame?.();
      } else {
        (window as unknown as { __resumeGame?: () => void }).__resumeGame?.();
        invalidate.balance();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
}

/** Haptic feedback (docs/18 mobile + docs/22 §vibration) */
export function vibrate(pattern: number | number[]) {
  if ('vibrate' in navigator) navigator.vibrate(pattern);
}

// ── useMultiTab — BroadcastChannel detection (docs/20 §15) ─────────────────
// D-079: guarded — BroadcastChannel / crypto.randomUUID are missing in some
// browsers & embedded contexts; an unguarded `new BroadcastChannel()` threw
// inside useEffect → game pages crashed with the in-app error boundary right
// after opening ("nano second" then "Something went wrong").
export function useMultiTab(gameSlug: string) {
  const [isDuplicate, setIsDuplicate] = useState(false);
  useEffect(() => {
    if (
      typeof BroadcastChannel === 'undefined' ||
      typeof crypto === 'undefined' ||
      !crypto.randomUUID
    )
      return;
    try {
      const channel = new BroadcastChannel(`game-${gameSlug}`);
      const tabId = crypto.randomUUID();
      channel.postMessage({ type: 'TAB_OPEN', tabId });
      channel.onmessage = (e) => {
        if (e.data.type === 'TAB_OPEN' && e.data.tabId !== tabId) {
          setIsDuplicate(true);
          channel.postMessage({ type: 'TAB_EXISTS', tabId });
        }
        if (e.data.type === 'TAB_EXISTS' && e.data.tabId !== tabId)
          setIsDuplicate(true);
      };
      return () => {
        channel.postMessage({ type: 'TAB_CLOSE', tabId });
        channel.close();
      };
    } catch {
      /* BroadcastChannel unavailable — multi-tab guard skipped */
    }
  }, [gameSlug]);
  return isDuplicate;
}

// ── useLazyImage — IntersectionObserver (docs/22 §lazy) ────────────────────
export function useLazyImage<T extends HTMLElement>(rootMargin = '200px') {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [rootMargin]);
  return { ref, visible };
}

// ── useNetworkStatus (docs/19 §22) ─────────────────────────────────────────
export function useNetworkStatus() {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

// ── useSessionGame (D-092) — multi-step session games (mines/tower/stairs/hi-lo) ─
// ONE bet per round: start() creates the session (wallet debited once), step()
// advances the multiplier, cashout() settles bet × multiplier. Timeout recovery:
// if the start request times out, GET /session returns the created round so a
// retry can never double-charge.
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
export interface SessionStepResponse {
  view: SessionView;
  stepResult: Record<string, unknown>;
  terminal: boolean;
}
export interface SessionCashoutResponse {
  roundId: string;
  result: 'CASHOUT';
  multiplier: number;
  payout: string;
  mappedOutcome: Record<string, unknown>;
}

export function useSessionGame(slug: string, demo = false) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  /** synchronous re-entry guard for step/cashout (see step()). */
  const stepInFlightRef = useRef(false);

  const start = useCallback(
    async (amount: number, choices: Record<string, unknown>, clientSeed: string) => {
      const token = ++requestRef.current;
      setBusy(true);
      // Balance-hold FIRST — the server debits + broadcasts balance:update
      // DURING this request, and the hold must exist before either reaches
      // the UI or the display would briefly float up by the stake.
      useBalanceHolds.getState().holdBet(`session:${slug}`, amount);
      try {
        const res = await api<{ status: 'SESSION_STARTED'; session: SessionView }>(
          `/games/${slug}/session`,
          {
            method: 'POST',
            body: { amount, choices, clientSeed, requestId: uuid() },
            timeoutMs: 8000,
            demo,
            skipAuth: demo,
            schema: sessionStartDto,
          }
        );
        if (token !== requestRef.current) return null;
        setSession(res.session);
        // Force the store onto the post-debit ledger NOW (the server debits
        // inside this request but sends no balance event for it) — then the
        // hold correction (+stake) exactly freezes the displayed number.
        if (!demo) void refreshBalance();
        return res.session;
      } catch (e) {
        useBalanceHolds.getState().releaseBet(`session:${slug}`);
        if (e instanceof ApiError && e.status === 408) {
          // timeout — the session may exist server-side; never double-charge
          try {
            const rec = await api<{ session: SessionView | null }>(
              `/games/${slug}/session`,
              { demo, skipAuth: demo, schema: sessionRecoverDto }
            );
            if (rec?.session?.status === 'ACTIVE') {
              setSession(rec.session as SessionView);
              useBalanceHolds.getState().holdBet(`session:${slug}`, amount);
              return rec.session as SessionView;
            }
          } catch {
            /* fall through */
          }
        }
        if (e instanceof ApiError && e.status === 409) {
          // already have an active round — recover it
          try {
            const rec = await api<{ session: SessionView | null }>(
              `/games/${slug}/session`,
              { demo, skipAuth: demo, schema: sessionRecoverDto }
            );
            if (rec?.session) {
              setSession(rec.session as SessionView);
              // recovered live rounds own the display hold (use its real
              // stake — restored sessions after a reload land through here)
              if (rec.session.status === 'ACTIVE')
                useBalanceHolds
                  .getState()
                  .holdBet(`session:${slug}`, Number(rec.session.betAmount) || 0);
              return rec.session as SessionView;
            }
          } catch {
            /* fall through */
          }
        }
        throw e;
      } finally {
        if (token === requestRef.current) setBusy(false);
      }
    },
    [slug, demo]
  );

  /** After a stale-round 409, quietly re-sync from the server instead of
   * surfacing "Round was already advanced or settled" as an error toast. The
   * board gets the round's true (settled) state and the game carries on. */
  const recoverSilently = useCallback(async (): Promise<SessionView | null> => {
    try {
      const rec = await api<{ session: SessionView | null }>(`/games/${slug}/session`, {
        demo,
        skipAuth: demo,
        schema: sessionRecoverDto,
      });
      if (rec?.session) {
        setSession(rec.session as SessionView);
        // Rehydrate the display hold for a live round (e.g. after a full
        // reload landed mid-session — the ledger was debited before, so the
        // number must stay frozen until THIS round announces too).
        if (rec.session.status === 'ACTIVE')
          useBalanceHolds
            .getState()
            .holdBet(`session:${slug}`, Number(rec.session.betAmount) || 0);
        return rec.session as SessionView;
      }
    } catch {
      /* best effort — the next action will retry */
    }
    return null;
  }, [slug, demo]);

  const step = useCallback(
    async (action: Record<string, unknown>): Promise<SessionStepResponse | null> => {
      if (!session) throw new Error('No active session');
      // Single-flight (synchronous ref, not the React `busy` state — state
      // flushes too late to stop two taps in the same 100ms window). The board
      // used to let BOTH taps reach the server; the loser 409'd as
      // "Round was already advanced or settled" — a scary error toast shown
      // for a plain double-tap right as the game ends.
      if (stepInFlightRef.current) return null;
      stepInFlightRef.current = true;
      setBusy(true);
      try {
        const res = await api<SessionStepResponse>(`/games/${slug}/step`, {
          method: 'POST',
          body: { roundId: session.roundId, action },
          demo,
          skipAuth: demo,
          schema: sessionStepDto,
        });
        setSession(res.view);
        // A bust settles the round on this step's response — that IS the
        // announce (the board renders the 💥 from res.view.status). Payout 0.
        if (res.view.status === 'BUST') {
          if (!demo) await refreshBalance();
          useBalanceHolds.getState().releaseBet(`session:${slug}`);
        }
        return res;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          await recoverSilently();
          return null;
        }
        throw e;
      } finally {
        stepInFlightRef.current = false;
        setBusy(false);
      }
    },
    [slug, session, demo, recoverSilently]
  );

  const cashout = useCallback(async (): Promise<SessionCashoutResponse | null> => {
    if (!session) throw new Error('No active session');
    // Same single-flight guard as step(): a double CASH OUT tap used to race
    // the /cashout endpoint and the slower request lost with a 409 toast.
    if (stepInFlightRef.current) return null;
    stepInFlightRef.current = true;
    setBusy(true);
    try {
      const res = await api<SessionCashoutResponse>(`/games/${slug}/cashout`, {
        method: 'POST',
        body: { roundId: session.roundId },
        demo,
        skipAuth: demo,
        schema: sessionCashoutDto,
      });
      setSession((s) => (s ? { ...s, status: 'CASHOUT' } : s));
      if (!demo) await refreshBalance(); // ledger now includes the payout
      {
        const v = useBalanceHolds.getState();
        v.settleBet(
          `session:${slug}`,
          Number(
            (res as { payoutAmount?: number | string }).payoutAmount ??
              (res as unknown as { payout?: number | string }).payout ??
              0
          )
        );
        v.releaseBet(`session:${slug}`);
      }
      return res;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await recoverSilently();
        return null;
      }
      throw e;
    } finally {
      stepInFlightRef.current = false;
      setBusy(false);
    }
  }, [slug, session, demo, recoverSilently]);

  const reset = useCallback(() => {
    requestRef.current++;
    setSession(null);
    setBusy(false);
  }, []);

  return { session, busy, start, step, cashout, reset };
}

// ── useSessionStats (docs/19 §6 sessionStats + v6) ─────────────────────────
export function useSessionStats() {
  // Subscribe to the slice directly. The previous implementation wrapped
  // `useGameStore.getState()` in a useMemo whose dependency was itself a hook
  // call — an invalid dependency expression that read a snapshot outside the
  // subscription, so the value could go stale.
  return useGameStore((s) => s.sessionStats);
}
