// packages/game-core/src/mask.ts — username masking (docs/20 §7 canonical)
export function maskUsername(name: string): string {
  if (name.length <= 4) return name[0] + '***';
  const visible = Math.min(3, Math.floor(name.length * 0.4));
  const start = name.substring(0, visible);
  const end = name.substring(name.length - 2);
  return `${start}***${end}`;
}

/** Mask a phone for logs: keep first 4 + last 4. */
export function maskPhone(phone: string): string {
  if (phone.length <= 8) return phone[0] + '***' + phone.slice(-2);
  return `${phone.slice(0, 4)}***${phone.slice(-4)}`;
}
