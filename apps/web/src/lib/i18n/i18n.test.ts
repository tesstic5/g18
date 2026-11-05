// apps/web/src/lib/i18n/i18n.test.ts — unit tests for the typed i18n layer.
import { describe, it, expect } from 'vitest';
import { t, detectLang } from './index';

describe('i18n', () => {
  it('resolves dot paths from the en dictionary', () => {
    const value = t('en', 'games.betAmount');
    expect(value).toBeTypeOf('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it('falls back to the key when missing', () => {
    expect(t('en', 'nope.missing.key')).toBe('nope.missing.key');
  });

  it('interpolates params', () => {
    const value = t('en', 'errors.AUTH_004', { minutes: 5 });
    expect(value).toContain('5');
  });

  it('resolves the ur dictionary too', () => {
    expect(t('ur', 'games.betAmount')).toBeTypeOf('string');
  });

  it('detects urdu from navigator language', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'ur-PK' },
      configurable: true,
    });
    expect(detectLang()).toBe('ur');
  });

  it('prefers an explicit preference over navigator', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'ur-PK' },
      configurable: true,
    });
    expect(detectLang('en')).toBe('en');
  });
});
