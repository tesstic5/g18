// apps/web/src/components/admin/SupportInbox.tsx — live agent desk (slice 1).
'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';
import { useAdminNotifs } from './notifications';
import { ActionBtn, Badge, Pagination, Segmented, TextInput, fmt } from './ui';

interface LastMsg {
  body: string;
  senderType: 'USER' | 'ADMIN';
  createdAt: string;
}

interface InboxRow {
  id: string;
  userId: string;
  subject?: string | null;
  category?: string | null;
  status: string;
  assignedTo?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  updatedAt: string;
  createdAt: string;
  userPhone?: string | null;
  userName?: string | null;
  lastMessage?: LastMsg | null;
  unreadCount: number;
  waitMs: number;
}

interface TicketMsg {
  id: string;
  senderType: string;
  body: string;
  attachmentUrl?: string | null;
  attachmentViewUrl?: string | null;
  createdAt: string;
}

interface PlayerCtx {
  id?: string;
  displayName?: string | null;
  phone?: string | null;
  status?: string;
  kycStatus?: string;
  createdAt?: string;
  wallet: { real: string; bonus: string; gifted: string; locked: string };
  deposits: Array<{
    id: string;
    amount: string;
    status: string;
    referenceNumber?: string | null;
    createdAt: string;
  }>;
  withdrawals: Array<{
    id: string;
    amount: string;
    netAmount: string;
    status: string;
    createdAt: string;
  }>;
  fraudOpen: number;
}

interface TicketDetail {
  id: string;
  userId: string;
  subject?: string | null;
  category?: string | null;
  status: string;
  assignedTo?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  createdAt: string;
  updatedAt: string;
  player: PlayerCtx;
}

