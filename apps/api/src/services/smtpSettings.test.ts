import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@casino/shared/constants/limits';
import {
  maskSmtpSettings,
  prepareSmtpPatch,
  recipientsFromSettings,
  smtpFromSettings,
  smtpIsConfigured,
  splitRecipients,
  validateSmtpPatch,
  emailBackupEnabled,
  SMTP_PASSWORD_MASK,
  SMTP_STRING_KEYS,
  SMTP_BOOLEAN_KEYS,
} from './smtpSettings';

// ENCRYPTION_KEY must exist before crypto-utils is used.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('validateSmtpPatch', () => {
  it('accepts a complete Gmail configuration', () => {
    expect(
      validateSmtpPatch({
        smtp_host: 'smtp.gmail.com',
        smtp_port: 587,
        smtp_user: 'me@gmail.com',
        smtp_password: 'abcd efgh ijkl mnop',
        smtp_from: 'me@gmail.com',
        backup_email_to: 'me@gmail.com',
        smtp_secure: false,
      })
    ).toBeNull();
  });

  it('accepts partial patches (only the changed fields)', () => {
    expect(validateSmtpPatch({ smtp_host: 'mail.example.com' })).toBeNull();
    expect(validateSmtpPatch({ backup_email_enabled: false })).toBeNull();
  });

  it('rejects a host with a scheme — the classic paste of a URL', () => {
    expect(validateSmtpPatch({ smtp_host: 'https://smtp.gmail.com' })).toMatch(/hostname only/);
  });

  it('rejects a host with a port glued on', () => {
    expect(validateSmtpPatch({ smtp_host: 'smtp.gmail.com:587' })).toMatch(/put the port in the port field/);
  });

  it('rejects an obviously invalid hostname', () => {
    expect(validateSmtpPatch({ smtp_host: 'not a host' })).toMatch(/valid hostname/);
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(validateSmtpPatch({ smtp_port: 'abc' })).toMatch(/whole number/);
    expect(validateSmtpPatch({ smtp_port: 0 })).toMatch(/between/);
    expect(validateSmtpPatch({ smtp_port: 70000 })).toMatch(/between/);
    expect(validateSmtpPatch({ smtp_port: 587.5 })).toMatch(/whole number/);
  });

  it('rejects a bad from-address and bad recipients', () => {
    expect(validateSmtpPatch({ smtp_from: 'not-an-email' })).toMatch(/email address/);
    expect(validateSmtpPatch({ backup_email_to: 'good@x.com, nope' })).toMatch(/not a valid email/);
  });

  it('accepts several recipients separated by commas', () => {
    expect(validateSmtpPatch({ backup_email_to: 'a@x.com, b@y.org,c@z.net' })).toBeNull();
  });

  it('rejects non-boolean switches', () => {
    expect(validateSmtpPatch({ smtp_secure: 'yes' })).toMatch(/true or false/);
    expect(validateSmtpPatch({ backup_email_enabled: 1 })).toMatch(/true or false/);
  });

  it('rejects over-long values (a pasted certificate would land here)', () => {
    expect(validateSmtpPatch({ smtp_host: 'a'.repeat(256) })).toMatch(/at most 255/);
    expect(validateSmtpPatch({ smtp_password: 'x'.repeat(513) })).toMatch(/at most 512/);
  });

  it('does not mistake the mask for a password that needs validating', () => {
    expect(validateSmtpPatch({ smtp_password: SMTP_PASSWORD_MASK })).toBeNull();
    expect(validateSmtpPatch({ smtp_password: '' })).toBeNull();
  });
});

describe('prepareSmtpPatch', () => {
  it('encrypts the password and never stores it in the clear', () => {
    const out = prepareSmtpPatch({ smtp_password: 'super-secret-app-password' });
    expect(typeof out.smtp_password).toBe('string');
    expect(String(out.smtp_password)).not.toContain('super-secret-app-password');
    // crypto-utils format: iv.tag.ciphertext (base64)
    expect(String(out.smtp_password).split('.')).toHaveLength(3);
  });

  it('drops a mask or blank password so saving the form keeps the stored one', () => {
    expect(prepareSmtpPatch({ smtp_password: SMTP_PASSWORD_MASK })).not.toHaveProperty('smtp_password');
    expect(prepareSmtpPatch({ smtp_password: '' })).not.toHaveProperty('smtp_password');
  });

  it('trims strings and passes unrelated settings through untouched', () => {
    const out = prepareSmtpPatch({
      smtp_host: '  smtp.gmail.com  ',
      min_deposit: 50,
      daily_checkin_ladder: [{ day: 1, bonus: 5 }],
    });
    expect(out.smtp_host).toBe('smtp.gmail.com');
    expect(out.min_deposit).toBe(50);
    expect(out.daily_checkin_ladder).toEqual([{ day: 1, bonus: 5 }]);
  });
});

