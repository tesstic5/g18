// apps/web/src/components/admin/monitoring.tsx — MONITORING console.
//
// The security inventory's finding was "nothing tells anyone when something
// breaks". This is the page that answers "is anything wrong right now?": the
// watchdog's checks (services, backup freshness, stalled money queues, fraud
// spikes, key rotation), the alerts that have fired, and the queued
// dual-control approvals waiting on a second admin.
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
  Icon,
  Pagination,
  Segmented,
  Spinner,
  fmt,
  type Column,
} from './ui';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  alerted: boolean;
  severity?: string;
}
interface Overview {
  ranAt: string;
  healthy: boolean;
  checks: Check[];
  counters: Record<string, number>;
  alerts: { open: number; critical: number; high: number };
  queues: {
    awaitingSecondApproval: number;
    frozenAccounts: number;
    recoveryRequestsOpen: number;
    parkedAdjustments: number;
  };
  redis: string;
  emailAlerts: boolean;
  keyRotationPending: boolean;
}
interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  message: string;
  status: string;
  createdAt: string;
  acknowledgedBy: string | null;
}
interface AdjustmentRow {
  id: string;
  userId: string;
  userName: string | null;
  userPhone: string | null;
  walletType: string;
  amount: string;
  reason: string | null;
  status: string;
  requestedBy: string;
  requestedAt: string;
}

const SEVERITY_COLOR: Record<string, 'red' | 'orange' | 'gold' | 'white'> = {
  critical: 'red',
  high: 'orange',
  medium: 'gold',
  low: 'white',
};

const COUNTER_LABEL: Record<string, string> = {
  requests: 'Requests',
  errors5xx: 'Server errors',
  logins: 'Logins',
  loginFailures: 'Failed logins',
  withdrawalsCreated: 'Withdrawals created',
  withdrawalsHeld: 'Withdrawals held',
  rateLimited: 'Rate-limited',
  limiterFallbacks: 'Limiter fallbacks',
  alertsRaised: 'Alerts raised',
};

