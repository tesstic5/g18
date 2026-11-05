// apps/web/src/lib/demo.ts — demo-mode virtual wallet (docs/20 §9).
// Virtual coins live in safeStorage (falls back to memory in sandboxed iframes);
// the server runs demo bets through the real engine with the shared demo user
// (X-Demo-Mode header) but moves no money. Rounds are flagged demo:true.
import { create } from 'zustand';
import { safeStorage } from './safe-storage';

export const DEMO_START_BALANCE = 10_000; // ₨10,000 virtual (docs/20 §9)

const KEY = 'demo_balance';

function readInitial(): number {
  const v = safeStorage.get(KEY);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEMO_START_BALANCE;
}

interface DemoState {
  balance: number;
  deduct: (amount: number) => void;
  credit: (amount: number) => void;
  reset: () => void;
}

export const useDemoStore = create<DemoState>((set) => ({
  balance: readInitial(),
  deduct: (amount) =>
    set((s) => {
      const next = Math.max(0, +(s.balance - amount).toFixed(2));
      safeStorage.set(KEY, String(next));
      return { balance: next };
    }),
  credit: (amount) =>
    set((s) => {
      const next = +(s.balance + amount).toFixed(2);
      safeStorage.set(KEY, String(next));
      return { balance: next };
    }),
  reset: () => {
    safeStorage.set(KEY, String(DEMO_START_BALANCE));
    set({ balance: DEMO_START_BALANCE });
  },
}));
