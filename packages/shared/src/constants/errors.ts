// packages/shared/src/constants/errors.ts — standardized error codes (docs/19 §12 canonical)
export const ERROR_CODES = {
  // Auth
  AUTH_INVALID_CREDENTIALS: 'AUTH_001',
  AUTH_TOKEN_EXPIRED: 'AUTH_002',
  AUTH_TOKEN_INVALID: 'AUTH_003',
  AUTH_RATE_LIMITED: 'AUTH_004',
  AUTH_ACCOUNT_SUSPENDED: 'AUTH_005',
  AUTH_ACCOUNT_CLOSED: 'AUTH_006',
  AUTH_SELF_EXCLUDED: 'AUTH_007',
  AUTH_PHONE_TAKEN: 'AUTH_008',
  // Security hardening (services/securityPolicy.ts)
  AUTH_ACCOUNT_LOCKED: 'AUTH_009',
  AUTH_STEP_UP_REQUIRED: 'AUTH_010',
  AUTH_PASSWORD_WEAK: 'AUTH_011',
  AUTH_PASSWORD_REUSED: 'AUTH_012',

  // Wallet / Betting
  WALLET_INSUFFICIENT_BALANCE: 'WAL_001',
  WALLET_BELOW_MIN_BET: 'WAL_002',
  WALLET_INVALID_WALLET_TYPE: 'WAL_003',
  WALLET_CONCURRENT_UPDATE: 'WAL_004',

  // Responsible Play
  RESP_DAILY_LOSS_LIMIT: 'RESP_001',
  RESP_DAILY_DEPOSIT_LIMIT: 'RESP_002',
  RESP_SELF_EXCLUDED: 'RESP_003',

  // Games
  GAME_NOT_FOUND: 'GAME_001',
  GAME_NOT_ACTIVE: 'GAME_002',
  GAME_INVALID_CHOICES: 'GAME_003',
  GAME_ROUND_NOT_FOUND: 'GAME_004',
  GAME_ROUND_EXPIRED: 'GAME_005',
  GAME_CASHOUT_TOO_LATE: 'GAME_006',
  GAME_ALREADY_BET_THIS_ROUND: 'GAME_007',
  GAME_NOT_AVAILABLE: 'GAME_008',
  /** stake outside the game's min/max window (H-1) */
  GAME_STAKE_OUT_OF_RANGE: 'GAME_009',
  /** seed rotation / client-seed change blocked while a round is PENDING (C-01) */
  GAME_SEED_CHANGE_WITH_OPEN_ROUND: 'GAME_010',

  // Financial
  FIN_BELOW_MIN_DEPOSIT: 'FIN_001',
  FIN_BELOW_MIN_WITHDRAW: 'FIN_002',
  FIN_ABOVE_MAX_WITHDRAW: 'FIN_008',
  FIN_NO_PAYOUT_ACCOUNT: 'FIN_003',
  FIN_PAYOUT_ACCOUNT_LOCKED: 'FIN_004',
  FIN_DEPOSIT_PROOF_REQUIRED: 'FIN_005',
  FIN_INVALID_FILE_TYPE: 'FIN_006',
  FIN_FILE_TOO_LARGE: 'FIN_007',
  // Account recovery freeze in force (see routes/recovery.ts): withdrawals and
  // new payout accounts are on hold until the freeze lapses.
  FIN_RECOVERY_FREEZE: 'FIN_009',
  FIN_DUAL_CONTROL_REQUIRED: 'FIN_010',

  // Config
  CONF_INVALID_RTP: 'CONF_001',
  CONF_EXCEEDS_CEILING: 'CONF_002',
  CONF_INVALID_WIN_RATE: 'CONF_003',

  // Generic
  GEN_VALIDATION_ERROR: 'GEN_001',
  GEN_NOT_FOUND: 'GEN_002',
  GEN_RATE_LIMITED: 'GEN_003',
  GEN_SERVER_ERROR: 'GEN_004',
  GEN_MAINTENANCE: 'GEN_005',
  PANEL_FORBIDDEN: 'PANEL_001',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES] | string;

/** Standard API error response shape (docs/19 §12). */
export interface ApiErrorBody {
  success: false;
  code: string; // from ERROR_CODES
  message: string; // user-friendly, safe to display
  details?: unknown; // validation details, never sensitive
  requestId: string; // for support reference
  refunded?: boolean; // for bet errors only
}

/** Standard success response shape (docs/19 §12). */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
}

/** Standard pagination envelope (docs/19 §23). */
export interface PaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  requestId: string;
}
