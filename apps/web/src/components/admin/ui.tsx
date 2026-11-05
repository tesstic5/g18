// apps/web/src/components/admin/ui.tsx — professional admin UI kit (D-068)
'use client';
import React from 'react';

// ── ICONS (inline SVG, currentColor) ─────────────────────────────────────
const PATHS: Record<string, string> = {
  dashboard: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM1 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2M17 9a3 3 0 1 0 0-6M23 21v-2a5 5 0 0 0-4-4.9',
  deposits: 'M12 3v13m0 0l-5-5m5 5l5-5M4 21h16',
  withdrawals: 'M12 21V8m0 0l5 5m-5-5l-5 5M4 3h16',
  cards:
    'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7zm0 4h20M6 15h4',
  ledger: 'M4 4h16v16H4zM4 9h16M8 13h4M8 17h8',
  games: 'M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  broadcast: 'M3 11l18-7-7 18-2.5-7.5L3 11z',
  legal: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zm0 5v8M9 10h6',
  support: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 8v4m0 4h.01',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  managers:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  audit: 'M12 1l9 4v6c0 5.5-3.8 9.7-9 12-5.2-2.3-9-6.5-9-12V5l9-4zm-3 12l2 2 4-4',
  backup: 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16',
  shield:
    'M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3zm-2 13l-2-2 1.5-1.5L10 12l4-4 1.5 1.5L10 15z',
  logout: 'M15 12H3m0 0l4-4m-4 4l4 4M12 4h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7',
  external:
    'M14 3h7v7M21 3l-9 9M17 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6',
  close: 'M18 6L6 18M6 6l12 12',
  wallet:
    'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zm18 4h-5a2 2 0 0 0 0 4h5',
  chart: 'M3 21V10M9 21V3M15 21v-7M21 21V7',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M10.3 21a2 2 0 0 0 3.4 0',
  arrowUp: 'M12 19V5m0 0l-6 6m6-6l6 6',
  arrowDown: 'M12 5v14m0 0l6-6m-6 6l-6-6',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  chevron: 'M9 6l6 6-6 6',
  live: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 5v5l3 2',
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1v-9z',
  edit: 'M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
  trash:
    'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  coins:
    'M12 2c4.4 0 8 2 8 4.5S16.4 11 12 11s-8-2-8-4.5S7.6 2 12 2zm-8 9.5V16c0 2.5 3.6 4.5 8 4.5s8-2 8-4.5v-4.5M4 16v4.5C4 23 7.6 25 12 25',
  zap: 'M13 2L3 14h7l-1 8 10-12h-7l1-8z',
  trophy:
    'M8 21h8M12 17v4M7 4h10v6a5 5 0 0 1-10 0V4zM7 5H4a0 0 0 0 0 0 5 3 3 0 0 0 3 3M17 5h3a0 0 0 0 1 0 5 3 3 0 0 1-3 3',
  circle: 'M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0',
  gift: 'M12 8v13M12 8c-1.5 0-4-2-4-4s1.5-3 3-2c1.5 1 1 3 1 3s-.5-2 1-3 3 1 3 2-2.5 4-4 4zm-8 5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM4 13V8h16v5',
};

export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const d = PATHS[name] ?? PATHS.circle ?? 'M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

// ── LAYOUT PRIMITIVES ────────────────────────────────────────────────────
export function Card({
  children,
  className = '',
  pad = true,
}: {
  children: React.ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <div
      className={`rounded-xl bg-layer-surface border border-white/8 ${pad ? 'p-5' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHead({
  title,
  right,
  icon,
}: {
  title: string;
  right?: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        {icon && (
          <span className="text-gold/80">
            <Icon name={icon} size={16} />
          </span>
        )}
        <h3 className="t-label-md text-secondary tracking-wide">{title}</h3>
      </div>
      {right}
    </div>
  );
}

/**
 * Sub-header for an admin page.
 *
 * NOTE: the panel LAYOUT already renders the page <h1> from its route->title
 * map, so this component must not render a second one — every admin page was
 * showing its title twice, one under the other. `title` is kept in the props so
 * call sites stay unchanged and it can label the region for screen readers.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  if (!subtitle && !actions) return null;
  return (
    <div
      aria-label={title}
      className="flex items-start justify-between mb-6 flex-wrap gap-3"
    >
      {subtitle ? (
        <p className="t-label-sm text-muted max-w-2xl">{subtitle}</p>
      ) : (
        <span />
      )}
      {actions}
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon,
  trend,
  up,
  accent = 'gold',
  hint,
}: {
  label: string;
  value: string;
  icon?: string;
  trend?: string;
  up?: boolean;
  accent?: 'gold' | 'green' | 'red' | 'blue' | 'violet' | 'orange';
  hint?: string;
}) {
  const accents: Record<string, { text: string; bg: string }> = {
    gold: { text: 'text-gold', bg: 'bg-gold/12' },
    green: { text: 'text-green', bg: 'bg-green/12' },
    red: { text: 'text-red', bg: 'bg-red/12' },
    blue: { text: 'text-sky-400', bg: 'bg-sky-400/12' },
    violet: { text: 'text-violet-400', bg: 'bg-violet-400/12' },
    orange: { text: 'text-orange-300', bg: 'bg-orange-400/12' },
  };
  const a = accents[accent] ?? accents.gold!;
  return (
    <div className="rounded-xl bg-layer-surface border border-white/8 p-4 flex flex-col gap-2 relative overflow-hidden">
      <div className="flex items-center justify-between">
        <p className="t-label-sm text-muted uppercase tracking-wide">{label}</p>
        {icon && (
          <span
            className={`h-8 w-8 rounded-lg ${a.bg} ${a.text} flex items-center justify-center`}
          >
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>
      <p className={`t-num-xl ${a.text}`}>{value}</p>
      <div className="flex items-center gap-2 min-h-[16px]">
        {trend && (
          <span
            className={`t-label-sm inline-flex items-center gap-1 ${up ? 'text-green' : trend.startsWith('+') ? 'text-green' : 'text-red'}`}
          >
            <Icon name={up ? 'arrowUp' : 'arrowDown'} size={12} /> {trend}
          </span>
        )}
        {hint && <span className="t-label-sm text-muted">{hint}</span>}
      </div>
    </div>
  );
}

export function Badge({
  children,
  color = 'white',
}: {
  children: React.ReactNode;
  color?: 'white' | 'green' | 'red' | 'orange' | 'gold' | 'sky' | 'violet';
}) {
  const map: Record<string, string> = {
    white: 'bg-white/10 text-white/70',
    green: 'bg-green/15 text-green',
    red: 'bg-red/15 text-red',
    orange: 'bg-orange-400/15 text-orange-300',
    gold: 'bg-gold/15 text-gold',
    sky: 'bg-sky-400/15 text-sky-300',
    violet: 'bg-violet-400/15 text-violet-300',
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${map[color]}`}
    >
      {children}
    </span>
  );
}

