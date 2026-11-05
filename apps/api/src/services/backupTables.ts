// apps/api/src/services/backupTables.ts — the table inventory every JSON backup
// and restore walks.
//
// WHY THIS IS ITS OWN MODULE: it is the one list in the backup path that must
// change whenever a new model is added to prisma/schema.prisma, and forgetting
// it fails SILENTLY — export skips the table and re-import leaves it empty, with
// no error anywhere. Keeping the lists here (no Prisma import) lets
// backupTables.test.ts diff them against the schema so the next feature cannot
// ship a table that backups ignore.
//
// Two orders, opposite requirements:
//   TABLES      — INSERT order: every FK target must appear BEFORE the table
//                 that references it, or inserts violate the constraint.
//   WIPE_ORDER  — DELETE order: children BEFORE parents, or deletes do.
// backupTables.test.ts enforces both against the real schema.

/** Insert order: parents first. */
export const TABLES = [
  'GameConfig',
  'ManualPaymentAccount',
  'AdminUser',
  'Setting',
  'LegalPage',
  'FaqCategory',
  'Faq',
  'DepositPackage',
  'User',
  'UserDevice',
  'UserLoginEvent',
  'Wallet',
  'SharedRoundBet',
  'RefreshTokenFamily',
  'SeedPair',
  'PayoutAccount',
  'GameRound',
  'Transaction',
  'Deposit',
  'Withdrawal',
  'SupportConversation',
  'SupportMessage',
  'Notification',
  'NotificationRead',
  'DailyCheckin',
  'GiftTransaction',
  'WinStreak',
  'RakebackRecord',
  'LeaderboardEntry',
  'AdminAuditLog',
  'FraudSignal',
  // Added with the recovery + security-hardening releases. They were missing
  // here, which meant a JSON backup silently omitted them — including
  // WalletAdjustment, a FINANCIAL table holding dual-control money moves.
  // All their FK targets (User, SupportConversation) appear above.
  'PasswordHistory',
  'RecoveryRequest',
  'SecurityAlert',
  'WalletAdjustment',
] as const;

/** Delete order: children first. */
export const WIPE_ORDER = [
  // The four newest tables reference User / SupportConversation, so they must
  // be cleared before both — hence the front of the list.
  'PasswordHistory',
  'RecoveryRequest',
  'SecurityAlert',
  'WalletAdjustment',
  'AdminAuditLog',
  'FraudSignal',
  'UserDevice',
  'UserLoginEvent',
  'NotificationRead',
  'Notification',
  'SupportMessage',
  'SupportConversation',
  'Faq',
  'FaqCategory',
  'GiftTransaction',
  'WinStreak',
  'RakebackRecord',
  'LeaderboardEntry',
  'DailyCheckin',
  'GameRound',
  'SharedRoundBet',
  'Transaction',
  'Deposit',
  'Withdrawal',
  'PayoutAccount',
  'RefreshTokenFamily',
  'SeedPair',
  'Wallet',
  'User',
  'DepositPackage',
  'GameConfig',
  'Setting',
  'LegalPage',
  'ManualPaymentAccount',
  'AdminUser',
] as const;
