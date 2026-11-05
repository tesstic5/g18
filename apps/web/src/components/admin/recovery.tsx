// apps/web/src/components/admin/recovery.tsx — ACCOUNT RECOVERY CONSOLE.
//
// An agent works a lockout here: the claimant's own words on one side, the
// account's real history (deposits, senders, devices, payout accounts) on the
// other. One admin ticks what matched; a DIFFERENT super-admin approves, which
// issues a one-time code the claimant collects on their public ticket page and
// puts a freeze on the money rails until the dust settles.
//
// The recovery code is never rendered here — an operator cannot leak what they
// cannot see. Approving is the deliberate, two-person, audited step.
'use client';
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';
import {
  ActionBtn,
  AdminTable,
  Badge,
  Card,
  CardHead,
  Field,
  Icon,
  Modal,
  Pagination,
  Segmented,
  Spinner,
  TextArea,
  TextInput,
  Toggle,
  fmt,
  type Column,
} from './ui';

interface ChecklistItem {
  key: string;
  label: string;
  hint: string;
}

interface RequestRow {
  id: string;
  status: string;
  statusLabel: string;
  phoneClaimed: string;
  userId: string | null;
  userName: string | null;
  userPhone: string | null;
  userStatus: string | null;
  kycStatus: string | null;
  matched: boolean;
  conversationId: string | null;
  hasCode: boolean;
  attempts: number;
  verifiedBy: string | null;
  approvedBy: string | null;
  freezeUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DepositRow {
  id: string;
  amount: string;
  status: string;
  method: string;
  referenceNumber: string | null;
  senderAccount: string | null;
  proofUrl: string | null;
  createdAt: string;
}
interface DeviceRow {
  id: string;
  fingerprintHash: string;
  userAgent: string | null;
  timezone: string | null;
  lastIp: string | null;
  ipCountry: string | null;
  loginCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
interface LoginRow {
  id: string;
  ip: string;
  ipCountry: string | null;
  userAgent: string | null;
  createdAt: string;
}
interface PayoutAccountRow {
  id: string;
  type: string;
  label: string;
  details: Record<string, string>;
  isLocked: boolean;
  createdAt: string;
}
interface PendingWithdrawalRow {
  id: string;
  amount: string;
  netAmount: string;
  status: string;
  requiresReview: boolean;
  createdAt: string;
}

interface Detail {
  request: {
    id: string;
    status: string;
    statusLabel: string;
    phoneClaimed: string;
    answers: unknown;
    matched: boolean;
    conversationId: string | null;
    checks: Record<string, boolean> | null;
    verifiedBy: string | null;
    verifiedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    rejectReason: string | null;
    attempts: number;
    redeemedAt: string | null;
    codeExpiresAt: string | null;
    freezeUntil: string | null;
    freezeActive: boolean;
    freezeHours: number | null;
    createdAt: string;
    updatedAt: string;
  };
  checklist: ChecklistItem[];
  minChecks: number;
  player: null | {
    phone: string | null;
    accountAgeDays: number | null;
    withdrawalFrozenUntil: string | null;
    fraudOpen: number;
    wallet: { real: string; bonus: string; gifted: string; locked: string };
    user: {
      id: string;
      displayName: string | null;
      phone: string;
      status: string;
      kycStatus: string;
      createdAt: string;
    } | null;
  };
  evidence: {
    deposits: DepositRow[];
    devices: DeviceRow[];
    logins: LoginRow[];
    payoutAccounts: PayoutAccountRow[];
    pendingWithdrawals: PendingWithdrawalRow[];
  };
}

/** The claimant's own words, rendered as label/value rows. */
function answerRows(answers: unknown): Array<[string, string]> {
  if (!answers || typeof answers !== 'object') return [];
  const a = answers as Record<string, unknown>;
  const labels: Array<[string, string]> = [
    ['lastDepositRef', 'Last deposit reference'],
    ['senderAccount', 'Sender account'],
    ['payoutHint', 'Payout account'],
    ['signupHint', 'Signup detail'],
  ];
  const rows: Array<[string, string]> = [];
  for (const [key, label] of labels) {
    const v = a[key];
    if (typeof v === 'string' && v.trim()) rows.push([label, v]);
  }
  const thread = a['thread'];
  if (Array.isArray(thread)) {
    for (const entry of thread) {
      const e = entry as { from?: string; body?: string };
      if (typeof e.body === 'string' && e.body.trim())
        rows.push([e.from === 'SUPPORT' ? 'Support message' : 'Player message', e.body]);
    }
  }
  return rows;
}

const STATUS_COLOR: Record<string, 'green' | 'red' | 'orange' | 'gold' | 'sky' | 'white'> = {
  PENDING: 'white',
  IN_REVIEW: 'sky',
  VERIFIED: 'sky',
  APPROVED: 'gold',
  REDEEMED: 'green',
  REJECTED: 'red',
  EXPIRED: 'orange',
};

export function RecoveryPanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('awaiting');
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [rejectReason, setRejectReason] = useState('');
  const [freezeHours, setFreezeHours] = useState('48');
  const [notes, setNotes] = useState('');