export function ActionBtn({
  children,
  tone = 'ghost',
  size = 'md',
  onClick,
  disabled,
  title,
  type,
}: {
  children: React.ReactNode;
  tone?: 'primary' | 'danger' | 'gold' | 'ghost' | 'solid';
  size?: 'sm' | 'md';
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const tones: Record<string, string> = {
    primary: 'bg-green/15 text-green border border-green/30 hover:bg-green/25',
    danger: 'bg-red/15 text-red border border-red/30 hover:bg-red/25',
    gold: 'bg-gold/15 text-gold border border-gold/30 hover:bg-gold/25',
    ghost: 'bg-white/5 text-white/70 border border-white/10 hover:bg-white/10',
    solid: 'bg-gold text-black border border-gold hover:bg-gold/90',
  };
  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg t-label-md transition-colors active:scale-95 disabled:opacity-40 inline-flex items-center gap-1.5 ${size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5'} ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  className?: string;
}

export function AdminTable<T>({
  columns,
  rows,
  loading,
  empty,
  rowKey = (r) => (r as { id?: string }).id ?? '',
  onRowClick,
  dense,
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  empty?: string;
  rowKey?: (r: T) => string;
  onRowClick?: (r: T) => void;
  dense?: boolean;
}) {
  if (loading) return <div className="h-40 skeleton rounded-xl" />;
  if (rows.length === 0)
    return (
      <div className="text-center py-12 t-label-md text-muted">
        {empty || 'No data'}
      </div>
    );
  return (
    <div className="rounded-xl overflow-hidden border border-white/8 bg-layer-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/5">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`text-left px-4 py-3 t-label-sm uppercase tracking-wide text-muted font-medium whitespace-nowrap ${c.className ?? ''}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`${dense ? '' : 'hover:bg-white/2'} ${onRowClick ? 'cursor-pointer hover:bg-white/4' : ''}`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-4 py-3 ${dense ? 'py-2' : ''} ${c.className ?? ''}`}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 mt-4">
      <ActionBtn size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        ← Prev
      </ActionBtn>
      <span className="t-label-sm text-muted">
        Page {page} / {Math.max(1, totalPages)}
      </span>
      <ActionBtn
        size="sm"
        onClick={() => onPage(page + 1)}
        disabled={page >= totalPages}
      >
        Next →
      </ActionBtn>
    </div>
  );
}

// ── FORM PRIMITIVES ──────────────────────────────────────────────────────
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="t-label-md text-secondary">{label}</span>
      {children}
      {hint && <span className="block t-label-sm text-muted">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full h-10 px-3 rounded-lg bg-layer-elevated border border-white/10 outline-none focus:border-gold/50 text-sm placeholder:text-white/25 transition-colors';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Select({
  options,
  ...props
}: {
  options: Array<{ value: string; label: string }>;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`${inputCls} appearance-none ${props.className ?? ''}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${inputCls} h-auto py-2.5 ${props.className ?? ''}`}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 group"
    >
      <span
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-gold/80' : 'bg-white/15'}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
        />
      </span>
      {label && <span className="t-label-sm text-secondary">{label}</span>}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-2xl',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      role="dialog"
      aria-modal
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={`relative w-full ${width} rounded-2xl bg-layer-surface border border-white/10 shadow-2xl`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
          <h2 className="t-label-xl text-primary">{title}</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-white/60"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-white/5 border border-white/10 p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`h-8 px-3 rounded-md t-label-md transition-colors ${value === o.value ? 'bg-gold text-black' : 'text-white/60 hover:text-white'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 justify-center py-10">
      <div className="h-6 w-6 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
      {label && <span className="t-label-sm text-muted">{label}</span>}
    </div>
  );
}

export function fmt(n: number): string {
  return (
    '₨' +
    (Number.isFinite(n)
      ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : '0')
  );
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
