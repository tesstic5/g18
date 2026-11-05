// apps/web/src/components/admin/sections.tsx — admin panels: queues, managers, settings,
// audit, broadcasts, support, legal, fraud, reports. (D-068 polish pass)
'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http, ApiError } from '../../lib/api';
import { notify } from '../../lib/toast';
import {
  AdminTable,
  ActionBtn,
  Badge,
  Pagination,
  Card,
  CardHead,
  Field,
  TextInput,
  Select,
  TextArea,
  Toggle,
  Icon,
  Segmented,
  fmt,
  Spinner,
  type Column,
} from './ui';
import { BarChart } from './charts';
import { useStepUp } from './step-up';
export { PaymentAccountsPanel } from './payment-accounts';
export { RecoveryPanel } from './recovery';
export { MonitoringPanel } from './monitoring';

// ── DEPOSITS QUEUE ─────────────────────────────────────────────────────────
interface DepositRow {
  id: string;
  userId: string;
  amount: string;
  status: string;
  paymentMethod: string;
  referenceNumber?: string | null;
  createdAt: string;
  accountDetails?: Record<string, unknown> | null;
  senderAccount?: string | null;
  proofObjectKey?: string | null;
  /** v1.3.2: click-ready signed proof URL (10 min) from the panel list —
   *  preferred over rebuilding the raw path because it needs no cookie. */
  proofUrl?: string | null;
  notes?: string | null;
  userPhone?: string | null;
  userName?: string | null;
}
export function DepositsQueue() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('PENDING');
  const [note, setNote] = useState<Record<string, string>>({});
  const { data, isLoading } = useQuery({
    queryKey: ['panel-deposits', status, page],
    queryFn: () =>
      http.get<{ data: DepositRow[]; total: number; sum: number }>(
        `/panel/deposits?status=${status}&page=${page}`
      ),
  });
  const review = useMutation({
    mutationFn: ({ id, st }: { id: string; st: 'APPROVED' | 'REJECTED' }) =>
      http.patch(`/panel/deposits/${id}`, {
        status: st,
        notes: note[id]?.trim() || undefined,
      }),
    onSuccess: (_d, v) => {
      notify.success(
        v.st === 'APPROVED' ? 'Approved — player credited & notified' : 'Rejected'
      );
      qc.invalidateQueries({ queryKey: ['panel-deposits'] });
    },
    onError: (e) => {
      const err = e as ApiError;
      if (err.status === 409 || err.code === 'GAME_007') {
        notify.success('Already processed — queue refreshed');
        qc.invalidateQueries({ queryKey: ['panel-deposits'] });
        return;
      }
      notify.error(err.message);
    },
  });
  const rows = data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: 'PENDING', label: `Pending` },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'REJECTED', label: 'Rejected' },
          ]}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
        {data && (
          <span className="t-label-sm text-muted ml-auto">
            {data.total} records · total {fmt(data.sum)}
          </span>
        )}
      </div>
      <AdminTable
        columns={[
          {
            key: 'ref',
            header: 'Reference',
            render: (r) => (
              <span className="t-mono t-label-sm">
                {r.referenceNumber || r.id.slice(0, 8)}
              </span>
            ),
          },
          {
            key: 'user',
            header: 'Player',
            render: (r) => (
              <div>
                <p className="t-label-md text-white/85">
                  {r.userName || r.userPhone || r.userId.slice(0, 8)}
                </p>
                {r.userPhone && r.userName && (
                  <p className="t-label-sm text-muted t-mono">{r.userPhone}</p>
                )}
              </div>
            ),
          },
          {
            key: 'amount',
            header: 'Amount',
            render: (r) => (
              <span className="t-num-md text-gold">{fmt(Number(r.amount))}</span>
            ),
          },
          {
            key: 'method',
            header: 'Method',
            render: (r) => <Badge color="gold">{r.paymentMethod}</Badge>,
          },
          {
            key: 'sender',
            header: 'Paid from',
            render: (r) => (
              <span className="t-mono t-label-sm">{r.senderAccount || '—'}</span>
            ),
          },
          {
            key: 'proof',
            header: 'Proof',
            render: (r) =>
              r.proofObjectKey ? (
                <a
                  className="t-label-sm text-gold underline"
                  href={r.proofUrl ?? `/api/v1/deposits/proof/${r.proofObjectKey}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View ↗
                </a>
              ) : (
                '—'
              ),
          },
          {
            key: 'date',
            header: 'Date',
            render: (r) => (
              <span className="t-label-sm text-muted">
                {new Date(r.createdAt).toLocaleString()}
              </span>
            ),
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <div className="flex flex-col gap-1.5 items-start">
                {status === 'PENDING' && (
                  <>
                    <input
                      placeholder="Note (shown to player if rejected)"
                      value={note[r.id] ?? ''}
                      onChange={(e) =>
                        setNote((n) => ({ ...n, [r.id]: e.target.value }))
                      }
                      className="w-44 h-8 px-2.5 rounded-lg bg-layer-elevated border border-white/10 text-xs outline-none placeholder:text-white/25"
                    />
                    <div className="flex gap-1.5">
                      <ActionBtn
                        size="sm"
                        tone="primary"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: r.id, st: 'APPROVED' })}
                      >
                        {review.isPending && review.variables?.id === r.id
                          ? 'Working…'
                          : 'Approve'}
                      </ActionBtn>
                      <ActionBtn
                        size="sm"
                        tone="danger"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: r.id, st: 'REJECTED' })}
                      >
                        Reject
                      </ActionBtn>
                    </div>
                  </>
                )}
                {status !== 'PENDING' && (
                  <span className="t-label-sm text-muted">
                    {r.status} {r.notes ? `· ${r.notes}` : ''}
                  </span>
                )}
              </div>
            ),
          },
        ]}
        rows={rows}
        loading={isLoading}
        empty="All deposits reviewed ✓"
      />
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

// ── WITHDRAWALS QUEUE ──────────────────────────────────────────────────────
interface WithdrawRow {
  id: string;
  userId: string;
  amount: string;
  fee: string;
  netAmount: string;
  status: string;
  requiresReview: boolean;
  createdAt: string;
  notes?: string | null;
  payoutAccount?: {
    type: string;
    label: string;
    accountDetails?: Record<string, unknown> | null;
  } | null;
  userPhone?: string | null;
  userName?: string | null;
}
export function WithdrawalsQueue() {
  const qc = useQueryClient();
  // Approving a payout now needs a fresh password (step-up). The hook prompts,
  // re-authenticates and replays the request, so the operator still performs
  // one action — see components/admin/step-up.tsx.
  const stepUp = useStepUp();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('PENDING');
  const [note, setNote] = useState<Record<string, string>>({});
  const { data, isLoading } = useQuery({
    queryKey: ['panel-withdrawals', status, page],
    queryFn: () =>
      http.get<{ data: WithdrawRow[]; total: number; sum: number; feeSum: number }>(
        `/panel/withdrawals?status=${status}&page=${page}`
      ),
  });
  const review = useMutation({
    mutationFn: ({
      id,
      st,
    }: {
      id: string;
      st: 'APPROVED' | 'REJECTED' | 'COMPLETED';
    }) =>
      stepUp.run(() =>
        http.patch(`/panel/withdrawals/${id}`, {
          status: st,
          notes: note[id]?.trim() || undefined,
        })
      ),
    onSuccess: (data, v) => {
      const staged = (data as { needsSecondApproval?: boolean } | undefined)?.needsSecondApproval;
      notify.success(
        staged
          ? 'First approval recorded — a different admin must approve this payout'
          : v.st === 'REJECTED'
            ? 'Rejected — funds refunded'
            : v.st === 'APPROVED'
              ? 'Approved'
              : 'Completed'
      );
      qc.invalidateQueries({ queryKey: ['panel-withdrawals'] });
    },
    onError: (e) => {
      const err = e as ApiError;
      if (err.status === 409 || err.code === 'GAME_007') {
        notify.success('Already processed — queue refreshed');
        qc.invalidateQueries({ queryKey: ['panel-withdrawals'] });
        return;
      }
      notify.error(err.message);
    },
  });
  const rows = data?.data ?? [];
  return (
    <div className="space-y-4">
      {stepUp.modal}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: 'PENDING', label: 'Pending' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'COMPLETED', label: 'Completed' },
            { value: 'REJECTED', label: 'Rejected' },
          ]}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
        {data && (
          <span className="t-label-sm text-muted ml-auto">
            {data.total} records · {fmt(data.sum)} requested · {fmt(data.feeSum)} fees
          </span>
        )}
      </div>
      <AdminTable
        columns={[
          {
            key: 'user',
            header: 'Player',
            render: (r) => (
              <div>
                <p className="t-label-md text-white/85">
                  {r.userName || r.userPhone || r.userId.slice(0, 8)}
                </p>
                {r.userPhone && r.userName && (
                  <p className="t-label-sm text-muted t-mono">{r.userPhone}</p>
                )}
              </div>
            ),
          },
          {
            key: 'amount',
            header: 'Requested',
            render: (r) => <span className="t-num-md">{fmt(Number(r.amount))}</span>,
          },
          {
            key: 'fee',
            header: 'Fee',
            render: (r) => (
              <span className="t-num-sm text-muted">−{fmt(Number(r.fee))}</span>
            ),
          },
          {
            key: 'net',
            header: 'Net payout',
            render: (r) => (
              <span className="t-num-md text-green">{fmt(Number(r.netAmount))}</span>
            ),
          },
          {
            key: 'to',
            header: 'Pay to',
            render: (r) => {
              const d = (r.payoutAccount?.accountDetails ?? {}) as Record<
                string,
                unknown
              >;
              return (
                <div className="max-w-[180px]">
                  <p className="t-label-sm text-white/75 truncate">
                    {r.payoutAccount?.label ?? '—'}
                  </p>
                  <p className="t-mono t-label-sm text-muted truncate">
                    {String(d.account_number ?? '')}
                    {r.payoutAccount?.type === 'bank'
                      ? ` · ${String(d.bank ?? '')}`
                      : ''}
                  </p>
                </div>
              );
            },
          },
          {
            key: 'flag',
            header: 'Flag',
            render: (r) =>
              r.requiresReview ? (
                <Badge color="orange">24h review</Badge>
              ) : (
                <span className="t-label-sm text-muted">—</span>
              ),
          },
          {
            key: 'date',
            header: 'Date',
            render: (r) => (
              <span className="t-label-sm text-muted">
                {new Date(r.createdAt).toLocaleString()}
              </span>
            ),
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <div className="flex flex-col gap-1.5 items-start">
                {(status === 'PENDING' || status === 'APPROVED') && (
                  <>
                    <input
                      placeholder="Note (shown to player if rejected)"
                      value={note[r.id] ?? ''}
                      onChange={(e) =>
                        setNote((n) => ({ ...n, [r.id]: e.target.value }))
                      }
                      className="w-44 h-8 px-2.5 rounded-lg bg-layer-elevated border border-white/10 text-xs outline-none placeholder:text-white/25"
                    />
                    <div className="flex gap-1.5">
                      {status === 'PENDING' && (
                        <ActionBtn
                          size="sm"
                          tone="primary"
                          disabled={review.isPending}
                          onClick={() => review.mutate({ id: r.id, st: 'APPROVED' })}
                        >
                          Approve
                        </ActionBtn>
                      )}
                      {status === 'APPROVED' && (
                        <ActionBtn
                          size="sm"
                          tone="gold"
                          disabled={review.isPending}
                          onClick={() => review.mutate({ id: r.id, st: 'COMPLETED' })}
                        >
                          Mark paid
                        </ActionBtn>
                      )}
                      <ActionBtn
                        size="sm"
                        tone="danger"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ id: r.id, st: 'REJECTED' })}
                      >
                        Reject
                      </ActionBtn>
                    </div>
                  </>
                )}
                {status === 'COMPLETED' || status === 'REJECTED' ? (
                  <span className="t-label-sm text-muted">
                    {r.status}
                    {r.notes ? ` · ${r.notes}` : ''}
                  </span>
                ) : null}
              </div>
            ),
          },
        ]}
        rows={rows}
        loading={isLoading}
        empty="All withdrawals processed ✓"
      />
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

// ── MANAGERS ─────────────────────────────────────────────────────────────
export function ManagersPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['panel-managers'],
    queryFn: () =>
      http.get<
        Array<{
          id: string;
          username: string;
          isSuperAdmin: boolean;
          lastLoginAt?: string | null;
          createdAt: string;
          permFinancial?: boolean;
          permUsers?: boolean;
          permReporting?: boolean;
          permChat?: boolean;
          permGames?: boolean;
          permSettings?: boolean;
        }>
      >('/panel/managers'),
  });
  const { data: me } = useQuery({
    queryKey: ['panel-me'],
    queryFn: () =>
      http.get<{ isSuperAdmin: boolean; username: string; hiddenFromAdmins?: boolean }>(
        '/panel/auth/me'
      ),
  });
  const isSuper = !!me?.isSuperAdmin;
  const toggleHidden = useMutation({
    mutationFn: (hiddenFromAdmins: boolean) =>
      http.patch('/panel/managers/me', { hiddenFromAdmins }),
    onSuccess: () => {
      notify.success('Visibility updated');
      qc.invalidateQueries({ queryKey: ['panel-me'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const [form, setForm] = useState({
    username: '',
    password: '',
    isSuperAdmin: false,
    permissions: {
      financial: false,
      users: false,
      reporting: false,
      chat: false,
      games: false,
      settings: false,
    },
  });
  const create = useMutation({
    mutationFn: () => http.post('/panel/managers', form),
    onSuccess: () => {
      notify.success('Manager created');
      qc.invalidateQueries({ queryKey: ['panel-managers'] });
      setForm({
        username: '',
        password: '',
        isSuperAdmin: false,
        permissions: { financial: false, users: false, reporting: false, chat: false, games: false, settings: false },
      });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Record<string, boolean>>({});
  const [editSuper, setEditSuper] = useState(false);
  const [editPassword, setEditPassword] = useState('');
  const startEdit = (row: NonNullable<typeof data>[number]) => {
    setEditingId(row.id);
    setEditPerms({
      financial: !!row.permFinancial,
      users: !!row.permUsers,
      reporting: !!row.permReporting,
      chat: !!row.permChat,
      games: !!row.permGames,
      settings: !!row.permSettings,
    });
    setEditSuper(!!row.isSuperAdmin);
    setEditPassword('');
  };
  const saveEdit = useMutation({
    mutationFn: ({ id, perms, isSuperAdmin, password }: { id: string; perms: Record<string, boolean>; isSuperAdmin?: boolean; password?: string }) => {
      const body: Record<string, unknown> = { permissions: perms };
      if (isSuper) body.isSuperAdmin = isSuperAdmin;
      if (password) body.password = password;
      return http.patch(`/panel/managers/${id}`, body);
    },
    onSuccess: () => {
      notify.success('Permissions updated');
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ['panel-managers'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHead
          title="Create manager"
          icon="managers"
          right={<Badge color={isSuper ? 'gold' : 'white'}>{isSuper ? 'super admin' : 'admin'}</Badge>}
        />
        <div className="grid sm:grid-cols-2 gap-3 max-w-2xl">
          <Field label="Username">
            <TextInput value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field label="Password (8+ chars)">
            <TextInput type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
        {isSuper && (
          <div className="flex items-center gap-2 mt-3">
            <Toggle checked={form.isSuperAdmin} onChange={(v) => setForm({ ...form, isSuperAdmin: v })} />
            <span className="t-label-md">Create as super admin</span>
          </div>
        )}
        {isSuper && (
          <div className="flex items-center gap-2 mt-3">
            <Toggle
              checked={!!me?.hiddenFromAdmins}
              onChange={(v) => toggleHidden.mutate(v)}
            />
            <span className="t-label-md">
              Hide me from other admins (super admins are not listed for non-super admins)
            </span>
          </div>
        )}
        <div className="grid sm:grid-cols-3 gap-2 mt-4 max-w-2xl">
          {Object.entries(form.permissions).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between rounded-lg bg-layer-elevated border border-white/8 px-3 py-2">
              <span className="t-label-md text-secondary capitalize">{k}</span>
              <Toggle checked={v as boolean} onChange={(nv) => setForm({ ...form, permissions: { ...form.permissions, [k]: nv } })} />
            </div>
          ))}
        </div>
        <div className="mt-4">
          <ActionBtn tone="gold" onClick={() => create.mutate()} disabled={!form.username || form.password.length < 8}>
            <Icon name="plus" size={14} /> Create manager
          </ActionBtn>
        </div>
      </Card>
      <AdminTable
        columns={[
          { key: 'u', header: 'Username', render: (r) => <span className="t-label-lg text-primary">{r.username}</span> },
          { key: 's', header: 'Role', render: (r) => <Badge color={r.isSuperAdmin ? 'gold' : 'white'}>{r.isSuperAdmin ? 'SUPER ADMIN' : 'manager'}</Badge> },
          {
            key: 'perms',
            header: 'Permissions',
            render: (r) => {
              if (editingId === r.id) return <span className="t-label-sm text-muted">editing…</span>;
              const active = [
                r.permFinancial && 'financial',
                r.permUsers && 'users',
                r.permReporting && 'reporting',
                r.permChat && 'chat',
                r.permGames && 'games',
                r.permSettings && 'settings',
              ].filter(Boolean);
              return <span className="t-label-sm text-muted">{active.length ? active.join(', ') : '—'}</span>;
            },
          },
          { key: 'c', header: 'Created', render: (r) => <span className="t-label-sm text-muted">{new Date(r.createdAt).toLocaleDateString()}</span> },
          { key: 'l', header: 'Last login', render: (r) => <span className="t-label-sm text-muted">{r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString() : 'never'}</span> },
          {
            key: 'a',
            header: '',
            render: (r) => {
              const canEdit = isSuper || !r.isSuperAdmin;
              if (editingId === r.id) return null;
              return canEdit ? (
                <ActionBtn size="sm" tone="ghost" onClick={() => startEdit(r)}>Edit</ActionBtn>
              ) : (
                <span className="t-label-sm text-muted">locked</span>
              );
            },
          },
        ]}
        rows={data ?? []}
        empty="No managers yet"
      />
      {editingId && (
        <Card>
          <CardHead title={`Edit ${data?.find((x) => x.id === editingId)?.username ?? ''}`} />
          <div className="grid sm:grid-cols-3 gap-2 max-w-2xl">
            {Object.entries(editPerms).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between rounded-lg bg-layer-elevated border border-white/8 px-3 py-2">
                <span className="t-label-md capitalize">{k}</span>
                <Toggle checked={!!v} onChange={(nv) => setEditPerms((p) => ({ ...p, [k]: nv }))} />
              </div>
            ))}
          </div>
          {isSuper && (
            <div className="flex items-center gap-2 mt-3">
              <Toggle checked={editSuper} onChange={setEditSuper} />
              <span className="t-label-md">Super admin</span>
            </div>
          )}
          <Field label="New password (leave blank to keep)">
            <TextInput type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="••••••••" />
          </Field>
          <div className="flex gap-2 mt-4">
            <ActionBtn tone="gold" onClick={() => saveEdit.mutate({ id: editingId!, perms: editPerms, isSuperAdmin: editSuper, password: editPassword || undefined })} disabled={saveEdit.isPending}>
              Save
            </ActionBtn>
            <ActionBtn tone="ghost" onClick={() => setEditingId(null)}>Cancel</ActionBtn>
          </div>
          {!isSuper && data?.find((x) => x.id === editingId)?.isSuperAdmin && (
            <p className="t-label-sm text-red mt-2">Admins cannot modify a super admin — ask a super admin.</p>
          )}
        </Card>
      )}
    </div>
  );
}

// ── SETTINGS (RTP ceiling locked — docs/20 rule 4) ─────────────────────────
const SETTING_GROUPS: Array<{ group: string; keys: Array<[string, string, string]> }> =
  [
    {
      group: 'General',
      keys: [
        ['coin_rate', 'Coin rate (₨1 = ? coins)', 'Display rate for coin chips'],
        ['registration_open', 'Allow new signups', 'Turn off to close registration'],
        [
          'maintenance_mode',
          'Maintenance mode',
          'When ON the player site shows 503 and only the panel stays reachable',
        ],
        [
          'demo_mode_enabled',
          'Demo mode for guests',
          'When ON, guests can try every game with virtual coins. When OFF (default), playing requires login.',
        ],
        [
          'lobby_show_game_names',
          'Show game names on lobby',
          'OFF (default): home and /games show thumbnails only — the art already has the title. ON: overlay the display name on cards, hot row, recently played, and the featured banner.',
        ],
      ],
    },
    {
      group: 'Deposits & withdrawals',
      keys: [
        [
          'min_deposit',
          'Minimum deposit (₨)',
          'Smallest amount a deposit request may ask for',
        ],
        [
          'max_deposit',
          'Maximum deposit (₨)',
          'Biggest amount allowed per single deposit request',
        ],
        [
          'deposit_rate_max',
          'Deposit requests allowed per window',
          'How many deposit requests one player may submit inside the window below (default 5)',
        ],
        [
          'deposit_rate_window_sec',
          'Deposit window (seconds)',
          'After this many seconds the player can submit the next batch of deposits — e.g. 600 = a 2nd batch after 10 minutes. Seconds, not minutes, per operator request.',
        ],
        [
          'min_withdrawal',
          'Minimum withdrawal (₨)',
          'Smallest amount a withdrawal request may ask for',
        ],
        [
          'max_withdrawal',
          'Maximum withdrawal (₨)',
          'Biggest amount allowed per single withdrawal request',
        ],
        ['withdrawal_fee_percent', 'Withdrawal fee (%)', 'Charged on each withdrawal'],
      ],
    },
    {
      group: 'Betting limits',
      keys: [
        ['global_min_bet', 'Minimum bet (₨)', ''],
        ['global_max_bet', 'Maximum bet (₨)', 'Platform-wide stake ceiling'],
        [
          'global_max_payout',
          'Maximum payout per round (₨)',
          'Hard currency liability ceiling',
        ],
        [
          'global_max_win_multiplier',
          'Max win multiplier',
          'Multiplier ceiling; currency payout cap still applies',
        ],
      ],
    },
    {
      group: 'Bonuses & engagement',
      keys: [
        [
          'signup_bonus_enabled',
          'Signup bonus',
          'Give every new player a welcome bonus',
        ],
        [
          'signup_bonus_amount',
          'Signup bonus amount (₨)',
          'Credited to the bonus wallet at signup — must be wagered, not withdrawn',
        ],
        [
          'daily_checkin_min_balance',
          'Daily bonus — minimum balance (₨)',
          'Players below this cannot claim the daily bonus. 0 = anyone can claim',
        ],
        ['rakeback_percent', 'Rakeback (%)', 'Returned to players weekly'],
        ['referral_bonus_enabled', 'Referral bonus enabled (true/false)', ''],
        ['referral_bonus_referrer', 'Referral bonus — referrer (₨)', ''],
        ['referral_bonus_referee', 'Referral bonus — new player (₨)', ''],
        ['referral_max_rewards', 'Max rewards per referrer (0 = unlimited)', ''],
        [
          'referral_commission_pct',
          'Referral agent commission (% of net spend)',
          'Paid daily to referral agents in /panel/referral-users',
        ],
        [
          'session_reminder_default_min',
          'Session reminder (minutes)',
          'Default for players who enable it',
        ],
        [
          'big_win_ticker_threshold',
          'Big-win ticker threshold (₨)',
          'Wins above this appear in the site ticker',
        ],
      ],
    },
    {
      group: 'Responsible play',
      keys: [
        [
          'responsible_play_enabled',
          'Responsible-play tools',
          'Self-exclusion + daily loss/deposit limits. OFF = disabled entirely',
        ],
      ],
    },
    {
      group: 'Security',
      keys: [
        [
          'withdrawal_dual_control_threshold',
          'Dual control over withdrawals (₨)',
          'A payout at or above this amount needs a SECOND admin — the first approver can never release it. 0 turns dual control off.',
        ],
        [
          'admin_credit_dual_control_threshold',
          'Dual control over admin credits (₨)',
          'A manual balance credit at or above this amount is parked for a second admin instead of applying instantly. 0 turns it off.',
        ],
        [
          'admin_step_up_minutes',
          'Step-up window (minutes)',
          'How long a password re-entry stays valid for money actions. After this the panel asks again.',
        ],
        [
          'admin_idle_timeout_minutes',
          'Panel idle timeout (minutes)',
          'A signed-in admin who does nothing for this long is logged out.',
        ],
        [
          'password_min_length',
          'Minimum password length',
          'Applies to signup, password change and recovery resets',
        ],
        [
          'password_reject_common',
          'Reject common passwords',
          'Blocks guesses like 12345678 — rotate off only if players complain',
        ],
        [
          'password_history_depth',
          'Password history depth',
          'How many previous passwords may not be reused. 0 disables the check.',
        ],
        [
          'login_max_attempts',
          'Failed logins before lockout',
          'Per account, so many IPs cannot spray one login',
        ],
        [
          'login_lock_minutes',
          'Lockout length (minutes)',
          'How long a locked account must wait (and the player is told to use support chat — there is no email reset)',
        ],
        [
          'new_device_policy',
          'Sign-in from a new device',
          'notify = allow and alert the player (default). block = refuse sign-in from a device the account has never used. Accounts with no device history are never blocked.',
        ],
        [
          'rate_limit_fail_mode',
          'If the rate-limit store is down',
          'memory = keep limiting locally (default). open = allow traffic through. closed = refuse rate-limited requests. Only matters when Redis is unreachable.',
        ],
        [
          'retention_login_events_days',
          'Keep login events (days)',
          'Older rows are purged nightly. 0 disables the purge.',
        ],
        [
          'retention_notifications_days',
          'Keep read notifications (days)',
          'Nightly purge of READ notifications older than this. Unread ones are never deleted — they are still messages someone has not seen. 0 disables the purge.',
        ],
        [
          'retention_recovery_requests_days',
          'Keep recovery requests (days)',
          'Older rows are purged nightly. 0 disables the purge.',
        ],
        [
          'security_watchdog_enabled',
          'Hourly security watchdog',
          'Checks services, backup freshness, stalled payouts, fraud spikes and key rotation, then raises alerts',
        ],
        [
          'alerts_webhook_url',
          'Alerts webhook URL',
          'Optional http(s) endpoint that receives every alert as JSON. Empty = panel alerts + notifications only.',
        ],
      ],
    },
  ];
export function SettingsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => http.get<Record<string, unknown>>('/panel/settings'),
  });
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  // D-071: daily-bonus editor — one number scales the whole streak ladder
  const [bonusBase, setBonusBase] = useState<string>('');
  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = Object.fromEntries(
        Object.entries(edits).map(([k, v]) => [
          k,
          typeof v === 'boolean' ? v : isNaN(Number(v)) ? v : Number(v),
        ])
      );
      if (bonusBase !== '') {
        const base = Math.max(1, Math.min(100000, Number(bonusBase) || 5));
        const DAYS = [1, 2, 3, 4, 5, 6, 7, 14, 21, 30];
        const RATIOS = [1, 1.6, 2.4, 3.6, 5, 7, 10, 15, 20, 40];
        payload.daily_checkin_ladder = DAYS.map((day, i) => ({
          day,
          bonus: Math.round(base * RATIOS[i]! * 100) / 100,
        }));
      }
      return http.patch('/panel/settings', payload);
    },
    onSuccess: () => {
      notify.success('Settings saved');
      qc.invalidateQueries({ queryKey: ['panel-settings'] });
      setEdits({});
      setBonusBase('');
    },
    onError: (e) => notify.error((e as Error).message),
  });
  if (!data) return <Spinner label="Loading settings…" />;
  const dirty = Object.keys(edits).length > 0 || bonusBase !== '';
  const ladder =
    (data.daily_checkin_ladder as Array<{ day: number; bonus: number }> | undefined) ??
    [];
  return (
    <div className="space-y-5 max-w-3xl">
      {/* D-071: DAILY BONUS — admin can change the reward amount */}
      <Card className="border-gold/20">
        <CardHead
          title="Daily bonus"
          icon="gift"
          right={<Badge color="gold">players see this on the homepage</Badge>}
        />
        <div className="grid sm:grid-cols-2 gap-4 items-end">
          <Field
            label="Day-1 bonus (₨)"
            hint="Streak rewards scale from it: day 7 = 10×, day 14 = 15×, day 21 = 20×, day 30 = 40×"
          >
            <TextInput
              type="number"
              min={1}
              step={1}
              placeholder={String(ladder[0]?.bonus ?? 5)}
              value={bonusBase}
              onChange={(e) => setBonusBase(e.target.value)}
              className="t-num-md"
            />
          </Field>
          <div className="rounded-lg bg-layer-elevated border border-white/8 p-3">
            <p className="t-label-sm text-muted mb-1">Current ladder (₨)</p>
            <div className="flex flex-wrap gap-1.5">
              {ladder.slice(0, 7).map((l) => (
                <span
                  key={l.day}
                  className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-xs text-white/70"
                >
                  D{l.day} · {l.bonus}
                </span>
              ))}
              {ladder.length > 7 && (
                <span className="px-2 py-0.5 rounded bg-gold/10 border border-gold/25 text-xs text-gold">
                  …D30 · {ladder[ladder.length - 1]?.bonus}
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>
      <Card className="border-gold/20">
        <div className="flex items-center justify-between">
          <div>
            <p className="t-label-md text-secondary">RTP ceiling (hard-coded)</p>
            <p className="t-num-lg text-gold">{Number(data.rtp_ceiling).toFixed(1)}%</p>
          </div>
          <Badge color="gold">locked — cannot be changed by any admin</Badge>
        </div>
      </Card>
      {/* PLAYER DIFFICULTY — platform default win-frequency (product spec:
          easy / normal / hard / impossible). Every one-shot game can override
          this in its own editor; crash games scale the takeoff-blast share with
          the same ladder; session games stay exempt. WinGo fades the book. */}
      <Card className="border-gold/20">
        <CardHead
          title="Player difficulty (default)"
          icon="controller"
          right={<Badge color="gold">applies to new bets immediately</Badge>}
        />
        <p className="t-label-sm text-muted mb-3">
          Scales how often players WIN across the one-shot games (dice, limbo, wheel,
          roulette, keno, plinko, thimbles, coin flip, ring of fortune, scratch card,
          lucky number, baccarat, dragon tiger). Payout prices are never touched — only
          win frequency. On aviator and crash-x the same ladder sizes the instant 1.00x
          takeoff bust (easy ≈ 48% / normal ≈ 65% / hard ≈ 83% / impossible ≈ 97% of
          rounds). A game&apos;s own difficulty setting overrides this; mines, tower,
          stairs and hi-lo stay at their committed odds. WinGo keeps 1.96× pay and fades
          the cheapest winning-stake digit on hard/impossible.
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['easy', 'Easy', '×1.5 win chance — generous'],
              ['normal', 'Normal', 'the configured odds (provably fair)'],
              ['hard', 'Hard', '×0.5 win chance'],
              ['impossible', 'Impossible', '×0.1 win chance — rare wins'],
            ] as const
          ).map(([value, label, sub]) => {
            const current = String(
              edits['game_difficulty'] !== undefined
                ? edits['game_difficulty']
                : (data['game_difficulty'] ?? 'normal')
            );
            const active = current === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setEdits((ed) => ({ ...ed, game_difficulty: value }))}
                className={`min-w-32 rounded-xl border px-4 py-3 text-left transition-all ${
                  active
                    ? 'bg-gold/15 border-gold/50 text-gold'
                    : 'bg-white/5 border-white/10 text-white/60 hover:border-white/25'
                }`}
              >
                <span className="t-label-md block">{label}</span>
                <span className="t-label-sm opacity-70">{sub}</span>
              </button>
            );
          })}
        </div>
      </Card>
      {SETTING_GROUPS.map((g) => (
        <Card key={g.group}>
          <CardHead title={g.group} />
          <div className="grid sm:grid-cols-2 gap-4">
            {g.keys.map(([k, label, hint]) => {
              const isBool =
                typeof data[k] === 'boolean' ||
                k === 'lobby_show_game_names' ||
                k === 'demo_mode_enabled' ||
                k === 'maintenance_mode' ||
                k === 'registration_open' ||
                k === 'signup_bonus_enabled' ||
                k === 'responsible_play_enabled' ||
                k === 'password_reject_common' ||
                k === 'security_watchdog_enabled';
              return (
                <div key={k} className={isBool ? 'sm:col-span-2' : ''}>
                  <Field label={label} hint={hint}>
                    {isBool ? (
                      <div className="pt-1">
                        <Toggle
                          checked={
                            edits[k] !== undefined
                              ? Boolean(edits[k])
                              : Boolean(data[k])
                          }
                          onChange={(v) => setEdits((ed) => ({ ...ed, [k]: v }))}
                        />
                      </div>
                    ) : (
                      <TextInput
                        key={`${k}-${String(data[k])}`}
                        defaultValue={String(data[k] ?? '')}
                        onChange={(e) =>
                          setEdits((ed) => ({ ...ed, [k]: e.target.value }))
                        }
                        className="t-num-md"
                      />
                    )}
                  </Field>
                </div>
              );
            })}
          </div>
        </Card>
      ))}
      <div className="flex items-center gap-3">
        <ActionBtn
          tone="solid"
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
        >
          <Icon name="check" size={14} /> Save settings
        </ActionBtn>
        {dirty && (
          <span className="t-label-sm text-gold">
            {Object.keys(edits).length} unsaved change(s)
          </span>
        )}
      </div>
    </div>
  );
}

// ── AUDIT LOG ──────────────────────────────────────────────────────────────
interface AuditRow {
  id: string;
  adminId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  createdAt: string;
}
export function AuditLogPanel() {
  const { data } = useQuery({
    queryKey: ['panel-audit'],
    queryFn: () => http.get<{ data: AuditRow[] }>('/panel/audit-log?page=1'),
  });
  const cols: Column<AuditRow>[] = [
    {
      key: 'time',
      header: 'When',
      render: (r) => (
        <span className="t-label-sm text-muted">
          {new Date(r.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'admin',
      header: 'Admin',
      render: (r) => <span className="t-mono t-label-sm">{r.adminId.slice(0, 8)}</span>,
    },
    {
      key: 'action',
      header: 'Action',
      render: (r) => (
        <Badge
          color={
            r.action.includes('reject')
              ? 'red'
              : r.action.includes('delete')
                ? 'red'
                : r.action.includes('create')
                  ? 'green'
                  : 'gold'
          }
        >
          {r.action}
        </Badge>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      render: (r) => (
        <span className="t-label-sm text-secondary">
          {r.targetType} {r.targetId ? `#${r.targetId.slice(0, 8)}` : ''}
        </span>
      ),
    },
  ];
  return <AdminTable columns={cols} rows={data?.data ?? []} empty="No audit entries" />;
}

// ── BROADCASTS ─────────────────────────────────────────────────────────────
export function BroadcastsPanel() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [actionUrl, setActionUrl] = useState('');
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () =>
      http.post('/panel/broadcasts', {
        title,
        body,
        actionUrl: actionUrl || undefined,
      }),
    onSuccess: () => {
      notify.success('Broadcast sent to all players');
      setTitle('');
      setBody('');
      setActionUrl('');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  return (
    <Card className="max-w-lg">
      <CardHead
        title="Send a broadcast"
        icon="broadcast"
        right={
          <span className="t-label-sm text-muted">pushes to every player's bell</span>
        }
      />
      <div className="space-y-3">
        <Field label="Title">
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Weekend 10% rakeback!"
          />
        </Field>
        <Field label="Message">
          <TextArea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Message body…"
          />
        </Field>
        <Field label="Action URL (optional)">
          <TextInput
            value={actionUrl}
            onChange={(e) => setActionUrl(e.target.value)}
            placeholder="/wallet"
          />
        </Field>
        <ActionBtn tone="gold" onClick={() => send.mutate()} disabled={!title || !body}>
          <Icon name="broadcast" size={14} /> Send broadcast
        </ActionBtn>
      </div>
    </Card>
  );
}

// ── SUPPORT INBOX (extracted — live admin socket, tabs, player rail) ──────
export { SupportInbox } from './SupportInbox';

// ── LEGAL PAGES EDITOR ─────────────────────────────────────────────────────
export function LegalEditor() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['panel-legal'],
    queryFn: () =>
      http.get<Array<{ slug: string; title: string; content: string }>>('/panel/legal'),
  });
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const save = useMutation({
    mutationFn: () => http.put(`/panel/legal/${sel}`, { content }),
    onSuccess: () => {
      notify.success('Page saved');
      qc.invalidateQueries({ queryKey: ['panel-legal'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  return (
    <div className="grid lg:grid-cols-[240px_1fr] gap-6">
      <div className="space-y-1.5">
        {(data ?? []).map((p) => (
          <button
            key={p.slug}
            onClick={() => {
              setSel(p.slug);
              setContent(p.content);
            }}
            className={`w-full text-left px-3 py-2 rounded-lg t-label-md ${sel === p.slug ? 'bg-gold/10 text-gold' : 'text-secondary hover:bg-white/4'}`}
          >
            {p.title}
          </button>
        ))}
      </div>
      {sel && (
        <div className="space-y-3">
          <TextArea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={18}
            className="font-mono text-sm"
          />
          <ActionBtn tone="gold" onClick={() => save.mutate()}>
            <Icon name="check" size={14} /> Save page
          </ActionBtn>
        </div>
      )}
    </div>
  );
}

// ── FRAUD SIGNALS (docs/20 §18) ────────────────────────────────────────────
interface FraudRow {
  id: string;
  userId: string;
  signal: string;
  severity: string;
  status: string;
  data: unknown;
  notes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  userPhone: string | null;
  userName: string | null;
  userStatus: string | null;
}
export function FraudSignalsPanel() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('new');
  const [sel, setSel] = useState<FraudRow | null>(null);
  const [notes, setNotes] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['panel-fraud', status, page],
    queryFn: () =>
      http.get<{ data: FraudRow[]; total: number }>(
        `/panel/fraud-signals?status=${encodeURIComponent(status)}&page=${page}`
      ),
  });
  const review = useMutation({
    mutationFn: ({
      id,
      st,
      notes: n,
    }: {
      id: string;
      st: 'reviewed' | 'ignored';
      notes?: string;
    }) => http.patch(`/panel/fraud-signals/${id}`, { status: st, notes: n }),
    onSuccess: () => {
      notify.success('Signal updated');
      setSel(null);
      setNotes('');
      qc.invalidateQueries({ queryKey: ['panel-fraud'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const rows = data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: 'new', label: 'New' },
            { value: 'reviewed', label: 'Reviewed' },
            { value: 'ignored', label: 'Ignored' },
            { value: 'all', label: 'All' },
          ]}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
        {data && (
          <span className="t-label-sm text-muted ml-auto">{data.total} signals</span>
        )}
      </div>
      <AdminTable
        columns={[
          {
            key: 'when',
            header: 'When',
            render: (r) => (
              <span className="t-label-sm text-muted">
                {new Date(r.createdAt).toLocaleString()}
              </span>
            ),
          },
          {
            key: 'player',
            header: 'Player',
            render: (r) => (
              <div>
                <p className="t-label-md text-white/85">
                  {r.userName || r.userPhone || r.userId.slice(0, 8)}
                </p>
                <p className="t-mono t-label-sm text-muted">
                  {r.userPhone || r.userId}
                </p>
              </div>
            ),
          },
          {
            key: 'signal',
            header: 'Signal',
            render: (r) => (
              <Badge
                color={
                  r.severity === 'high'
                    ? 'red'
                    : r.severity === 'medium'
                      ? 'orange'
                      : 'white'
                }
              >
                {r.signal.replace(/_/g, ' ')}
              </Badge>
            ),
          },
          {
            key: 'sev',
            header: 'Severity',
            render: (r) => (
              <span className="t-label-sm text-secondary">{r.severity}</span>
            ),
          },
          {
            key: 'st',
            header: 'Status',
            render: (r) => <span className="t-label-sm text-muted">{r.status}</span>,
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <ActionBtn
                size="sm"
                onClick={() => {
                  setSel(r);
                  setNotes(r.notes || '');
                }}
              >
                Review
              </ActionBtn>
            ),
          },
        ]}
        rows={rows}
        loading={isLoading}
        empty="No fraud signals in this view"
      />
      {data && (
        <Pagination
          page={page}
          totalPages={Math.max(1, Math.ceil(data.total / 25))}
          onPage={setPage}
        />
      )}
      {sel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-layer-surface border border-white/10 p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="t-label-lg text-white/90">
                  {sel.signal.replace(/_/g, ' ')}
                </p>
                <p className="t-label-sm text-muted">
                  {sel.userName || sel.userPhone} · {sel.userPhone} · {sel.userStatus}
                </p>
                <p className="t-mono t-label-sm text-muted">{sel.userId}</p>
              </div>
              <button
                type="button"
                className="h-8 w-8 rounded-lg bg-white/5 text-white/60"
                onClick={() => setSel(null)}
              >
                ×
              </button>
            </div>
            <pre className="text-xs text-white/70 bg-black/30 rounded-lg p-3 overflow-auto max-h-40">
              {JSON.stringify(sel.data ?? {}, null, 2)}
            </pre>
            <Field label="Review notes">
              <TextArea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="What you found…"
              />
            </Field>
            <div className="flex gap-2">
              <ActionBtn
                tone="primary"
                disabled={review.isPending}
                onClick={() =>
                  review.mutate({
                    id: sel.id,
                    st: 'reviewed',
                    notes: notes.trim() || undefined,
                  })
                }
              >
                Mark reviewed
              </ActionBtn>
              <ActionBtn
                disabled={review.isPending}
                onClick={() =>
                  review.mutate({
                    id: sel.id,
                    st: 'ignored',
                    notes: notes.trim() || undefined,
                  })
                }
              >
                Ignore
              </ActionBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── REPORTS (docs/20 §20) ──────────────────────────────────────────────────
const REPORT_TYPES = [
  { value: 'revenue', label: 'Revenue (GGR)' },
  { value: 'games', label: 'Game performance' },
  { value: 'players', label: 'Top players' },
  { value: 'deposits', label: 'Deposits' },
  { value: 'transactions', label: 'Transactions' },
];
export function ReportsPanel() {
  const [type, setType] = useState('revenue');
  const [from, setFrom] = useState(
    new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
  );
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const { data } = useQuery({
    queryKey: ['panel-report', type, from, to],
    queryFn: () =>
      http.get<Array<Record<string, unknown>>>(
        `/panel/reports/preview?type=${type}&from=${from}&to=${to}`
      ),
  });
  const rows = data ?? [];
  const download = () =>
    window.open(
      `/api/v1/panel/reports/download?type=${type}&from=${from}&to=${to}`,
      '_blank',
      'noopener,noreferrer'
    );
  const revData =
    type === 'revenue'
      ? rows.map((r) => ({
          label: String(r.date).slice(5),
          value: Number(r.wagered),
          value2: Number(r.paid_out),
        }))
      : [];
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            options={REPORT_TYPES}
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-52"
          />
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
          <ActionBtn tone="solid" onClick={download}>
            <Icon name="reports" size={14} /> Download CSV
          </ActionBtn>
        </div>
      </Card>
      {type === 'revenue' && revData.length > 0 && (
        <Card>
          <CardHead
            title="Daily wagered vs paid out"
            icon="chart"
            right={
              <div className="flex items-center gap-3 t-label-sm text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-gold inline-block" /> Wagered
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-white/30 inline-block" /> Paid
                  out
                </span>
              </div>
            }
          />
          <BarChart data={revData} height={190} />
        </Card>
      )}
      {rows.length > 0 && (
        <div className="rounded-xl overflow-hidden border border-white/8 bg-layer-surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/5">
                {Object.keys(rows[0]!).map((k) => (
                  <th
                    key={k}
                    className="px-3 py-2.5 text-left t-label-sm uppercase tracking-wide text-muted font-medium whitespace-nowrap"
                  >
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((row, i) => (
                <tr key={i} className="hover:bg-white/2">
                  {Object.values(row).map((v, j) => (
                    <td key={j} className="px-3 py-2 t-num-sm text-white/75">
                      {String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && (
        <p className="text-center py-10 t-label-sm text-muted">
          No data for this period
        </p>
      )}
    </div>
  );
}
