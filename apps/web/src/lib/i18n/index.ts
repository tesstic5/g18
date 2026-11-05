// apps/web/src/lib/i18n/index.ts — tiny typed i18n (docs/20 §13 detection priority)
import { en } from './en';
import { ur } from './ur';

export const messages = { en, ur } as const;
export type Lang = keyof typeof messages;

export function detectLang(preferred?: string | null): Lang {
  if (preferred === 'en' || preferred === 'ur') return preferred;
  if (typeof navigator !== 'undefined') {
    const nav = navigator.language.toLowerCase();
    if (nav.startsWith('ur')) return 'ur';
  }
  return 'en';
}

export type TKey = string; // dot path into the en dictionary

/** t('games.betAmount') → "Bet Amount"; t('errors.AUTH_004', { minutes: 5 }) */
export function t(
  lang: Lang,
  key: TKey,
  params?: Record<string, string | number>
): string {
  const dict = messages[lang] ?? en;
  const value = key
    .split('.')
    .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], dict);
  if (typeof value !== 'string') return key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params[name] ?? `{${name}}`)
  );
}
