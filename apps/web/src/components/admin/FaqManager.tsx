// apps/web/src/components/admin/FaqManager.tsx — add / edit / remove FAQs + categories.
'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';
import {
  ActionBtn,
  Badge,
  Card,
  CardHead,
  Field,
  Icon,
  Modal,
  Select,
  Spinner,
  TextArea,
  TextInput,
  Toggle,
} from './ui';

interface Cat {
  id: string;
  slug: string;
  nameEn: string;
  nameUr: string;
  sortOrder: number;
  isActive: boolean;
  faqCount: number;
}

interface FaqRow {
  id: string;
  categoryId: string;
  questionEn: string;
  questionUr: string;
  answerEn: string;
  answerUr: string;
  sortOrder: number;
  isPublished: boolean;
  category?: { id: string; nameEn: string; slug: string };
}

const EMPTY_CAT = { nameEn: '', nameUr: '', sortOrder: 0, isActive: true };
const EMPTY_FAQ = {
  categoryId: '',
  questionEn: '',
  questionUr: '',
  answerEn: '',
  answerUr: '',
  sortOrder: 0,
  isPublished: true,
};

export function FaqManager() {
  const qc = useQueryClient();
  const [selCat, setSelCat] = useState<string | 'all'>('all');
  const [catForm, setCatForm] = useState(EMPTY_CAT);
  const [faqForm, setFaqForm] = useState(EMPTY_FAQ);
  const [editingCat, setEditingCat] = useState<Cat | null>(null);
  const [editingFaq, setEditingFaq] = useState<FaqRow | null>(null);
  const [showAddFaq, setShowAddFaq] = useState(false);

  const { data: cats, isLoading: catsLoading } = useQuery({
    queryKey: ['panel-faq-cats'],
    queryFn: () => http.get<Cat[]>('/panel/faq-categories'),
  });
  const { data: faqs, isLoading: faqsLoading } = useQuery({
    queryKey: ['panel-faqs', selCat],
    queryFn: () =>
      http.get<FaqRow[]>(
        selCat === 'all'
          ? '/panel/faqs'
          : `/panel/faqs?categoryId=${encodeURIComponent(selCat)}`
      ),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['panel-faq-cats'] });
    qc.invalidateQueries({ queryKey: ['panel-faqs'] });
  };

  const createCat = useMutation({
    mutationFn: () => http.post('/panel/faq-categories', catForm),
    onSuccess: () => {
      notify.success('Category added');
      setCatForm(EMPTY_CAT);
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const patchCat = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      http.patch(`/panel/faq-categories/${id}`, patch),
    onSuccess: () => {
      notify.success('Category updated');
      setEditingCat(null);
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const removeCat = useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade: boolean }) =>
      http.delete(`/panel/faq-categories/${id}${cascade ? '?cascade=1' : ''}`),
    onSuccess: (_d, v) => {
      notify.success('Category deleted');
      if (selCat === v.id) setSelCat('all');
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const createFaq = useMutation({
    mutationFn: (body: typeof EMPTY_FAQ) => http.post('/panel/faqs', body),
    onSuccess: () => {
      notify.success('FAQ published');
      setFaqForm({ ...EMPTY_FAQ, categoryId: selCat === 'all' ? '' : selCat });
      setShowAddFaq(false);
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const patchFaq = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      http.patch(`/panel/faqs/${id}`, patch),
    onSuccess: () => {
      notify.success('FAQ updated');
      setEditingFaq(null);
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });
  const removeFaq = useMutation({
    mutationFn: (id: string) => http.delete(`/panel/faqs/${id}`),
    onSuccess: () => {
      notify.success('FAQ removed');
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const catOptions = useMemo(
    () => (cats ?? []).map((c) => ({ value: c.id, label: c.nameEn })),
    [cats]
  );

  const askDeleteCat = (c: Cat) => {
    if (c.faqCount > 0) {
      const ok = confirm(
        `"${c.nameEn}" has ${c.faqCount} FAQ${c.faqCount === 1 ? '' : 's'}. Delete the category AND those articles?`
      );
      if (ok) removeCat.mutate({ id: c.id, cascade: true });
      return;
    }
    if (confirm(`Delete category "${c.nameEn}"?`))
      removeCat.mutate({ id: c.id, cascade: false });
  };

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-4">
      <div className="space-y-4">
        <Card>
          <CardHead title="New category" icon="plus" />
          <div className="space-y-3">
            <Field label="Name (English)">
              <TextInput
                value={catForm.nameEn}
                onChange={(e) => setCatForm((f) => ({ ...f, nameEn: e.target.value }))}
                placeholder="Deposits"
              />
            </Field>
            <Field label="Name (Urdu)" hint="Shown when the player language is Urdu">
              <TextInput
                value={catForm.nameUr}
                onChange={(e) => setCatForm((f) => ({ ...f, nameUr: e.target.value }))}
                placeholder="ڈپازٹ"
                dir="auto"
              />
            </Field>
            <div className="flex items-end gap-3">
              <div className="w-24">
                <Field label="Order">
                  <TextInput
                    type="number"
                    value={catForm.sortOrder}
                    onChange={(e) =>
                      setCatForm((f) => ({
                        ...f,
                        sortOrder: Number(e.target.value) || 0,
                      }))
                    }
                  />
                </Field>
              </div>
              <Toggle
                checked={catForm.isActive}
                onChange={(v) => setCatForm((f) => ({ ...f, isActive: v }))}
                label="Visible"
              />
            </div>
            <ActionBtn
              tone="solid"
              disabled={!catForm.nameEn.trim() || createCat.isPending}
              onClick={() => createCat.mutate()}
            >
              <Icon name="plus" size={14} /> Add category
            </ActionBtn>
          </div>
        </Card>

        <Card pad={false}>
          <div className="px-5 pt-4">
            <CardHead title={`Categories (${cats?.length ?? 0})`} icon="legal" />
          </div>
          {catsLoading && <Spinner label="Loading…" />}
          <div className="divide-y divide-white/5">
            <button
              type="button"
              onClick={() => setSelCat('all')}
              className={`w-full text-left px-5 py-3 t-label-md ${selCat === 'all' ? 'bg-gold/10 text-gold' : 'text-white/70 hover:bg-white/4'}`}
            >
              All FAQs
            </button>
            {(cats ?? []).map((c) => (
              <div
                key={c.id}
                className={`px-5 py-3 ${selCat === c.id ? 'bg-gold/8' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelCat(c.id);
                    setFaqForm((f) => ({ ...f, categoryId: c.id }));
                  }}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className={`t-label-md truncate ${selCat === c.id ? 'text-gold' : 'text-white/85'}`}
                    >
                      {c.nameEn}
                    </p>
                    <Badge color={c.isActive ? 'green' : 'white'}>{c.faqCount}</Badge>
                  </div>
                  {c.nameUr && (
                    <p className="t-label-sm text-muted truncate" dir="auto">
                      {c.nameUr}
                    </p>
                  )}
                </button>
                <div className="flex gap-1.5 mt-2">
                  <ActionBtn size="sm" onClick={() => setEditingCat(c)}>
                    <Icon name="edit" size={12} /> Edit
                  </ActionBtn>
                  <ActionBtn
                    size="sm"
                    onClick={() =>
                      patchCat.mutate({ id: c.id, patch: { isActive: !c.isActive } })
                    }
                  >
                    {c.isActive ? 'Hide' : 'Show'}
                  </ActionBtn>
                  <ActionBtn size="sm" tone="danger" onClick={() => askDeleteCat(c)}>
                    <Icon name="trash" size={12} />
                  </ActionBtn>
                </div>
              </div>
            ))}
            {cats?.length === 0 && !catsLoading && (
              <p className="py-8 text-center t-label-sm text-muted">
                Add a category first, then write FAQs into it.
              </p>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHead
            title={
              selCat === 'all'
                ? 'All FAQs'
                : (cats?.find((c) => c.id === selCat)?.nameEn ?? 'FAQs')
            }
            icon="support"
            right={
              <ActionBtn
                tone="gold"
                disabled={!cats?.length}
                onClick={() => {
                  setFaqForm({
                    ...EMPTY_FAQ,
                    categoryId: selCat === 'all' ? (cats?.[0]?.id ?? '') : selCat,
                  });
                  setShowAddFaq(true);
                }}
              >
                <Icon name="plus" size={14} /> New FAQ
              </ActionBtn>
            }
          />
          {faqsLoading && <Spinner label="Loading FAQs…" />}
          <div className="space-y-2">
            {(faqs ?? []).map((f) => (
              <div
                key={f.id}
                className="rounded-xl border border-white/8 bg-layer-elevated p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="t-label-lg text-primary">{f.questionEn}</p>
                    {f.questionUr && (
                      <p className="t-label-sm text-muted" dir="auto">
                        {f.questionUr}
                      </p>
                    )}
                    <p className="t-label-sm text-secondary mt-1 line-clamp-2 whitespace-pre-wrap">
                      {f.answerEn}
                    </p>
                    <p className="t-label-sm text-muted mt-1">
                      {f.category?.nameEn ?? ''} · order {f.sortOrder}
                    </p>
                  </div>
                  <Badge color={f.isPublished ? 'green' : 'white'}>
                    {f.isPublished ? 'live' : 'draft'}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  <ActionBtn
                    size="sm"
                    onClick={() =>
                      patchFaq.mutate({
                        id: f.id,
                        patch: { isPublished: !f.isPublished },
                      })
                    }
                  >
                    {f.isPublished ? 'Unpublish' : 'Publish'}
                  </ActionBtn>
                  <ActionBtn size="sm" tone="gold" onClick={() => setEditingFaq(f)}>
                    <Icon name="edit" size={12} /> Edit
                  </ActionBtn>
                  <ActionBtn
                    size="sm"
                    tone="danger"
                    onClick={() => {
                      if (confirm(`Remove “${f.questionEn}”?`)) removeFaq.mutate(f.id);
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </ActionBtn>
                </div>
              </div>
            ))}
            {faqs?.length === 0 && !faqsLoading && (
              <p className="py-10 text-center t-label-sm text-muted">
                No FAQs in this view — add one.
              </p>
            )}
          </div>
        </Card>
      </div>

      {editingCat && (
        <Modal
          open
          onClose={() => setEditingCat(null)}
          title={`Edit category — ${editingCat.nameEn}`}
          width="max-w-lg"
        >
          <CatEdit
            cat={editingCat}
            onSave={(patch) => patchCat.mutate({ id: editingCat.id, patch })}
            onClose={() => setEditingCat(null)}
          />
        </Modal>
      )}

      {(showAddFaq || editingFaq) && (
        <Modal
          open
          onClose={() => {
            setShowAddFaq(false);
            setEditingFaq(null);
          }}
          title={editingFaq ? 'Edit FAQ' : 'New FAQ'}
          width="max-w-2xl"
        >
          <FaqEdit
            cats={catOptions}
            initial={
              editingFaq
                ? {
                    categoryId: editingFaq.categoryId,
                    questionEn: editingFaq.questionEn,
                    questionUr: editingFaq.questionUr,
                    answerEn: editingFaq.answerEn,
                    answerUr: editingFaq.answerUr,
                    sortOrder: editingFaq.sortOrder,
                    isPublished: editingFaq.isPublished,
                  }
                : faqForm
            }
            onClose={() => {
              setShowAddFaq(false);
              setEditingFaq(null);
            }}
            onSave={(body) => {
              if (editingFaq) patchFaq.mutate({ id: editingFaq.id, patch: body });
              else createFaq.mutate(body);
            }}
            saving={createFaq.isPending || patchFaq.isPending}
          />
        </Modal>
      )}
    </div>
  );
}

function CatEdit({
  cat,
  onSave,
  onClose,
}: {
  cat: Cat;
  onSave: (patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [nameEn, setNameEn] = useState(cat.nameEn);
  const [nameUr, setNameUr] = useState(cat.nameUr);
  const [sortOrder, setSortOrder] = useState(cat.sortOrder);
  const [isActive, setIsActive] = useState(cat.isActive);
  return (
    <div className="space-y-3">
      <Field label="Name (English)">
        <TextInput value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
      </Field>
      <Field label="Name (Urdu)">
        <TextInput
          value={nameUr}
          onChange={(e) => setNameUr(e.target.value)}
          dir="auto"
        />
      </Field>
      <Field label="Sort order">
        <TextInput
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
        />
      </Field>
      <Toggle checked={isActive} onChange={setIsActive} label="Visible to players" />
      <div className="flex justify-end gap-2 pt-2">
        <ActionBtn onClick={onClose}>Cancel</ActionBtn>
        <ActionBtn
          tone="solid"
          onClick={() => {
            if (!nameEn.trim()) {
              notify.error('English name is required');
              return;
            }
            onSave({ nameEn, nameUr, sortOrder, isActive });
          }}
        >
          <Icon name="check" size={14} /> Save
        </ActionBtn>
      </div>
    </div>
  );
}

function FaqEdit({
  cats,
  initial,
  onSave,
  onClose,
  saving,
}: {
  cats: Array<{ value: string; label: string }>;
  initial: typeof EMPTY_FAQ;
  onSave: (body: typeof EMPTY_FAQ) => void;
  onClose: () => void;
  saving?: boolean;
}) {
  const [form, setForm] = useState(initial);
  const set = (k: keyof typeof EMPTY_FAQ, v: string | number | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="space-y-3">
      <Field label="Category">
        <Select
          options={[{ value: '', label: 'Choose a category' }, ...cats]}
          value={form.categoryId}
          onChange={(e) => set('categoryId', e.target.value)}
        />
      </Field>
      <Field label="Question (English)">
        <TextInput
          value={form.questionEn}
          onChange={(e) => set('questionEn', e.target.value)}
        />
      </Field>
      <Field label="Question (Urdu)">
        <TextInput
          value={form.questionUr}
          onChange={(e) => set('questionUr', e.target.value)}
          dir="auto"
        />
      </Field>
      <Field label="Answer (English)">
        <TextArea
          rows={6}
          value={form.answerEn}
          onChange={(e) => set('answerEn', e.target.value)}
        />
      </Field>
      <Field label="Answer (Urdu)">
        <TextArea
          rows={6}
          value={form.answerUr}
          onChange={(e) => set('answerUr', e.target.value)}
          dir="auto"
        />
      </Field>
      <div className="flex items-end gap-4">
        <div className="w-28">
          <Field label="Order">
            <TextInput
              type="number"
              value={form.sortOrder}
              onChange={(e) => set('sortOrder', Number(e.target.value) || 0)}
            />
          </Field>
        </div>
        <Toggle
          checked={form.isPublished}
          onChange={(v) => set('isPublished', v)}
          label="Published"
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <ActionBtn onClick={onClose}>Cancel</ActionBtn>
        <ActionBtn
          tone="solid"
          disabled={saving}
          onClick={() => {
            if (!form.categoryId) {
              notify.error('Pick a category');
              return;
            }
            if (!form.questionEn.trim() || !form.answerEn.trim()) {
              notify.error('English question and answer are required');
              return;
            }
            onSave(form);
          }}
        >
          <Icon name="check" size={14} /> Save FAQ
        </ActionBtn>
      </div>
    </div>
  );
}
