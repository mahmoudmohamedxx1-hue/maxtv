'use client';

// ─── Client boot: locale direction + service worker ──────────────────────────
// Mounted once from the root layout. Keeps <html lang/dir> in sync with the
// persisted locale and registers the (stream-safe, shell-only) service worker
// for PWA installability.

import { useEffect } from 'react';
import { useLocaleDirection } from '@/lib/locale';
import { initPwaListeners } from '@/lib/pwa';

export function BootClient() {
  useLocaleDirection();

  useEffect(() => {
    initPwaListeners();
    // register the SW only in secure contexts (https / localhost) — and skip
    // during dev where the shell churns every save
    if (
      'serviceWorker' in navigator &&
      process.env.NODE_ENV === 'production' &&
      (location.protocol === 'https:' || location.hostname === 'localhost')
    ) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  return null;
}
