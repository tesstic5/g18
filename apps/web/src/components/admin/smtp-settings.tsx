// apps/web/src/components/admin/smtp-settings.tsx
// The email/SMTP card that used to be wedged into the bottom of Backup &
// Restore. It configures where the NIGHTLY backup is emailed — which is not
// what anyone opens the Backup page to do, and it pushed the two buttons that
// matter (download, restore) off the screen.
'use client';
import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';
import { Card, CardHead, Badge, Field, TextInput, Toggle, Spinner } from './ui';

/** The SMTP card's editable fields — mirrors services/smtpSettings.ts. */
interface SmtpForm {
  backup_email_enabled: boolean;
  smtp_host: string;
  smtp_port: string;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password: string;
  smtp_from: string;
  backup_email_to: string;
  smtp_require_tls: boolean;
  smtp_allow_self_signed: boolean;
}

const EMPTY_SMTP: SmtpForm = {
  backup_email_enabled: true,
  smtp_host: '',
  smtp_port: '587',
  smtp_secure: false,
  smtp_user: '',
  smtp_password: '',
  smtp_from: '',
  backup_email_to: '',
  smtp_require_tls: true,
  smtp_allow_self_signed: false,
};

/** Gmail, Outlook and a generic relay, filled in with one click. */
const PRESETS: Array<{ label: string; patch: Partial<SmtpForm> }> = [
  {
    label: 'Gmail',
    patch: { smtp_host: 'smtp.gmail.com', smtp_port: '587', smtp_secure: false },
  },
  {
    label: 'Gmail (SSL)',
    patch: { smtp_host: 'smtp.gmail.com', smtp_port: '465', smtp_secure: true },
  },
  {
    label: 'Outlook / Office 365',
    patch: { smtp_host: 'smtp.office365.com', smtp_port: '587', smtp_secure: false },
  },
  {
    label: 'Brevo',
    patch: { smtp_host: 'smtp-relay.brevo.com', smtp_port: '587', smtp_secure: false },
  },
  {
    label: 'Mailgun',
    patch: { smtp_host: 'smtp.mailgun.org', smtp_port: '587', smtp_secure: false },
  },
];

