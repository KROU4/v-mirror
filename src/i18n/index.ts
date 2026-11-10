// Interface language: Russian or English. The choice is stored in this browser; the first
// visit follows navigator.language. <html lang>, the title and the description follow it.
import { useCallback, useSyncExternalStore } from 'react';
import type { Loc } from '../model/catalog';
import { ru } from './ru';
import { en } from './en';

export type Lang = 'ru' | 'en';
export const LANGS: readonly Lang[] = ['ru', 'en'];
export type MsgKey = keyof typeof ru;
export type Params = Record<string, string | number>;

export const DICTS: Record<Lang, Record<MsgKey, string>> = { ru, en };

const STORE_KEY = 'vm.lang';

/** '{name}' placeholders → values; unknown placeholders stay as they are. */
export function format(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}

export function translate(lang: Lang, key: MsgKey, params?: Params): string {
  return format(DICTS[lang][key] ?? DICTS.ru[key] ?? key, params);
}

/** Language from the browser: Russian for ru-*, English for everything else. */
export function detectLang(langs: readonly string[] | undefined): Lang {
  for (const l of langs ?? []) {
    const p = l.toLowerCase().split('-')[0];
    if (p === 'ru') return 'ru';
    if (p === 'en') return 'en';
  }
  return 'en';
}

function initial(): Lang {
  try {
    const s = localStorage.getItem(STORE_KEY);
    if (s === 'ru' || s === 'en') return s;
  } catch {
    /* private mode */
  }
  if (typeof navigator === 'undefined') return 'ru';
  return detectLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

let current: Lang = typeof window === 'undefined' ? 'ru' : initial();
const subs = new Set<() => void>();

function applyDocument(lang: Lang) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.title = translate(lang, 'meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', translate(lang, 'meta.description'));
}
applyDocument(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  if (lang === current || !LANGS.includes(lang)) return;
  current = lang;
  try {
    localStorage.setItem(STORE_KEY, lang);
  } catch {
    /* private mode */
  }
  applyDocument(lang);
  for (const cb of [...subs]) cb();
}

export function subscribeLang(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Text of a catalog label in the current language (falls back to the other one). */
export function locText(l: Loc | string | undefined | null, lang: Lang): string {
  if (!l) return '';
  if (typeof l === 'string') return l;
  return l[lang] || l.ru || l.en || '';
}

export function useI18n() {
  const lang = useSyncExternalStore(subscribeLang, getLang, getLang);
  const t = useCallback((key: MsgKey, params?: Params) => translate(lang, key, params), [lang]);
  const loc = useCallback((l: Loc | string | undefined | null) => locText(l, lang), [lang]);
  return { lang, t, loc, setLang };
}

export type T = ReturnType<typeof useI18n>['t'];
