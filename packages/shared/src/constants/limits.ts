// packages/shared/src/constants/limits.ts — platform limits & default settings (docs/19 §16, v4)
export const LIMITS = {
  MAX_MONEY_DECIMALS: 2,
  MAX_BET_AMOUNT: 99999999,
  MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'] as const,
  RTP_CEILING: 99.0, // HARD CODED — never configurable by any admin (v6 rule)
  WIN_RATE_MIN: 1,
  WIN_RATE_MAX: 98,
  // Hard cap any game may declare. Tower's FAIR expert floor 10 is ~9.4M×;
  // the seeded/admin ladders are far below this — currency exposure is also
  // bounded by global_max_payout.
  MAX_WIN_MULTIPLIER_LIMIT: 10_000_000,
  SEED_ROTATION_DEFAULT: 1000,
  IDLE_LOGOUT_HOURS_DEFAULT: 24,
  BET_TIMEOUT_MS: 8000,
  PAGE_SIZE_DEFAULT: 20,
  PAGE_SIZE_MAX: 100,
} as const;

/** DEFAULT_SETTINGS — canonical (docs/19 §16 + docs/20 §6). PKR decision (D-017): symbol via env. */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  // Financial
  coin_rate: 1.0,
  min_deposit: 100, // PKR
  min_withdrawal: 500, // PKR
  withdrawal_fee_percent: 2.0,
  withdrawal_fee_flat: 0, // use percent OR flat, not both

  // Betting
  global_min_bet: 10, // PKR
  // Operator difficulty — platform-wide default win-frequency level; each game
  // can override via its own configJson.difficulty. easy|normal|hard|impossible
  game_difficulty: 'normal',
  // These two were MISSING from DEFAULT_SETTINGS while stakeLimits read them,
  // so any database seeded before they were added had no row at all and the
  // resolved maximum depended entirely on a hardcoded fallback. Declaring them
  // here means a fresh install, an older database and a wiped settings table
  // all agree.
  global_max_bet: 500000, // PKR
  global_max_payout: 5000000, // PKR — per-round liability ceiling
  global_max_win_multiplier: 25,
  rtp_ceiling: 99.0, // HARD CODED, display only

  // Bonuses
  daily_checkin_ladder: [
    { day: 1, bonus: 5 },
    { day: 2, bonus: 8 },
    { day: 3, bonus: 12 },
    { day: 4, bonus: 18 },
    { day: 5, bonus: 25 },
    { day: 6, bonus: 35 },
    { day: 7, bonus: 50 },
    { day: 14, bonus: 75 },
    { day: 21, bonus: 100 },
    { day: 30, bonus: 200 },
  ],
  win_streak_milestones: [
    { wins: 5, bonus: 25 },
    { wins: 10, bonus: 75 },
    { wins: 25, bonus: 250 },
  ],
  rakeback_percent: 5.0,
  referral_bonus_referrer: 25,
  referral_bonus_referee: 10,
  // % of referred users' net spend (house GGR) paid to a referral agent,
  // settled daily by the worker's referral-commission cron.
  referral_commission_pct: 5.0,

  // Responsible play (operator toggle D-043 — OFF by default, per D-042)
  responsible_play_enabled: true,
  session_reminder_default_min: 60,

  // Platform
  maintenance_mode: false,
  registration_open: true,
  big_win_ticker_threshold: 500,
  live_feed_visible_to_guests: true,
  currency_symbol: '₨',
  // D-073: demo mode master switch — when OFF (default) guests cannot play any
  // game in demo; games require login. Admin can enable it any time.
  demo_mode_enabled: false,
  // Lobby cards: thumbnails already carry the title. Off = no overlay name.
  lobby_show_game_names: false,

  // Session
  idle_logout_hours: 24,
  seed_rotation_after_rounds: 1000,

  // Wallet
  bet_spend_priority: ['BONUS', 'GIFTED', 'REAL'],
  leaderboard_metric: 'total_wagered',

  // Feature flags (docs/19 §24)
  ENABLE_DEMO_MODE: true,
  ENABLE_REFERRAL_PROGRAM: true,
  ENABLE_LEADERBOARD: true,
  ENABLE_RAKEBACK: true,
  ENABLE_WIN_STREAKS: true,
  ENABLE_COIN_GIFTS: true,
  ENABLE_CRYPTO_DEPOSITS: false,
  ENABLE_PUSH_NOTIFICATIONS: false,
  // ENABLE_2FA_ADMIN was removed deliberately: it was never implemented, and a
  // security toggle that does nothing is worse than an honest gap.
  ENABLE_KYC: false,

  // ── Email delivery (admin panel → Backup → Email delivery) ───────────────
  // Used by the nightly backup job and the "send test email" button. The
  // password is stored ENCRYPTED (see services/smtpSettings.ts) and is never
  // returned by any read path. SMTP_* env vars remain a fallback for any field
  // left blank here.
  backup_email_enabled: true,
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_password: '',
  smtp_from: '',
  smtp_require_tls: true,
  smtp_allow_self_signed: false,
  smtp_tls_servername: '',
  backup_email_to: '',

  // ── Security hardening (SECURITY-INVENTORY.md follow-up) ────────────────
  // Every one of these is optional; the code default below is what runs when
  // nobody edits it, and each is also honoured when set in the settings table.
  //
  // Dual control: a withdrawal / admin credit at or above the threshold needs
  // a SECOND admin (never the first approver) before it executes. 0 = off.
  withdrawal_dual_control_threshold: 50000,
  admin_credit_dual_control_threshold: 25000,
  // Panel session hygiene: idle timeout and the freshness window for
  // step-up re-authentication on money-moving actions.
  admin_idle_timeout_minutes: 60,
  admin_step_up_minutes: 15,
  // Password policy (applies to signup, change-password and recovery reset).
  password_min_length: 8,
  password_reject_common: true,
  password_history_depth: 3,
  // Account lockout after repeated failures — per ACCOUNT, so a botnet with
  // many IPs cannot spray one account (the IP limiter cannot see that).
  login_max_attempts: 8,
  login_lock_minutes: 15,
  // What happens when the rate-limit store (Redis) is unreachable:
  //   memory = keep limiting from a per-process window (default)
  //   open   = allow everything (the old behaviour)
  //   closed = reject everything that is rate limited
  rate_limit_fail_mode: 'memory',
  // Signs in from an unseen device: notify (default) or block the login.
  new_device_policy: 'notify',
  // Retention — worker purges rows older than this. 0 disables the purge.
  retention_login_events_days: 180,
  retention_notifications_days: 90,
  retention_recovery_requests_days: 365,
  // Monitoring: where alerts are POSTed (empty = admin feed + notifications
  // only) and whether the watchdog job runs.
  alerts_webhook_url: '',
  security_watchdog_enabled: true,
};
