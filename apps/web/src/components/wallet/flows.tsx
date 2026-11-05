// apps/web/src/components/wallet/flows.tsx — DepositFlow (6 steps) + WithdrawFlow (3 steps).
// Canonical: v4 WALLET & FINANCIAL FLOWS + v7 §5 presigned uploads + docs/19 §1 errors.
// D-071: redesigned proof picker (preview + retake), upload-failure no longer
// blocks the deposit (submits without proof + warns), balance refreshes after
// submit, and WithdrawFlow now uses ₨ instead of $.
'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { http, uploadProof } from '../../lib/api';
import { invalidate } from '../../lib/app';
import { socket } from '../../lib/app';
import { refreshBalance } from '../../stores';
import { notify } from '../../lib/toast';
import { parseDto, withdrawalFeeDto } from '../../lib/dto';

// v1.4.1: admin-set min/max bounds, fetched once per mount from the public
// /wallet/limits endpoint. Deposit/Withdraw sheets clamp + hint from these so
// the server-side 422 is almost never reached through normal clicking.
interface WalletLimits {
  minDeposit: number;
  maxDeposit: number;
  minWithdrawal: number;
  maxWithdrawal: number;
  withdrawalFeePercent: number;
  currencySymbol: string;
}
function useWalletLimits(): WalletLimits {
  const [lim, setLim] = useState<WalletLimits>({
    minDeposit: 10,
    maxDeposit: 100000,
    minWithdrawal: 500,
    maxWithdrawal: 100000,
    withdrawalFeePercent: 2,
    currencySymbol: process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨',
  });
  useEffect(() => {
    let dead = false;
    http
      .get<WalletLimits>('/wallet/limits')
      .then((l) => !dead && setLim(l))
      .catch(() => {}); // defaults already safe
    return () => {
      dead = true;
    };
  }, []);
  return lim;
}

// ── DEPOSIT — 1 amount → 2 pick account → 3 copy details + sender →
//    4 screenshot → 5 confirm → 6 pending card ─────────────────────────────
interface DepositPackage {
  id: string;
  name: string;
  price: number;
  credits: number;
  bonus: number;
  total: number;
  badge?: string | null;
  description?: string | null;
}

