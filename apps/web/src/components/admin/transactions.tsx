// apps/web/src/components/admin/transactions.tsx — full money ledger with filters + CSV export (D-068)
'use client';
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../lib/api';
import {
  Card,
  Badge,
  TextInput,
  Select,
  Field,
  Pagination,
  Icon,
  fmt,
  Spinner,
} from './ui';

interface TxnRow {
  id: string;
  type: string;
  walletType: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  description: string | null;
  createdAt: string;
  userPhone: string | null;
  userName: string | null;
}

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'BET', label: 'Bets (BET)' },
  { value: 'WIN', label: 'Wins (WIN)' },
  { value: 'DEPOSIT', label: 'Deposits' },
  { value: 'WITHDRAWAL', label: 'Withdrawals' },
  { value: 'REFUND', label: 'Refunds' },
  { value: 'ADMIN_CREDIT', label: 'Admin adjustments' },
  { value: 'BONUS_CHECKIN', label: 'Check-in bonus' },
  { value: 'BONUS_REFERRAL', label: 'Referral bonus' },
  { value: 'BONUS_WINSTREAK', label: 'Win-streak bonus' },
  { value: 'BONUS_RAKEBACK', label: 'Rakeback' },
  { value: 'GIFT_SENT', label: 'Gifts sent' },
  { value: 'GIFT_RECEIVED', label: 'Gifts received' },
];

const TYPE_COLOR: Record<
  string,
  'green' | 'red' | 'gold' | 'orange' | 'sky' | 'violet' | 'white'
> = {
  DEPOSIT: 'green',
  WIN: 'green',
  REFUND: 'sky',
  BONUS_CHECKIN: 'gold',
  BONUS_REFERRAL: 'gold',
  BONUS_WINSTREAK: 'gold',
  BONUS_RAKEBACK: 'gold',
  GIFT_RECEIVED: 'violet',
  ADMIN_CREDIT: 'sky',
  BET: 'red',
  WITHDRAWAL: 'orange',
  GIFT_SENT: 'orange',
};

export function TransactionsPanel() {
  const [type, setType] = useState('');
  const [walletType, setWalletType] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState('');

  const qs = new URLSearchParams({ page: String(page) });
  if (applied)
    for (const [k, v] of Object.entries(JSON.parse(applied) as Record<string, string>))
      if (v) qs.set(k, v);

  const { data, isLoading } = useQuery({
    queryKey: ['panel-transactions', applied, page],
    queryFn: () =>
      http.get<{ data: TxnRow[]; total: number; sum: number }>(
        `/panel/transactions?${qs.toString()}`
      ),
  });

  const apply = () => {
    setPage(1);
    setApplied(JSON.stringify({ type, walletType, search: search.trim(), from, to }));
  };

  const download = () => {
    const p = new URLSearchParams();
    if (type) p.set('type', type);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    window.open(
      `/api/v1/panel/reports/download?type=transactions${p.size ? `&${p.toString()}` : ''}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid md:grid-cols-6 gap-3 items-end">
          <div className="md:col-span-2">
            <Field label="Search player">
              <TextInput
                placeholder="Phone or name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
              />
            </Field>
          </div>
          <Field label="Type">
            <Select
              options={TYPE_OPTIONS}
              value={type}
              onChange={(e) => setType(e.target.value)}
            />
          </Field>
          <Field label="Wallet">
            <Select
              options={[
                { value: '', label: 'All wallets' },
                { value: 'REAL', label: 'Real' },
                { value: 'BONUS', label: 'Bonus' },
                { value: 'GIFTED', label: 'Gifted' },
              ]}
              value={walletType}
              onChange={(e) => setWalletType(e.target.value)}
            />
          </Field>
          <Field label="From">
            <TextInput
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <ActionBtnF onClick={apply}>
            <Icon name="search" size={14} /> Apply filters
          </ActionBtnF>
          <ActionBtnF onClick={download}>
            <Icon name="reports" size={14} /> Download CSV
          </ActionBtnF>
          {data && (
            <span className="t-label-sm text-muted ml-auto">
              {data.total} rows · net sum{' '}
              <b className={data.sum >= 0 ? 'text-green' : 'text-red'}>
                {data.sum >= 0 ? '+' : ''}
                {fmt(data.sum)}
              </b>
            </span>
          )}
        </div>
      </Card>

      <div className="rounded-xl overflow-hidden border border-white/8 bg-layer-surface">
        {isLoading && <Spinner label="Loading ledger…" />}
        {!isLoading && data && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/5">
                  {[
                    'When',
                    'Player',
                    'Type',
                    'Wallet',
                    'Amount',
                    'Before → After',
                    'Description',
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 t-label-sm uppercase tracking-wide text-muted font-medium whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.data.map((t) => {
                  const n = Number(t.amount);
                  return (
                    <tr key={t.id} className="hover:bg-white/2">
                      <td className="px-4 py-2.5 t-label-sm text-muted whitespace-nowrap">
                        {new Date(t.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <p className="t-label-md text-white/85">
                          {t.userName || t.userPhone || '—'}
                        </p>
                        {t.userPhone && t.userName && (
                          <p className="t-label-sm text-muted t-mono">{t.userPhone}</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge color={TYPE_COLOR[t.type] ?? 'white'}>{t.type}</Badge>
                      </td>
                      <td className="px-4 py-2.5 t-label-sm text-white/50">
                        {t.walletType}
                      </td>
                      <td
                        className={`px-4 py-2.5 t-num-sm whitespace-nowrap ${n >= 0 ? 'text-green' : 'text-red'}`}
                      >
                        {n >= 0 ? '+' : ''}
                        {fmt(n)}
                      </td>
                      <td className="px-4 py-2.5 t-num-sm text-white/50 whitespace-nowrap">
                        {fmt(Number(t.balanceBefore))} → {fmt(Number(t.balanceAfter))}
                      </td>
                      <td className="px-4 py-2.5 t-label-sm text-white/55 max-w-[240px] truncate">
                        {t.description ?? '—'}
                      </td>
                    </tr>
                  );
                })}
                {data.data.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center t-label-sm text-muted"
                    >
                      No transactions match your filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {data && (
        <Pagination
          page={page}
          totalPages={Math.max(1, Math.ceil(data.total / 25))}
          onPage={setPage}
        />
      )}
    </div>
  );
}

function ActionBtnF({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="h-9 px-3.5 rounded-lg bg-white/5 border border-white/10 t-label-md text-white/75 hover:bg-white/10 inline-flex items-center gap-1.5"
    >
      {children}
    </button>
  );
}
