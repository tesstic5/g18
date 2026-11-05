// apps/web/src/components/support/thread.tsx — shared player thread bits (slice 1).
'use client';
import { useRef, useState } from 'react';
import { http, uploadProof } from '../../lib/api';
import { socket } from '../../lib/app';
import { notify } from '../../lib/toast';
import { SUPPORT_CATEGORIES, type SupportCategoryId } from '@casino/shared';

export interface SupportMsg {
  id: string;
  senderType: 'USER' | 'ADMIN';
  body: string;
  attachmentUrl?: string | null;
  attachmentViewUrl?: string | null;
  createdAt: string;
}

export interface SupportConvo {
  id: string;
  subject?: string | null;
  category?: string | null;
  status: string;
  referenceType?: string | null;
  referenceId?: string | null;
  updatedAt: string;
  createdAt?: string;
  lastMessage?: {
    body: string;
    senderType: 'USER' | 'ADMIN';
    createdAt: string;
  } | null;
  unreadCount?: number;
}

export const TOPIC_LABEL: Record<SupportCategoryId, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  game: 'Game problem',
  account: 'Account / Login',
  bonus: 'Bonus / Promo',
  other: 'Other question',
};

export function topicLabel(id: string | null | undefined, subject?: string | null) {
  if (id && id in TOPIC_LABEL) return TOPIC_LABEL[id as SupportCategoryId];
  return subject || 'General';
}

export function topicIcon(id: string | null | undefined) {
  return SUPPORT_CATEGORIES.find((c) => c.id === id)?.icon ?? '💬';
}

export function isClosed(status: string | null | undefined) {
  return status === 'CLOSED';
}

export function imgSrc(m: SupportMsg): string | null {
  if (m.attachmentViewUrl) return m.attachmentViewUrl;
  if (!m.attachmentUrl) return null;
  if (m.attachmentUrl.startsWith('http') || m.attachmentUrl.startsWith('/'))
    return m.attachmentUrl;
  return null;
}

export function MessageBubble({ m, mine }: { m: SupportMsg; mine: boolean }) {
  const src = imgSrc(m);
  return (
    <div
      className={`max-w-[82%] px-3 py-2 rounded-xl text-sm ${
        mine
          ? 'ml-auto bg-gold/15 border border-gold/20 rounded-br-md'
          : 'bg-layer-floating border border-white/8 rounded-bl-md'
      }`}
    >
      {src && (
        <a href={src} target="_blank" rel="noreferrer" className="block mb-1.5">
          <img
            src={src}
            alt="Attachment"
            className="max-h-40 rounded-lg object-contain"
          />
        </a>
      )}
      {m.body ? <p className="text-white whitespace-pre-wrap">{m.body}</p> : null}
      <p className="t-label-sm text-white/30 mt-1">
        {m.senderType === 'ADMIN' ? 'Support · ' : ''}
        {new Date(m.createdAt).toLocaleTimeString()}
      </p>
    </div>
  );
}

export function ClosedBanner({ t }: { t: (k: string) => string }) {
  return (
    <div className="mx-3 mb-2 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-center">
      <p className="t-label-sm text-muted">{t('support.closedBanner')}</p>
    </div>
  );
}

type SendAck = { ok: boolean; message?: SupportMsg; error?: string } | undefined;

export async function sendSupportMessage(opts: {
  conversationId: string;
  body: string;
  file?: File | null;
  onOptimistic: (temp: SupportMsg) => void;
  onConfirm: (tempId: string, real: SupportMsg) => void;
  onFail: (tempId: string, err: string) => void;
}) {
  const text = opts.body.trim();
  let attachmentObjectKey: string | undefined;
  if (opts.file) {
    try {
      attachmentObjectKey = await uploadProof(opts.file);
    } catch (e) {
      notify.error((e as Error).message);
      return;
    }
  }
  if (!text && !attachmentObjectKey) return;
  const temp: SupportMsg = {
    id: `tmp-${Date.now()}`,
    senderType: 'USER',
    body: text,
    attachmentUrl: attachmentObjectKey ?? null,
    createdAt: new Date().toISOString(),
  };
  opts.onOptimistic(temp);

  const payload = {
    conversationId: opts.conversationId,
    message: text,
    attachmentObjectKey,
  };

  const viaHttp = async () => {
    try {
      const real = await http.post<SupportMsg>(
        `/support/conversations/${opts.conversationId}/messages`,
        {
          message: text || undefined,
          attachmentObjectKey,
        }
      );
      opts.onConfirm(temp.id, real);
    } catch (e) {
      opts.onFail(temp.id, (e as Error).message);
    }
  };

  if (!socket.connected) {
    await viaHttp();
    return;
  }

  let settled = false;
  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    opts.onFail(temp.id, 'Message timed out — try again');
  }, 8000);
  socket.emit('chat:send', payload, (r: SendAck) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    if (r?.ok && r.message) opts.onConfirm(temp.id, r.message);
    else opts.onFail(temp.id, r?.error || 'Failed to send');
  });
}

export function ThreadComposer({
  conversationId,
  closed,
  placeholder,
  sendLabel,
  attachLabel,
  onOptimistic,
  onConfirm,
  onFail,
}: {
  conversationId: string;
  closed: boolean;
  placeholder: string;
  sendLabel: string;
  attachLabel: string;
  onOptimistic: (temp: SupportMsg) => void;
  onConfirm: (tempId: string, real: SupportMsg) => void;
  onFail: (tempId: string, err: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | null) => {
    setFile(f);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return f ? URL.createObjectURL(f) : null;
    });
  };

  if (closed) return null;

  const go = async () => {
    if (busy) return;
    if (!draft.trim() && !file) return;
    setBusy(true);
    const body = draft;
    const f = file;
    try {
      await sendSupportMessage({
        conversationId,
        body,
        file: f,
        onOptimistic: (temp) => {
          setDraft('');
          pick(null);
          if (fileRef.current) fileRef.current.value = '';
          onOptimistic(temp);
        },
        onConfirm,
        onFail: (id, err) => {
          notify.error(err);
          onFail(id, err);
        },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3 border-t border-white/8 shrink-0 space-y-2">
      {preview && (
        <div className="flex items-center gap-2">
          <img src={preview} alt="" className="h-12 w-12 rounded object-cover" />
          <button
            type="button"
            className="t-label-sm text-red/80 underline"
            onClick={() => {
              pick(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
          >
            Remove
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          aria-label={attachLabel}
          title={attachLabel}
          onClick={() => fileRef.current?.click()}
          className="w-11 h-11 rounded-lg bg-layer-elevated border border-white/10 text-lg shrink-0"
        >
          📎
        </button>
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            socket.emit('chat:typing', { conversationId });
          }}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void go()}
          placeholder={placeholder}
          className="flex-1 h-11 px-3 rounded-lg bg-layer-elevated border border-white/10 t-body outline-none focus:border-gold/40"
        />
        <button
          type="button"
          onClick={() => void go()}
          disabled={busy || (!draft.trim() && !file)}
          className="h-11 px-4 rounded-lg bg-gold text-[#003d20] t-label-lg disabled:opacity-40 shrink-0"
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}

export { SUPPORT_CATEGORIES };