describe('maskSmtpSettings', () => {
  it('replaces a stored password with the mask and flags it', () => {
    // A REAL encrypted value — fake ciphertext would (correctly) be reported as
    // unreadable now that maskSmtpSettings checks decryptability.
    const stored = prepareSmtpPatch({ smtp_password: 'iv-tag-ciphertext' });
    const masked = maskSmtpSettings({ smtp_host: 'x.test', ...stored });
    expect(masked.smtp_password).toBe(SMTP_PASSWORD_MASK);
    expect(masked.smtp_password_set).toBe(true);
    expect(JSON.stringify(masked)).not.toContain(String(stored.smtp_password));
  });

  it('reports an unset password', () => {
    const masked = maskSmtpSettings({ smtp_host: 'x.test', smtp_password: '' });
    expect(masked.smtp_password).toBe('');
    expect(masked.smtp_password_set).toBe(false);
  });

  it('flags a stored password that cannot be decrypted (ENCRYPTION_KEY changed)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const masked = maskSmtpSettings({ smtp_host: 'x.test', smtp_password: 'iv.tag.corrupt' });
    expect(masked.smtp_password_set).toBe(false);
    expect(masked.smtp_password_unreadable).toBe(true);
    warn.mockRestore();
  });

  it('reports a genuinely usable password as set', () => {
    const stored = prepareSmtpPatch({ smtp_password: 'real-app-password' });
    const masked = maskSmtpSettings(stored);
    expect(masked.smtp_password_set).toBe(true);
    expect(masked.smtp_password_unreadable).toBeUndefined();
    expect(JSON.stringify(masked)).not.toContain('real-app-password');
  });
});