export function DepositFlow() {
  const limits = useWalletLimits();
  const params = useSearchParams();
  const returnedPayment = params.get('payfast');
  const [returnedStatus, setReturnedStatus] = useState<{
    id: string;
    amount: number;
    status: string;
  } | null>(null);
  const [returnError, setReturnError] = useState('');
  useEffect(() => {
    if (!returnedPayment) return;
    let alive = true;
    const load = () =>
      http
        .get<{ id: string; amount: number; status: string }>(
          `/payfast/status/${encodeURIComponent(returnedPayment)}`
        )
        .then((d) => {
          if (alive) {
            setReturnError('');
            setReturnedStatus(d);
            if (d.status === 'COMPLETED') void refreshBalance().catch(() => {});
          }
        })
        .catch((e) => {
          if (alive) setReturnError((e as Error).message);
        });
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [returnedPayment]);
  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState(50);
  // Admin-created top-up packages, shown first on the deposit page (which is
  // where signup lands). Picking one locks the amount to its price and carries
  // its bonus through to approval.
  const [packages, setPackages] = useState<DepositPackage[] | null>(null);
  const [pkg, setPkg] = useState<DepositPackage | null>(null);
  const [account, setAccount] = useState<PaymentAccount | null>(null);
  const [senderAccount, setSenderAccount] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [accounts] = useAccounts();
  const [payfastEnabled, setPayfastEnabled] = useState(false);
  const [payfastEnvironment, setPayfastEnvironment] = useState('uat');
  const [payfastEmail, setPayfastEmail] = useState('');
  useEffect(() => {
    http
      .get<{ enabled: boolean; environment: string }>('/payfast/config')
      .then((c) => {
        setPayfastEnabled(c.enabled);
        setPayfastEnvironment(c.environment);
      })
      .catch(() => {});
  }, []);
  const startPayfast = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const checkout = await http.post<{ id: string; launchUrl: string }>(
        '/payfast/checkout',
        {
          amount,
          packageId: pkg?.id,
          email: payfastEmail.trim(),
        }
      );
      window.location.assign(checkout.launchUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    let alive = true;
    http
      .get<DepositPackage[]>('/deposits/packages')
      .then((r) => {
        if (alive) setPackages(Array.isArray(r) ? r : []);
      })
      .catch(() => {
        if (alive) setPackages([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // preview URL for the picked screenshot (cleaned up on change/unmount)
  useEffect(() => {
    if (!proof) {
      setProofPreview(null);
      return;
    }
    const url = URL.createObjectURL(proof);
    setProofPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [proof]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // presigned upload (v7 §5): client → MinIO direct.
      // H-07: the proof receipt is REQUIRED server-side (a deposit without a
      // receipt is an unreviewable debt claim) — upload failure now blocks
      // submission with an actionable message instead of silently proceeding.
      if (!proof) {
        setError(
          'Please attach your payment screenshot — it is required so we can verify the transfer.'
        );
        setSubmitting(false);
        return;
      }
      let objectKey: string;
      try {
        objectKey = await uploadProof(proof);
      } catch (uploadErr) {
        // 2026-08-21 correction #8: do NOT erase the real reason. uploadProof()
        // already produces specific messages ("storage rejected (403)",
        // "direct failed …, relay failed …") — the old blanket catch replaced
        // ALL of them with one generic string, which made misconfigurations
        // indistinguishable from a bad file. Show the truth, keep the deposit
        // NOT submitted (H-07).
        setError(
          `${(uploadErr as Error)?.message || 'Screenshot upload failed.'} The deposit was NOT submitted.`
        );
        setSubmitting(false);
        return;
      }
      const dep = await http.post<{ id: string }>('/deposits/create', {
        amount,
        packageId: pkg?.id,
        paymentMethod: account?.id,
        accountLabel: account?.label,
        accountDetails: account?.accountDetails,
        senderAccount: senderAccount.trim() || undefined,
        proofObjectKey: objectKey,
      });
      setPendingId(dep.id);
      setStep(6); // pending status card
      notify.success('Deposit submitted for review');
      void refreshBalance().catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (returnedPayment) {
    if (returnError)
      return (
        <p role="alert" className="text-orange">
          {returnError}
        </p>
      );
    if (!returnedStatus) return <p>Loading payment status…</p>;
    return (
      <DepositStatusCard
        key={returnedStatus.status}
        depositId={returnedStatus.id}
        amount={returnedStatus.amount}
        initialStatus={returnedStatus.status as 'PENDING' | 'COMPLETED' | 'REJECTED'}
      />
    );
  }

  if (step === 6 && pendingId)
    return <DepositStatusCard depositId={pendingId} amount={amount} />;

  return (
    <div className="space-y-6">
      {/* STEP 1: PACKAGES + AMOUNT */}
      {step === 1 && (
        <>
          {packages && packages.length > 0 && (
            <div className="space-y-2">
              <h2 className="t-label-xl text-primary">Top-up packages</h2>
              <p className="t-label-sm text-secondary">
                Pick a package for extra bonus credit, or enter your own amount below.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {packages.map((p) => {
                  const active = pkg?.id === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        setPkg(active ? null : p);
                        setAmount(active ? amount : p.price);
                      }}
                      aria-pressed={active}
                      className={`relative rounded-xl border-2 p-3 text-left transition-all active:scale-[0.98] ${active ? 'border-gold bg-gold/10 shadow-[0_0_18px_rgba(245,200,66,0.25)]' : 'border-white/10 bg-layer-elevated'}`}
                    >
                      {p.badge && (
                        <span className="absolute -top-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-black bg-gold text-[#3d2800]">
                          {p.badge}
                        </span>
                      )}
                      <p className="t-label-md text-primary font-bold">{p.name}</p>
                      <p className="t-num-lg text-gold leading-tight">
                        ₨{p.price.toLocaleString()}
                      </p>
                      {p.bonus > 0 ? (
                        <p className="t-label-sm text-green leading-tight">
                          +₨{p.bonus.toLocaleString()} bonus
                        </p>
                      ) : (
                        <p className="t-label-sm text-white/35 leading-tight">
                          no bonus
                        </p>
                      )}
                      <p className="t-label-sm text-white/45 leading-tight">
                        you get ₨{p.total.toLocaleString()}
                      </p>
                      {p.description && (
                        <p className="t-label-sm text-white/35 mt-1 leading-tight">
                          {p.description}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <h2 className="t-label-xl text-primary">
            {pkg ? 'Amount (set by your package)' : 'Or enter an amount'}
          </h2>
          <div className="grid grid-cols-3 gap-2">
            {[100, 500, 1000, 5000, 10000, 50000].map((a) => (
              <button
                key={a}
                disabled={!!pkg}
                onClick={() => setAmount(a)}
                className={`h-12 rounded-lg t-num-lg disabled:opacity-35 ${amount === a && !pkg ? 'bg-gold/15 border-gold/40 text-gold' : 'bg-layer-elevated text-white/70'}`}
              >
                ₨{a.toLocaleString()}
              </button>
            ))}
          </div>
          <input
            type="number"
            value={amount}
            disabled={!!pkg}
            min={limits.minDeposit}
            max={limits.maxDeposit}
            onChange={(e) => setAmount(+e.target.value)}
            className="w-full h-12 rounded-lg bg-layer-elevated border border-white/10 t-num-lg text-center outline-none disabled:opacity-60"
          />
          {/* v1.4.1: live min/max hint from the admin-set window */}
          <p className="t-label-sm text-secondary text-center">
            {limits.currencySymbol}
            {limits.minDeposit.toLocaleString()} – {limits.currencySymbol}
            {limits.maxDeposit.toLocaleString()}
            {amount < limits.minDeposit && (
              <span className="text-orange"> · below min</span>
            )}
            {amount > limits.maxDeposit && (
              <span className="text-orange"> · above max</span>
            )}
          </p>
          {pkg && (
            <p className="t-label-sm text-secondary text-center">
              {pkg.name} — pay ₨{pkg.price.toLocaleString()}, receive ₨
              {pkg.total.toLocaleString()}.{' '}
              <button className="text-gold underline" onClick={() => setPkg(null)}>
                Choose a different amount
              </button>
            </p>
          )}
          {payfastEnabled && (
            <div className="space-y-2">
              <label className="t-label-sm text-secondary" htmlFor="payfast-email">
                Email for PayFast checkout {payfastEnvironment === 'uat' ? '(UAT)' : ''}
              </label>
              <input
                id="payfast-email"
                type="email"
                value={payfastEmail}
                onChange={(e) => setPayfastEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-white/10 bg-transparent p-3"
              />
              <button
                type="button"
                disabled={
                  submitting ||
                  !payfastEmail ||
                  amount < limits.minDeposit ||
                  amount > limits.maxDeposit
                }
                onClick={() => void startPayfast()}
                className="w-full rounded-lg bg-gold p-3 text-black disabled:opacity-50"
              >
                {submitting
                  ? 'Opening checkout…'
                  : `Pay with PayFast${payfastEnvironment === 'uat' ? ' (test)' : ''}`}
              </button>
              <p className="t-label-sm text-secondary">
                {payfastEnvironment === 'uat' ? 'Test payments only. ' : ''}Balance
                updates after independent gateway verification. Or continue below with a
                manual transfer.
              </p>
              {error && (
                <p role="alert" className="text-orange">
                  {error}
                </p>
              )}
            </div>
          )}
          <Next onNext={() => setStep(2)} />
        </>
      )}

      {/* STEP 2: PICK ACCOUNT (from admin panel) */}
      {step === 2 && (
        <>
          <h2 className="t-label-xl text-primary">Select Payment Account</h2>
          <p className="t-label-sm text-secondary mb-3">
            Choose the account you'll send money to:
          </p>
          {!accounts || accounts.length === 0 ? (
            <p className="t-label-md text-muted py-8 text-center">
              No payment accounts available yet — please try again later.
            </p>
          ) : (
            <div className="space-y-2">
              {(accounts ?? []).map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    setAccount(a);
                    setStep(3);
                  }}
                  className="w-full h-16 px-4 rounded-xl bg-layer-elevated border border-white/10 flex items-center justify-between hover:border-gold/40 active:scale-[0.99] transition-all"
                >
                  <div className="text-left">
                    <p className="t-label-lg text-primary">{a.label}</p>
                    <p className="t-label-sm text-muted capitalize">
                      {a.type === 'mobile_wallet'
                        ? '📱 Mobile wallet'
                        : a.type === 'bank'
                          ? '🏦 Bank account'
                          : a.type}
                    </p>
                  </div>
                  <span className="text-white/30">›</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* STEP 3: ACCOUNT DETAILS (copy-paste) + SENDER ACCOUNT */}
      {step === 3 && account && (
        <>
          <h2 className="t-label-xl text-primary">Pay to {account.label}</h2>
          <div className="rounded-xl bg-layer-elevated border border-gold/20 p-4 space-y-3">
            <p className="t-label-md text-secondary">
              Send exactly{' '}
              <span className="text-gold t-num-lg">₨{amount.toLocaleString()}</span> to:
            </p>
            {Object.entries(account.accountDetails ?? {}).map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between gap-2 bg-layer-surface border border-white/8 rounded-lg px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="t-label-sm text-muted capitalize">
                    {k.replace(/_/g, ' ')}
                  </p>
                  <p className="t-mono text-primary text-sm break-all">{String(v)}</p>
                </div>
                <button
                  aria-label={`Copy ${k}`}
                  onClick={() => copy(String(v))}
                  className="shrink-0 h-9 px-3 rounded-lg bg-gold/15 border border-gold/30 text-gold t-label-sm active:scale-95"
                >
                  Copy
                </button>
              </div>
            ))}
            <p className="t-label-sm text-muted">
              After paying, add a note with your reference (optional):
            </p>
            <button
              className="t-label-sm text-gold underline"
              onClick={() => copy(`REF-${Date.now()}`)}
            >
              Copy reference
            </button>
          </div>

          <div>
            <label className="t-label-md text-secondary block mb-1">
              Your account number you paid from
            </label>
            <input
              value={senderAccount}
              onChange={(e) => setSenderAccount(e.target.value)}
              maxLength={64}
              placeholder="e.g. 0345-1234567"
              className="w-full h-12 rounded-lg bg-layer-elevated border border-white/10 t-num-md outline-none px-3 focus:border-gold/40"
            />
          </div>

          <Next onNext={() => setStep(4)} disabled={!senderAccount.trim()} />
        </>
      )}

      {/* STEP 4: PROOF SCREENSHOT — D-071 redesigned picker with preview */}
      {step === 4 && (
        <>
          <h2 className="t-label-xl text-primary">Upload Payment Screenshot</h2>
          <p className="t-label-sm text-secondary mb-3">
            Attach the screenshot of your transfer so we can confirm it faster.
          </p>

          <label className="block cursor-pointer">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => setProof(e.target.files?.[0] ?? null)}
            />
            {proofPreview ? (
              <div className="relative rounded-xl overflow-hidden border border-gold/40 bg-layer-elevated">
                <img
                  src={proofPreview}
                  alt="Payment proof preview"
                  className="w-full max-h-64 object-contain"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-3 bg-gradient-to-t from-black/80 to-transparent">
                  <span className="t-label-sm text-white/85 truncate">
                    ✓ {proof?.name} · {(proof!.size / 1e6).toFixed(2)} MB
                  </span>
                  <span className="shrink-0 h-8 px-3 rounded-lg bg-white/15 border border-white/20 text-white t-label-sm flex items-center">
                    Tap to change
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/20 bg-layer-elevated hover:border-gold/50 hover:bg-gold/5 transition-colors py-10">
                <span className="text-4xl">📷</span>
                <p className="t-label-lg text-primary">Tap to choose a screenshot</p>
                <p className="t-label-sm text-muted">JPG, PNG or WebP — max 5 MB</p>
              </div>
            )}
          </label>

          {proof && (
            <button
              onClick={() => setProof(null)}
              className="w-full h-10 t-label-md text-red/80 underline"
            >
              ✕ Remove screenshot
            </button>
          )}
          {error && <p className="t-label-sm text-red">{error}</p>}
          <Next onNext={() => setStep(5)} disabled={!proof} />
        </>
      )}

      {/* STEP 5: CONFIRM & SUBMIT */}
      {step === 5 && account && (
        <>
          <h2 className="t-label-xl text-primary">Confirm Deposit</h2>
          <div className="rounded-xl bg-layer-elevated border border-white/8 p-4 space-y-2 t-label-md">
            <div className="flex justify-between">
              <span className="text-secondary">Amount</span>
              <span className="t-num-md text-gold">₨{amount.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">To</span>
              <span className="text-primary">{account.label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">From</span>
              <span className="text-primary">{senderAccount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-secondary">Screenshot</span>
              <span className="text-primary">{proof?.name ?? '—'}</span>
            </div>
          </div>
          {error && <p className="t-label-sm text-red">{error}</p>}
          <button disabled={submitting} onClick={submit} className="btn-primary w-full">
            {submitting ? 'Submitting…' : 'Confirm & Submit'}
          </button>
          <button
            onClick={() => setStep(4)}
            className="w-full h-11 t-label-md text-white/50 underline"
          >
            ← Back
          </button>
        </>
      )}
    </div>
  );
}

interface PaymentAccount {
  id: string;
  type: string;
  label: string;
  accountDetails: Record<string, string>;
}

// ── WITHDRAW — Step 1 amount+fee → 2 payout account → 3 confirm (D-074: real accounts) ──
interface PayoutAccount {
  id: string;
  type: string;
  label: string;
  isLocked: boolean;
  details?: Record<string, string>;
}
export function WithdrawFlow() {
  const limits = useWalletLimits();
  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState(50);
  const [account, setAccount] = useState<PayoutAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [fee, setFee] = useState<{ percent: number; fee: number; net: number }>({
    percent: 2,
    fee: 1,
    net: 49,
  });
  const [accounts, setAccounts] = useState<PayoutAccount[]>([]);
  const [form, setForm] = useState({
    type: 'mobile_wallet',
    label: '',
    accountNumber: '',
    holder: '',
    bank: '',
    iban: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{
    id: string;
    net: string;
    requiresReview: boolean;
  } | null>(null);

  const loadAccounts = async () => {
    try {
      const rows = await http.get<PayoutAccount[]>('/withdrawals/payout-accounts');
      setAccounts(rows);
    } catch {
      /* guest-safe */
    }
  };
  useEffect(() => {
    void loadAccounts();
  }, []);

  const preview = async (a: number) => {
    setAmount(a);
    try {
      const raw = await http.get<unknown>(`/withdrawals/fee-preview?amount=${a}`);
      setFee(parseDto(withdrawalFeeDto, raw, 'Withdrawal fee'));
    } catch {
      /* keep last fee */
    }
  };

  const createAccount = async () => {
    setFormError(null);
    if (!form.label.trim() || !form.accountNumber.trim()) {
      setFormError('Label and account number are required');
      return;
    }
    setSaving(true);
    try {
      await http.post('/withdrawals/payout-accounts', form);
      notify.success('Payout account added');
      setAdding(false);
      setForm({
        type: 'mobile_wallet',
        label: '',
        accountNumber: '',
        holder: '',
        bank: '',
        iban: '',
      });
      await loadAccounts();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const lockAccount = async (id: string) => {
    try {
      await http.patch(`/withdrawals/payout-accounts/${id}/lock`);
      notify.success('Account secured — contact support to change it');
      await loadAccounts();
    } catch (e) {
      notify.error((e as Error).message);
    }
  };

  const confirm = async () => {
    if (!account || submitting) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      const w = await http.post<{
        id: string;
        status: string;
        netAmount: string;
        requiresReview: boolean;
      }>('/withdrawals/create', { amount, payoutAccountId: account.id });
      notify.success('Withdrawal submitted');
      invalidate.transactions();
      void refreshBalance().catch(() => {});
      setSubmitted({
        id: w.id,
        net: w.netAmount,
        requiresReview: !!w.requiresReview,
      });
    } catch (e) {
      const msg = (e as Error).message || 'Withdrawal failed';
      setConfirmError(msg);
      notify.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted)
    return (
      <WithdrawStatusCard
        withdrawalId={submitted.id}
        amount={amount}
        net={submitted.net}
        requiresReview={submitted.requiresReview}
        accountLabel={account?.label ?? ''}
      />
    );

  return (
    <div className="space-y-6">
      {step === 1 && (
        <>
          <h2 className="t-label-xl text-primary">Amount</h2>
          <input
            type="number"
            value={amount}
            min={limits.minWithdrawal}
            max={limits.maxWithdrawal}
            onChange={(e) => preview(+e.target.value)}
            className="w-full h-12 rounded-lg bg-layer-elevated border border-white/10 t-num-lg text-center outline-none"
          />
          {/* v1.4.1: live min/max hint from the admin-set window */}
          <p className="t-label-sm text-secondary text-center">
            {limits.currencySymbol}
            {limits.minWithdrawal.toLocaleString()} – {limits.currencySymbol}
            {limits.maxWithdrawal.toLocaleString()}
            {amount < limits.minWithdrawal && (
              <span className="text-orange"> · below min</span>
            )}
            {amount > limits.maxWithdrawal && (
              <span className="text-orange"> · above max</span>
            )}
          </p>
          <div className="rounded-lg bg-layer-elevated p-3 t-label-md">
            <p className="text-secondary">
              Fee: {fee.percent}% ={' '}
              <span className="text-white/70">
                {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                {fee.fee.toFixed(2)}
              </span>
            </p>
            <p className="text-secondary">
              You receive:{' '}
              <span className="text-green t-num-md">
                {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
                {fee.net.toFixed(2)}
              </span>
            </p>
          </div>
          <Next onNext={() => setStep(2)} />
        </>
      )}

      {step === 2 && (
        <>
          <h2 className="t-label-xl text-primary">Payout Account</h2>
          {accounts.length > 0 && (
            <div className="space-y-2 mb-4">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    setAccount(a);
                    setStep(3);
                  }}
                  className={`w-full h-16 px-4 rounded-xl bg-layer-elevated border flex items-center justify-between transition-all ${account?.id === a.id ? 'border-gold/50 bg-gold/5' : 'border-white/10 hover:border-gold/40'}`}
                >
                  <div className="text-left">
                    <p className="t-label-lg text-primary">{a.label}</p>
                    <p className="t-label-sm text-muted t-mono">
                      {a.details?.account_number ?? ''}
                      {a.details?.bank ? ` · ${a.details.bank}` : ''}
                    </p>
                  </div>
                  <span className="t-label-sm text-gold">Choose ›</span>
                </button>
              ))}
            </div>
          )}

          {adding ? (
            <div className="rounded-xl bg-layer-elevated border border-white/10 p-4 space-y-3">
              <p className="t-label-lg text-primary">Add payout account</p>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full h-11 px-3 rounded-lg bg-layer-surface border border-white/10 outline-none t-label-md"
              >
                <option value="mobile_wallet">
                  📱 Mobile wallet (JazzCash/Easypaisa)
                </option>
                <option value="bank">🏦 Bank account</option>
              </select>
              <input
                placeholder="Label (e.g. JazzCash 0301…)"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                className="w-full h-11 px-3 rounded-lg bg-layer-surface border border-white/10 outline-none focus:border-gold/40"
              />
              <input
                placeholder="Account / mobile number"
                value={form.accountNumber}
                onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
                className="w-full h-11 px-3 rounded-lg bg-layer-surface border border-white/10 outline-none focus:border-gold/40 t-mono"
              />
              <input
                placeholder="Account holder name"
                value={form.holder}
                onChange={(e) => setForm({ ...form, holder: e.target.value })}
                className="w-full h-11 px-3 rounded-lg bg-layer-surface border border-white/10 outline-none focus:border-gold/40"
              />
              {form.type === 'bank' && (
                <>
                  <input
                    placeholder="Bank name"
                    value={form.bank}
                    onChange={(e) => setForm({ ...form, bank: e.target.value })}
                    className="w-full h-11 px-3 rounded-lg bg-layer-surface border border-white/10 outline-none focus:border-gold/40"
                  />
                  <input
                    placeholder="IBAN (optional)"
                    value={form.iban}
                    onChange={(e) => setForm({ ...form, iban: e.target.value })}
                    className="w-full h-11 px-3 rounded-lg bg-layer-surface border border-white/10 outline-none focus:border-gold/40 t-mono"
                  />
                </>
              )}
              {formError && <p className="t-label-sm text-red">{formError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => setAdding(false)}
                  className="btn-ghost flex-1 h-11"
                >
                  Cancel
                </button>
                <button
                  onClick={createAccount}
                  disabled={saving}
                  className="btn-primary flex-1 h-11"
                >
                  {saving ? 'Saving…' : 'Save account'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="w-full h-14 rounded-xl bg-layer-elevated border border-dashed border-gold/40 t-label-lg text-gold"
            >
              + Add Payout Account
            </button>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={() => setStep(1)} className="btn-ghost flex-1 h-11">
              ← Back
            </button>
            {account && (
              <button onClick={() => setStep(3)} className="btn-primary flex-1 h-11">
                Continue
              </button>
            )}
          </div>
        </>
      )}

      {step === 3 && account && (
        <>
          <h2 className="t-label-xl text-primary">Confirm</h2>
          <div className="rounded-xl bg-layer-surface border border-white/8 p-4 space-y-2">
            <Row k="Pay to" v={account.label} />
            {account.details?.account_number && (
              <Row k="Account" v={account.details.account_number} />
            )}
            <Row
              k="Amount"
              v={`${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${amount.toFixed(2)}`}
            />
            <Row
              k="Fee"
              v={`-${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${fee.fee.toFixed(2)}`}
            />
            <Row
              k="You receive"
              v={`${process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}${fee.net.toFixed(2)}`}
              gold
            />
          </div>
          {confirmError && <p className="t-label-sm text-red">{confirmError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => setStep(2)}
              disabled={submitting}
              className="btn-ghost flex-1 h-11"
            >
              ← Back
            </button>
            <button
              onClick={confirm}
              disabled={submitting}
              className="btn-primary flex-1 h-11"
            >
              {submitting ? 'Submitting…' : 'Confirm Withdrawal'}
            </button>
          </div>
          <button
            onClick={() => lockAccount(account.id)}
            className="w-full h-10 t-label-sm text-white/40 underline"
          >
            🔒 Lock this account (no changes without support)
          </button>
        </>
      )}
    </div>
  );
}

// ── D-083: LIVE DEPOSIT STATUS — polls the API + listens to the socket so the
//    pending page auto-flips when an admin approves/rejects. Also refreshes the
//    balance the moment money lands.
function DepositStatusCard({
  depositId,
  amount,
  initialStatus = 'PENDING',
}: {
  depositId: string;
  amount: number;
  initialStatus?: 'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED';
}) {
  const [status, setStatus] = useState<
    'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED'
  >(initialStatus);
  const [notes, setNotes] = useState<string | null>(null);

  // socket: instant updates (deposit:status + notification:new for deposits)
  useEffect(() => {
    const onDep = (p: { id: string; status: string; notes?: string | null }) => {
      if (p.id !== depositId) return;
      setStatus(p.status as never);
      setNotes(p.notes ?? null);
      if (p.status === 'APPROVED' || p.status === 'COMPLETED')
        void refreshBalance().catch(() => {});
    };
    const onNotif = (n: { type?: string }) => {
      if (n.type !== 'deposit') return;
      void http
        .get<Array<{ id: string; status: string; notes?: string | null }>>('/deposits')
        .then((rows) => {
          const d = rows.find((r) => r.id === depositId);
          if (d && d.status !== 'PENDING') onDep(d);
        })
        .catch(() => {});
    };
    socket.on('deposit:status', onDep);
    socket.on('notification:new', onNotif);
    return () => {
      socket.off('deposit:status', onDep);
      socket.off('notification:new', onNotif);
    };
  }, [depositId]);

  // polling fallback (covers socket-less tabs)
  useEffect(() => {
    if (status !== 'PENDING') return;
    const iv = setInterval(() => {
      void http
        .get<Array<{ id: string; status: string; notes?: string | null }>>('/deposits')
        .then((rows) => {
          const d = rows.find((r) => r.id === depositId);
          if (d && d.status !== 'PENDING') {
            setStatus(d.status as never);
            setNotes(d.notes ?? null);
            if (d.status === 'APPROVED' || d.status === 'COMPLETED')
              void refreshBalance().catch(() => {});
          }
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(iv);
  }, [depositId, status]);

  if (status === 'APPROVED' || status === 'COMPLETED') {
    return (
      <div className="text-center py-10 animate-spring-in">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="t-label-xl text-green mb-2">Deposit Approved!</h2>
        <p className="t-body text-secondary mb-1">
          {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
          {amount.toLocaleString()} has been added to your balance.
        </p>
        <p className="t-body text-secondary mb-6">You can start playing right away.</p>
        <Link href="/games" className="btn-primary inline-flex px-8">
          Play now
        </Link>
      </div>
    );
  }
  if (status === 'REJECTED') {
    return (
      <div className="text-center py-10">
        <div className="text-5xl mb-4">❌</div>
        <h2 className="t-label-xl text-red mb-2">Deposit Rejected</h2>
        <p className="t-body text-secondary mb-2">
          We couldn't confirm your deposit of{' '}
          {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
          {amount.toLocaleString()}.
        </p>
        {notes && (
          <p className="t-body text-secondary mb-2">
            Reason: <span className="text-white/90">{notes}</span>
          </p>
        )}
        <p className="t-body text-secondary mb-6">
          If you believe this is a mistake, contact support with your deposit reference.
        </p>
        <a
          href={`/support?topic=deposit&refType=deposit&refId=${encodeURIComponent(depositId)}`}
          className="btn-outline-gold inline-flex px-8"
        >
          Contact support
        </a>
      </div>
    );
  }
  return (
    <div className="text-center py-10">
      <div className="text-5xl mb-4 animate-pulse">⏳</div>
      <h2 className="t-label-xl text-primary mb-2">Pending Review</h2>
      <p className="t-body text-secondary">
        Your deposit of {process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨'}
        {amount.toLocaleString()} is being verified.
      </p>
      <p className="t-body text-secondary">
        This page updates automatically the moment it's approved.
      </p>
      <p className="t-mono text-muted mt-4">Deposit #{depositId}</p>
      <a
        href={`/support?topic=deposit&refType=deposit&refId=${encodeURIComponent(depositId)}`}
        className="t-label-md text-gold underline inline-block mt-6"
      >
        Need help?
      </a>
    </div>
  );
}

function WithdrawStatusCard({
  withdrawalId,
  amount,
  net,
  requiresReview,
  accountLabel,
}: {
  withdrawalId: string;
  amount: number;
  net: string;
  requiresReview: boolean;
  accountLabel: string;
}) {
  const [status, setStatus] = useState<
    'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED'
  >('PENDING');
  const [notes, setNotes] = useState<string | null>(null);
  const sym = process.env.NEXT_PUBLIC_CURRENCY_SYMBOL || '₨';

  useEffect(() => {
    const onWd = (p: { id: string; status: string; notes?: string | null }) => {
      if (p.id !== withdrawalId) return;
      setStatus(p.status as never);
      setNotes(p.notes ?? null);
      if (p.status === 'REJECTED' || p.status === 'CANCELLED')
        void refreshBalance().catch(() => {});
    };
    const onNotif = (n: { type?: string }) => {
      if (n.type !== 'withdrawal') return;
      void http
        .get<
          Array<{
            id: string;
            status: string;
            notes?: string | null;
            rejectionReason?: string | null;
          }>
        >('/withdrawals')
        .then((rows) => {
          const w = rows.find((r) => r.id === withdrawalId);
          if (w && w.status !== 'PENDING')
            onWd({ ...w, notes: w.notes ?? w.rejectionReason ?? null });
        })
        .catch(() => {});
    };
    socket.on('withdrawal:status', onWd);
    socket.on('notification:new', onNotif);
    return () => {
      socket.off('withdrawal:status', onWd);
      socket.off('notification:new', onNotif);
    };
  }, [withdrawalId]);

  useEffect(() => {
    if (status !== 'PENDING' && status !== 'APPROVED') return;
    const iv = setInterval(() => {
      void http
        .get<
          Array<{
            id: string;
            status: string;
            notes?: string | null;
            rejectionReason?: string | null;
          }>
        >('/withdrawals')
        .then((rows) => {
          const w = rows.find((r) => r.id === withdrawalId);
          if (w && w.status !== status) {
            setStatus(w.status as never);
            setNotes(w.notes ?? w.rejectionReason ?? null);
            if (w.status === 'REJECTED' || w.status === 'CANCELLED')
              void refreshBalance().catch(() => {});
          }
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(iv);
  }, [withdrawalId, status]);

  if (status === 'COMPLETED') {
    return (
      <div className="text-center py-10 animate-spring-in">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="t-label-xl text-green mb-2">Withdrawal sent</h2>
        <p className="t-body text-secondary mb-1">
          {sym}
          {Number(net).toLocaleString()} is on its way to{' '}
          {accountLabel || 'your account'}.
        </p>
        <p className="t-body text-secondary mb-6">
          Gross {sym}
          {amount.toLocaleString()} · fee already deducted.
        </p>
        <Link href="/wallet" className="btn-primary inline-flex px-8">
          Back to wallet
        </Link>
      </div>
    );
  }
  if (status === 'REJECTED' || status === 'CANCELLED') {
    return (
      <div className="text-center py-10">
        <div className="text-5xl mb-4">❌</div>
        <h2 className="t-label-xl text-red mb-2">
          {status === 'CANCELLED' ? 'Withdrawal cancelled' : 'Withdrawal rejected'}
        </h2>
        <p className="t-body text-secondary mb-2">
          {sym}
          {amount.toLocaleString()} has been returned to your balance.
        </p>
        {notes && (
          <p className="t-body text-secondary mb-2">
            Reason: <span className="text-white/90">{notes}</span>
          </p>
        )}
        <div className="flex flex-col items-center gap-3 mt-4">
          <a
            href={`/support?topic=withdraw&refType=withdrawal&refId=${encodeURIComponent(withdrawalId)}`}
            className="btn-outline-gold inline-flex px-8"
          >
            Contact support
          </a>
          <Link href="/wallet" className="t-label-md text-gold underline">
            Back to wallet
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="text-center py-10">
      <div className="text-5xl mb-4 animate-pulse">⏳</div>
      <h2 className="t-label-xl text-primary mb-2">
        {status === 'APPROVED' ? 'Approved — paying out' : 'Withdrawal submitted'}
      </h2>
      <p className="t-body text-secondary">
        {sym}
        {amount.toLocaleString()} to {accountLabel || 'your payout account'}.
      </p>
      <p className="t-body text-secondary">
        You receive {sym}
        {Number(net).toLocaleString()} after the fee.
      </p>
      {requiresReview && status === 'PENDING' && (
        <p className="t-body text-secondary mt-2">
          New payout account — this one is flagged for extra review.
        </p>
      )}
      <p className="t-body text-secondary mt-2">
        This page updates automatically when it is processed.
      </p>
      <p className="t-mono text-muted mt-4">Withdrawal #{withdrawalId}</p>
      <Link href="/wallet" className="t-label-md text-gold underline inline-block mt-6">
        Back to wallet
      </Link>
    </div>
  );
}

function Row({ k, v, gold }: { k: string; v: string; gold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="t-label-md text-secondary">{k}</span>
      <span className={`t-num-md ${gold ? 'text-gold' : 'text-primary'}`}>{v}</span>
    </div>
  );
}
function Next({ onNext, disabled }: { onNext: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onNext} className="btn-primary w-full">
      Continue
    </button>
  );
}
function useAccounts() {
  // public endpoint (D-061) — the admin-only /payment-accounts would 403 for users
  const { data } = useQuery({
    queryKey: ['deposit-accounts'],
    queryFn: () => http.get<PaymentAccount[]>('/deposits/accounts'),
  });
  return [data];
}
import { useQuery } from '@tanstack/react-query';
function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}
