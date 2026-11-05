// apps/web/src/components/admin/packages.tsx — CRUD for deposit top-up packages.
//
// These are the bundles shown on the deposit page (where signup lands).
// `price` is what the player pays, `credits` lands in their REAL wallet and
// `bonus` in their BONUS wallet when an admin approves the deposit — keeping
// promo value in the bonus wallet means it has to be wagered rather than
// withdrawn straight back out.
'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';

interface Pkg {
  id: string;
  name: string;
  price: string | number;
  credits: string | number;
  bonus: string | number;
  badge?: string | null;
  description?: string | null;
  sortOrder: number;
  isActive: boolean;
}

const CURRENCY = () => process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨';

const BLANK = {
  name: '',
  price: 500,
  credits: 500,
  bonus: 0,
  badge: '',
  description: '',
  sortOrder: 0,
  isActive: true,
};

export function PackagesPanel() {
  const [rows, setRows] = useState<Pkg[] | null>(null);
  const [form, setForm] = useState<typeof BLANK & { id?: string }>({ ...BLANK });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await http.get<Pkg[]>('/panel/packages'));
    } catch (e) {
      notify.error((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const edit = (p: Pkg) =>
    setForm({
      id: p.id,
      name: p.name,
      price: Number(p.price),
      credits: Number(p.credits),
      bonus: Number(p.bonus),
      badge: p.badge ?? '',
      description: p.description ?? '',
      sortOrder: p.sortOrder,
      isActive: p.isActive,
    });

  const save = async () => {
    if (!form.name.trim()) {
      notify.error('Give the package a name');
      return;
    }
    if (form.price < 0 || form.credits < 0 || form.bonus < 0) {
      notify.error('Amounts cannot be negative');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        price: Number(form.price),
        credits: Number(form.credits),
        bonus: Number(form.bonus),
        badge: form.badge.trim() || null,
        description: form.description.trim() || null,
        sortOrder: Number(form.sortOrder),
        isActive: form.isActive,
      };
      if (form.id) await http.patch(`/panel/packages/${form.id}`, body);
      else await http.post('/panel/packages', body);
      notify.success(form.id ? 'Package updated' : 'Package created');
      setForm({ ...BLANK });
      await load();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (p: Pkg) => {
    if (
      !confirm(
        `Hide "${p.name}" from the deposit page? Existing deposits keep their bonus.`
      )
    )
      return;
    try {
      await http.del(`/panel/packages/${p.id}`);
      notify.success('Package hidden');
      await load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  };

  const num = (k: 'price' | 'credits' | 'bonus' | 'sortOrder') => ({
    type: 'number' as const,
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: Number(e.target.value) })),
    className:
      'w-full h-10 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none focus:border-gold/40',
  });

  const total = Number(form.credits) + Number(form.bonus);

  return (
    <div className="space-y-6">
      {/* editor */}
      <div className="rounded-xl border border-white/10 bg-layer-surface p-4 space-y-3">
        <h3 className="t-label-lg text-primary">
          {form.id ? 'Edit package' : 'New package'}
        </h3>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="t-label-sm text-secondary block mb-1">Name</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Starter pack"
              className="w-full h-10 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none focus:border-gold/40"
            />
          </label>
          <label className="block">
            <span className="t-label-sm text-secondary block mb-1">
              Badge (optional)
            </span>
            <input
              value={form.badge}
              onChange={(e) => setForm((f) => ({ ...f, badge: e.target.value }))}
              placeholder="MOST POPULAR"
              className="w-full h-10 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none focus:border-gold/40"
            />
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="t-label-sm text-secondary block mb-1">Player pays</span>
            <input {...num('price')} />
          </label>
          <label className="block">
            <span className="t-label-sm text-secondary block mb-1">Real credit</span>
            <input {...num('credits')} />
          </label>
          <label className="block">
            <span className="t-label-sm text-secondary block mb-1">Bonus credit</span>
            <input {...num('bonus')} />
          </label>
        </div>

        <p className="t-label-sm text-secondary">
          Player pays{' '}
          <span className="text-gold">
            {CURRENCY()}
            {Number(form.price).toLocaleString()}
          </span>{' '}
          and receives{' '}
          <span className="text-green">
            {CURRENCY()}
            {total.toLocaleString()}
          </span>{' '}
          ({CURRENCY()}
          {Number(form.credits).toLocaleString()} real
          {' + '}
          {CURRENCY()}
          {Number(form.bonus).toLocaleString()} bonus).
          {Number(form.bonus) === 0 && (
            <span className="text-white/40"> Add bonus credit to make it a deal.</span>
          )}
        </p>

        <label className="block">
          <span className="t-label-sm text-secondary block mb-1">
            Description (optional)
          </span>
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Best value for new players"
            className="w-full h-10 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none focus:border-gold/40"
          />
        </label>

        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2">
            <span className="t-label-sm text-secondary">Order</span>
            <input
              {...num('sortOrder')}
              className="w-20 h-10 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none"
            />
          </label>
          <label className="flex items-center gap-2 t-label-sm text-secondary">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
            Visible to players
          </label>
          <div className="flex-1" />
          {form.id && (
            <button
              onClick={() => setForm({ ...BLANK })}
              className="h-10 px-4 rounded-lg bg-white/5 border border-white/10 t-label-md text-white/70"
            >
              Cancel
            </button>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="btn-primary h-10 px-6 !rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create package'}
          </button>
        </div>
      </div>

      {/* list */}
      <div className="rounded-xl border border-white/10 overflow-hidden">
        {rows === null ? (
          <p className="p-6 t-label-md text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 t-label-md text-muted">
            No packages yet. Create one above and it appears on the deposit page
            immediately.
          </p>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-white/[0.03] text-white/50">
              <tr>
                <th className="p-3 t-label-sm font-normal">Name</th>
                <th className="p-3 t-label-sm font-normal">Pays</th>
                <th className="p-3 t-label-sm font-normal">Gets</th>
                <th className="p-3 t-label-sm font-normal">Order</th>
                <th className="p-3 t-label-sm font-normal">Status</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="p-3">
                    <span className="t-label-md text-primary">{p.name}</span>
                    {p.badge && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-gold/20 text-gold">
                        {p.badge}
                      </span>
                    )}
                  </td>
                  <td className="p-3 t-num-md text-white/80">
                    {CURRENCY()}
                    {Number(p.price).toLocaleString()}
                  </td>
                  <td className="p-3 t-num-md text-green">
                    {CURRENCY()}
                    {(Number(p.credits) + Number(p.bonus)).toLocaleString()}
                    {Number(p.bonus) > 0 && (
                      <span className="text-white/40 t-label-sm">
                        {' '}
                        (+{CURRENCY()}
                        {Number(p.bonus).toLocaleString()})
                      </span>
                    )}
                  </td>
                  <td className="p-3 t-num-md text-white/50">{p.sortOrder}</td>
                  <td className="p-3">
                    <span
                      className={`t-label-sm ${p.isActive ? 'text-green' : 'text-white/35'}`}
                    >
                      {p.isActive ? 'Visible' : 'Hidden'}
                    </span>
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => edit(p)}
                      className="t-label-sm text-gold underline mr-3"
                    >
                      Edit
                    </button>
                    {p.isActive && (
                      <button
                        onClick={() => deactivate(p)}
                        className="t-label-sm text-red/80 underline"
                      >
                        Hide
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