export function MonitoringPanel() {
  const qc = useQueryClient();
  const [alertStatus, setAlertStatus] = useState('open');
  const [page, setPage] = useState(1);

  const overview = useQuery({
    queryKey: ['panel-monitoring'],
    queryFn: () => http.get<Overview>('/panel/monitoring/overview'),
    refetchInterval: 60_000,
  });
  const alerts = useQuery({
    queryKey: ['panel-alerts', alertStatus, page],
    queryFn: () =>
      http.get<{ data: AlertRow[]; total: number }>(
        `/panel/monitoring/alerts?status=${encodeURIComponent(alertStatus)}&page=${page}`
      ),
  });
  const adjustments = useQuery({
    queryKey: ['panel-wallet-adjustments'],
    queryFn: () =>
      http.get<{ data: AdjustmentRow[]; total: number }>(
        '/panel/wallet-adjustments?status=PENDING'
      ),
  });

  const ack = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'acknowledged' | 'resolved' }) =>
      http.patch(`/panel/monitoring/alerts/${id}`, { status }),
    onSuccess: () => {
      notify.success('Alert updated');
      qc.invalidateQueries({ queryKey: ['panel-alerts'] });
      qc.invalidateQueries({ queryKey: ['panel-monitoring'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const runNow = useMutation({
    mutationFn: () => http.post('/panel/monitoring/watchdog/run'),
    onSuccess: () => {
      notify.success('Checks run');
      qc.invalidateQueries({ queryKey: ['panel-monitoring'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      http.patch(`/panel/wallet-adjustments/${id}`, { decision }),
    onSuccess: (_d, v) => {
      notify.success(v.decision === 'approve' ? 'Credit applied' : 'Request declined');
      qc.invalidateQueries({ queryKey: ['panel-wallet-adjustments'] });
      qc.invalidateQueries({ queryKey: ['panel-monitoring'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const o = overview.data;
  const rows = alerts.data?.data ?? [];
  const pendingAdjustments = adjustments.data?.data ?? [];

  const alertColumns: Column<AlertRow>[] = [
    {
      key: 'when',
      header: 'When',
      render: (r) => (
        <span className="t-label-sm text-muted">{new Date(r.createdAt).toLocaleString()}</span>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (r) => <Badge color={SEVERITY_COLOR[r.severity] ?? 'white'}>{r.severity}</Badge>,
    },
    {
      key: 'kind',
      header: 'Alert',
      render: (r) => (
        <div>
          <p className="t-mono t-label-sm text-white/85">{r.kind}</p>
          <p className="t-label-sm text-muted">{r.message}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge color={r.status === 'open' ? 'orange' : 'green'}>{r.status}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex gap-2 justify-end">
          {r.status === 'open' && (
            <>
              <ActionBtn size="sm" onClick={() => ack.mutate({ id: r.id, status: 'acknowledged' })}>
                Acknowledge
              </ActionBtn>
              <ActionBtn
                size="sm"
                tone="primary"
                onClick={() => ack.mutate({ id: r.id, status: 'resolved' })}
              >
                Resolve
              </ActionBtn>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="t-label-sm text-secondary">
          Checked {o ? new Date(o.ranAt).toLocaleTimeString() : '…'} · emails go to the backup
          recipients{o?.emailAlerts === false ? ' (SMTP not configured)' : ''} · a webhook can be
          set with ALERTS_WEBHOOK_URL
        </p>
        <span className="ml-auto">
          <ActionBtn onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            <Icon name="refresh" size={14} /> Run checks now
          </ActionBtn>
        </span>
      </div>

      {overview.isLoading && <Spinner label="Running checks…" />}

      {o && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <p className="t-label-sm text-muted">Overall</p>
              <p className={`t-title ${o.healthy ? 'text-green' : 'text-orange'}`}>
                {o.healthy ? 'Healthy' : 'Attention needed'}
              </p>
              <p className="t-label-sm text-muted mt-1">
                Redis {o.redis}
                {o.keyRotationPending ? ' · key rotation unfinished' : ''}
              </p>
            </Card>
            <Card>
              <p className="t-label-sm text-muted">Open alerts</p>
              <p className="t-title text-primary">{o.alerts.open}</p>
              <p className="t-label-sm text-muted mt-1">
                {o.alerts.critical} critical · {o.alerts.high} high
              </p>
            </Card>
            <Card>
              <p className="t-label-sm text-muted">Waiting on a second admin</p>
              <p className="t-title text-primary">{o.queues.awaitingSecondApproval}</p>
              <p className="t-label-sm text-muted mt-1">
                {o.queues.parkedAdjustments} parked credit(s)
              </p>
            </Card>
            <Card>
              <p className="t-label-sm text-muted">Recovery / freezes</p>
              <p className="t-title text-primary">{o.queues.recoveryRequestsOpen}</p>
              <p className="t-label-sm text-muted mt-1">
                {o.queues.frozenAccounts} account(s) frozen
              </p>
            </Card>
          </div>

          <Card>
            <CardHead title="Checks" icon="shield" />
            <div className="space-y-2">
              {o.checks.map((c) => (
                <div
                  key={c.name}
                  className="flex items-start gap-3 rounded-lg bg-white/5 px-3 py-2"
                >
                  <span className={`mt-0.5 ${c.ok ? 'text-green' : 'text-red'}`}>
                    {c.ok ? '✓' : '✕'}
                  </span>
                  <div className="flex-1">
                    <p className="t-label-md text-white/85">{c.name.replace(/_/g, ' ')}</p>
                    <p className="t-label-sm text-muted">{c.detail}</p>
                  </div>
                  {c.severity && <Badge color={SEVERITY_COLOR[c.severity] ?? 'white'}>{c.severity}</Badge>}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHead title="Traffic counters (since last restart)" icon="chart" />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {Object.entries(o.counters)
                .filter(([k]) => COUNTER_LABEL[k])
                .map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-white/5 px-3 py-2">
                    <p className="t-num-lg text-white/90">{v}</p>
                    <p className="t-label-sm text-muted">{COUNTER_LABEL[k]}</p>
                  </div>
                ))}
            </div>
            <p className="t-label-sm text-muted mt-2">
              Prometheus can scrape /metrics with the METRICS_TOKEN bearer (unset = endpoint
              disabled).
            </p>
          </Card>
        </>
      )}

      {pendingAdjustments.length > 0 && (
        <Card>
          <CardHead
            title={`Wallet adjustments waiting on a second admin (${pendingAdjustments.length})`}
            icon="wallet"
          />
          <p className="t-label-sm text-secondary mb-3">
            Above the dual-control threshold, a credit is parked here instead of moving money. You
            cannot clear your own request — that is the point.
          </p>
          <AdminTable
            columns={[
              {
                key: 'who',
                header: 'Player',
                render: (r) => (
                  <span className="t-label-md text-white/85">
                    {r.userName || r.userPhone || r.userId.slice(0, 8)}
                  </span>
                ),
              },
              {
                key: 'amount',
                header: 'Amount',
                render: (r) => (
                  <span className="t-label-md text-white/85">
                    {fmt(Number(r.amount))} <span className="text-muted">{r.walletType}</span>
                  </span>
                ),
              },
              { key: 'reason', header: 'Reason', render: (r) => <span className="t-label-sm text-muted">{r.reason || '—'}</span> },
              {
                key: 'requested',
                header: 'Requested',
                render: (r) => (
                  <span className="t-label-sm text-muted">
                    {new Date(r.requestedAt).toLocaleString()} · {r.requestedBy.slice(0, 8)}…
                  </span>
                ),
              },
              {
                key: 'act',
                header: '',
                render: (r) => (
                  <div className="flex gap-2 justify-end">
                    <ActionBtn
                      size="sm"
                      tone="primary"
                      onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}
                    >
                      Approve
                    </ActionBtn>
                    <ActionBtn
                      size="sm"
                      tone="danger"
                      onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}
                    >
                      Decline
                    </ActionBtn>
                  </div>
                ),
              },
            ]}
            rows={pendingAdjustments}
            dense
          />
        </Card>
      )}

      <Card>
        <CardHead title="Alerts" icon="bell" />
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Segmented
            options={[
              { value: 'open', label: 'Open' },
              { value: 'acknowledged', label: 'Acknowledged' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'all', label: 'All' },
            ]}
            value={alertStatus}
            onChange={(v) => {
              setAlertStatus(v);
              setPage(1);
            }}
          />
          {alerts.data && (
            <span className="t-label-sm text-muted ml-auto">{alerts.data.total} alerts</span>
          )}
        </div>
        <AdminTable
          columns={alertColumns}
          rows={rows}
          loading={alerts.isLoading}
          empty="No alerts — nothing has tripped the watchdog"
        />
        {alerts.data && alerts.data.total > 25 && (
          <div className="mt-3">
            <Pagination
              page={page}
              totalPages={Math.ceil(alerts.data.total / 25)}
              onPage={setPage}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
