'use client';

// ─── Locale store — client-side EN/AR with RTL ───────────────────────────────
// Persisted in localStorage ('maxtv-locale'). The <html lang/dir> attributes
// are applied on hydration (and pre-hydration by the inline boot script in
// layout.tsx, so Arabic users never see an LTR flash). Font swap to Cairo for
// Arabic happens via globals.css `html[lang="ar"] body`.

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { translate, localeDir, type Locale } from './i18n';

interface LocaleState {
  locale: Locale;
  setLocale: (l: Locale) => void;
  toggle: () => void;
}

export const useLocale = create<LocaleState>()(
  persist(
    (set, get) => ({
      locale: 'en',
      setLocale: (locale) => set({ locale }),
      toggle: () => set({ locale: get().locale === 'ar' ? 'en' : 'ar' }),
    }),
    { name: 'maxtv-locale' }
  )
);

export interface Translator {
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: Locale;
  isRTL: boolean;
}

/** the translation hook — re-renders the component when the locale flips */
export function useT(): Translator {
  const locale = useLocale((s) => s.locale);
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale]
  );
  return { t, locale, isRTL: localeDir(locale) === 'rtl' };
}

/** apply <html lang/dir> whenever the locale changes (mount in the root layout
 *  via a client boot component) */
export function useLocaleDirection(): void {
  const locale = useLocale((s) => s.locale);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDir(locale);
  }, [locale]);
}
