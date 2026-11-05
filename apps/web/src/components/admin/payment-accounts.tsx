// apps/web/src/components/admin/payment-accounts.tsx — structured CRUD (D-068)
// Replaces the raw-JSON form that threw errors on any typo.
'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { notify } from '../../lib/toast';
import {
  Card,
  CardHead,
  Badge,
  ActionBtn,
  TextInput,
  Select,
  Field,
  Modal,
  Icon,
  Spinner,
  Toggle,
} from './ui';

interface Account {
  id: string;
  type: string;
  label: string;
  isActive: boolean;
  displayOrder: number;
  accountDetails:
    | { account_number?: string; holder?: string; bank?: string; iban?: string }
    | Record<string, unknown>;
}

interface FormState {
  type: string;
  label: string;
  accountNumber: string;
  holder: string;
  bank: string;
  iban: string;
  isActive: boolean;
  displayOrder: number;
}

const EMPTY: FormState = {
  type: 'mobile_wallet',
  label: '',
  accountNumber: '',
  holder: '',
  bank: '',
  iban: '',
  isActive: true,
  displayOrder: 0,
};

export function PaymentAccountsPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['panel-payacc'],
    queryFn: () => http.get<Account[]>('/panel/payment-accounts'),
  });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState<Account | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['panel-payacc'] });

  const create = useMutation({
    mutationFn: () => http.post('/panel/payment-accounts', form),
    onSuccess: () => {
      notify.success('Payment account added');
      setForm(EMPTY);
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const update = useMutation({
    // Take the target id explicitly: the row Activate/Deactivate button fires
    // this with NO account in edit state (`editing === null`), and the old
    // `editing!.id` here crashed with "Cannot read properties of null (id)".
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      http.patch(`/panel/payment-accounts/${id}`, patch),
    onSuccess: () => {
      notify.success('Updated');
      setEditing(null);
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => http.delete(`/panel/payment-accounts/${id}`),
    onSuccess: () => {
      notify.success('Deleted');
      invalidate();
    },
    onError: (e) => notify.error((e as Error).message),
  });

  const detailsOf = (a: Account) => {
    const d = (a.accountDetails ?? {}) as Record<string, unknown>;
    return {
      accountNumber: String(d.account_number ?? ''),
      holder: String(d.holder ?? ''),
      bank: String(d.bank ?? ''),
      iban: String(d.iban ?? ''),
    };
  };

  const set = (k: keyof FormState, v: string | boolean | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  const formValid =
    form.label.trim() && form.accountNumber.trim() && (!form.holder.trim() || true);

  return (
    <div className="space-y-6">
      {/* Add form */}
      <Card>
        <CardHead
          title="Add a payment account"
          icon="cards"
          right={
            <span className="t-label-sm text-muted">
              Shown to players on the deposit screen
            </span>
          }
        />
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="Type">
            <Select
              options={[
                {
                  value: 'mobile_wallet',
                  label: 'Mobile wallet (JazzCash / Easypaisa / SadaPay…)',
                },
                { value: 'bank', label: 'Bank account' },
              ]}
              value={form.type}
              onChange={(e) => set('type', e.target.value)}
            />
          </Field>
          <Field label="Display label">
            <TextInput
              placeholder="e.g. JazzCash 0301 2345678"
              value={form.label}
              onChange={(e) => set('label', e.target.value)}
            />
          </Field>
          <Field label="Account number / mobile number">
            <TextInput
              placeholder="0301 2345678"
              value={form.accountNumber}
              onChange={(e) => set('accountNumber', e.target.value)}
            />
          </Field>
          <Field label="Account holder name">
            <TextInput
              placeholder="Brand Pvt Ltd"
              value={form.holder}
              onChange={(e) => set('holder', e.target.value)}
            />
          </Field>
          {form.type === 'bank' && (
            <>
              <Field label="Bank name">
                <TextInput
                  placeholder="Meezan Bank"
                  value={form.bank}
                  onChange={(e) => set('bank', e.target.value)}
                />
              </Field>
              <Field label="IBAN (optional)">
                <TextInput
                  placeholder="PK36 MEZN 0001 2345 6789 01"
                  value={form.iban}
                  onChange={(e) => set('iban', e.target.value)}
                />
              </Field>
            </>
          )}
          <div className="flex items-end gap-4 pb-1">
            <div>
              <p className="t-label-md text-secondary mb-1.5">Active</p>
              <Toggle checked={form.isActive} onChange={(v) => set('isActive', v)} />
            </div>
            <div className="w-24">
              <Field label="Sort order">
                <TextInput
                  type="number"
                  value={form.displayOrder}
                  onChange={(e) => set('displayOrder', Number(e.target.value) || 0)}
                />
              </Field>
            </div>
          </div>
          <div className="flex items-end">
            <ActionBtn
              tone="solid"
              disabled={!formValid || create.isPending}
              onClick={() => create.mutate()}
            >
              <Icon name="plus" size={15} /> Add account
            </ActionBtn>
          </div>
        </div>
        {create.isError && (
          <p className="t-label-sm text-red mt-3">{(create.error as Error).message}</p>
        )}
      </Card>

      {/* List */}
      <Card pad={false}>
        <CardHead title={`Payment accounts (${data?.length ?? 0})`} icon="ledger" />
        {isLoading && <Spinner label="Loading accounts…" />}
        {!isLoading && (
          <div className="divide-y divide-white/5">
            {(data ?? []).map((a) => {
              const d = detailsOf(a);
              return (
                <div key={a.id} className="px-5 py-4 flex flex-wrap items-center gap-4">
                  <span
                    className={`h-10 w-10 rounded-xl flex items-center justify-center ${a.type === 'bank' ? 'bg-sky-400/12 text-sky-300' : 'bg-gold/12 text-gold'}`}
                  >
                    <Icon name={a.type === 'bank' ? 'legal' : 'wallet'} size={17} />
                  </span>
                  <div className="min-w-[200px] flex-1">
                    <div className="flex items-center gap-2">
                      <p className="t-label-md text-white/90">{a.label}</p>
                      <Badge color={a.isActive ? 'green' : 'white'}>
                        {a.isActive ? 'active' : 'off'}
                      </Badge>
                    </div>
                    <p className="t-label-sm text-muted t-mono">
                      {d.accountNumber}
                      {d.bank ? ` · ${d.bank}` : ''}
                      {d.holder ? ` · ${d.holder}` : ''}
                      {d.iban ? ` · ${d.iban}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ActionBtn
                      size="sm"
                      onClick={() =>
                        update.mutate({ id: a.id, patch: { isActive: !a.isActive } })
                      }
                    >
                      {a.isActive ? 'Deactivate' : 'Activate'}
                    </ActionBtn>
                    <ActionBtn
                      size="sm"
                      tone="gold"
                      onClick={() => setEditing({ ...a, accountDetails: d as never })}
                    >
                      <Icon name="edit" size={13} /> Edit
                    </ActionBtn>
                    <ActionBtn
                      size="sm"
                      tone="danger"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete "${a.label}"? Past deposits keep their records.`
                          )
                        )
                          remove.mutate(a.id);
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </ActionBtn>
                  </div>
                </div>
              );
            })}
            {data?.length === 0 && (
              <p className="py-10 text-center t-label-sm text-muted">
                No payment accounts yet — add your first one above.
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Edit modal */}
      {editing && (
        <EditModal
          acc={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => update.mutate({ id: editing!.id, patch })}
        />
      )}
    </div>
  );
}

function EditModal({
  acc,
  onClose,
  onSave,
}: {
  acc: Account;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const d = (acc.accountDetails ?? {}) as Record<string, unknown>;
  const [label, setLabel] = useState(acc.label);
  const [accountNumber, setAccountNumber] = useState(String(d.account_number ?? ''));
  const [holder, setHolder] = useState(String(d.holder ?? ''));
  const [bank, setBank] = useState(String(d.bank ?? ''));
  const [iban, setIban] = useState(String(d.iban ?? ''));
  const [order, setOrder] = useState(acc.displayOrder);

  const save = () => {
    if (!label.trim() || !accountNumber.trim()) {
      notify.error('Label and account number are required');
      return;
    }
    onSave({
      label,
      accountNumber,
      holder,
      bank,
      iban,
      displayOrder: Number(order) || 0,
    });
  };

  return (
    <Modal open onClose={onClose} title={`Edit — ${acc.label}`} width="max-w-lg">
      <div className="space-y-4">
        <Field label="Display label">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Account number / mobile number">
          <TextInput
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
          />
        </Field>
        <Field label="Account holder name">
          <TextInput value={holder} onChange={(e) => setHolder(e.target.value)} />
        </Field>
        {acc.type === 'bank' && (
          <>
            <Field label="Bank name">
              <TextInput value={bank} onChange={(e) => setBank(e.target.value)} />
            </Field>
            <Field label="IBAN">
              <TextInput value={iban} onChange={(e) => setIban(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Sort order">
          <TextInput
            type="number"
            value={order}
            onChange={(e) => setOrder(Number(e.target.value) || 0)}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <ActionBtn onClick={onClose}>Cancel</ActionBtn>
          <ActionBtn tone="solid" onClick={save}>
            <Icon name="check" size={14} /> Save changes
          </ActionBtn>
        </div>
      </div>
    </Modal>
  );
}
