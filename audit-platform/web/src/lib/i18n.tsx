'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ar } from '@/messages/ar';
import { en, type MessageKey } from '@/messages/en';

export type Locale = 'en' | 'ar';
const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ar };
const STORAGE_KEY = 'audit.locale';

export function translate(locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = catalogs[locale][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
}

interface I18n {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  toggle: () => void;
}

const I18nContext = createContext<I18n | null>(null);

function initialLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch { /* storage unavailable: fall through */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export function I18nProvider({ children, forced }: { children: ReactNode; forced?: Locale }) {
  const [locale, setLocale] = useState<Locale>(forced ?? 'en');
  useEffect(() => { if (!forced) setLocale(initialLocale()); }, [forced]);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const toggle = useCallback(() => {
    setLocale((l) => {
      const next = l === 'ar' ? 'en' : 'ar';
      try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const value = useMemo<I18n>(() => ({
    locale, dir, toggle, t: (key, vars) => translate(locale, key, vars),
  }), [locale, dir, toggle]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
