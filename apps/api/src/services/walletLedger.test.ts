// Regression test for the fail-closed wallet lock: lockWalletRow must THROW
// when the transaction client cannot run raw queries, never silently skip the
// FOR UPDATE lock on a money path.
import { describe, it, expect } from 'vitest';
import { lockWalletRow } from './walletLedger';

describe('lockWalletRow', () => {
  it('throws when the tx client has no $queryRaw (fail closed)', async () => {
    const fakeTx = {} as never;
    await expect(lockWalletRow('user-1', fakeTx)).rejects.toMatchObject({
      code: 'WAL_005',
    });
  });

  it('runs the FOR UPDATE lock when $queryRaw is available', async () => {
    const calls: string[] = [];
    const fakeTx = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(strings.join('?') + ' ' + values.join(','));
        return Promise.resolve([]);
      },
    } as never;
    await lockWalletRow('user-1', fakeTx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('FOR UPDATE');
    expect(calls[0]).toContain('user-1');
  });
});
