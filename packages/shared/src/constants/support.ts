// packages/shared/src/constants/support.ts — ticket topics shared by player UI + API.
export const SUPPORT_CATEGORY_IDS = [
  'deposit',
  'withdrawal',
  'game',
  'account',
  'bonus',
  'other',
] as const;
export type SupportCategoryId = (typeof SUPPORT_CATEGORY_IDS)[number];

export const SUPPORT_CATEGORIES: ReadonlyArray<{
  id: SupportCategoryId;
  subject: string;
  icon: string;
}> = [
  { id: 'deposit', subject: 'Deposit issue', icon: '📥' },
  { id: 'withdrawal', subject: 'Withdrawal issue', icon: '📤' },
  { id: 'game', subject: 'Game issue', icon: '🎮' },
  { id: 'account', subject: 'Account / Login', icon: '🔑' },
  { id: 'bonus', subject: 'Bonus', icon: '🎁' },
  { id: 'other', subject: 'Other', icon: '💬' },
];

const BY_ID = new Map(SUPPORT_CATEGORIES.map((c) => [c.id, c]));

export function isSupportCategory(v: unknown): v is SupportCategoryId {
  return typeof v === 'string' && BY_ID.has(v as SupportCategoryId);
}

export function supportSubject(id: SupportCategoryId): string {
  return BY_ID.get(id)?.subject ?? 'General';
}

/** Map a free-text / legacy subject onto a category id. */
export function supportCategoryFromSubject(
  subject: string | null | undefined
): SupportCategoryId {
  const s = (subject ?? '').toLowerCase();
  if (s.includes('deposit')) return 'deposit';
  if (s.includes('withdraw')) return 'withdrawal';
  if (s.includes('game')) return 'game';
  if (s.includes('account') || s.includes('login')) return 'account';
  if (s.includes('bonus') || s.includes('promo')) return 'bonus';
  const exact = SUPPORT_CATEGORIES.find(
    (c) => c.id === s || c.subject.toLowerCase() === s
  );
  return exact?.id ?? 'other';
}

export const SUPPORT_REFERENCE_TYPES = ['deposit', 'withdrawal'] as const;
export type SupportReferenceType = (typeof SUPPORT_REFERENCE_TYPES)[number];

export function isSupportReferenceType(v: unknown): v is SupportReferenceType {
  return (
    typeof v === 'string' && (SUPPORT_REFERENCE_TYPES as readonly string[]).includes(v)
  );
}
