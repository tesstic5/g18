'use client';
import { useEffect, useState } from 'react';
import { http } from '../../../lib/api';
import { useStepUp } from '../../../components/admin/step-up';
import { PageHeader } from '../../../components/admin/ui';

type Config = Record<string, string | boolean | string[]>;
const fields: Array<[string, string, string]> = [
  ['merchantId', 'Merchant ID', 'Issued by PayFast'],
  ['merchantName', 'Merchant name', 'Approved business name'],
  ['securedKey', 'Secured key', 'Leave blank to keep the saved key'],
  ['storeId', 'Store / outlet ID (optional)', ''],
  ['publicApiOrigin', 'Public API origin', 'https://api.yourdomain.com (no path)'],
  ['frontendOrigin', 'Website origin', 'https://yourdomain.com (no path)'],
  ['checkoutTokenUrl', 'Hosted checkout token endpoint', 'Full GetAccessToken URL'],
  ['checkoutUrl', 'Hosted checkout POST endpoint', 'Full PostTransaction URL'],
  ['inquiryTokenUrl', 'Inquiry authentication endpoint', 'Full REST /token URL'],
  [
    'inquiryBaseUrl',
    'Inquiry REST base URL',
    'Base before /transaction/basket_id/{id}',
  ],
  ['inquiryTokenField', 'Access-token response field', 'token'],
  ['statusField', 'Inquiry status field', 'status_code'],
  ['basketField', 'Inquiry basket-ID field', 'basket_id'],
  ['transactionField', 'Inquiry transaction-ID field', 'transaction_id'],
  [
    'amountField',
    'Inquiry original merchant-amount field',
    'Enter field name confirmed by PayFast',
  ],
  ['currencyField', 'Inquiry currency field', 'Enter field name confirmed by PayFast'],
];
interface Pending {
  id: string;
  referenceNumber: string;
  amount: string;
  createdAt: string;
  payfastLastError: string | null;
  payfastLastCheckedAt: string | null;
}
export default function PayfastPage() {
  const stepUp = useStepUp();
  const [config, setConfig] = useState<Config | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [testBasket, setTestBasket] = useState('');
  const [testAmount, setTestAmount] = useState('');
  const load = async () => {
    const [c, p] = await Promise.all([
      http.get<Config & { missing: string[]; hasSecuredKey: boolean }>(
        '/panel/payfast/settings'
      ),
      http.get<Pending[]>('/panel/payfast/pending'),
    ]);
    const { missing: m, hasSecuredKey, ...values } = c;
    setConfig({ ...values, securedKey: '' });
    setHasKey(hasSecuredKey);
    setMissing(m);
    setPending(p);
  };
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, []);
  const save = async () => {
    if (!config) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const payload = {
        ...config,
        successCodes: (config.successCodes as string[])
          .map((s) => s.trim())
          .filter(Boolean),
        terminalFailureCodes: (config.terminalFailureCodes as string[])
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await stepUp.run(() => http.patch('/panel/payfast/settings', payload));
      await load();
      setMessage(
        'Settings saved. Complete the checklist and verify a real UAT payment before using production.'
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async (id: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await stepUp.run(() =>
        http.post<{ status: string }>(
          `/panel/payfast/reconcile/${encodeURIComponent(id)}`,
          {}
        )
      );
      setMessage(
        `Provider check result: ${result.status}. No credit is issued without matching authenticated inquiry data.`
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-6">
      {stepUp.modal}
      <PageHeader title="PayFast gateway setup" />
      <p className="text-sm text-secondary">
        Super-admin only. Secrets are encrypted at rest and never returned. Blank secret
        keeps the current key ({hasKey ? 'saved' : 'not saved'}). Configure only values
        supplied and approved by PayFast.
      </p>
      <div className="rounded-xl border border-amber-500/30 p-4 text-sm">
        <strong>
          {missing.length
            ? 'Not ready — automatic checkout is blocked'
            : 'Configuration complete — provider acceptance testing still required'}
        </strong>
        {missing.length > 0 && (
          <ul className="list-disc pl-5">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <p>
          Financial endpoint origins must be approved in the API deployment variable
          PAYFAST_ALLOWED_ORIGINS (comma-separated HTTPS origins). This prevents
          secret-bearing calls to arbitrary servers. Provider field names support dot
          notation for nested JSON. The authenticated inquiry must return original
          merchant amount, PKR currency, basket ID and transaction ID.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-green-400">
          {message}
        </p>
      )}
      {config && (
        <div className="space-y-4">
          <label className="block">
            Environment{' '}
            <select
              value={String(config.environment)}
              onChange={(e) => setConfig({ ...config, environment: e.target.value })}
              className="ml-3 rounded bg-zinc-900 p-2"
            >
              <option value="uat">UAT / sandbox</option>
              <option value="production">Production</option>
            </select>
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            {fields.map(([key, label, hint]) => (
              <label key={key} className="block text-sm">
                {label}
                <input
                  type={key === 'securedKey' ? 'password' : 'text'}
                  autoComplete="off"
                  value={String(config[key] ?? '')}
                  onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                  placeholder={hint}
                  className="mt-1 block w-full rounded border border-white/15 bg-transparent p-3"
                />
              </label>
            ))}
          </div>
          <label className="block text-sm">
            Final paid/captured status codes (comma separated, preserve leading zeroes)
            <input
              className="mt-1 block w-full rounded border border-white/15 bg-transparent p-3"
              value={(config.successCodes as string[]).join(',')}
              onChange={(e) =>
                setConfig({
                  ...config,
                  successCodes: e.target.value.split(',').map((s) => s.trim()),
                })
              }
              placeholder="Enter only provider-confirmed final success codes"
            />
          </label>
          <label className="block text-sm">
            Optional irrevocable final-failure codes (comma separated). Leave empty
            until PayFast confirms they cannot later succeed.
            <input
              className="mt-1 block w-full rounded border border-white/15 bg-transparent p-3"
              value={(config.terminalFailureCodes as string[]).join(',')}
              onChange={(e) =>
                setConfig({
                  ...config,
                  terminalFailureCodes: e.target.value.split(',').map((s) => s.trim()),
                })
              }
            />
          </label>
          <label className="flex gap-3">
            <input
              type="checkbox"
              checked={Boolean(config.providerConfirmed)}
              onChange={(e) =>
                setConfig({ ...config, providerConfirmed: e.target.checked })
              }
            />
            I have confirmed with PayFast that this merchant can query hosted-checkout
            orders through these endpoints and that the amount/currency fields and final
            success codes are correct. Business/use case approval and UAT certification
            are complete for the selected environment.
          </label>
          <label className="flex gap-3">
            <input
              type="checkbox"
              checked={Boolean(config.enabled)}
              onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
            />
            Enable NEW checkouts (turning this off does not stop settlement of existing
            payments)
          </label>
          <button
            disabled={busy}
            onClick={() => void save()}
            className="rounded bg-amber-400 px-5 py-3 text-black disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Save gateway configuration'}
          </button>
          <div className="rounded border border-white/10 p-3 text-sm">
            IPN URL: <code>{String(config.publicApiOrigin)}/api/v1/payfast/ipn</code>
            <br />
            Method: POST, form-encoded or JSON. HTTP 200 acknowledges receipt; only
            authenticated inquiry credits the wallet.
          </div>
        </div>
      )}
      <section className="space-y-3 rounded border border-white/10 p-4">
        <h2 className="text-lg font-semibold">
          Test saved inquiry settings (does not credit money)
        </h2>
        <input
          aria-label="Known provider basket ID"
          placeholder="Known UAT/production basket ID"
          value={testBasket}
          onChange={(e) => setTestBasket(e.target.value)}
          className="mr-3 rounded border bg-transparent p-3"
        />
        <input
          aria-label="Expected merchant amount"
          placeholder="Original merchant amount, e.g. 100.00"
          value={testAmount}
          onChange={(e) => setTestAmount(e.target.value)}
          className="mr-3 rounded border bg-transparent p-3"
        />
        <button
          disabled={busy || !testBasket || !testAmount}
          className="rounded border p-3 disabled:opacity-50"
          onClick={() => {
            setBusy(true);
            setError('');
            setMessage('');
            void stepUp
              .run(() =>
                http.post<{ verified: boolean; status: string; outcome: string }>(
                  '/panel/payfast/test-inquiry',
                  { basketId: testBasket, expectedAmount: testAmount }
                )
              )
              .then((r) =>
                setMessage(
                  `Inquiry verified: ${r.outcome}, status ${r.status}. No balance was changed.`
                )
              )
              .catch((e) => setError((e as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          Test inquiry
        </button>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Pending payments / reconciliation</h2>
        <p className="text-sm text-secondary">
          Oldest 50 shown. Automatic checks run every minute, with up to four orders per
          pass and a five-minute minimum recheck interval. Failed or ambiguous results
          stay pending; do not release reserved daily limits without provider
          confirmation. Legacy orders without credential snapshots require
          provider-assisted reconciliation.
        </p>
        <button
          disabled={busy}
          onClick={() => {
            void load().catch((e) => setError((e as Error).message));
          }}
          className="rounded border px-3 py-2"
        >
          Refresh
        </button>
        {pending.map((p) => (
          <div key={p.id} className="rounded border border-white/10 p-4">
            <div className="flex flex-wrap justify-between gap-3">
              <div>
                <strong>{p.referenceNumber}</strong> · PKR {p.amount}
                <br />
                <code className="text-xs">{p.id}</code>
                <p className="text-sm">
                  {p.payfastLastError || 'Awaiting provider check'}
                </p>
                <p className="text-xs">
                  Last checked: {p.payfastLastCheckedAt || 'not yet'}
                </p>
              </div>
              <button
                disabled={busy}
                onClick={() => void reconcile(p.id)}
                className="rounded border px-3 py-2 disabled:opacity-50"
              >
                Verify with provider now
              </button>
            </div>
          </div>
        ))}
        {!pending.length && <p>No pending PayFast orders.</p>}
      </section>
    </div>
  );
}
