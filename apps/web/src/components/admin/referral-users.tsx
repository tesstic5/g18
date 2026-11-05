// apps/web/src/components/admin/referral-users.tsx — admin panel: referral
// agent accounts. Create agents, copy their unique invite link, suspend them.
// Server enforces super-admin on every mutation.
'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';
import { AdminTable, ActionBtn, Badge, Card, CardHead, Field, TextInput, Spinner, type Column } from './ui';

interface Agent {
  id: string;
  phone: string;
  displayName: string | null;
  status: string;
  referralCode: string;
  inviteUrl: string;
  createdAt: string;
  totalReferred: number;
  commissionPaid: number;
  referralSignupBonusEnabled: boolean;
  referralSignupBonusAmount: number;
}

export function ReferralUsersPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['panel-referral-users'],
    queryFn: () => http.get<{ agents: Agent[] }>('/panel/referral-users'),
  });
  const [form, setForm] = useState({ phone: '', password: '', displayName: '' });

  const create = useMutation({
    mutationFn: () => http.post('/panel/referral-users', form),
    onSuccess: () => {
      notify.success('Referral agent created');
      qc.invalidateQueries({ queryKey: ['panel-referral-users'] });
      setForm({ phone: '', password: '', displayName: '' });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => http.post(`/panel/referral-users/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['panel-referral-users'] }),
    onError: (e) => notify.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => http.del(`/panel/referral-users/${id}`),
    onSuccess: () => {
      notify.success('Referral agent removed (login disabled)');
      qc.invalidateQueries({ queryKey: ['panel-referral-users'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const [bonusFor, setBonusFor] = useState<string | null>(null);
  const [bonusEnabled, setBonusEnabled] = useState(false);
  const [bonusAmount, setBonusAmount] = useState('0');
  const saveBonus = useMutation({
    mutationFn: (id: string) =>
      http.patch(`/panel/referral-users/${id}/bonus`, {
        enabled: bonusEnabled,
        amount: Number(bonusAmount) || 0,
      }),
    onSuccess: () => {
      notify.success('Signup bonus updated');
      setBonusFor(null);
      qc.invalidateQueries({ queryKey: ['panel-referral-users'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const resetPw = useMutation({
    mutationFn: (id: string) =>
      http.post(`/panel/referral-users/${id}/reset-password`, { password: newPassword }),
    onSuccess: () => {
      notify.success('Password reset');
      setResetFor(null);
      setNewPassword('');
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const columns: Column<Agent>[] = [
    { key: 'displayName', header: 'Agent', render: (a) => a.displayName || a.phone },
    { key: 'phone', header: 'Phone', render: (a) => a.phone },
    {
      key: 'inviteUrl',
      header: 'Invite link',
      render: (a) => (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <code style={{ fontSize: 12 }}>{a.referralCode}</code>
          <ActionBtn
            onClick={() => {
              void navigator.clipboard?.writeText(a.inviteUrl);
              notify.success('Invite link copied');
            }}
          >
            Copy
          </ActionBtn>
        </span>
      ),
    },
    { key: 'totalReferred', header: 'Referred', render: (a) => a.totalReferred },
    {
      key: 'commissionPaid',
      header: 'Commission paid',
      render: (a) => `₨${a.commissionPaid.toFixed(2)}`,
    },
    {
      key: 'bonus',
      header: 'Signup bonus',
      render: (a) =>
        a.referralSignupBonusEnabled ? (
          <Badge color="gold">₨{a.referralSignupBonusAmount.toFixed(2)}</Badge>
        ) : (
          <span className="t-label-md text-muted">off</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (a) => (
        <Badge color={a.status === 'ACTIVE' ? 'green' : 'red'}>{a.status}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (a) => (
        <ActionBtn onClick={() => toggle.mutate(a.id)}>
          {a.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
        </ActionBtn>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardHead title="Add referral agent" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Phone">
            <TextInput
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="0300XXXXXXX"
            />
          </Field>
          <Field label="Password">
            <TextInput
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="min 8 chars"
            />
          </Field>
          <Field label="Name (optional)">
            <TextInput
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              placeholder="Agent Ali"
            />
          </Field>
          <ActionBtn
            onClick={() => create.mutate()}
            disabled={create.isPending || !form.phone || form.password.length < 8}
          >
            {create.isPending ? 'Creating…' : 'Create agent'}
          </ActionBtn>
        </div>
      </Card>

      {isLoading ? (
        <Spinner />
      ) : (
        <AdminTable columns={columns} rows={data?.agents ?? []} rowKey={(a) => a.id} />
      )}

      {resetFor && (
        <Card>
          <CardHead title="Reset password" />
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <Field label="New password">
              <TextInput
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="min 8 chars"
              />
            </Field>
            <ActionBtn
              disabled={newPassword.length < 8 || resetPw.isPending}
              onClick={() => resetPw.mutate(resetFor)}
            >
              Save
            </ActionBtn>
            <ActionBtn onClick={() => setResetFor(null)}>Cancel</ActionBtn>
          </div>
        </Card>
      )}
    </div>
  );
}
