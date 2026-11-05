// apps/web/src/components/support/ChatWidget.tsx — live support bubble (slice 1).
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { socket } from '../../lib/app';
import { useAuthStore } from '../../stores';
import { notify } from '../../lib/toast';
import { t, detectLang } from '../../lib/i18n';
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
} from './thread';
import type { SupportCategoryId } from '@casino/shared';
import { FaqList } from './FaqList';

const PANEL_W = 380;
const PANEL_H = 500;

export function ChatWidget() {
  const user = useAuthStore((s) => s.user);
  const lang = detectLang(user?.language);
  const tr = (k: string) => t(lang, k);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [messages, setMessages] = useState<SupportMsg[]>([]);
  const [typing, setTyping] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const joinedRef = useRef<string | null>(null);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null
  );
  const didDrag = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) didDrag.current = true;
    if (didDrag.current) {
      const vw = window.innerWidth,
        vh = window.innerHeight;
      setPos({
        x: Math.min(Math.max(8, d.ox + dx), vw - 60),
        y: Math.min(Math.max(8, d.oy + dy), vh - 60),
      });
    }
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };
  const onBubbleClick = () => {
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    setOpen((o) => {
      const n = !o;
      if (n) setUnread(0);
      return n;
    });
  };

  const { data: convos } = useQuery({
    queryKey: ['support-convos'],
    queryFn: () => http.get<SupportConvo[]>('/support/conversations'),
    enabled: open && !!user,
  });

  const selected = useMemo(
    () => convos?.find((c) => c.id === sel) ?? null,
    [convos, sel]
  );

  const startConvo = async (category: SupportCategoryId) => {
    try {
      const created = await http.post<{ id: string }>('/support/conversations', {
        category,
      });
      setSel(created.id);
      setMessages([]);
      setPicking(false);
      qc.invalidateQueries({ queryKey: ['support-convos'] });
    } catch (e) {
      notify.error((e as Error).message);
    }
  };

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
      if (!open) setUnread((u) => u + 1);
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
  }, [sel, open, lang]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const showPicker = !!user && (picking || ((!convos || convos.length === 0) && !sel));
  const showList = !!user && !showPicker && !sel && (convos?.length ?? 0) > 0;

  return (
    <>
      <button
        aria-label={tr('support.title')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onBubbleClick}
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        className="fixed bottom-[84px] right-4 z-[120] w-[52px] h-[52px] rounded-full bg-gold shadow-[0_4px_20px_rgba(245,200,66,0.4)] flex items-center justify-center text-[#003d20] cursor-grab active:cursor-grabbing touch-none select-none"
      >
        💬
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red text-white text-[10px] font-bold flex items-center justify-center">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed z-[121] flex flex-col bg-layer-elevated rounded-2xl border border-white/10 shadow-[0_16px_48px_rgba(0,0,0,0.5)] overflow-hidden"
          style={{
            width: `min(92vw, ${PANEL_W}px)`,
            height: `min(70dvh, ${PANEL_H}px)`,
            ...(pos
              ? {
                  left: Math.max(4, Math.min(pos.x, window.innerWidth - PANEL_W - 8)),
                  top: Math.max(
                    4,
                    Math.min(pos.y - PANEL_H - 12, window.innerHeight - PANEL_H - 8)
                  ),
                }
              : { right: 16, bottom: 148 }),
          }}
        >
          <div className="flex items-center justify-between px-4 h-12 bg-layer-surface border-b border-white/8 shrink-0">
            <h2 className="t-label-lg text-primary truncate">
              {selected
                ? `${topicLabel(selected.category, selected.subject)} · ${tr('support.title')}`
                : tr('support.title')}
            </h2>
            <div className="flex items-center gap-2 shrink-0">
              {sel && (
                <button
                  type="button"
                  className="t-label-sm text-white/60"
                  onClick={() => {
                    setSel(null);
                    setPicking(false);
                  }}
                >
                  ←
                </button>
              )}
              <a href="/support" className="t-label-sm text-gold/80 underline">
                {tr('support.fullPage')}
              </a>
              <button
                aria-label={tr('common.close')}
                onClick={() => setOpen(false)}
                className="w-8 h-8 rounded-full hover:bg-white/5 text-white/60"
              >
                ✕
              </button>
            </div>
          </div>

          {!user ? (
            <div className="flex-1 flex flex-col gap-3 p-4 overflow-y-auto">
              <p className="t-label-lg text-primary text-center">
                {tr('support.loginToChat')}
              </p>
              <div className="flex gap-2 justify-center">
                <a href="/login" className="btn-primary px-4">
                  {tr('support.logIn')}
                </a>
                <a href="/signup" className="btn-outline-gold px-4 h-[44px]">
                  {tr('support.signUp')}
                </a>
              </div>
              <FaqList lang={lang} title={tr('support.faqTitle')} compact />
            </div>
          ) : showPicker ? (
            <div className="flex-1 flex flex-col gap-4 p-5 overflow-y-auto">
              <div className="text-center">
                <p className="text-3xl">👋</p>
                <p className="t-label-xl text-primary">{tr('support.howCanWeHelp')}</p>
                <p className="t-label-sm text-muted">{tr('support.chooseTopic')}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 w-full">
                {SUPPORT_CATEGORIES.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => void startConvo(r.id)}
                    className="flex flex-col items-center gap-1.5 rounded-xl border border-white/10 bg-layer-surface hover:border-gold/50 hover:bg-gold/5 transition-all py-3 active:scale-95"
                  >
                    <span className="text-2xl">{r.icon}</span>
                    <span className="t-label-sm text-white/80">
                      {tr(`support.cat_${r.id}`)}
                    </span>
                  </button>
                ))}
              </div>
              <FaqList lang={lang} title={tr('support.faqTitle')} compact />
            </div>
          ) : showList ? (
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="w-full h-10 rounded-xl border border-gold/30 bg-gold/10 t-label-md text-gold"
              >
                + {tr('support.newConversation')}
              </button>
              {(convos ?? []).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSel(c.id)}
                  className="w-full text-left rounded-xl border border-white/8 bg-layer-surface p-3"
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
                    {isClosed(c.status) ? tr('support.closed') : tr('support.open')}
                    {c.lastMessage?.body ? ` · ${c.lastMessage.body}` : ''}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {messages.length === 0 && (
                  <p className="t-label-sm text-muted text-center pt-6">
                    {tr('support.usuallyMinutes')}
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
                      return next.some((x) => x.id === real.id)
                        ? next
                        : [...next, real];
                    })
                  }
                  onFail={(tempId) =>
                    setMessages((m) => m.filter((x) => x.id !== tempId))
                  }
                />
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
