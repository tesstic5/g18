// apps/web/src/stores/index.ts — Zustand stores (docs/19 §6 shape + v4).
import { create } from 'zustand';
import { safeStorage } from '../lib/safe-storage';
import { http, forgetCsrf } from '../lib/api';
import { sound } from '../lib/sound';
import { apiBaseUrl } from '../lib/env';
import { balanceDto, parseDto } from '../lib/dto';

// Late binding for logout() → balance-hold cleanup: the holds store is
// created below the auth store, so logout dereferences through this ref.
let useBalanceHoldsStoreRef: { clearHolds: () => void } | null = null;

// ── AUTH ───────────────────────────────────────────────────────────────────
interface AuthState {
  user: {
    id: string;
    displayName?: string;
    phone: string;
    language?: string;
    theme?: string;
    sessionReminderMin?: number | null;
    dailyLossLimit?: number | string | null;
    dailyDepositLimit?: number | string | null;
    selfExcludedUntil?: string | null;
    favorites?: string[]; // M-18: persisted favorites ride /auth/me
  } | null;
  accessToken: string | null;
  hydrated: boolean;
  setSession: (u: AuthState['user'], t: string | null) => void;
  logout: () => Promise<void>;
}
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  hydrated: false,
  setSession: (user, accessToken) => set({ user, accessToken, hydrated: true }),
  logout: async () => {
    const here = window.location.pathname;
    set({ user: null, accessToken: null, hydrated: true });
    forgetCsrf();
    // drop any balance-hold corrections of the outgoing user — never let the
    // previous player's frozen display leak into the next session.
    useBalanceHoldsStoreRef?.clearHolds?.();
    // Revoke the durable refresh family and clear the httpOnly cookie before
    // navigating. Local-only logout was undone by session restore on reload.
    await fetch(`${apiBaseUrl()}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
    }).catch(() => {});
    if (process.env.NODE_ENV !== 'test' && here !== '/login' && here !== '/signup') {
      window.location.href = '/login';
    }
  },
}));

// ── WALLET (docs/19 §7 optimistic deduction) ────────────────────────────────
interface Balances {
  real: number;
  bonus: number;
  gifted: number;
  locked: number;
}
type BalanceInput = { [K in keyof Balances]: Balances[K] | string };
type SpendableWallet = Exclude<keyof Balances, 'locked'>;
interface WalletState extends Balances {
  /** M-11: mirrors the server's `bet_spend_priority` setting. */
  spendPriority: SpendableWallet[];
  optimisticDeduct: (amount: number) => Balances; // returns exact rollback snapshot
  setBalance: (b: Partial<BalanceInput> | null | undefined) => void; // server truth
  rollback: (snapshot: Balances) => void; // exact rollback on error
}
// M-11: cents-integer math — float subtraction on large Decimal-derived
// numbers loses cents (e.g. 9999999.99 - 0.1). All money here is ≤ 2dp, so
// integer cents are exact.
const toCents = (n: number): number => Math.round(n * 100);
const fromCents = (c: number): number => c / 100;
const PRIORITY_KEY: Record<string, SpendableWallet> = {
  REAL: 'real',
  BONUS: 'bonus',
  GIFTED: 'gifted',
};
export const useWalletStore = create<WalletState>((set, get) => ({
  real: 0,
  bonus: 0,
  gifted: 0,
  locked: 0,
  spendPriority: ['bonus', 'gifted', 'real'],
  optimisticDeduct: (amount) => {
    const before: Balances = {
      real: get().real,
      bonus: get().bonus,
      gifted: get().gifted,
      locked: get().locked,
    };
    // M-11: walk the SERVER'S configured spend order (was hardcoded
    // BONUS → GIFTED → REAL and silently disagreed with the settled split
    // whenever the operator changed the setting).
    const order = get().spendPriority;
    let remainingCents = Math.max(0, toCents(amount));
    const spent: Record<SpendableWallet, number> = { real: 0, bonus: 0, gifted: 0 };
    for (const key of order) {
      if (remainingCents <= 0) break;
      const availableCents = toCents(before[key]);
      const take = Math.min(availableCents, remainingCents);
      spent[key] = take;
      remainingCents -= take;
    }
    set({
      bonus: fromCents(toCents(before.bonus) - spent.bonus),
      gifted: fromCents(toCents(before.gifted) - spent.gifted),
      real: fromCents(toCents(before.real) - spent.real),
    });
    return before;
  },
  // D-077: the API returns balances as STRINGS (Decimal.toString) and the
  // socket balance:update / game results too. Every UI calls .toFixed() —
  // storing raw strings made the whole app crash for logged-in users
  // ("Something went wrong", private window worked because guests never
  // fetch the balance). Coerce to numbers HERE so every consumer is safe.
  setBalance: (b) => {
    // M-11: adopt the server's spend order when it ships with the balance.
    const rawPriority = (b as { spendPriority?: string[] } | null | undefined)
      ?.spendPriority;
    const spendPriority = Array.isArray(rawPriority)
      ? (rawPriority
          .map((k) => PRIORITY_KEY[String(k).toUpperCase()])
          .filter(Boolean) as SpendableWallet[])
      : undefined;
    set({
      real: Number(b?.real ?? 0) || 0,
      bonus: Number(b?.bonus ?? 0) || 0,
      gifted: Number(b?.gifted ?? 0) || 0,
      locked: Number(b?.locked ?? 0) || 0,
      ...(spendPriority && spendPriority.length ? { spendPriority } : {}),
    });
  },
  rollback: (snapshot) => set(snapshot),
}));

export async function refreshBalance() {
  const raw = await http.get<unknown>('/wallet/balance');
  const balance = parseDto(balanceDto, raw, 'Wallet balance');
  useWalletStore.getState().setBalance(balance);
}

/** Apply a server snapshot from a mutation response (claim, bet, admin credit). */
export function applyServerBalance(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  try {
    const balance = parseDto(balanceDto, raw, 'Wallet balance');
    useWalletStore.getState().setBalance(balance);
  } catch {
    void refreshBalance().catch(() => {});
  }
}

// ── BALANCE HOLDS (display-side) ───────────────────────────────────────────
// Product rule: the visible balance must NOT move the instant a bet is
// placed. It updates exactly once — when THAT round's result is announced
// (reveal end for one-shot games, {slug}:my-result for wingo/crash, and
// cashout/bust for session games).
//
// The server ledger stays perfectly correct & atomic (debit at placement is
// required to stop double-spends); this store only holds a *display
// correction*: for every bet still waiting for its announcement we add back
// the stake (and subtract the already-credited payout), so the rendered total
// equals the pre-bet balance until the announce moment.
export interface BalanceHold {
  stake: number; // total staked still awaiting announce (can stack)
  payout: number; // credited-but-not-yet-announced payout (adds as results land)
  at: number;
}
interface BalanceHoldState {
  holds: Record<string, BalanceHold>;
  holdBet: (key: string, stake: number) => void;
  /** An already-placed bet moves from "pending" to "settled" — display stays
   *  frozen (net correction stake−payout) until releaseBet fires at announce. */
  settleBet: (key: string, payout: number) => void;
  /** The announce moment — the display snaps to the ledger truth. */
  releaseBet: (key: string) => void;
  /** Move a hold to a new key without ever dropping the correction. */
  renameHold: (from: string, to: string) => void;
  clearHolds: () => void;
}
/** Hard bound on how long a display freeze can outlive its announce handler
 *  (tab closed mid-round, socket loss…). Longest round is wingo-5Min, so
 *  anything past 12 minutes is definitely stale. */
const HOLD_TTL_MS = 12 * 60 * 1000;
const holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const useBalanceHolds = create<BalanceHoldState>((set) => ({
  holds: {},
  holdBet: (key, stake) => {
    if (!stake || stake <= 0) return;
    set((s) => {
      const cur = s.holds[key];
      return {
        holds: {
          ...s.holds,
          [key]: {
            stake: +((cur?.stake ?? 0) + stake).toFixed(2),
            payout: cur?.payout ?? 0,
            at: Date.now(),
          },
        },
      };
    });
    if (holdTimers.has(key)) clearTimeout(holdTimers.get(key));
    holdTimers.set(
      key,
      setTimeout(() => useBalanceHolds.getState().releaseBet(key), HOLD_TTL_MS)
    );
  },
  settleBet: (key, payout) =>
    set((s) => {
      const cur = s.holds[key];
      if (!cur || cur.payout > 0) return {}; // already settled — idempotent
      return {
        holds: {
          ...s.holds,
          [key]: { ...cur, payout: +(cur.payout + payout).toFixed(2) },
        },
      };
    }),
  releaseBet: (key) => {
    if (holdTimers.has(key)) {
      clearTimeout(holdTimers.get(key));
      holdTimers.delete(key);
    }
    set((s) => {
      if (!(key in s.holds)) return {};
      const next = { ...s.holds };
      delete next[key];
      return { holds: next };
    });
  },
  renameHold: (from, to) => {
    if (from === to) return;
    if (holdTimers.has(from)) {
      clearTimeout(holdTimers.get(from));
      holdTimers.delete(from);
    }
    set((s) => {
      const moved = s.holds[from];
      if (!moved) return {};
      const next = { ...s.holds };
      delete next[from];
      const cur = next[to];
      next[to] = cur
        ? {
            stake: +(cur.stake + moved.stake).toFixed(2),
            payout: +(cur.payout + moved.payout).toFixed(2),
            at: moved.at,
          }
        : moved;
      return { holds: next };
    });
    if (!holdTimers.has(to))
      holdTimers.set(
        to,
        setTimeout(() => useBalanceHolds.getState().releaseBet(to), HOLD_TTL_MS)
      );
  },
  clearHolds: () => {
    for (const t of holdTimers.values()) clearTimeout(t);
    holdTimers.clear();
    set({ holds: {} });
  },
}));
useBalanceHoldsStoreRef = useBalanceHolds.getState();

/** Displayed total = ledger total + per-bet corrections (stake back, payout
 *  out). In the ideal path this equals exactly what the player last saw. */
export function balanceCorrection(holds: Record<string, BalanceHold>): number {
  let c = 0;
  for (const key in holds) {
    const h = holds[key];
    if (!h) continue;
    c += h.stake - h.payout;
  }
  return Math.round(c * 100) / 100;
}

/** The balance every player-facing number should render. Applies the hold
 *  correction over (real + bonus + gifted); locked funds never display. */
export function useDisplayBalance(): number {
  const real = useWalletStore((s) => s.real);
  const bonus = useWalletStore((s) => s.bonus);
  const gifted = useWalletStore((s) => s.gifted);
  const holds = useBalanceHolds((s) => s.holds);
  return (
    (Number(real) || 0) +
    (Number(bonus) || 0) +
    (Number(gifted) || 0) +
    balanceCorrection(holds)
  );
}

// ── GAME — universal state machine (docs/19 §6) ────────────────────────────
export type GameState =
  | 'IDLE'
  | 'BETTING'
  | 'PLAYING'
  | 'CASHING_OUT'
  | 'RESULT_WIN'
  | 'RESULT_LOSE'
  | 'COOLDOWN'
  | 'ERROR';

interface GameStore {
  state: GameState;
  currentRound: {
    id: string | null;
    betAmount: number;
    outcome: unknown;
    animationData: unknown;
    startedAt: number | null;
  };
  sessionStats: {
    roundsPlayed: number;
    roundsWon: number;
    totalWagered: number;
    totalWon: number;
    biggestWin: number;
    startedAt: number;
  };
  setState: (s: GameState) => void;
  placeBet: (amount: number, choices: unknown) => Promise<unknown>;
  cashOut: () => Promise<void>;
  recordResult: (r: {
    betAmount: number;
    payout: number;
    result: 'WIN' | 'LOSE';
  }) => void;
}
export const useGameStore = create<GameStore>((set, get) => ({
  state: 'IDLE',
  currentRound: {
    id: null,
    betAmount: 0,
    outcome: null,
    animationData: null,
    startedAt: null,
  },
  sessionStats: {
    roundsPlayed: 0,
    roundsWon: 0,
    totalWagered: 0,
    totalWon: 0,
    biggestWin: 0,
    startedAt: Date.now(),
  },
  setState: (state) => set({ state }),
  placeBet: async (amount, _choices) => {
    set({
      state: 'BETTING',
      currentRound: { ...get().currentRound, betAmount: amount },
    });
    // full lifecycle incl. timeout recovery lives in hooks/useGame (docs/19 §7)
    throw new Error('useGame.placeBet');
  },
  cashOut: async () => {
    /* socket aviator:cashout or REST — hooks/useGame */
  },
  recordResult: ({ betAmount, payout, result }) =>
    set((s) => ({
      sessionStats: {
        ...s.sessionStats,
        roundsPlayed: s.sessionStats.roundsPlayed + 1,
        roundsWon: s.sessionStats.roundsWon + (result === 'WIN' ? 1 : 0),
        totalWagered: +(s.sessionStats.totalWagered + betAmount).toFixed(2),
        totalWon: +(s.sessionStats.totalWon + payout).toFixed(2),
        biggestWin: Math.max(s.sessionStats.biggestWin, payout),
      },
    })),
}));

// ── UI (docs/18: theme/sound; docs/19 §11 sound persistence) ───────────────
interface UIState {
  theme: 'dark' | 'light';
  soundEnabled: boolean;
  activeModal: string | null;
  setTheme: (t: 'dark' | 'light') => void;
  toggleSound: () => void;
  openModal: (id: string | null) => void;
}
export const useUIStore = create<UIState>((set, get) => ({
  // Light theme is unfinished — always dark until that work is complete.
  theme: 'dark',
  soundEnabled: safeStorage.get('sound_enabled') !== 'false',
  activeModal: null,
  setTheme: (_theme) => {
    try {
      safeStorage.set('theme', 'dark');
    } catch {
      /* storage may be blocked */
    }
    if (typeof document !== 'undefined')
      document.documentElement.dataset.theme = 'dark';
    set({ theme: 'dark' });
  },
  toggleSound: () => {
    const enabled = !get().soundEnabled;
    sound.setEnabled(enabled);
    set({ soundEnabled: enabled });
  },
  openModal: (activeModal) => set({ activeModal }),
}));
