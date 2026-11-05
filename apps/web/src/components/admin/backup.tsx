// apps/web/src/components/admin/backup.tsx — Backup & Restore (D-062).
//
// This page does exactly two things: SAVE everything into one file, and PUT
// everything back from that file. Everything else (JSON rows, CSV, the old
// JSON-bundle restore) is one click away under "Other options" instead of
// competing for attention.
//
// Two facts shape the design:
//   1. The file is built and streamed by the SERVER. The old export handed the
//      tab a blob and the old restore read the whole file into browser memory
//      (~3x its size in RAM, hard-capped at 512 MB) — a mid-size platform died
//      silently in the tab. Both directions now talk to the API directly.
//   2. Uploaded images are part of the backup. The JSON export never included
//      them, so a "successful" restore produced deposits whose proof images
//      were broken links.
'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http, uploadArchiveInChunks, pollRestoreJob } from '../../lib/api';
import { apiBaseUrl } from '../../lib/env';
import { notify } from '../../lib/toast';
import { useStepUp } from './step-up';
import { Card, CardHead, Badge, TextInput, Spinner, Icon } from './ui';

interface ArchiveInfo {
  generatedAt: string;
  counts: Record<string, number>;
  objects: { count: number; bytes: number; buckets: string[]; error?: string };
  keyFingerprint: string;
  estimatedBytes: number;
}

interface RestoreResult {
  tables: Record<string, number>;
  objects: { restored: number; failed: number; total: number };
}

const COUNT_LABELS: Record<string, string> = {
  User: 'Players',
  Wallet: 'Wallets',
  GameRound: 'Game rounds',
  Transaction: 'Transactions',
  Deposit: 'Deposits',
  Withdrawal: 'Withdrawals',
  AdminUser: 'Admins',
  GameConfig: 'Game configs',
};

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function fmtCount(n: number): string {
  return n < 0 ? '—' : n.toLocaleString('en-US');
}

/**
 * Kick off a file download by NAVIGATING to the API route. The API streams the
 * archive and the browser writes it to disk as it arrives, so a multi-gigabyte
 * backup never has to fit in the tab's memory (a fetch → blob would).
 * The admin cookie authenticates the request; the panel needs no token here.
 */