  const me = useQuery({
    queryKey: ['panel-recovery-me'],
    queryFn: () => http.get<{ id?: string; isSuperAdmin?: boolean }>('/panel/auth/me'),
  });
  const isSuperAdmin = me.data?.isSuperAdmin === true;
  const myId = me.data?.id ?? null;

  const list = useQuery({
    queryKey: ['panel-recovery', filter, page],
    queryFn: () =>
      http.get<{ data: RequestRow[]; total: number; checklist: ChecklistItem[]; minChecks: number }>(
        `/panel/recovery?status=${encodeURIComponent(filter)}&page=${page}`
      ),
  });

  const detail = useQuery({
    queryKey: ['panel-recovery-detail', sel],
    queryFn: () => http.get<Detail>(`/panel/recovery/${sel}`),
    enabled: Boolean(sel),
  });

  // Seed the checklist when a DIFFERENT case is opened (keyed on the request
  // id, not on the data object: a background refetch must never wipe the boxes
  // an agent has already ticked).
  const openedId = detail.data?.request.id ?? null;
  const detailChecks = detail.data?.request.checks ?? null;
  React.useEffect(() => {
    setChecks(detailChecks ?? {});
    setRejectReason('');
    setNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed per case id only
  }, [openedId]);

  const after = (msg: string) => {
    notify.success(msg);
    qc.invalidateQueries({ queryKey: ['panel-recovery'] });
    qc.invalidateQueries({ queryKey: ['panel-recovery-detail'] });
  };
  const onFail = (e: unknown) => notify.error((e as Error).message);

  const verify = useMutation({
    mutationFn: () =>
      http.patch(`/panel/recovery/${sel}/verify`, { checks, notes: notes || undefined }),
    onSuccess: () => after('Evidence recorded'),
    onError: onFail,
  });
  const approve = useMutation({
    mutationFn: () =>
      http.patch<{ freezeUntil: string | null }>(`/panel/recovery/${sel}/approve`, {
        hours: Number(freezeHours),
      }),
    onSuccess: (r) =>
      after(
        r.freezeUntil
          ? 'Approved — code issued, withdrawals frozen'
          : 'Approved — code issued (no freeze requested)'
      ),
    onError: onFail,
  });
  const reject = useMutation({
    mutationFn: () => http.patch(`/panel/recovery/${sel}/reject`, { reason: rejectReason }),
    onSuccess: () => {
      setRejectReason('');
      after('Request declined');
    },
    onError: onFail,
  });
  const freeze = useMutation({
    mutationFn: (hours: number) => http.post(`/panel/recovery/${sel}/freeze`, { hours }),
    onSuccess: () => after('Freeze updated'),
    onError: onFail,
  });

  const rows = list.data?.data ?? [];
  const checklist = detail.data?.checklist ?? list.data?.checklist ?? [];
  const minChecks = detail.data?.minChecks ?? list.data?.minChecks ?? 3;
  const matched = checklist.filter((c) => checks[c.key]).length;
  const d = detail.data;
  const req = d?.request;

