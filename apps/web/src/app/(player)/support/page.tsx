// apps/web/src/app/(player)/support/page.tsx — full support desk (slice 1).
'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../../lib/api';
import { socket } from '../../../lib/app';
import { useAuthStore } from '../../../stores';
import { Skeleton } from '../../../components/ui';
import { notify } from '../../../lib/toast';
import { t, detectLang } from '../../../lib/i18n';
import {
  SUPPORT_CATEGORIES,
  ClosedBanner,
  MessageBubble,
  ThreadComposer,
  isClosed,
  topicIcon,
  topicLabel,
  type SupportConvo,
  type SupportMsg,
} from '../../../components/support/thread';
import {
  isSupportCategory,
  isSupportReferenceType,
  type SupportCategoryId,
} from '@casino/shared';
import { FaqList } from '../../../components/support/FaqList';

export default function SupportPage() {
  return (
    <Suspense
      fallback={
        <div className="px-4 py-6 max-w-2xl mx-auto">
          <Skeleton className="h-64" />
        </div>
      }
    >
      <SupportDesk />
    </Suspense>
  );
}

function SupportDesk() {
  const user = useAuthStore((s) => s.user);
  const lang = detectLang(user?.language);
  const tr = (k: string) => t(lang, k);
  const qc = useQueryClient();
  const sp = useSearchParams();
  const [sel, setSel] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [messages, setMessages] = useState<SupportMsg[]>([]);
  const [typing, setTyping] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const joinedRef = useRef<string | null>(null);
  const deepLinked = useRef(false);

  const { data: convos, isLoading } = useQuery({
    queryKey: ['support-convos'],
    queryFn: () => http.get<SupportConvo[]>('/support/conversations'),
    enabled: !!user,
  });

  const selected = useMemo(
    () => convos?.find((c) => c.id === sel) ?? null,
    [convos, sel]
  );

  useEffect(() => {
    if (!sel && convos && convos.length > 0 && !picking && !deepLinked.current) {
      const open = convos.find((c) => !isClosed(c.status));
      setSel((open ?? convos[0]!).id);
    }
  }, [convos, sel, picking]);

  const startConvo = async (opts: {
    category: SupportCategoryId;
    referenceType?: string;
    referenceId?: string;
    message?: string;
  }) => {
    try {
      const created = await http.post<{ id: string; reused?: boolean }>(
        '/support/conversations',
        {
          category: opts.category,
          referenceType: opts.referenceType,
          referenceId: opts.referenceId,
          message: opts.message,
        }
      );
      setSel(created.id);
      setMessages([]);
      setPicking(false);
      qc.invalidateQueries({ queryKey: ['support-convos'] });
    } catch (e) {
      notify.error((e as Error).message);
    }
  };

  useEffect(() => {
    if (!user || deepLinked.current) return;
    const topic = sp.get('topic');
    const refType = sp.get('refType');
    const refId = sp.get('refId');
    if (!topic && !refId) return;
    deepLinked.current = true;
    const category: SupportCategoryId = isSupportCategory(topic)
      ? topic
      : topic === 'withdraw'
        ? 'withdrawal'
        : 'deposit';
    const referenceType = isSupportReferenceType(refType)
      ? refType
      : category === 'withdrawal'
        ? 'withdrawal'
        : category === 'deposit'
          ? 'deposit'
          : undefined;
    const label =
      category === 'withdrawal'
        ? tr('support.cat_withdrawal')
        : tr('support.cat_deposit');
    void startConvo({
      category,
      referenceType,
      referenceId: refId ?? undefined,
      message: refId
        ? `${tr('support.needHelp')} ${label} #${refId.slice(0, 10)}`
        : undefined,
    });
  }, [user, sp]);

  useEffect(() => {
    if (!sel) return;
    if (joinedRef.current !== sel) {
      joinedRef.current = sel;
      socket.emit('chat:join', { conversationId: sel });
    }
    let alive = true;
    void http
      .get<SupportMsg[]>(`/support/conversations/${sel}/messages`)
      .then((m) => {
        if (alive) setMessages(m);
      })
      .catch(() => {});
    const onMessage = (p: { conversationId: string; message: SupportMsg }) => {
      if (p.conversationId !== sel) return;
      setMessages((m) =>
        m.some((x) => x.id === p.message.id) ? m : [...m, p.message]
      );
    };
    const onTyping = (p: { conversationId: string; from?: string }) => {
      if (p.conversationId === sel && p.from !== 'USER') {
        setTyping(tr('support.supportTyping'));
        setTimeout(() => setTyping(null), 1500);
      }
    };
    socket.on('chat:message', onMessage);
    socket.on('chat:typing', onTyping);
    return () => {
      alive = false;
      socket.off('chat:message', onMessage);
      socket.off('chat:typing', onTyping);
    };
  }, [sel, lang]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  if (!user) {
    return (
      <div className="px-4 py-6 max-w-md mx-auto">
        <h1 className="t-title text-primary mb-4">{tr('support.title')}</h1>
        <FaqList lang={lang} title={tr('support.faqTitle')} />
        <div className="rounded-2xl bg-layer-surface border border-white/8 p-6 text-center">
          <p className="text-3xl mb-3">💬</p>
          <h2 className="t-label-xl text-primary mb-2">{tr('support.chatWithTeam')}</h2>
          <p className="t-body text-secondary mb-6">{tr('support.loginToChat')}</p>
          <div className="flex gap-2">
            <a href="/login" className="btn-primary flex-1">
              {tr('support.logIn')}
            </a>
            <a href="/signup" className="btn-outline-gold flex-1">
              {tr('support.signUp')}
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading)
    return (
      <div className="px-4 py-6 max-w-2xl mx-auto">
        <Skeleton className="h-64" />
      </div>
    );

  const showPicker = picking || (!convos?.length && !sel);

  return (
    <div className="px-4 py-6 max-w-2xl mx-auto">
      <FaqList lang={lang} title={tr('support.faqTitle')} />
      <p className="t-label-sm text-muted mb-4">{tr('support.faqStillNeed')}</p>

      <div className="flex items-center justify-between mb-4">
        <h1 className="t-title text-primary">{tr('support.title')}</h1>
        {!!convos?.length && (
          <button
            type="button"
            onClick={() => {
              setPicking(true);
              setSel(null);
            }}
            className="h-10 px-3 rounded-lg border border-gold/30 bg-gold/10 t-label-md text-gold"
          >
            + {tr('support.newConversation')}
          </button>
        )}
      </div>

      {showPicker ? (
        <div className="rounded-2xl bg-layer-surface border border-gold/20 p-6 text-center">
          <p className="text-3xl mb-2">👋</p>
          <p className="t-label-xl text-primary mb-1">{tr('support.howCanWeHelp')}</p>
          <p className="t-body text-secondary mb-5">{tr('support.chooseTopic')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {SUPPORT_CATEGORIES.map((r) => (
              <button
                key={r.id}
                onClick={() => void startConvo({ category: r.id })}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-white/10 bg-layer-elevated hover:border-gold/50 hover:bg-gold/5 transition-all py-4 active:scale-95"
              >
                <span className="text-2xl">{r.icon}</span>
                <span className="t-label-sm text-white/80">
                  {tr(`support.cat_${r.id}`)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-[240px_1fr] gap-4">
          <div className="space-y-2 md:max-h-[60dvh] md:overflow-y-auto">
            {convos?.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setSel(c.id);
                  setPicking(false);
                }}
                className={`w-full text-left rounded-xl border p-3 ${sel === c.id ? 'border-gold/40 bg-gold/5' : 'border-white/8 bg-layer-surface hover:bg-white/3'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="t-label-md text-primary truncate">
                    {topicIcon(c.category)} {topicLabel(c.category, c.subject)}
                  </p>
                  {!!c.unreadCount && (
                    <span className="min-w-5 h-5 px-1 rounded-full bg-red text-white text-[10px] font-bold text-center">
                      {c.unreadCount}
                    </span>
                  )}
                </div>
                <p className="t-label-sm text-muted mt-0.5 truncate">
                  {isClosed(c.status) ? tr('support.closed') : c.status} ·{' '}
                  {c.lastMessage?.body || new Date(c.updatedAt).toLocaleString()}
                </p>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-white/8 bg-layer-surface flex flex-col h-[60dvh]">
            <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <p className="t-label-sm text-muted text-center pt-8">
                  {tr('support.noMessages')}
                </p>
              )}
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} mine={m.senderType === 'USER'} />
              ))}
              {typing && <p className="t-label-sm text-muted">{typing}</p>}
            </div>
            {isClosed(selected?.status) && <ClosedBanner t={tr} />}
            {sel && (
              <ThreadComposer
                conversationId={sel}
                closed={isClosed(selected?.status)}
                placeholder={tr('support.typeMessage')}
                sendLabel={tr('support.send')}
                attachLabel={tr('support.attachPhoto')}
                onOptimistic={(temp) => setMessages((m) => [...m, temp])}
                onConfirm={(tempId, real) =>
                  setMessages((m) => {
                    const next = m.filter((x) => x.id !== tempId);
                    return next.some((x) => x.id === real.id) ? next : [...next, real];
                  })
                }
                onFail={(tempId) =>
                  setMessages((m) => m.filter((x) => x.id !== tempId))
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
