// apps/web/src/app/referral-panel/page.tsx — referral agent dashboard,
// styled with the shared admin design system (stat cards, surface cards, table).
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiBaseUrl } from '../../lib/env';
import { notify } from '../../lib/toast';
import {
  Card,
  CardHead,
  PageHeader,
  StatCard,
  AdminTable,
  Badge,
  ActionBtn,
  Spinner,
  Icon,
  fmt,
  type Column,
} from '../../components/admin/ui';

const TOKEN_KEY = 'referral_agent_token';

interface DashboardUser {
  id: string;
  phone: string;
  displayName: string | null;
  joinedAt: string;
  roundsPlayed: number;
  totalDeposited: number;
  totalWagered: number;
  totalPayout: number;
  netSpend: number;
  balance: number;
}
interface Dashboard {
  inviteUrl: string;
  referralCode: string;
  totals: {
    users: number;
    roundsPlayed: number;
    totalDeposited: number;
    totalWagered: number;
    totalPayout: number;
    netSpend: number;
  };
  commissionEarned: number;
  users: DashboardUser[];
}

export default function ReferralDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      router.replace('/rlogin');
      return;
    }
    fetch(`${apiBaseUrl()}/referral-panel/dashboard`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (res.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          router.replace('/rlogin');
          return;
        }
        const json = (await res.json().catch(() => null)) as { data?: Dashboard } | null;
        if (!res.ok || !json?.data) setError('Failed to load dashboard');
        else setData(json.data);
      })
      .catch(() => setError('Network error'));
  }, [router]);

  if (error)
    return (
      <div className="min-h-screen flex items-center justify-center t-label-lg text-red">{error}</div>
    );
  if (!data)
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner label="Loading dashboard…" />
      </div>
    );

  const columns: Column<DashboardUser>[] = [
    {
      key: 'player',
      header: 'Player',
      render: (u) => (
        <span className="t-label-lg text-primary">{u.displayName || u.phone}</span>
      ),
    },
    { key: 'joined', header: 'Joined', render: (u) => new Date(u.joinedAt).toLocaleDateString() },
    { key: 'dep', header: 'Deposited', render: (u) => `₨${fmt(u.totalDeposited)}` },
    { key: 'wag', header: 'Wagered', render: (u) => `₨${fmt(u.totalWagered)}` },
    { key: 'pay', header: 'Payout', render: (u) => `₨${fmt(u.totalPayout)}` },
    {
      key: 'net',
      header: 'Net spend',
      render: (u) => (
        <Badge color={u.netSpend > 0 ? 'gold' : 'white'}>₨{fmt(u.netSpend)}</Badge>
      ),
    },
    { key: 'rounds', header: 'Rounds', render: (u) => u.roundsPlayed },
    { key: 'bal', header: 'Balance', render: (u) => `₨${fmt(u.balance)}` },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <PageHeader
        title="Referral Dashboard"
        subtitle="Everyone who signed up with your invite link"
        actions={
          <ActionBtn
            onClick={() => {
              localStorage.removeItem(TOKEN_KEY);
              router.replace('/rlogin');
            }}
          >
            <Icon name="logout" size={14} /> Log out
          </ActionBtn>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Invited users" value={String(data.totals.users)} icon="users" accent="blue" />
        <StatCard
          label="Total deposited"
          value={`₨${fmt(data.totals.totalDeposited)}`}
          icon="deposits"
          accent="green"
        />
        <StatCard
          label="Total wagered"
          value={`₨${fmt(data.totals.totalWagered)}`}
          icon="coins"
          accent="gold"
        />
        <StatCard
          label="Commission earned"
          value={`₨${fmt(data.commissionEarned)}`}
          icon="trophy"
          accent="violet"
          hint="paid daily"
        />
      </div>

      <Card className="mb-4">
        <CardHead title="Your invite link" icon="gift" />
        <div className="flex gap-2 flex-wrap">
          <input
            readOnly
            value={data.inviteUrl}
            className="flex-1 min-w-[240px] rounded-lg bg-layer-elevated border border-white/8 px-3 py-2 t-label-md text-secondary"
          />
          <ActionBtn
            tone="gold"
            onClick={() => {
              void navigator.clipboard?.writeText(data.inviteUrl);
              notify.success('Invite link copied');
            }}
          >
            <Icon name="check" size={14} /> Copy link
          </ActionBtn>
        </div>
        <p className="t-label-sm text-muted mt-2">
          Code <span className="text-gold font-mono">{data.referralCode}</span> — signups via
          this link are locked to your account and cannot be changed.
        </p>
      </Card>

      <Card pad={false}>
        <AdminTable columns={columns} rows={data.users} rowKey={(u) => u.id} />
        {data.users.length === 0 && (
          <p className="t-label-md text-muted text-center py-8">
            No invited users yet — share your link to get started.
          </p>
        )}
      </Card>
    </div>
  );
}
