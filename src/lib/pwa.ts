'use client';

// ─── PWA install state ────────────────────────────────────────────────────────
// Captures the browser's beforeinstallprompt so the UI can offer a native
// "Install app" button, plus standalone/iOS detection for the fallback hint.
// Lives outside React so any component (TopNav, settings, toasts) can read it.

import { useSyncExternalStore } from 'react';

interface PwaState {
  /** the browser fired beforeinstallprompt — an install button is available */
  canInstall: boolean;
  /** the app is already running as an installed PWA */
  standalone: boolean;
  /** iOS Safari (no beforeinstallprompt — install is a manual Share-menu flow) */
  ios: boolean;
  /** the last captured prompt event (null when unavailable) */
  prompt: () => Promise<{ accepted: boolean }>;
}

let state: PwaState = {
  canInstall: false,
  standalone: false,
  ios: false,
  prompt: async () => ({ accepted: false }),
};

const listeners = new Set<() => void>();

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function initPwaListeners(): void {
  if (typeof window === 'undefined') return;
  const nav = navigator as Navigator & { standalone?: boolean };
  const isIos = /iphone|ipad|ipod/i.test(nav.userAgent);
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true;
  set({ ios: isIos, standalone: isStandalone });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep our own button as the entry point
    const ev = e as Event & { prompt: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };
    set({
      canInstall: true,
      prompt: async () => {
        try {
          await ev.prompt();
          const choice = (await ev.userChoice) || { outcome: 'dismissed' };
          const accepted = choice.outcome === 'accepted';
          if (accepted) set({ canInstall: false });
          return { accepted };
        } catch {
          return { accepted: false };
        }
      },
    });
  });

  window.addEventListener('appinstalled', () => set({ canInstall: false, standalone: true }));
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state
  );
}
