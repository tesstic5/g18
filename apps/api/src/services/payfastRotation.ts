import { prisma } from '../db/prisma';
import { reencryptToCurrentKey } from '../lib/crypto-utils';
import { PAYFAST_SETTINGS_KEY } from './payfastSettings';
/** Include every PayFast encrypted field in the existing operator key rotation. */
export async function rotatePayfastSecrets(apply: boolean) {
  let rotated = 0;
  const failures: string[] = [];
  const settings = await prisma.setting.findUnique({
    where: { key: PAYFAST_SETTINGS_KEY },
  });
  if (settings && typeof settings.value === 'string') {
    try {
      const result = reencryptToCurrentKey(settings.value);
      if (result.kind === 'previous') {
        if (apply)
          await prisma.setting.updateMany({
            where: { key: PAYFAST_SETTINGS_KEY, updatedAt: settings.updatedAt },
            data: { value: result.value },
          });
        rotated++;
      }
    } catch {
      failures.push('payfast:settings');
    }
  }
  const rows = await prisma.deposit.findMany({
    where: {
      paymentMethod: 'PAYFAST',
      OR: [
        { payfastConfigSnapshot: { not: null } },
        { payfastLaunchData: { not: null } },
      ],
    },
    select: { id: true, payfastConfigSnapshot: true, payfastLaunchData: true },
  });
  for (const row of rows)
    for (const field of ['payfastConfigSnapshot', 'payfastLaunchData'] as const) {
      const value = row[field];
      if (!value) continue;
      try {
        const result = reencryptToCurrentKey(value);
        if (result.kind !== 'previous') continue;
        // Compare-and-swap avoids overwriting a launch consumed during rotation.
        if (apply)
          await prisma.deposit.updateMany({
            where: { id: row.id, [field]: value },
            data: { [field]: result.value },
          });
        rotated++;
      } catch {
        failures.push(`payfast:${row.id}:${field}`);
      }
    }
  return { rotated, failures };
}