  const columns: Column<RequestRow>[] = [
    {
      key: 'when',
      header: 'Filed',
      render: (r) => (
        <span className="t-label-sm text-muted">{new Date(r.createdAt).toLocaleString()}</span>
      ),
    },
    {
      key: 'who',
      header: 'Claimant',
      render: (r) => (
        <div>
          <p className="t-label-md text-white/85">
            {r.userName || r.userPhone || r.phoneClaimed}
          </p>
          <p className="t-mono t-label-sm text-muted">{r.phoneClaimed}</p>
          {!r.matched && (
            <span className="t-label-sm text-orange">no account for this number</span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <Badge color={STATUS_COLOR[r.status] ?? 'white'}>{r.statusLabel}</Badge>
          {r.hasCode && <span className="t-label-sm text-muted">code outstanding</span>}
          {r.attempts > 0 && (
            <span className="t-label-sm text-orange">{r.attempts} wrong code(s)</span>
          )}
        </div>
      ),
    },
    {
      key: 'verified',
      header: 'Verified by',
      render: (r) => (
        <span className="t-label-sm text-muted">
          {r.verifiedBy ? `${r.verifiedBy.slice(0, 8)}…` : '—'}
        </span>
      ),
    },
    {
      key: 'freeze',
      header: 'Freeze',
      render: (r) =>
        r.freezeUntil && new Date(r.freezeUntil).getTime() > Date.now() ? (
          <Badge color="orange">until {new Date(r.freezeUntil).toLocaleString()}</Badge>
        ) : (
          <span className="t-label-sm text-muted">none</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <p className="t-label-sm text-secondary">
        Locked-out players have no email or OTP — they file a request, keep a ticket code, and an
        agent verifies them against their own history. Verify here; a second super-admin approves.
        The recovery code is shown only on the player&apos;s ticket page, never in this console.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: 'awaiting', label: 'Awaiting' },
            { value: 'VERIFIED', label: 'Verified' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'closed', label: 'Closed' },
            { value: 'all', label: 'All' },
          ]}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
        />
        {list.data && <span className="t-label-sm text-muted ml-auto">{list.data.total} requests</span>}
      </div>

      <AdminTable
        columns={columns}
        rows={rows}
        loading={list.isLoading}
        empty="No recovery requests in this bucket"
        onRowClick={(r) => setSel(r.id)}
      />

      {list.data && list.data.total > 25 && (
        <Pagination
          page={page}
          totalPages={Math.ceil(list.data.total / 25)}
          onPage={setPage}
        />
      )}

      <Modal
        open={Boolean(sel)}
        onClose={() => setSel(null)}
        title="Recovery review"
        width="max-w-5xl"
      >
        {detail.isLoading && <Spinner label="Loading the case file…" />}
        {d && req && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={STATUS_COLOR[req.status] ?? 'white'}>{req.statusLabel}</Badge>
              {req.freezeActive && req.freezeUntil && (
                <Badge color="orange">
                  withdrawals frozen until {new Date(req.freezeUntil).toLocaleString()}
                </Badge>
              )}
              {req.attempts > 0 && (
                <Badge color="red">{req.attempts} failed code attempt(s)</Badge>
              )}
              {req.codeExpiresAt && req.status === 'APPROVED' && (
                <span className="t-label-sm text-muted">
                  code expires {new Date(req.codeExpiresAt).toLocaleString()}
                </span>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHead title="What the claimant says" icon="support" />
                <div className="space-y-2">
                  <p className="t-label-sm text-muted">
                    Filed {new Date(req.createdAt).toLocaleString()} for{' '}
                    <span className="t-mono">{req.phoneClaimed}</span>
                  </p>
                  {answerRows(req.answers).length === 0 && (
                    <p className="t-label-sm text-muted">Nothing volunteered yet.</p>
                  )}
                  {answerRows(req.answers).map(([label, value], i) => (
                    <div key={`${label}-${i}`} className="rounded-lg bg-white/5 px-3 py-2">
                      <p className="t-label-sm text-muted">{label}</p>
                      <p className="t-label-md text-white/90 whitespace-pre-wrap break-words">
                        {value}
                      </p>
                    </div>
                  ))}
                  {req.conversationId && (
                    <a
                      href={`/panel/support?conversation=${req.conversationId}`}
                      className="t-label-sm text-gold underline underline-offset-2 inline-flex items-center gap-1"
                    >
                      <Icon name="support" size={14} /> Open the thread in Support Inbox
                    </a>
                  )}
                </div>
              </Card>

              <Card>
                <CardHead title="Account on file" icon="users" />
                {d.player?.user ? (
                  <div className="space-y-1.5">
                    <p className="t-label-md text-white/85">
                      {d.player.user.displayName || '—'}{' '}
                      <span className="t-mono t-label-sm text-muted">{d.player.phone}</span>
                    </p>
                    <p className="t-label-sm text-muted">
                      status {d.player.user.status} · KYC {d.player.user.kycStatus} ·{' '}
                      {d.player.accountAgeDays ?? 0} day(s) old
                    </p>
                    <p className="t-label-md text-white/85">
                      Wallet {fmt(Number(d.player.wallet.real))} real ·{' '}
                      {fmt(Number(d.player.wallet.bonus))} bonus
                    </p>
                    {d.player.fraudOpen > 0 && (
                      <p className="t-label-sm text-orange">
                        {d.player.fraudOpen} open fraud signal(s) on this account
                      </p>
                    )}
                    {d.evidence.pendingWithdrawals.length > 0 && (
                      <div className="rounded-lg border border-orange/30 bg-orange/10 px-3 py-2 mt-2">
                        <p className="t-label-sm text-orange">
                          {d.evidence.pendingWithdrawals.length} withdrawal(s) in flight — they stay
                          held until the freeze lapses.
                        </p>
                        {d.evidence.pendingWithdrawals.map((w) => (
                          <p key={w.id} className="t-label-sm text-muted">
                            {fmt(Number(w.amount))} · {w.status}
                            {w.requiresReview ? ' · needs review' : ''}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="t-label-sm text-orange">
                    No account matches this number. Nothing can be recovered — decline with a note
                    (and watch for repeated attempts from one IP).
                  </p>
                )}
              </Card>

              <Card className="lg:col-span-2">
                <CardHead title="Evidence to check against" icon="shield" />
                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <p className="t-label-sm text-muted uppercase tracking-wide mb-2">Deposits</p>
                    {d.evidence.deposits.length === 0 && (
                      <p className="t-label-sm text-muted">No deposits on record.</p>
                    )}
                    {d.evidence.deposits.map((dep) => (
                      <div key={dep.id} className="rounded-lg bg-white/5 px-3 py-2 mb-2">
                        <p className="t-label-md text-white/90">
                          {fmt(Number(dep.amount))} · {dep.status} ·{' '}
                          {new Date(dep.createdAt).toLocaleDateString()}
                        </p>
                        <p className="t-label-sm text-muted">
                          ref <span className="t-mono">{dep.referenceNumber ?? '—'}</span>
                        </p>
                        <p className="t-label-sm text-muted">
                          from <span className="t-mono">{dep.senderAccount ?? '—'}</span>{' '}
                          {dep.method ? `· ${dep.method}` : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="t-label-sm text-muted uppercase tracking-wide mb-2">
                      Devices &amp; recent logins
                    </p>
                    {d.evidence.devices.map((dev) => (
                      <div key={dev.id} className="rounded-lg bg-white/5 px-3 py-2 mb-2">
                        <p className="t-label-sm text-white/85 break-words">
                          {dev.userAgent?.slice(0, 80) ?? 'unknown device'}
                        </p>
                        <p className="t-label-sm text-muted">
                          fp <span className="t-mono">{dev.fingerprintHash}</span> ·{' '}
                          {dev.loginCount} login(s) · {dev.ipCountry ?? '—'}
                        </p>
                        <p className="t-label-sm text-muted">
                          first {new Date(dev.firstSeenAt).toLocaleDateString()} · last{' '}
                          {new Date(dev.lastSeenAt).toLocaleString()}
                        </p>
                      </div>
                    ))}
                    {d.evidence.logins.slice(0, 6).map((l) => (
                      <p key={l.id} className="t-label-sm text-muted">
                        {new Date(l.createdAt).toLocaleString()} ·{' '}
                        <span className="t-mono">{l.ip}</span> {l.ipCountry ?? ''}
                      </p>
                    ))}
                  </div>
                  <div>
                    <p className="t-label-sm text-muted uppercase tracking-wide mb-2">
                      Payout accounts (masked)
                    </p>
                    {d.evidence.payoutAccounts.length === 0 && (
                      <p className="t-label-sm text-muted">None saved.</p>
                    )}
                    {d.evidence.payoutAccounts.map((a) => (
                      <div key={a.id} className="rounded-lg bg-white/5 px-3 py-2 mb-2">
                        <p className="t-label-md text-white/90">
                          {a.label} {a.isLocked && <Badge color="orange">locked</Badge>}
                        </p>
                        {Object.entries(a.details).map(([k, v]) => (
                          <p key={k} className="t-label-sm text-muted">
                            {k}: <span className="t-mono">{v}</span>
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="t-label-sm text-muted uppercase tracking-wide mb-2">
                      Checklist ({matched}/{checklist.length})
                    </p>
                    <div className="space-y-2">
                      {checklist.map((c) => (
                        <div key={c.key} className="rounded-lg border border-white/10 px-3 py-2">
                          <Toggle
                            checked={Boolean(checks[c.key])}
                            onChange={(v) => setChecks((s) => ({ ...s, [c.key]: v }))}
                            label={c.label}
                          />
                          <p className="t-label-sm text-muted mt-1">{c.hint}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3">
                      <Field label="Agent notes (optional)">
                        <TextArea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          rows={2}
                          maxLength={500}
                        />
                      </Field>
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            {/* ── Actions ───────────────────────────────────────────────── */}
            {req.status !== 'REDEEMED' && req.status !== 'REJECTED' && (
              <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ActionBtn
                    tone="primary"
                    onClick={() => verify.mutate()}
                    disabled={!req.matched || matched < minChecks || verify.isPending}
                    title={
                      matched < minChecks
                        ? `Tick at least ${minChecks} of ${checklist.length} checks`
                        : undefined
                    }
                  >
                    Verify evidence ({matched}/{checklist.length})
                  </ActionBtn>

                  <div className="flex items-center gap-2">
                    <TextInput
                      value={freezeHours}
                      onChange={(e) => setFreezeHours(e.target.value)}
                      className="w-20 h-9"
                      inputMode="numeric"
                    />
                    <ActionBtn
                      tone="gold"
                      onClick={() => approve.mutate()}
                      disabled={
                        !isSuperAdmin || !req.matched || req.verifiedBy === myId || approve.isPending
                      }
                      title={
                        !isSuperAdmin
                          ? 'Only a super-admin can approve'
                          : req.verifiedBy === myId
                            ? 'A second admin must approve — you verified this request'
                            : 'Issue a one-time code and freeze withdrawals'
                      }
                    >
                      Approve &amp; issue code (freeze {freezeHours}h)
                    </ActionBtn>
                  </div>

                  <div className="flex items-center gap-2 ml-auto">
                    <TextInput
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Reason for declining"
                      className="w-56 h-9"
                    />
                    <ActionBtn
                      tone="danger"
                      onClick={() => reject.mutate()}
                      disabled={rejectReason.trim().length < 4 || reject.isPending}
                    >
                      Decline
                    </ActionBtn>
                  </div>
                </div>

                {isSuperAdmin && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
                    <span className="t-label-sm text-muted">Withdrawal hold:</span>
                    <ActionBtn
                      size="sm"
                      onClick={() => freeze.mutate(Number(freezeHours) || 0)}
                      disabled={freeze.isPending}
                    >
                      Apply {freezeHours}h
                    </ActionBtn>
                    <ActionBtn
                      size="sm"
                      onClick={() => freeze.mutate(0)}
                      disabled={freeze.isPending || !req.freezeActive}
                    >
                      Release now
                    </ActionBtn>
                    <span className="t-label-sm text-muted">
                      Releasing early is audited — it is the one control that stops a stolen account
                      from being emptied.
                    </span>
                  </div>
                )}

                {req.verifiedBy && (
                  <p className="t-label-sm text-muted">
                    Verified by <span className="t-mono">{req.verifiedBy.slice(0, 12)}…</span>
                    {req.approvedBy
                      ? ` · approved by ${req.approvedBy.slice(0, 12)}…`
                      : ' · awaiting a second admin'}
                  </p>
                )}
              </div>
            )}

            {req.redeemedAt && (
              <p className="t-label-sm text-green">
                Completed {new Date(req.redeemedAt).toLocaleString()} — the player set a new
                password and every session was revoked.
              </p>
            )}
            {req.rejectReason && (
              <p className="t-label-sm text-red">Declined: {req.rejectReason}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
