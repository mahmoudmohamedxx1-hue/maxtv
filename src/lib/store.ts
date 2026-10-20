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

/** one pane in the multi-view grid */
export interface GridPane {
  /** stable pane id (separate from the channel id — a channel can re-enter) */
  id: string;
  ch: Playable;
  addedAt: number;
}

/** max simultaneous panes — bandwidth reality on 1-vCPU CDNs */
export const MAX_GRID_PANES = 4;

interface TVState {
  player: Playable | null;
  playerOpen: boolean;
  /** alternate feeds for the currently playing item (match channels etc.) */
  altFeeds: Playable[];
  favorites: Playable[];
  recents: Playable[];

  /** multi-view grid (transient — never persisted) */
  gridOpen: boolean;
  gridPanes: GridPane[];
  gridActive: string | null;

  openPlayer: (ch: Playable, altFeeds?: Playable[]) => void;
  closePlayer: () => void;
  toggleFavorite: (ch: Playable) => void;
  isFavorite: (id: string) => boolean;
  pushRecent: (ch: Playable) => void;
  /** patch a playable everywhere it appears (player, feeds, favorites, recents) —
   *  used by the logo backfill to give persisted entries their photos */
  enrichPlayable: (id: string, patch: Partial<Playable>) => void;

  openGrid: () => void;
  closeGrid: () => void;
  /** add a channel as a pane — false when the grid is full */
  addPane: (ch: Playable) => boolean;
  removePane: (id: string) => void;
  setGridActive: (id: string | null) => void;
}

export const useTV = create<TVState>()(
  persist(
    (set, get) => ({
      player: null,
      playerOpen: false,
      altFeeds: [],
      favorites: [],
      recents: [],
      gridOpen: false,
      gridPanes: [],
      gridActive: null,

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

      /* ── multi-view grid ─────────────────────────────────────────────── */
      openGrid: () => set({ gridOpen: true }),
      closeGrid: () => set((s) => ({ gridOpen: false, gridActive: s.gridActive })),
      addPane: (ch) => {
        const s = get();
        const existing = s.gridPanes.find((p) => p.ch.id === ch.id);
        if (existing) {
          // already in the grid — focus it instead of duplicating
          set({ gridActive: existing.id, gridOpen: true });
          return true;
        }
        if (s.gridPanes.length >= MAX_GRID_PANES) return false;
        const pane: GridPane = { id: `${ch.kind}-${ch.ref}-${Date.now().toString(36)}`, ch, addedAt: Date.now() };
        set({ gridPanes: [...s.gridPanes, pane], gridActive: pane.id, gridOpen: true });
        return true;
      },
      removePane: (id) =>
        set((s) => {
          const panes = s.gridPanes.filter((p) => p.id !== id);
          return { gridPanes: panes, gridActive: s.gridActive === id ? (panes[0]?.id ?? null) : s.gridActive };
        }),
      setGridActive: (id) => set({ gridActive: id }),
    }),
    {
      name: 'zilla-tv-store',
      partialize: (s) => ({ favorites: s.favorites, recents: s.recents }),
    }
  )
);
