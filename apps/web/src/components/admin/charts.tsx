// apps/web/src/components/admin/charts.tsx — dependency-free SVG charts (D-068)
'use client';
import React from 'react';

export function BarChart({
  data,
  height = 180,
  color = '#e6b84c',
  secondary,
  valueFmt,
}: {
  data: Array<{ label: string; value: number; value2?: number }>;
  height?: number;
  color?: string;
  secondary?: string;
  valueFmt?: (n: number) => string;
}) {
  const w = 640;
  const padL = 8,
    padB = 22,
    padT = 14,
    padR = 8;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.value2 ?? 0)));
  const iw = w - padL - padR,
    ih = height - padT - padB;
  const n = data.length;
  const slot = iw / Math.max(1, n);
  const barW = Math.min(26, slot * 0.55);
  const fmt = valueFmt ?? ((x: number) => String(Math.round(x)));
  const mid = Math.floor(n / 2);
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="w-full min-w-[420px]"
        role="img"
        aria-label="Bar chart"
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={padL}
            x2={w - padR}
            y1={padT + ih * (1 - f)}
            y2={padT + ih * (1 - f)}
            stroke="rgba(255,255,255,0.06)"
            strokeDasharray="3 4"
          />
        ))}
        {data.map((d, i) => {
          const x = padL + slot * i + (slot - barW) / 2;
          const h = (d.value / max) * ih;
          const h2 = d.value2 !== undefined ? (d.value2 / max) * ih : 0;
          const labelShow =
            n <= 16 ? (n <= 9 ? i % 2 === 0 : i % 3 === 0) : i % 4 === 0;
          return (
            <g key={i}>
              {d.value2 !== undefined && (
                <rect
                  x={x + (d.value >= d.value2 ? 1 : 0) * (barW / 2)}
                  y={padT + ih - h2}
                  width={barW / 2 - 1}
                  height={Math.max(0, h2)}
                  rx={2}
                  fill={secondary ?? 'rgba(255,255,255,0.28)'}
                  opacity={0.85}
                >
                  <title>{`${d.label}: ${fmt(d.value2)}`}</title>
                </rect>
              )}
              <rect
                x={x}
                y={padT + ih - h}
                width={barW}
                height={Math.max(0, h)}
                rx={2}
                fill={color}
                opacity={0.92}
              >
                <title>{`${d.label}: ${fmt(d.value)}`}</title>
              </rect>
              {labelShow && (
                <text
                  x={x + barW / 2}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize="9"
                  fill="rgba(255,255,255,0.45)"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
        {data[mid] && (
          <text x={padL} y={padT - 4} fontSize="10" fill="rgba(255,255,255,0.5)">
            max {fmt(max)}
          </text>
        )}
      </svg>
    </div>
  );
}

/** Horizontal bars with label + value + sub-value (e.g. game performance). */
export function HBarList({
  rows,
  accent = '#e6b84c',
  valueFmt,
}: {
  rows: Array<{ label: string; value: number; sub?: string; badge?: React.ReactNode }>;
  accent?: string;
  valueFmt?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fmt = valueFmt ?? ((x: number) => '₨' + Math.round(x).toLocaleString());
  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={i}>
          <div className="flex items-center justify-between mb-1 gap-2">
            <span className="t-label-md text-white/80 truncate">{r.label}</span>
            <span className="flex items-center gap-2 shrink-0">
              {r.badge}
              <span className="t-num-sm text-white/60">{fmt(r.value)}</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/6 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (r.value / max) * 100)}%`,
                background: accent,
                opacity: 0.9,
              }}
            />
          </div>
          {r.sub && <p className="t-label-sm text-muted mt-0.5">{r.sub}</p>}
        </div>
      ))}
    </div>
  );
}

/** Small sparkline for trends. */
export function Sparkline({
  points,
  width = 120,
  height = 32,
  color = '#e6b84c',
}: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (points.length < 2) return <div style={{ width, height }} />;
  const max = Math.max(...points),
    min = Math.min(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const d = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 3 - ((p - min) / range) * (height - 8)).toFixed(1)}`
    )
    .join(' ');
  return (
    <svg width={width} height={height} className="opacity-80">
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
