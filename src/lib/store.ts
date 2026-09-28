'use client';

// ─── Global client state ─────────────────────────────────────────────────────
// Player queue + favorites + recents, kept in zustand with localStorage
// persistence for favorites/recents.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Playable {
  id: string;
  name: string;
  logo?: string;
  /** 'daddylive' resolves via /api/sports/stream, 'iptv' via /api/iptv/stream */
  kind: 'daddylive' | 'iptv';
  /** daddylive: numeric channel id — iptv: absolute stream url */
  ref: string;
  source?: string;
  meta?: string;
  /** sport category of the event this feed belongs to (content-mismatch guard) */
  category?: string;
}

interface TVState {
  player: Playable | null;
  playerOpen: boolean;
  /** alternate feeds for the currently playing item (match channels etc.) */
  altFeeds: Playable[];
  favorites: Playable[];
  recents: Playable[];

  openPlayer: (ch: Playable, altFeeds?: Playable[]) => void;
  closePlayer: () => void;
  toggleFavorite: (ch: Playable) => void;
  isFavorite: (id: string) => boolean;
  pushRecent: (ch: Playable) => void;
  /** patch a playable everywhere it appears (player, feeds, favorites, recents) —
   *  used by the logo backfill to give persisted entries their photos */
  enrichPlayable: (id: string, patch: Partial<Playable>) => void;
}

export const useTV = create<TVState>()(
  persist(
    (set, get) => ({
      player: null,
      playerOpen: false,
      altFeeds: [],
      favorites: [],
      recents: [],

      openPlayer: (ch, altFeeds = []) =>
        set((s) => ({
          player: ch,
          playerOpen: true,
          altFeeds,
          recents: [ch, ...s.recents.filter((r) => r.id !== ch.id)].slice(0, 24),
        })),

      closePlayer: () => set({ playerOpen: false }),

      toggleFavorite: (ch) =>
        set((s) => ({
          favorites: s.favorites.some((f) => f.id === ch.id)
            ? s.favorites.filter((f) => f.id !== ch.id)
            : [ch, ...s.favorites].slice(0, 100),
        })),

      isFavorite: (id) => get().favorites.some((f) => f.id === id),

      pushRecent: (ch) =>
        set((s) => ({
          recents: [ch, ...s.recents.filter((r) => r.id !== ch.id)].slice(0, 24),
        })),

      enrichPlayable: (id, patch) =>
        set((s) => ({
          player: s.player?.id === id && s.playerOpen ? { ...s.player, ...patch } : s.player,
          altFeeds: s.altFeeds.map((f) => (f.id === id ? { ...f, ...patch } : f)),
          favorites: s.favorites.map((f) => (f.id === id ? { ...f, ...patch } : f)),
          recents: s.recents.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        })),
    }),
    {
      name: 'zilla-tv-store',
      partialize: (s) => ({ favorites: s.favorites, recents: s.recents }),
    }
  )
);
