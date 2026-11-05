// apps/web/src/components/support/FaqList.tsx — published help articles, grouped by category.
'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../lib/api';
import type { Lang } from '../../lib/i18n';

export interface PublicFaq {
  id: string;
  questionEn: string;
  questionUr: string;
  answerEn: string;
  answerUr: string;
  sortOrder: number;
}

export interface PublicFaqCategory {
  id: string;
  slug: string;
  nameEn: string;
  nameUr: string;
  sortOrder: number;
  faqs: PublicFaq[];
}

function pick(lang: Lang, en: string, ur: string) {
  return lang === 'ur' && ur.trim() ? ur : en;
}

export function usePublicFaqs() {
  return useQuery({
    queryKey: ['support-faqs'],
    queryFn: () => http.get<PublicFaqCategory[]>('/support/faqs'),
    staleTime: 60_000,
  });
}

export function FaqList({
  lang,
  title,
  empty,
  compact,
}: {
  lang: Lang;
  title: string;
  empty?: string;
  compact?: boolean;
}) {
  const { data, isLoading } = usePublicFaqs();
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) return null;
  if (!data?.length) {
    if (!empty) return null;
    return <p className="t-label-sm text-muted text-center py-4">{empty}</p>;
  }

  return (
    <section id="faq" className={compact ? 'space-y-2' : 'space-y-3 mb-6'}>
      <h2 className={compact ? 't-label-lg text-primary' : 't-label-xl text-primary'}>
        {title}
      </h2>
      {data.map((cat) => (
        <div key={cat.id} className="space-y-1.5">
          <p className="t-label-sm uppercase tracking-wide text-muted px-1" dir="auto">
            {pick(lang, cat.nameEn, cat.nameUr)}
          </p>
          {cat.faqs.map((f) => {
            const open = openId === f.id;
            return (
              <div
                key={f.id}
                className="rounded-xl border border-white/8 bg-layer-surface overflow-hidden"
              >
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : f.id)}
                  className="w-full text-left px-3 py-3 flex items-start justify-between gap-3"
                >
                  <span className="t-label-md text-primary" dir="auto">
                    {pick(lang, f.questionEn, f.questionUr)}
                  </span>
                  <span className="text-white/40 shrink-0">{open ? '–' : '+'}</span>
                </button>
                {open && (
                  <p
                    className="px-3 pb-3 t-body text-secondary whitespace-pre-wrap"
                    dir="auto"
                  >
                    {pick(lang, f.answerEn, f.answerUr)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