describe('smtpFromSettings', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('returns null when nothing is configured (feature stays inert)', () => {
    expect(smtpFromSettings({}, env)).toBeNull();
    expect(smtpFromSettings({ smtp_host: 'smtp.gmail.com' }, env)).toBeNull(); // no from/user
  });

  it('builds options from panel settings alone and decrypts the password', () => {
    const stored = prepareSmtpPatch({
      smtp_host: 'smtp.gmail.com',
      smtp_port: 465,
      smtp_user: 'me@gmail.com',
      smtp_password: 'app-password-here',
      smtp_from: 'me@gmail.com',
    });
    const opts = smtpFromSettings({ ...stored }, env)!;
    expect(opts.host).toBe('smtp.gmail.com');
    expect(opts.port).toBe(465);
    expect(opts.user).toBe('me@gmail.com');
    expect(opts.pass).toBe('app-password-here');
  });

  it('defaults secure=true on port 465 and false on 587', () => {
    const base = { smtp_host: 'h.test', smtp_from: 'a@b.co' };
    expect(smtpFromSettings({ ...base, smtp_port: 465 }, env)!.secure).toBe(true);
    expect(smtpFromSettings({ ...base, smtp_port: 587 }, env)!.secure).toBe(false);
  });

  it('falls back to the environment for blank fields', () => {
    const opts = smtpFromSettings(
      { smtp_host: '' },
      {
        SMTP_HOST: 'env-relay.test',
        SMTP_PORT: '2525',
        SMTP_FROM: 'env@relay.test',
        SMTP_USER: 'envuser',
        SMTP_PASS: 'envpass',
      } as NodeJS.ProcessEnv
    )!;
    expect(opts.host).toBe('env-relay.test');
    expect(opts.port).toBe(2525);
    expect(opts.pass).toBe('envpass');
  });

  it('lets panel settings override the environment', () => {
    const opts = smtpFromSettings(
      { smtp_host: 'panel.test', smtp_from: 'panel@test.co' },
      { SMTP_HOST: 'env.test', SMTP_FROM: 'env@test.co' } as NodeJS.ProcessEnv
    )!;
    expect(opts.host).toBe('panel.test');
    expect(opts.from).toBe('panel@test.co');
  });

  it('honours the master switch', () => {
    expect(
      smtpFromSettings(
        { backup_email_enabled: false, smtp_host: 'h.test', smtp_from: 'a@b.co' },
        env
      )
    ).toBeNull();
  });

  it('maps allow-self-signed onto rejectUnauthorized=false', () => {
    const base = { smtp_host: 'h.test', smtp_from: 'a@b.co' };
    expect(smtpFromSettings({ ...base }, env)!.rejectUnauthorized).toBe(true);
    expect(smtpFromSettings({ ...base, smtp_allow_self_signed: true }, env)!.rejectUnauthorized).toBe(
      false
    );
  });

  it('degrades to "not configured" when the stored password cannot be decrypted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = smtpFromSettings(
      { smtp_host: 'h.test', smtp_from: 'a@b.co', smtp_user: 'u', smtp_password: 'garbage.not.base64' },
      env
    )!;
    expect(opts.pass).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('recipients', () => {
  it('splits, trims and drops blanks', () => {
    expect(splitRecipients(' a@x.co , b@y.co ,, ')).toEqual(['a@x.co', 'b@y.co']);
  });

  it('prefers settings over the environment', () => {
    expect(
      recipientsFromSettings(
        { backup_email_to: 'panel@x.co' },
        { BACKUP_EMAIL_TO: 'env@y.co' } as NodeJS.ProcessEnv
      )
    ).toEqual(['panel@x.co']);
    expect(recipientsFromSettings({}, { BACKUP_EMAIL_TO: 'env@y.co' } as NodeJS.ProcessEnv)).toEqual([
      'env@y.co',
    ]);
  });
});

describe('smtpIsConfigured', () => {
  it('is false until both a server and a recipient exist', () => {
    expect(smtpIsConfigured({}, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      smtpIsConfigured({ smtp_host: 'h.test', smtp_from: 'a@b.co' }, {} as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      smtpIsConfigured(
        { smtp_host: 'h.test', smtp_from: 'a@b.co', backup_email_to: 'a@b.co' },
        {} as NodeJS.ProcessEnv
      )
    ).toBe(true);
  });
});

// ── integration guarantees ────────────────────────────────────────────────
// These protect the wiring between the admin form, the settings validator and
// the defaults. When they drift, saving mail settings fails with
// 'Unknown setting "smtp_host"' — a bug that only shows up in production.
describe('settings wiring', () => {
  const ALL_SMTP_KEYS = [
    ...Object.keys(SMTP_STRING_KEYS),
    'smtp_port',
    ...SMTP_BOOLEAN_KEYS,
  ];

  it('every SMTP key is owned by this module (so the panel validator skips it)', () => {
    for (const key of ALL_SMTP_KEYS) {
      const owned =
        key in SMTP_STRING_KEYS || key === 'smtp_port' || (SMTP_BOOLEAN_KEYS as readonly string[]).includes(key);
      expect(owned, `${key} must be covered by the SMTP allowlist`).toBe(true);
    }
  });

  it('every mail key is caught by the super-admin prefix guard in panel.ts', () => {
    // panel.ts refuses `smtp_*` / `backup_email_*` writes from a non-super-admin.
    // A mail key named anything else would silently escape that guard.
    for (const key of ALL_SMTP_KEYS) {
      expect(
        key.startsWith('smtp_') || key.startsWith('backup_email_'),
        `${key} escapes the super-admin prefix guard`
      ).toBe(true);
    }
  });

  it('every key the admin form sends has a default', () => {
    for (const key of ALL_SMTP_KEYS) {
      expect(Object.keys(DEFAULT_SETTINGS)).toContain(key);
    }
  });

  it('ships with email delivery inert but switchable', () => {
    expect(DEFAULT_SETTINGS.backup_email_enabled).toBe(true);
    expect(DEFAULT_SETTINGS.smtp_host).toBe('');
    expect(DEFAULT_SETTINGS.backup_email_to).toBe('');
    // No secrets in defaults, ever.
    expect(DEFAULT_SETTINGS.smtp_password).toBe('');
  });

  it('a full panel-style payload passes validation and round-trips through smtpFromSettings', () => {
    const payload = {
      backup_email_enabled: true,
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      smtp_secure: false,
      smtp_user: 'me@gmail.com',
      smtp_password: 'abcd efgh ijkl mnop',
      smtp_from: 'me@gmail.com',
      backup_email_to: 'me@gmail.com',
      smtp_require_tls: true,
      smtp_allow_self_signed: false,
    };
    expect(validateSmtpPatch(payload)).toBeNull();
    const stored = prepareSmtpPatch(payload);
    const opts = smtpFromSettings({ ...DEFAULT_SETTINGS, ...stored }, {} as NodeJS.ProcessEnv)!;
    expect(opts.user).toBe('me@gmail.com');
    expect(opts.pass).toBe('abcd efgh ijkl mnop');
    expect(recipientsFromSettings({ ...DEFAULT_SETTINGS, ...stored }, {} as NodeJS.ProcessEnv)).toEqual([
      'me@gmail.com',
    ]);
  });

  it('saving the form without retyping the password keeps the stored one', () => {
    const first = prepareSmtpPatch({ smtp_password: 'original-app-password', smtp_host: 'h.test' });
    // Second save: the UI sends the mask value.
    const second = prepareSmtpPatch({ smtp_password: SMTP_PASSWORD_MASK, smtp_host: 'h2.test' });
    const merged = { ...DEFAULT_SETTINGS, ...first, ...second };
    expect(merged.smtp_host).toBe('h2.test');
    const opts = smtpFromSettings(
      { ...merged, smtp_from: 'a@b.co', smtp_user: 'u@b.co' },
      {} as NodeJS.ProcessEnv
    )!;
    expect(opts.pass).toBe('original-app-password'); // NOT erased
  });
});

// Regression: the panel tests UNSAVED form values, so the recipients typed in
// the form must be used — not BACKUP_EMAIL_TO. Before this, the Test button
// answered "No recipient" on a correctly filled form (caught by tsc: the panel
// passed `recipients` to a function that had no such option).
describe('sendTestEmail with unsaved panel values', () => {
  it('uses the recipients from the form when there is no env at all', async () => {
    const sent: Array<{ to: string[] }> = [];
    const { sendTestEmail } = await import('./backupDelivery');
    const res = await sendTestEmail({
      smtp: {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        user: 'me@gmail.com',
        pass: 'app-password',
        from: 'me@gmail.com',
        requireTls: true,
        rejectUnauthorized: true,
      },
      recipients: ['owner@casino.test'],
      env: {} as NodeJS.ProcessEnv,
      send: async (_opts, msg) => {
        sent.push({ to: msg.to });
        return { accepted: msg.to };
      },
    });
    expect(res.ok).toBe(true);
    expect(sent[0]!.to).toEqual(['owner@casino.test']);
  });
});

describe('emailBackupEnabled', () => {
  it('is on unless explicitly switched off', () => {
    expect(emailBackupEnabled({})).toBe(true);
    expect(emailBackupEnabled({ backup_email_enabled: true })).toBe(true);
    expect(emailBackupEnabled({ backup_email_enabled: false })).toBe(false);
    // A string must not silently disable it (settings can hold stale values).
    expect(emailBackupEnabled({ backup_email_enabled: 'false' })).toBe(true);
  });
});

describe('prepareSmtpPatch does not swallow unrelated settings', () => {
  it('passes every non-mail key through untouched', () => {
    // The panel PATCH writes prepareSmtpPatch(body) — if it filtered to mail
    // keys only, saving any other setting would silently do nothing.
    const out = prepareSmtpPatch({
      min_deposit: 100,
      max_deposit: 5000,
      demo_mode_enabled: true,
      rtp_ceiling: 96,
      smtp_host: '  smtp.gmail.com  ',
      smtp_password: SMTP_PASSWORD_MASK,
    });
    expect(out.min_deposit).toBe(100);
    expect(out.max_deposit).toBe(5000);
    expect(out.demo_mode_enabled).toBe(true);
    expect(out.rtp_ceiling).toBe(96);
    expect(out.smtp_host).toBe('smtp.gmail.com'); // trimmed
    expect('smtp_password' in out).toBe(false); // mask = keep existing
  });
});
