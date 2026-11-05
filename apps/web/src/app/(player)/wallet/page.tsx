// apps/web/src/app/(player)/wallet/page.tsx — wallet page (docs/18 WALLET PAGE)
'use client';
import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../../lib/api';
import { txnListDto } from '../../../lib/dto';
import {
  useWalletStore,
  useAuthStore,
  useBalanceHolds,
  balanceCorrection,
  refreshBalance,
} from '../../../stores';
import { DepositFlow, WithdrawFlow } from '../../../components/wallet/flows';
import { Skeleton, EmptyState } from '../../../components/ui';

interface Txn {
  id: string;
  type: string;
  walletType?: string;
  amount: string;
  balanceAfter: string;
  description?: string | null;
  createdAt: string;
}

const CREDIT_TYPES = new Set([
  'WIN',
  'DEPOSIT',
  'BONUS_CHECKIN',
  'BONUS_SIGNUP',
  'BONUS_REFERRAL',
  'BONUS_WINSTREAK',
  'BONUS_RAKEBACK',
  'GIFT_RECEIVED',
  'ADMIN_CREDIT',
  'REFUND',
]);

function isCredit(type: string): boolean {
  return (
    CREDIT_TYPES.has(type) || type.startsWith('BONUS_') || type.startsWith('DEPOSIT')
  );
}

function txnIcon(type: string): string {
  if (type.startsWith('BONUS')) return '🎁';
  if (type.startsWith('DEPOSIT')) return '📥';
  if (type === 'WIN') return '🏆';
  if (type === 'BET') return '🎲';
  if (type === 'REFUND') return '↩️';
  if (type === 'GIFT_RECEIVED') return '🎀';
  if (type === 'GIFT_SENT') return '📤';
  if (type === 'ADMIN_CREDIT') return '➕';
  if (type === 'WITHDRAWAL' || type === 'ADMIN_DEBIT') return '📤';
  return isCredit(type) ? '📥' : '📤';
}

export default function WalletPage() {
  // useSearchParams must render inside Suspense during static prerender (Next 16)
  return (
    <Suspense
      fallback={
        <div className="min-h-[40dvh] flex items-center justify-center">
          <div className="h-6 w-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        </div>
      }
    >
      <WalletContent />
    </Suspense>
  );
}

function WalletContent() {
  const user = useAuthStore((s) => s.user);
  const params = useSearchParams();
  // support ?mode=deposit|withdraw deep links (e.g. post-signup jump)
  const [mode, setMode] = useState<'view' | 'deposit' | 'withdraw'>(() => {
    const m = params.get('mode');
    return m === 'deposit' || m === 'withdraw' ? m : 'view';
  });
  const real = useWalletStore((s) => s.real);
  const bonus = useWalletStore((s) => s.bonus);
  const gifted = useWalletStore((s) => s.gifted);
  const holds = useBalanceHolds((s) => s.holds);
  const { data: txns, isLoading } = useQuery({
    queryKey: ['transactions'],
    queryFn: () =>
      http.get<{ data: Txn[] }>('/wallet/transactions?page=1&pageSize=20', {
        schema: txnListDto,
      }),
    enabled: !!user, // wallet requires login — don't fire authed calls when signed out
    staleTime: 0,
  });

  useEffect(() => {
    if (!user) return;
    void refreshBalance().catch(() => {});
  }, [user]);

  // ── LOGIN GUARD (coins live in the account — must be logged in) ─────────
  if (!user) {
    return (
      <div className="min-h-[60dvh] flex items-center justify-center px-6">
        <div className="w-full max-w-sm rounded-2xl bg-layer-surface border border-white/8 p-6 text-center">
          <p className="text-3xl mb-3">👛</p>
          <h1 className="t-title text-primary mb-2">Log in to view your wallet</h1>
          <p className="t-body text-secondary mb-6">
            Your balance, deposits and withdrawals live in your account.
          </p>
          <div className="flex gap-2">
            <a href="/login" className="btn-primary flex-1">
              Log in
            </a>
            <a
              href="/signup"
              className="flex-1 h-[52px] rounded-lg border border-gold/40 text-gold t-label-lg flex items-center justify-center"
            >
              Sign up
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'deposit')
    return (
      <WalletShell title="Deposit">
        <DepositFlow />
      </WalletShell>
    );
  if (mode === 'withdraw')
    return (
      <WalletShell title="Withdraw">
        <WithdrawFlow />
      </WalletShell>
    );

  return (
    <WalletShell title="Wallet">
      {/* Balance hero (docs/18: biggest number on page, gold) */}
      <div className="mb-6">
        <p className="t-label-md text-secondary">Total Balance</p>
        <p className="t-hero text-gold">
          ₨
          {(
            (Number(real) || 0) +
            (Number(bonus) || 0) +
            (Number(gifted) || 0) +
            balanceCorrection(holds)
          ).toFixed(2)}
        </p>
      </div>

      {/* Balance breakdown cards (docs/18) */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {(
          [
            ['💵', 'Cash', real, 'Withdrawable'],
            ['🎁', 'Bonus', bonus, 'Playable'],
            ['🎀', 'Gifted', gifted, 'Playable'],
          ] as const
        ).map(([icon, label, amt, hint]) => (
          <div
            key={label}
            className="rounded-xl bg-layer-surface border border-white/8 p-4"
          >
            <p className="text-xl mb-1">{icon}</p>
            <p className="t-num-xl text-primary">₨{(Number(amt) || 0).toFixed(2)}</p>
            <p className="t-label-sm text-muted">{label}</p>
            <p className="t-label-sm text-white/35">{hint}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-3 mb-8">
        <button onClick={() => setMode('deposit')} className="btn-primary flex-1">
          + Deposit
        </button>
        <button onClick={() => setMode('withdraw')} className="btn-outline-gold flex-1">
          → Withdraw
        </button>
      </div>

      {/* Transaction history (docs/18 rows) */}
      <h3 className="t-label-lg text-primary mb-3">Transactions</h3>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : !txns?.data.length ? (
        <EmptyState
          icon="🧾"
          title="No transactions yet"
          body="Deposit to start playing"
        />
      ) : (
        <div className="rounded-xl overflow-hidden border border-white/8 divide-y divide-white/5">
          {txns.data.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-3 px-4 py-3 bg-layer-surface"
            >
              <span className="w-10 h-10 rounded-full bg-layer-elevated flex items-center justify-center text-lg">
                {txnIcon(t.type)}
              </span>
              <div className="flex-1 min-w-0">
                <p className="t-label-lg text-primary truncate">
                  {t.description || t.type.replace(/_/g, ' ')}
                </p>
                <p className="t-label-sm text-muted">
                  {new Date(t.createdAt).toLocaleString()}
                  {t.walletType ? ` · ${t.walletType.toLowerCase()}` : ''}
                </p>
              </div>
              <div className="text-right">
                <p
                  className={`t-num-md ${isCredit(t.type) ? 'text-green' : t.type === 'BET' ? 'text-white/40' : 'text-orange'}`}
                >
                  {isCredit(t.type) ? '+' : '−'}₨{Number(t.amount).toFixed(2)}
                </p>
                <p className="t-num-sm text-muted">
                  ₨{Number(t.balanceAfter).toFixed(2)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </WalletShell>
  );
}

function WalletShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      <h1 className="t-title text-primary mb-6">{title}</h1>
      {children}
    </div>
  );
}