export function SmtpSettings() {
  const qc = useQueryClient();
  const [form, setForm] = useState<SmtpForm>(EMPTY_SMTP);
  const [passwordSet, setPasswordSet] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['panel-smtp-settings'],
    queryFn: () => http.get<Record<string, unknown>>('/panel/settings'),
  });

  // Hydrate the form once, when the settings arrive.
  useEffect(() => {
    if (!data) return;
    setForm({
      backup_email_enabled: data.backup_email_enabled !== false,
      smtp_host: String(data.smtp_host ?? ''),
      smtp_port: String(data.smtp_port ?? 587),
      smtp_secure: data.smtp_secure === true,
      smtp_user: String(data.smtp_user ?? ''),
      smtp_password: '',
      smtp_from: String(data.smtp_from ?? ''),
      backup_email_to: String(data.backup_email_to ?? ''),
      smtp_require_tls: data.smtp_require_tls !== false,
      smtp_allow_self_signed: data.smtp_allow_self_signed === true,
    });
    setPasswordSet(data.smtp_password_set === true);
    setTestTo((prev) => prev || String(data.backup_email_to ?? ''));
  }, [data]);

  const set = <K extends keyof SmtpForm>(k: K, v: SmtpForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  /** Payload shared by save + test. The password is only sent when retyped. */
  const payload = () => {
    const p: Record<string, unknown> = {
      backup_email_enabled: form.backup_email_enabled,
      smtp_host: form.smtp_host.trim(),
      smtp_port: Number(form.smtp_port) || 587,
      smtp_secure: form.smtp_secure,
      smtp_user: form.smtp_user.trim(),
      smtp_from: form.smtp_from.trim(),
      backup_email_to: form.backup_email_to.trim(),
      smtp_require_tls: form.smtp_require_tls,
      smtp_allow_self_signed: form.smtp_allow_self_signed,
    };
    if (form.smtp_password.trim() !== '') p.smtp_password = form.smtp_password;
    return p;
  };

  const save = useMutation({
    mutationFn: () => http.patch('/panel/settings', payload()),
    onSuccess: () => {
      notify.success('Email settings saved');
      setForm((f) => ({ ...f, smtp_password: '' }));
      setPasswordSet((prev) => prev || form.smtp_password.trim() !== '');
      qc.invalidateQueries({ queryKey: ['panel-smtp-settings'] });
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const test = useMutation({
    mutationFn: () =>
      http.post<{ ok: boolean; error?: string; accepted?: string[] }>('/panel/settings/smtp-test', {
        to: testTo.trim() || undefined,
        settings: payload(),
      }),
    onSuccess: (res) => {
      setTestResult(
        res.ok
          ? { ok: true, text: `Test email sent to ${(res.accepted ?? []).join(', ')}` }
          : { ok: false, text: res.error ?? 'Failed' }
      );
    },
    onError: (e) => setTestResult({ ok: false, text: (e as Error).message }),
  });

  if (isLoading) return <Spinner label="Loading email settings…" />;

  return (
    <Card>
      <CardHead
        title="Email delivery"
        icon="bell"
        right={
          passwordSet ? (
            <Badge color="green">password saved</Badge>
          ) : (
            <Badge color="gold">not configured</Badge>
          )
        }
      />
      <p className="t-label-sm text-muted mb-4">
        The nightly encrypted backup is emailed here. For Gmail, enable 2-step verification and
        create an <strong>App Password</strong> — a normal account password will be rejected.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => setForm((f) => ({ ...f, ...preset.patch }))}
            className="h-9 px-3 rounded-lg bg-white/5 border border-white/10 t-label-sm active:scale-95"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="SMTP host" hint="e.g. smtp.gmail.com — hostname only, no https://">
          <TextInput
            value={form.smtp_host}
            onChange={(e) => set('smtp_host', e.target.value)}
            placeholder="smtp.gmail.com"
          />
        </Field>
        <Field label="Port" hint="587 = STARTTLS (recommended), 465 = SSL">
          <TextInput
            type="number"
            value={form.smtp_port}
            onChange={(e) => set('smtp_port', e.target.value)}
            placeholder="587"
          />
        </Field>
        <Field label="Username" hint="Usually the full email address">
          <TextInput
            value={form.smtp_user}
            onChange={(e) => set('smtp_user', e.target.value)}
            placeholder="you@gmail.com"
          />
        </Field>
        <Field
          label="Password / App password"
          hint={passwordSet ? 'Saved — leave blank to keep it' : 'Gmail: 16-character app password'}
        >
          <TextInput
            type="password"
            autoComplete="new-password"
            value={form.smtp_password}
            onChange={(e) => set('smtp_password', e.target.value)}
            placeholder={passwordSet ? '••••••••  (unchanged)' : 'app password'}
          />
        </Field>
        <Field label="From address" hint="What recipients see as the sender">
          <TextInput
            value={form.smtp_from}
            onChange={(e) => set('smtp_from', e.target.value)}
            placeholder="backups@yourdomain.com"
          />
        </Field>
        <Field label="Send backups to" hint="Comma-separate for several recipients">
          <TextInput
            value={form.backup_email_to}
            onChange={(e) => set('backup_email_to', e.target.value)}
            placeholder="you@yourdomain.com"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-6 mt-4">
        <Toggle
          checked={form.backup_email_enabled}
          onChange={(v) => set('backup_email_enabled', v)}
          label="Email the nightly backup"
        />
        <Toggle
          checked={form.smtp_secure}
          onChange={(v) => set('smtp_secure', v)}
          label="Use SSL (port 465)"
        />
        <Toggle
          checked={form.smtp_require_tls}
          onChange={(v) => set('smtp_require_tls', v)}
          label="Require encryption"
        />
        <Toggle
          checked={form.smtp_allow_self_signed}
          onChange={(v) => set('smtp_allow_self_signed', v)}
          label="Allow self-signed certificate"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-6">
        <Field label="Send a test to" hint="Leave blank to use the address above">
          <TextInput
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@yourdomain.com"
          />
        </Field>
        <button
          type="button"
          disabled={test.isPending || save.isPending}
          onClick={() => {
            setTestResult(null);
            test.mutate();
          }}
          className="h-11 px-5 rounded-lg bg-white/5 border border-white/10 t-label-md active:scale-95 disabled:opacity-40"
        >
          {test.isPending ? 'Sending…' : 'Send test email'}
        </button>
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          className="h-11 px-5 rounded-lg bg-gold/15 border border-gold/30 text-gold t-label-md active:scale-95 disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : 'Save email settings'}
        </button>
      </div>

      {testResult && (
        <div
          className={`mt-4 rounded-lg border p-3 t-label-sm ${
            testResult.ok ? 'border-green/30 bg-green/10 text-green' : 'border-red/30 bg-red/10 text-red'
          }`}
        >
          {testResult.ok ? '✓ ' : '✕ '}
          {testResult.text}
        </div>
      )}
    </Card>
  );
}