function startArchiveDownload(): void {
  const a = document.createElement('a');
  a.href = `${apiBaseUrl()}/panel/backup/download`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── SAVE ────────────────────────────────────────────────────────────────────
function SaveCard({ isSuperAdmin, info, loading }: {
  isSuperAdmin: boolean;
  info: ArchiveInfo | undefined;
  loading: boolean;
}) {
  const [started, setStarted] = useState(false);

  return (
    <Card>
      <CardHead title="Save everything into one file" icon="backup" />
      <p className="t-label-sm text-secondary mb-4">
        One <code className="text-gold">.tar.gz</code> file holding the whole platform: every
        player, wallet, transaction and configuration row, <strong>plus</strong> every uploaded
        image (deposit proofs and avatars). Keep it somewhere safe — it is everything.
      </p>

      {loading ? (
        <Spinner label="Checking what would be included…" />
      ) : info ? (
        <div className="rounded-lg bg-layer-elevated border border-white/8 p-4 mb-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
            {Object.entries(info.counts).map(([table, n]) => (
              <div key={table}>
                <p className="t-label-sm text-muted">{COUNT_LABELS[table] ?? table}</p>
                <p className="t-num-md text-primary">{fmtCount(n)}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-white/8">
            <Badge color={info.objects.error ? 'gold' : 'green'}>
              {info.objects.error
                ? 'images unavailable'
                : `${fmtCount(info.objects.count)} images · ${fmtBytes(info.objects.bytes)}`}
            </Badge>
            <Badge color="sky">encrypted with key {info.keyFingerprint}</Badge>
            {info.estimatedBytes > 0 && (
              <Badge color="white">about {fmtBytes(info.estimatedBytes)} in total</Badge>
            )}
          </div>
        </div>
      ) : null}

      {info?.objects.error && (
        <div className="rounded-lg border border-gold/30 bg-gold/10 text-gold t-label-sm p-3 mb-4">
          Image storage could not be read ({info.objects.error}). A backup taken now would contain
          the database but <strong>no images</strong>. Fix storage and take it again if you can.
        </div>
      )}

      <button
        type="button"
        disabled={!isSuperAdmin}
        onClick={() => {
          setStarted(true);
          startArchiveDownload();
          notify.success('Building your backup — the download starts in a moment. Keep this tab open.');
        }}
        className="h-12 px-6 rounded-lg bg-gold/15 border border-gold/30 text-gold t-label-lg active:scale-[0.98] disabled:opacity-40"
      >
        ⬇ Download backup file
      </button>

      {!isSuperAdmin && (
        <p className="t-label-sm text-muted mt-3">
          Only a super admin can take or restore a full platform backup.
        </p>
      )}
      {started && (
        <p className="t-label-sm text-muted mt-3">
          The server packages every image as it streams, so this takes a little while on a big
          platform. If the download fails, the file is simply not created — take it again.
        </p>
      )}
    </Card>
  );
}

// ── RESTORE ────────────────────────────────────────────────────────────────
function RestoreCard({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const stepUp = useStepUp();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [percent, setPercent] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'uploading' | 'restoring'>('idle');
  // What the server is doing right now ("Wiping the current data…"), so a long
  // restore is legible instead of a bar that sits at 99% and then fails.
  const [stage, setStage] = useState('');
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase !== 'idle';

  const pick = (f: File | null) => {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!/\.(tar\.gz|tgz|gz)$/.test(name)) {
      notify.error(
        'That is not a platform backup file. It should be a .tar.gz downloaded from this page. ' +
          'An older .json bundle can be restored under "Other options".'
      );
      return;
    }
    setFile(f);
    setResult(null);
  };

  const restore = async () => {
    if (!file) {
      notify.error('Choose the backup file first');
      return;
    }
    if (confirmText !== 'RESTORE') {
      notify.error('Type RESTORE in the box to confirm');
      return;
    }
    setResult(null);
    setPercent(0);
    try {
      // Ask for the password BEFORE uploading. A restore needs a fresh
      // re-authentication, and being told that after a 2 GB upload is cruel.
      setPhase('checking');
      await stepUp.run(() => http.post('/panel/backup/restore-archive/preflight', {}));

      // Upload as many small requests rather than one long one: a single
      // multi-minute request is cut by the proxy in front of the API (Traefik's
      // 60s read deadline) and surfaced as "HTTP 408" once the bar hit 99%.
      setPhase('uploading');
      setStage('Sending the file…');
      const uploaded = await stepUp.run(() =>
        uploadArchiveInChunks(file, {
          onProgress: (pct) => setPercent(pct),
        })
      );

      // Then hand the assembled file to a background job and watch it. Nothing
      // here stays open long enough for a proxy to time it out, and the outcome
      // is still readable if the restore signs us out (it replaces AdminUser).
      setPhase('restoring');
      setStage('Starting the restore…');
      setPercent(99);
      const started = await stepUp.run(() =>
        http.post<{ jobId: string; jobToken: string }>('/panel/backup/restore/start', {
          tempPath: uploaded.tempPath,
        })
      );
      const job = await pollRestoreJob(started.jobId, started.jobToken, {
        onUpdate: (j) => {
          setStage(j.label);
          if (j.state === 'running') setPercent(Math.max(99, Math.min(100, j.percent)));
        },
      });
      if (job.state === 'error') {
        throw new Error(job.error || 'The restore failed — nothing may have been changed.');
      }
      const res = job.result as RestoreResult;
      setStage('');
      setResult(res);
      setConfirmText('');
      setFile(null);
      notify.success('Restore complete');
      qc.invalidateQueries();
    } catch (e) {
      const msg = (e as Error).message || 'Restore failed';
      notify.error(
        /AUTH_010|re-authenticat/i.test(msg) ? 'Password check cancelled — nothing was changed.' : msg
      );
    } finally {
      setPhase('idle');
      setPercent(0);
      setStage('');
    }
  };

  return (
    <>
      <div className="rounded-xl bg-layer-surface border border-red/20 p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-red">
            <Icon name="shield" size={16} />
          </span>
          <h2 className="t-label-lg text-primary">Restore from a backup file</h2>
        </div>
        <p className="t-label-sm text-secondary mb-4">
          This <strong className="text-red">replaces everything</strong> currently on the platform
          — all players, balances, history and images — with the contents of the file. It cannot be
          undone, so take a fresh backup first if you are unsure.
        </p>

        <div className="space-y-4">
          <div>
            <p className="t-label-md text-primary mb-2">1. Choose the backup file</p>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pick(e.dataTransfer.files.item(0));
              }}
              className={`flex items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-4 cursor-pointer transition-colors ${
                dragging
                  ? 'border-gold/50 bg-gold/10'
                  : 'border-white/15 bg-layer-elevated hover:border-white/25'
              }`}
            >
              <span className="min-w-0">
                <span className="t-label-md text-primary block truncate">
                  {file ? file.name : 'Drop the .tar.gz here, or click to browse'}
                </span>
                <span className="t-label-sm text-muted">
                  {file
                    ? `${fmtBytes(file.size)} — ready to upload`
                    : 'The file this page produced: casino-platform-<date>.tar.gz'}
                </span>
              </span>
              <span className="t-label-sm text-gold whitespace-nowrap">
                {file ? 'Change' : 'Browse'}
              </span>
              <input
                type="file"
                accept=".gz,.tar.gz,.tgz,application/gzip"
                className="hidden"
                disabled={busy}
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          <div>
            <p className="t-label-md text-primary mb-2">2. Confirm</p>
            <TextInput
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type RESTORE to enable the button"
              disabled={busy}
              className="t-mono"
            />
            <p className="t-label-sm text-muted mt-2">
              You will be asked for your password once more before anything is uploaded.
            </p>
          </div>

          <button
            type="button"
            disabled={busy || !file || confirmText !== 'RESTORE' || !isSuperAdmin}
            onClick={() => void restore()}
            className="w-full h-12 rounded-lg bg-red t-label-lg text-white disabled:opacity-40 active:scale-[0.98]"
          >
            {phase === 'idle' && 'Restore everything from this file'}
            {phase === 'checking' && 'Waiting for your password…'}
            {phase === 'uploading' && `Uploading… ${percent}%`}
            {phase === 'restoring' && `Restoring… ${percent >= 100 ? 99 : percent}%`}
          </button>

          {busy && (
            <div>
              <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
                <div
                  className="h-full bg-gold transition-all"
                  style={{ width: `${Math.max(3, Math.min(100, percent))}%` }}
                />
              </div>
              <p className="t-label-sm text-muted mt-2">
                {phase === 'uploading'
                  ? stage ||
                    'Sending the file in small pieces — a dropped piece is retried, so a slow connection is fine.'
                  : phase === 'restoring'
                    ? stage ||
                      'The server is wiping and rewriting every table, then putting the images back.'
                    : 'Confirm your password in the dialog to continue.'}
              </p>
            </div>
          )}

          {result && (
            <div className="rounded-lg bg-layer-elevated border border-green/25 p-4">
              <p className="t-label-md text-green mb-2">✓ Restore complete</p>
              <p className="t-label-sm text-secondary mb-2">
                {Object.values(result.tables).reduce((a, b) => a + b, 0).toLocaleString('en-US')}{' '}
                rows across {Object.keys(result.tables).length} tables
                {result.objects.total > 0 &&
                  ` · ${result.objects.restored.toLocaleString('en-US')} images restored`}
                {result.objects.failed > 0 &&
                  ` · ${result.objects.failed} images could not be restored (the new database is still intact — upload those images again from their records)`}
                .
              </p>
              <p className="t-label-sm text-muted">
                The admin accounts now come from the backup — if you are still signed in, sign out
                and back in with the password that backup used.
              </p>
            </div>
          )}
        </div>
      </div>
      {stepUp.modal}
    </>
  );
}

// ── OTHER OPTIONS ──────────────────────────────────────────────────────────
function OtherOptions() {
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);

  const download = (path: string, fallbackName: string) => {
    void (async () => {
      try {
        const res = await fetch(`${apiBaseUrl()}${path}`, { credentials: 'include' });
        if (!res.ok) {
          notify.error('Export failed');
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fallbackName;
        a.click();
        URL.revokeObjectURL(url);
        notify.success('Download started');
      } catch (e) {
        notify.error((e as Error).message);
      }
    })();
  };

  const restoreLegacyJson = async () => {
    if (!jsonFile || confirmText !== 'RESTORE') {
      notify.error('Type RESTORE and choose a file');
      return;
    }
    if (jsonFile.size > 512 * 1024 * 1024) {
      notify.error(
        `That file is ${(jsonFile.size / 1024 / 1024).toFixed(0)} MB — too large for the browser to parse. ` +
          'Use the one-file restore above instead.'
      );
      return;
    }
    setRestoring(true);
    try {
      const data = JSON.parse(await jsonFile.text()) as Record<string, unknown>;
      const res = await http.post<Record<string, number>>(
        '/panel/backup/restore-json',
        { data, confirm: 'RESTORE' },
        // The API budgets 15 minutes (RESTORE_TX_TIMEOUT_MS); the 15 s default
        // would abort the browser long before the server finished.
        { timeoutMs: 15 * 60 * 1000 }
      );
      setResult(res);
      notify.success('Restore complete');
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <details className="rounded-xl bg-layer-surface border border-white/8">
      <summary className="cursor-pointer select-none px-5 py-4 t-label-lg text-primary">
        Other options — spreadsheets and the older JSON format
      </summary>
      <div className="px-5 pb-5 space-y-5">
        <div>
          <h3 className="t-label-md text-primary mb-1">Export rows for a spreadsheet</h3>
          <p className="t-label-sm text-muted mb-3">
            Database rows only — no images, and no encrypted payout details. Handy for reporting,
            useless for disaster recovery.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => download('/panel/backup/export-json', `casino-backup-${new Date().toISOString().slice(0, 10)}.json`)}
              className="h-11 px-5 rounded-lg bg-white/5 border border-white/10 t-label-md active:scale-95"
            >
              ⬇ Full database (JSON)
            </button>
            <button
              type="button"
              onClick={() => download('/panel/backup/export-csv?table=users', `users-${new Date().toISOString().slice(0, 10)}.csv`)}
              className="h-11 px-5 rounded-lg bg-white/5 border border-white/10 t-label-md active:scale-95"
            >
              ⬇ Players (CSV)
            </button>
            <button
              type="button"
              onClick={() => download('/panel/backup/export-csv?table=transactions', `transactions-${new Date().toISOString().slice(0, 10)}.csv`)}
              className="h-11 px-5 rounded-lg bg-white/5 border border-white/10 t-label-md active:scale-95"
            >
              ⬇ Transactions (CSV)
            </button>
          </div>
        </div>

        <div className="pt-4 border-t border-white/8">
          <h3 className="t-label-md text-primary mb-1">Restore an older JSON bundle</h3>
          <p className="t-label-sm text-muted mb-3">
            Only for a <code>.json</code> export from before this page produced one-file backups.
            The browser has to parse the whole file, so anything above a few hundred megabytes will
            fail here — use the one-file restore for those.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <input
              type="file"
              accept="application/json,.json"
              disabled={restoring}
              onChange={(e) => setJsonFile(e.target.files?.[0] ?? null)}
              className="w-full h-12 rounded-lg bg-layer-elevated border border-dashed border-white/15 text-secondary"
            />
            <TextInput
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type RESTORE to confirm"
              disabled={restoring}
            />
          </div>
          <button
            type="button"
            disabled={restoring || confirmText !== 'RESTORE' || !jsonFile}
            onClick={() => void restoreLegacyJson()}
            className="mt-3 h-11 px-5 rounded-lg bg-red/80 t-label-md text-white disabled:opacity-40 active:scale-95"
          >
            {restoring ? 'Restoring…' : 'Restore JSON bundle'}
          </button>
          {result && (
            <p className="t-label-sm text-muted mt-3">
              Restored rows —{' '}
              {Object.entries(result)
                .map(([t, n]) => `${t}: ${n}`)
                .join(' · ')}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

export function BackupPanel() {
  const { data: me } = useQuery({
    queryKey: ['panel-auth-me'],
    queryFn: () => http.get<{ isSuperAdmin?: boolean }>('/panel/auth/me'),
  });
  const isSuperAdmin = me?.isSuperAdmin === true;

  const {
    data: info,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['panel-backup-info'],
    queryFn: () => http.get<ArchiveInfo>('/panel/backup/archive-info'),
    enabled: isSuperAdmin,
  });

  return (
    <div className="space-y-6">
      <SaveCard isSuperAdmin={isSuperAdmin} info={info} loading={isLoading && isSuperAdmin} />

      <RestoreCard isSuperAdmin={isSuperAdmin} />
      <div className="flex justify-end -mt-3">
        <button type="button" onClick={() => void refetch()} className="t-label-sm text-muted hover:text-primary">
          Refresh the “what’s included” figures
        </button>
      </div>

      <div className="rounded-xl bg-layer-surface border border-white/8 p-4 flex flex-wrap items-center justify-between gap-3">
        <p className="t-label-sm text-secondary">
          <strong className="text-primary">Nightly automatic backups.</strong> The worker takes one
          every night and emails it to the address configured under email settings. Those only
          contain the database.
        </p>
        <Link
          href="/panel/settings/email"
          className="h-10 px-4 rounded-lg bg-white/5 border border-white/10 t-label-md inline-flex items-center"
        >
          Email settings →
        </Link>
      </div>

      <OtherOptions />
    </div>
  );
}
