// apps/web/src/components/admin/users.tsx — user management + player detail drawer (D-068)
'use client';
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';
import {
  Card,
  CardHead,
  Badge,
  ActionBtn,
  TextInput,
  Select,
  Field,
  Modal,
  Pagination,
  Icon,
  fmt,
  Spinner,
} from './ui';

export interface UserRow {
  id: string;
  phone: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  real: string;
  bonus: string;
  gifted: string;
  rounds: number;
  deposits: number;
  withdrawals: number;
  referrals: number;
}

interface StatsRes {
  rounds: { count: number; volume: number; payout: number; net: number };
  deposits: { count: number; amount: number };
  withdrawals: { count: number; amount: number; fee: number };
  checkins: number;
  referrals: number;
  transactions: number;
}

interface TxnRow {
  id: string;
  type: string;
  walletType: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  description: string | null;
  createdAt: string;
}

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

function WalletCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl bg-layer-elevated border border-white/8 p-4">
      <p className="t-label-sm text-muted uppercase tracking-wide">{label}</p>
      <p className="t-num-lg text-white mt-1">{fmt(Number(value))}</p>
      {sub && <p className="t-label-sm text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

export function UsersPanel() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<UserRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['panel-users', search, status, page],
    queryFn: () =>
      http.get<{ data: UserRow[]; total: number }>(
        `/panel/users?page=${page}${search ? `&search=${encodeURIComponent(search)}` : ''}${status ? `&status=${status}` : ''}`
      ),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30">
            <Icon name="search" size={15} />
          </span>
          <TextInput
            placeholder="Search by phone or name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select
          options={[
            { value: '', label: 'All statuses' },
            { value: 'ACTIVE', label: 'Active' },
            { value: 'SUSPENDED', label: 'Suspended' },
          ]}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="w-40"
        />
        <span className="t-label-sm text-muted ml-auto">
          {data?.total ?? 0} players
        </span>
      </div>

      <div className="rounded-xl overflow-hidden border border-white/8 bg-layer-surface">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/5">
                {[
                  'Player',
                  'Status',
                  'Real',
                  'Bonus',
                  'Gifted',
                  'Rounds',
                  'Joined',
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
              {(data?.data ?? []).map((u) => (
                <tr
                  key={u.id}
                  onClick={() => setSel(u)}
                  className="cursor-pointer hover:bg-white/4"
                >
                  <td className="px-4 py-3">
                    <p className="t-label-md text-white/90">
                      {u.displayName || u.phone}
                    </p>
                    <p className="t-label-sm text-muted t-mono">{u.phone}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={u.status === 'ACTIVE' ? 'green' : 'red'}>
                      {u.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 t-num-sm text-white/75">
                    {fmt(Number(u.real))}
                  </td>
                  <td className="px-4 py-3 t-num-sm text-gold/90">
                    {fmt(Number(u.bonus))}
                  </td>
                  <td className="px-4 py-3 t-num-sm text-violet-300/90">
                    {fmt(Number(u.gifted))}
                  </td>
                  <td className="px-4 py-3 t-num-sm text-white/60">{u.rounds}</td>
                  <td className="px-4 py-3 t-label-sm text-muted">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {!isLoading && data?.data.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center t-label-sm text-muted"
                  >
                    No players found
                  </td>
                </tr>
              )}
              {isLoading && (
                <tr>
                  <td colSpan={7} className="p-4">
                    <Spinner label="Loading players…" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {data && (
        <Pagination
          page={page}
          totalPages={Math.max(1, Math.ceil(data.total / 25))}
          onPage={setPage}
        />
      )}

      {sel && (
        <UserDrawer
          user={sel}
          onClose={() => setSel(null)}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ['panel-users'] });
            qc.invalidateQueries({ queryKey: ['panel-dash'] });
          }}
        />
      )}
    </div>
  );
}

function UserDrawer({
  user,
  onClose,
  onChanged,
}: {
  user: UserRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'ledger' | 'risk'>('overview');
  const [flagNote, setFlagNote] = useState('');
  const [flagSev, setFlagSev] = useState<'low' | 'medium' | 'high'>('medium');
  const [amount, setAmount] = useState('');
  const [walletType, setWalletType] = useState<'real' | 'bonus' | 'gifted'>('real');
  const [reason, setReason] = useState('');
  // Dedicated "remove balance" flow (v1.4.2): explicit panel + confirm
  // dialog so admins don't have to hand-type a negative number.
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeWallet, setRemoveWallet] = useState<'real' | 'bonus' | 'gifted'>('real');
  const [removeReason, setRemoveReason] = useState('Balance reset by admin');

  interface RiskDevice {
    id: string;
    fingerprintHash: string;
    userAgent: string | null;
    screen: string | null;
    timezone: string | null;
    language: string | null;
    firstIp: string | null;
    lastIp: string | null;
    ipCountry: string | null;
    loginCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }
  interface LinkedAcc {
    id: string;
    phone: string;
    displayName: string | null;
    status: string;
    lastLoginAt: string | null;
    lastLoginIp: string | null;
    lastLoginCountry: string | null;
  }
  const { data: detail } = useQuery({
    queryKey: ['panel-user', user.id],
    queryFn: () =>
      http.get<{
        phone: string;
        displayName: string | null;
        status: string;
        kycStatus?: string;
        language?: string;
        createdAt: string;
        lastLoginAt: string | null;
        lastActivityAt?: string | null;
        lastLoginIp?: string | null;
        lastLoginCountry?: string | null;
        fingerprintHash?: string | null;
        referralCode?: string;
        wallet: {
          realBalance: string;
          bonusBalance: string;
          giftedBalance: string;
          lockedBalance?: string;
        };
        risk?: {
          fingerprintHash: string | null;
          lastLoginIp: string | null;
          lastLoginCountry: string | null;
          devices: RiskDevice[];
          logins: Array<{
            id: string;
            ip: string;
            ipCountry: string | null;
            userAgent: string | null;
            timezone: string | null;
            language: string | null;
            screen: string | null;
            createdAt: string;
          }>;
          linkedByDevice: LinkedAcc[];
          linkedByIp: LinkedAcc[];
          signals: Array<{
            id: string;
            signal: string;
            severity: string;
            status: string;
            data: unknown;
            notes: string | null;
            createdAt: string;
          }>;
        };
      }>(`/panel/users/${user.id}`),
  });
  const { data: stats } = useQuery({
    queryKey: ['panel-user-stats', user.id],
    queryFn: () => http.get<StatsRes>(`/panel/users/${user.id}/stats`),
  });
  const { data: txns, isLoading: txnsLoading } = useQuery({
    queryKey: ['panel-user-txns', user.id],
    queryFn: () =>
      http.get<{ data: TxnRow[]; total: number }>(
        `/panel/users/${user.id}/transactions?page=1`
      ),
    enabled: tab === 'ledger',
  });

  const fund = useMutation({
    mutationFn: (amt: number) =>
      http.post(`/panel/users/${user.id}/fund`, {
        walletType,
        amount: amt,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      // amount state may have been staged by the remove-balance flow
      notify.success(
        amount.startsWith('-')
          ? 'Deducted — player notified'
          : 'Credited — player notified'
      );
      setAmount('');
      setReason('');
      setRemoveOpen(false);
      setRemoveReason('Balance reset by admin');
      onChanged();
      qc.invalidateQueries({ queryKey: ['panel-user', user.id] });
      qc.invalidateQueries({ queryKey: ['panel-user-stats', user.id] });
      qc.invalidateQueries({ queryKey: ['panel-user-txns', user.id] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const flag = useMutation({
    mutationFn: () =>
      http.post(`/panel/users/${user.id}/fraud-flag`, {
        severity: flagSev,
        notes: flagNote.trim() || undefined,
      }),
    onSuccess: () => {
      notify.success('Flagged for review');
      setFlagNote('');
      qc.invalidateQueries({ queryKey: ['panel-user', user.id] });
      qc.invalidateQueries({ queryKey: ['panel-fraud'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const setStatus = useMutation({
    mutationFn: (s: 'ACTIVE' | 'SUSPENDED') =>
      http.patch(`/panel/users/${user.id}`, {
        status: s,
        note: s === 'SUSPENDED' ? 'Suspended by admin' : undefined,
      }),
    onSuccess: () => {
      notify.success('Status updated');
      onChanged();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const w = detail?.wallet;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Player — ${user.displayName || user.phone}`}
      width="max-w-4xl"
    >
      <div className="space-y-5">
        {/* Identity — prefer detail (unmasked phone, KYC, last IP) over the list row */}
        <div className="flex flex-wrap items-center gap-4">
          <span className="h-12 w-12 rounded-full bg-gold/15 text-gold flex items-center justify-center t-label-xl">
            {(detail?.displayName || user.displayName || user.phone)
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <div className="flex-1 min-w-[180px]">
            <p className="t-label-lg text-white/90">
              {detail?.displayName || user.displayName || 'No name set'}
            </p>
            <p className="t-mono t-label-sm text-muted">
              {detail?.phone || user.phone}
            </p>
            <p className="t-label-sm text-muted">
              Joined {new Date(detail?.createdAt || user.createdAt).toLocaleString()} ·
              Last login{' '}
              {detail?.lastLoginAt || user.lastLoginAt
                ? new Date(
                    detail?.lastLoginAt || user.lastLoginAt || ''
                  ).toLocaleString()
                : 'never'}
            </p>
            <p className="t-mono t-label-sm text-muted">
              {detail?.lastLoginIp || '—'}
              {detail?.lastLoginCountry ? ` · ${detail.lastLoginCountry}` : ''}
              {detail?.language ? ` · ${detail.language}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              color={(detail?.status || user.status) === 'ACTIVE' ? 'green' : 'red'}
            >
              {detail?.status || user.status}
            </Badge>
            {detail?.kycStatus && detail.kycStatus !== 'NONE' && (
              <Badge color={detail.kycStatus === 'APPROVED' ? 'green' : 'orange'}>
                KYC {detail.kycStatus}
              </Badge>
            )}
            {user.status === 'ACTIVE' ? (
              <ActionBtn tone="danger" onClick={() => setStatus.mutate('SUSPENDED')}>
                <Icon name="x" size={13} /> Suspend
              </ActionBtn>
            ) : (
              <ActionBtn tone="primary" onClick={() => setStatus.mutate('ACTIVE')}>
                <Icon name="check" size={13} /> Activate
              </ActionBtn>
            )}
          </div>
        </div>

        {/* Wallet + adjust */}
        <div className="grid md:grid-cols-3 gap-3">
          <WalletCard label="Real (cash)" value={w?.realBalance ?? user.real} />
          <WalletCard label="Bonus" value={w?.bonusBalance ?? user.bonus} />
          <WalletCard label="Gifted" value={w?.giftedBalance ?? user.gifted} />
        </div>

        {/* Adjust balance */}
        <Card>
          <CardHead
            title="Adjust balance"
            icon="coins"
            right={
              <span className="t-label-sm text-muted">
                Player receives an in-app notification
              </span>
            }
          />
          <div className="grid md:grid-cols-4 gap-3 items-end">
            <Field label="Wallet">
              <Select
                options={[
                  { value: 'real', label: 'Real (cash)' },
                  { value: 'bonus', label: 'Bonus' },
                  { value: 'gifted', label: 'Gifted' },
                ]}
                value={walletType}
                onChange={(e) => setWalletType(e.target.value as never)}
              />
            </Field>
            <Field label="Amount (use − to deduct)" hint="e.g. 500 or -100">
              <TextInput
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="500"
              />
            </Field>
            <Field label="Reason (shown to player)">
              <TextInput
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Welcome bonus, correction…"
              />
            </Field>
            <ActionBtn
              tone="solid"
              disabled={!amount || Number(amount) === 0 || fund.isPending}
              onClick={() => fund.mutate(Number(amount))}
            >
              <Icon name="coins" size={14} /> {Number(amount) < 0 ? 'Deduct' : 'Credit'}
            </ActionBtn>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* v1.4.2: one-click remove affordance — balance display + confirm dialog */}
            <ActionBtn
              tone="danger"
              onClick={() => setRemoveOpen(true)}
              disabled={fund.isPending}
            >
              <Icon name="trash" size={14} /> Remove balance…
            </ActionBtn>
            {w && (
              <span className="t-label-sm text-muted">
                Balances — real {fmt(Number(w.realBalance))} · bonus{' '}
                {fmt(Number(w.bonusBalance))} · gifted {fmt(Number(w.giftedBalance))}
              </span>
            )}
          </div>
        </Card>

        {/* v1.4.2 remove-balance confirm dialog */}
        {(() => {
          const bal =
            removeWallet === 'real'
              ? Number(w?.realBalance ?? 0)
              : removeWallet === 'bonus'
                ? Number(w?.bonusBalance ?? 0)
                : Number(w?.giftedBalance ?? 0);
          const doRemove = (amt: number) => {
            // stage as a negative amount — reuse the audited debit path and
            // the onSuccess toast/refresh logic unchanged
            setWalletType(removeWallet);
            setAmount(String(-amt));
            setReason(removeReason.trim());
            fund.mutate(-amt);
            setRemoveOpen(false);
          };
          return (
            <Modal
              open={removeOpen}
              onClose={() => setRemoveOpen(false)}
              title={`Remove balance — ${user.displayName || user.phone}`}
              width="max-w-md"
            >
              <div className="space-y-4">
                <Field label="Wallet">
                  <Select
                    options={[
                      { value: 'real', label: 'Real (cash)' },
                      { value: 'bonus', label: 'Bonus' },
                      { value: 'gifted', label: 'Gifted' },
                    ]}
                    value={removeWallet}
                    onChange={(e) => setRemoveWallet(e.target.value as never)}
                  />
                </Field>
                <p className="t-label-sm text-muted">
                  Current balance:{' '}
                  <span className="t-mono text-white/90">{fmt(bal)}</span>
                </p>
                <Field label="Reason (shown to player)">
                  <TextInput
                    value={removeReason}
                    onChange={(e) => setRemoveReason(e.target.value)}
                    placeholder="Balance reset by admin"
                  />
                </Field>
                {bal <= 0 ? (
                  <p className="t-label-sm text-muted">
                    This wallet is already empty — nothing to remove.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    <ActionBtn
                      tone="danger"
                      disabled={fund.isPending}
                      onClick={() => doRemove(bal)}
                    >
                      <Icon name="trash" size={14} /> Zero it ({fmt(bal)})
                    </ActionBtn>
                    <ActionBtn
                      tone="ghost"
                      disabled={fund.isPending}
                      onClick={() => doRemove(Math.floor(bal * 0.5 * 100) / 100)}
                    >
                      −50% ({fmt(Math.floor(bal * 0.5 * 100) / 100)})
                    </ActionBtn>
                    <ActionBtn
                      tone="ghost"
                      disabled={fund.isPending}
                      onClick={() => doRemove(Math.floor(bal * 0.25 * 100) / 100)}
                    >
                      −25% ({fmt(Math.floor(bal * 0.25 * 100) / 100)})
                    </ActionBtn>
                  </div>
                )}
                <p className="t-label-sm text-muted">
                  The server writes an ADMIN_DEBIT ledger row, notifies the player, and
                  refuses the request if it would push the wallet below zero.
                </p>
              </div>
            </Modal>
          );
        })()}

        {/* Stats strip */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {[
              { l: 'Rounds played', v: stats.rounds.count.toLocaleString() },
              { l: 'Total wagered', v: fmt(stats.rounds.volume) },
              { l: 'Total won', v: fmt(stats.rounds.payout) },
              {
                l: 'Net to house',
                v: fmt(stats.rounds.net),
                red: stats.rounds.net > 0,
              },
              {
                l: 'Deposits / Withdrawals',
                v: `${fmt(stats.deposits.amount)} / ${fmt(stats.withdrawals.amount)}`,
              },
            ].map((x) => (
              <div
                key={x.l}
                className="rounded-lg bg-layer-elevated border border-white/8 p-3"
              >
                <p className="t-label-sm text-muted uppercase tracking-wide">{x.l}</p>
                <p
                  className={`t-num-md mt-0.5 ${x.red ? 'text-red' : 'text-white/85'}`}
                >
                  {x.v}
                </p>
              </div>
            ))}
            <div className="rounded-lg bg-layer-elevated border border-white/8 p-3">
              <p className="t-label-sm text-muted uppercase tracking-wide">Extras</p>
              <p className="t-label-sm text-white/75 mt-1">
                Referrals: <b>{stats.referrals}</b> · Check-ins: <b>{stats.checkins}</b>{' '}
                · Ledger rows: <b>{stats.transactions}</b>
              </p>
            </div>
          </div>
        )}

        {/* Ledger tab */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => setTab('overview')}
              className={`h-8 px-3 rounded-lg t-label-md ${tab === 'overview' ? 'bg-gold text-black' : 'bg-white/5 text-white/60'}`}
            >
              Overview
            </button>
            <button
              onClick={() => setTab('ledger')}
              className={`h-8 px-3 rounded-lg t-label-md ${tab === 'ledger' ? 'bg-gold text-black' : 'bg-white/5 text-white/60'}`}
            >
              Money ledger
            </button>
            <button
              onClick={() => setTab('risk')}
              className={`h-8 px-3 rounded-lg t-label-md ${tab === 'risk' ? 'bg-gold text-black' : 'bg-white/5 text-white/60'}`}
            >
              Device &amp; fraud
            </button>
          </div>
          {tab === 'ledger' && (
            <div className="rounded-xl border border-white/8 bg-layer-surface overflow-hidden">
              {txnsLoading && <Spinner label="Loading ledger…" />}
              {!txnsLoading && txns && (
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-layer-surface">
                      <tr className="bg-white/5">
                        {[
                          'When',
                          'Type',
                          'Wallet',
                          'Amount',
                          'Balance after',
                          'Description',
                        ].map((h) => (
                          <th
                            key={h}
                            className="text-left px-3 py-2.5 t-label-sm uppercase tracking-wide text-muted font-medium whitespace-nowrap"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {txns.data.map((t) => {
                        const n = Number(t.amount);
                        return (
                          <tr key={t.id}>
                            <td className="px-3 py-2 t-label-sm text-muted whitespace-nowrap">
                              {new Date(t.createdAt).toLocaleString()}
                            </td>
                            <td className="px-3 py-2">
                              <Badge color={TYPE_COLOR[t.type] ?? 'white'}>
                                {t.type}
                              </Badge>
                            </td>
                            <td className="px-3 py-2 t-label-sm text-white/50">
                              {t.walletType}
                            </td>
                            <td
                              className={`px-3 py-2 t-num-sm ${n >= 0 ? 'text-green' : 'text-red'}`}
                            >
                              {n >= 0 ? '+' : ''}
                              {fmt(n)}
                            </td>
                            <td className="px-3 py-2 t-num-sm text-white/60">
                              {fmt(Number(t.balanceAfter))}
                            </td>
                            <td className="px-3 py-2 t-label-sm text-white/55 max-w-[220px] truncate">
                              {t.description ?? '—'}
                            </td>
                          </tr>
                        );
                      })}
                      {txns.data.length === 0 && (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-3 py-8 text-center t-label-sm text-muted"
                          >
                            No transactions yet
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {tab === 'risk' && (
            <div className="space-y-4">
              <p className="t-label-sm text-muted">
                Location is IP + CDN country header (Cloudflare/Vercel), not GPS.
                Same-IP matches ignore private/NAT addresses so a shared office Wi-Fi
                does not auto-flag every player.
              </p>
              <div className="grid sm:grid-cols-2 gap-3 t-label-sm">
                <div className="rounded-lg bg-layer-elevated border border-white/8 p-3">
                  <p className="t-label-sm text-muted uppercase">Last IP / country</p>
                  <p className="t-mono text-white/80 mt-1">
                    {detail?.risk?.lastLoginIp || detail?.lastLoginIp || '—'}{' '}
                    {detail?.risk?.lastLoginCountry || detail?.lastLoginCountry || ''}
                  </p>
                </div>
                <div className="rounded-lg bg-layer-elevated border border-white/8 p-3">
                  <p className="t-label-sm text-muted uppercase">Device fingerprint</p>
                  <p className="t-mono text-white/80 mt-1 break-all">
                    {(
                      detail?.risk?.fingerprintHash ||
                      detail?.fingerprintHash ||
                      '—'
                    ).slice(0, 16)}
                  </p>
                </div>
              </div>
              <Card>
                <CardHead title="Devices" icon="shield" />
                {(detail?.risk?.devices ?? []).length === 0 && (
                  <p className="t-label-sm text-muted">
                    No device seen yet — appears after the next login.
                  </p>
                )}
                {(detail?.risk?.devices ?? []).map((d) => (
                  <div
                    key={d.id}
                    className="py-2 border-t border-white/5 t-label-sm text-white/75"
                  >
                    <p className="t-mono">
                      {d.fingerprintHash.slice(0, 12)} · {d.ipCountry || '—'} ·{' '}
                      {d.lastIp || '—'}
                    </p>
                    <p className="text-muted truncate">
                      {d.userAgent || 'unknown UA'} · {d.timezone || ''}{' '}
                      {d.screen || ''}
                    </p>
                    <p className="text-muted">
                      {d.loginCount} login(s) · first{' '}
                      {new Date(d.firstSeenAt).toLocaleString()} · last{' '}
                      {new Date(d.lastSeenAt).toLocaleString()}
                    </p>
                  </div>
                ))}
              </Card>
              <Card>
                <CardHead title="Recent logins" />
                {(detail?.risk?.logins ?? []).length === 0 && (
                  <p className="t-label-sm text-muted">None recorded yet.</p>
                )}
                <div className="max-h-48 overflow-y-auto">
                  {(detail?.risk?.logins ?? []).map((l) => (
                    <p
                      key={l.id}
                      className="t-label-sm text-white/70 py-1 border-t border-white/5"
                    >
                      {new Date(l.createdAt).toLocaleString()} · {l.ip}
                      {l.ipCountry ? ` (${l.ipCountry})` : ''} · {l.timezone || '—'}
                    </p>
                  ))}
                </div>
              </Card>
              <Card>
                <CardHead
                  title="Same device"
                  right={
                    <Badge color="orange">
                      {detail?.risk?.linkedByDevice.length ?? 0}
                    </Badge>
                  }
                />
                {(detail?.risk?.linkedByDevice ?? []).map((a) => (
                  <p key={a.id} className="t-label-sm text-white/80 py-1">
                    {a.displayName || a.phone} · {a.phone} · {a.status}
                    {a.lastLoginIp ? ` · ${a.lastLoginIp}` : ''}
                  </p>
                ))}
                {(detail?.risk?.linkedByDevice ?? []).length === 0 && (
                  <p className="t-label-sm text-muted">
                    No other accounts on this device fingerprint.
                  </p>
                )}
              </Card>
              <Card>
                <CardHead
                  title="Same public IP"
                  right={
                    <Badge color="white">{detail?.risk?.linkedByIp.length ?? 0}</Badge>
                  }
                />
                {(detail?.risk?.linkedByIp ?? []).map((a) => (
                  <p key={a.id} className="t-label-sm text-white/80 py-1">
                    {a.displayName || a.phone} · {a.phone} · {a.status}
                    {a.lastLoginIp ? ` · ${a.lastLoginIp}` : ''}
                  </p>
                ))}
                {(detail?.risk?.linkedByIp ?? []).length === 0 && (
                  <p className="t-label-sm text-muted">
                    No other accounts on this player&apos;s public IPs.
                  </p>
                )}
              </Card>
              <Card>
                <CardHead title="Fraud signals" />
                {(detail?.risk?.signals ?? []).map((s) => (
                  <div key={s.id} className="py-2 border-t border-white/5">
                    <Badge
                      color={
                        s.severity === 'high'
                          ? 'red'
                          : s.severity === 'medium'
                            ? 'orange'
                            : 'white'
                      }
                    >
                      {s.signal.replace(/_/g, ' ')}
                    </Badge>{' '}
                    <span className="t-label-sm text-muted">
                      {s.status} · {new Date(s.createdAt).toLocaleString()}
                    </span>
                    {s.notes ? (
                      <p className="t-label-sm text-white/60 mt-0.5">{s.notes}</p>
                    ) : null}
                  </div>
                ))}
                {(detail?.risk?.signals ?? []).length === 0 && (
                  <p className="t-label-sm text-muted">No signals on this player.</p>
                )}
              </Card>
              <Card>
                <CardHead title="Manual flag" icon="shield" />
                <div className="grid sm:grid-cols-3 gap-3 items-end">
                  <Field label="Severity">
                    <Select
                      options={[
                        { value: 'low', label: 'Low' },
                        { value: 'medium', label: 'Medium' },
                        { value: 'high', label: 'High' },
                      ]}
                      value={flagSev}
                      onChange={(e) =>
                        setFlagSev(e.target.value as 'low' | 'medium' | 'high')
                      }
                    />
                  </Field>
                  <Field label="Note">
                    <TextInput
                      value={flagNote}
                      onChange={(e) => setFlagNote(e.target.value)}
                      placeholder="Why you are flagging…"
                    />
                  </Field>
                  <ActionBtn
                    tone="danger"
                    disabled={flag.isPending}
                    onClick={() => flag.mutate()}
                  >
                    Flag player
                  </ActionBtn>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