function formatWait(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

export function SupportInbox() {
  const qc = useQueryClient();
  const { socket, clear } = useAdminNotifs();
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [typing, setTyping] = useState(false);
  const [liveMsgs, setLiveMsgs] = useState<TicketMsg[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const joinedRef = useRef<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setQ(search);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['panel-support', tab, q, page],
    queryFn: () =>
      http.get<{ data: InboxRow[]; total: number }>(
        `/panel/support/conversations?tab=${encodeURIComponent(tab)}&search=${encodeURIComponent(q)}&page=${page}`
      ),
  });

  const { data: detail } = useQuery({
    queryKey: ['panel-support-detail', sel],
    queryFn: () => http.get<TicketDetail>(`/panel/support/conversations/${sel}`),
    enabled: !!sel,
  });

  const { data: fetchedMsgs } = useQuery({
    queryKey: ['panel-support-msgs', sel],
    queryFn: () =>
      http.get<TicketMsg[]>(`/panel/support/conversations/${sel}/messages`),
    enabled: !!sel,
  });

  const fetchedRef = useRef(fetchedMsgs);
  fetchedRef.current = fetchedMsgs;
  const msgs = liveMsgs ?? fetchedMsgs ?? [];

  useEffect(() => {
    setLiveMsgs(null);
  }, [sel]);

  useEffect(() => {
    if (sel) clear('support');
  }, [sel, clear]);

  // Join the ticket room on the admin socket (not the player socket).
  useEffect(() => {
    if (!socket || !sel) return;
    const join = () => {
      socket.emit(
        'chat:join',
        { conversationId: sel },
        (r: { ok?: boolean; error?: string } | undefined) => {
          if (r && r.ok === false) notify.error(r.error || 'Could not join live chat');
        }
      );
      joinedRef.current = sel;
    };
    join();
    const onConnect = () => join();
    const onMsg = (p: { conversationId: string; message: TicketMsg }) => {
      if (p.conversationId !== sel) {
        qc.invalidateQueries({ queryKey: ['panel-support'] });
        return;
      }
      setLiveMsgs((cur) => {
        const base = cur ?? fetchedRef.current ?? [];
        return base.some((x) => x.id === p.message.id) ? base : [...base, p.message];
      });
      qc.invalidateQueries({ queryKey: ['panel-support'] });
    };
    const onTyping = (p: { conversationId: string; from?: string }) => {
      if (p.conversationId === sel && p.from !== 'ADMIN') {
        setTyping(true);
        window.setTimeout(() => setTyping(false), 1500);
      }
    };
    const onAdminPing = () => {
      qc.invalidateQueries({ queryKey: ['panel-support'] });
    };
    socket.on('connect', onConnect);
    socket.on('chat:message', onMsg);
    socket.on('chat:typing', onTyping);
    socket.on('admin:chat-message', onAdminPing);
    return () => {
      socket.off('connect', onConnect);
      socket.off('chat:message', onMsg);
      socket.off('chat:typing', onTyping);
      socket.off('admin:chat-message', onAdminPing);
    };
  }, [socket, sel, qc]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, typing]);

  const sendViaHttp = async (body: string) => {
    const real = await http.post<TicketMsg>(
      `/panel/support/conversations/${sel}/reply`,
      { message: body }
    );
    setLiveMsgs((cur) => {
      const base = cur ?? fetchedMsgs ?? [];
      return base.some((x) => x.id === real.id) ? base : [...base, real];
    });
  };

  const replyMut = useMutation({
    mutationFn: async () => {
      const body = reply.trim();
      if (!body || !sel) return;
      setReply('');
      if (socket?.connected) {
        const ack = await new Promise<{
          ok?: boolean;
          message?: TicketMsg;
          error?: string;
        }>((resolve) => {
          const t = window.setTimeout(
            () => resolve({ ok: false, error: 'timeout' }),
            2500
          );
          socket.emit(
            'chat:send',
            { conversationId: sel, message: body },
            (r: { ok?: boolean; message?: TicketMsg; error?: string } | undefined) => {
              window.clearTimeout(t);
              resolve(r ?? { ok: false });
            }
          );
        });
        if (ack.ok && ack.message) {
          setLiveMsgs((cur) => {
            const base = cur ?? fetchedRef.current ?? [];
            return base.some((x) => x.id === ack.message!.id)
              ? base
              : [...base, ack.message!];
          });
          return;
        }
        if (ack.error === 'timeout') {
          notify.error('Send timed out — try again');
          return;
        }
      }
      await sendViaHttp(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['panel-support'] });
      qc.invalidateQueries({ queryKey: ['panel-support-msgs', sel] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const update = useMutation({
    mutationFn: (body: { status?: string }) =>
      http.patch(`/panel/support/conversations/${sel}`, body),
    onSuccess: () => {
      notify.success('Updated');
      qc.invalidateQueries({ queryKey: ['panel-support'] });
      qc.invalidateQueries({ queryKey: ['panel-support-detail', sel] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const closed = detail?.status === 'CLOSED';

  const waitLabel = useMemo(() => {
    const row = rows.find((r) => r.id === sel);
    return row ? formatWait(row.waitMs) : '';
  }, [rows, sel]);

  return (
    <div className="grid lg:grid-cols-[minmax(280px,360px)_1fr_260px] gap-4">
      <div className="space-y-3">
        <Segmented
          options={[
            { value: 'active', label: 'Open' },
            { value: 'mine', label: 'Assigned to me' },
            { value: 'closed', label: 'Closed' },
          ]}
          value={tab}
          onChange={(v) => {
            setTab(v);
            setPage(1);
            setSel(null);
          }}
        />
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search phone, name, subject…"
        />
        {isLoading && (
          <p className="t-label-sm text-muted py-6 text-center">Loading…</p>
        )}
        {rows.map((c) => (
          <button
            key={c.id}
            onClick={() => setSel(c.id)}
            className={`w-full text-left rounded-xl border p-3 ${sel === c.id ? 'border-gold/40 bg-gold/5' : 'border-white/8 bg-layer-surface hover:bg-white/3'}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="t-label-lg text-primary truncate">
                {c.subject || c.category || 'General'}
              </p>
              <div className="flex items-center gap-1 shrink-0">
                {c.unreadCount > 0 && (
                  <span className="min-w-5 h-5 px-1 rounded-full bg-red text-white text-[10px] font-bold text-center">
                    {c.unreadCount}
                  </span>
                )}
                <Badge
                  color={
                    c.status === 'OPEN'
                      ? 'orange'
                      : c.status === 'ASSIGNED'
                        ? 'sky'
                        : 'white'
                  }
                >
                  {c.status}
                </Badge>
              </div>
            </div>
            <p className="t-label-sm text-muted mt-1 truncate">
              {c.userName || c.userPhone || c.userId.slice(0, 8)}
              {c.lastMessage?.body ? ` · ${c.lastMessage.body}` : ''}
            </p>
            <p className="t-label-sm text-muted mt-0.5">
              {c.waitMs > 0
                ? `Waiting ${formatWait(c.waitMs)}`
                : new Date(c.updatedAt).toLocaleString()}
            </p>
          </button>
        ))}
        {rows.length === 0 && !isLoading && (
          <p className="py-10 text-center t-label-sm text-muted">No conversations</p>
        )}
        {total > 40 && (
          <Pagination
            page={page}
            totalPages={Math.max(1, Math.ceil(total / 40))}
            onPage={setPage}
          />
        )}
      </div>

      {sel ? (
        <div className="rounded-xl border border-white/8 bg-layer-surface p-4 flex flex-col min-h-[520px]">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div>
              <p className="t-label-lg text-primary">
                {detail?.subject || detail?.category || 'Conversation'}
              </p>
              {waitLabel && (
                <p className="t-label-sm text-orange">Player waiting {waitLabel}</p>
              )}
            </div>
            <div className="flex gap-2">
              {!closed && (
                <ActionBtn
                  size="sm"
                  tone="gold"
                  onClick={() => update.mutate({ status: 'ASSIGNED' })}
                >
                  Assign to me
                </ActionBtn>
              )}
              {!closed && (
                <ActionBtn
                  size="sm"
                  tone="danger"
                  onClick={() => update.mutate({ status: 'CLOSED' })}
                >
                  Close
                </ActionBtn>
              )}
            </div>
          </div>
          <div
            ref={scrollRef}
            className="flex-1 space-y-2 overflow-y-auto max-h-[52vh] pr-1"
          >
            {msgs.map((m) => {
              const src = m.attachmentViewUrl;
              return (
                <div
                  key={m.id}
                  className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${m.senderType === 'USER' ? 'ml-auto bg-gold/15 text-white/90' : 'bg-layer-elevated text-white/70'}`}
                >
                  <p className="t-label-sm text-muted mb-0.5">
                    {m.senderType === 'USER' ? 'Player' : 'You'} ·{' '}
                    {new Date(m.createdAt).toLocaleTimeString()}
                  </p>
                  {src && (
                    <a
                      href={src}
                      target="_blank"
                      rel="noreferrer"
                      className="block mb-1"
                    >
                      <img
                        src={src}
                        alt=""
                        className="max-h-36 rounded-lg object-contain"
                      />
                    </a>
                  )}
                  {m.body}
                </div>
              );
            })}
            {msgs.length === 0 && (
              <p className="text-center t-label-sm text-muted py-6">No messages yet</p>
            )}
            {typing && <p className="t-label-sm text-muted">Player is typing…</p>}
          </div>
          {closed ? (
            <p className="t-label-sm text-muted mt-3 text-center">
              Closed — composer is off. Players open a new ticket if they still need
              help.
            </p>
          ) : (
            <div className="flex gap-2 mt-3">
              <TextInput
                value={reply}
                onChange={(e) => {
                  setReply(e.target.value);
                  socket?.emit('chat:typing', { conversationId: sel });
                }}
                placeholder="Reply…"
                onKeyDown={(e) =>
                  e.key === 'Enter' && reply.trim() && replyMut.mutate()
                }
              />
              <ActionBtn
                tone="primary"
                disabled={!reply.trim() || replyMut.isPending}
                onClick={() => replyMut.mutate()}
              >
                Send
              </ActionBtn>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-white/8 bg-layer-surface p-8 text-center t-label-sm text-muted">
          Pick a conversation
        </div>
      )}

      {sel && detail && (
        <aside className="rounded-xl border border-white/8 bg-layer-surface p-4 space-y-3 h-fit">
          <p className="t-label-lg text-primary">Player</p>
          <p className="t-label-md text-white/85">{detail.player.displayName || '—'}</p>
          <p className="t-mono t-label-sm text-muted">{detail.player.phone}</p>
          <div className="flex flex-wrap gap-1.5">
            <Badge color={detail.player.status === 'ACTIVE' ? 'green' : 'red'}>
              {detail.player.status || '—'}
            </Badge>
            <Badge color={detail.player.kycStatus === 'APPROVED' ? 'green' : 'white'}>
              KYC {detail.player.kycStatus || 'NONE'}
            </Badge>
            {detail.player.fraudOpen > 0 && (
              <Badge color="red">{detail.player.fraudOpen} fraud</Badge>
            )}
          </div>
          <div className="rounded-lg bg-layer-elevated border border-white/8 p-3 space-y-1">
            <Row k="Real" v={fmt(Number(detail.player.wallet.real))} />
            <Row k="Bonus" v={fmt(Number(detail.player.wallet.bonus))} />
            <Row k="Gifted" v={fmt(Number(detail.player.wallet.gifted))} />
            <Row k="Locked" v={fmt(Number(detail.player.wallet.locked))} />
          </div>
          {detail.referenceType && (
            <p className="t-label-sm text-gold">
              Linked {detail.referenceType} #{detail.referenceId?.slice(0, 8)}
            </p>
          )}
          <p className="t-label-sm text-muted uppercase tracking-wide">Deposits</p>
          {detail.player.deposits.length === 0 && (
            <p className="t-label-sm text-muted">None</p>
          )}
          {detail.player.deposits.map((d) => (
            <p key={d.id} className="t-label-sm text-white/70">
              {fmt(Number(d.amount))} · {d.status}
              {d.referenceNumber ? ` · ${d.referenceNumber}` : ''}
            </p>
          ))}
          <p className="t-label-sm text-muted uppercase tracking-wide">Withdrawals</p>
          {detail.player.withdrawals.length === 0 && (
            <p className="t-label-sm text-muted">None</p>
          )}
          {detail.player.withdrawals.map((w) => (
            <p key={w.id} className="t-label-sm text-white/70">
              {fmt(Number(w.amount))} · {w.status}
            </p>
          ))}
          {detail.player.createdAt && (
            <p className="t-label-sm text-muted">
              Joined {new Date(detail.player.createdAt).toLocaleDateString()}
            </p>
          )}
        </aside>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="t-label-sm text-muted">{k}</span>
      <span className="t-num-sm text-white/80">{v}</span>
    </div>
  );
}
