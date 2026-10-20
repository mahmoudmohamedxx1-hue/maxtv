// ─── Player module: tiny inline icon set ─────────────────────────────────────
// Extracted from the old PlayerOverlay monolith. No external icon lib — these
// are 24×24 path-only SVGs that scale with the parent (h-N w-N on the span).

import type { ReactNode } from 'react';

function svg(path: ReactNode, extra?: ReactNode): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      {path}
      {extra}
    </svg>
  );
}

export const Icon = {
  play: svg(<path d="M8 5v14l11-7z" />),
  pause: svg(<path d="M6 5h4v14H6zm8 0h4v14h-4z" />),
  volumeHi: svg(
    <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.8v2.1a6.5 6.5 0 0 1 0 12.2v2.1a8.5 8.5 0 0 0 0-16.4z" />
  ),
  volumeOff: svg(
    <path d="M3 10v4h4l5 4V6L7 10H3zm13.6 2 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7z" />
  ),
  fullscreen: svg(<path d="M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z" />),
  fullscreenExit: svg(<path d="M7 5h2v5H5V8h2V5zm8 0h2v3h2v2h-4V5zM5 14h4v5H7v-3H5v-2zm10 0h4v2h-2v3h-2v-5z" />),
  pip: svg(
    <path d="M19 11h-8v6h8v-6zm4 8V5a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zM3 5h18v14H3V5z" />
  ),
  star: svg(
    <path d="M12 17.3 6.2 21l1.6-6.6L2.7 9.9l6.7-.6L12 3l2.6 6.3 6.7.6-5.1 4.5L17.8 21 12 17.3z" />
  ),
  share: svg(
    <path d="M18 16.1c-.8 0-1.5.3-2 .8l-7.1-4.2c0-.2.1-.5.1-.7s0-.5-.1-.7L16 7.2c.5.5 1.2.8 2 .8a3 3 0 1 0-3-3c0 .2 0 .5.1.7L8 9.8a3 3 0 1 0 0 4.4l7.1 4.2c0 .2-.1.4-.1.6a3 3 0 1 0 3-2.9z" />
  ),
  close: svg(
    <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4z" transform="translate(1.4 -1.4)" />
  ),
  next: svg(<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />),
  prev: svg(<path d="M18 6l-8.5 6L18 18V6zM8 6v12H6V6h2z" />),
  tv: svg(
    <path d="M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18v12z" />
  ),
  server: svg(
    <path d="M4 3h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm0 11h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm2 2v3h2v-3H6zm0-11v3h2V5H6z" />
  ),
  /** stats / activity — the "stats for nerds" toggle */
  stats: svg(
    <path d="M3.5 18.5 9 13l4 4 7.5-8.6V3.5h-4L9 11 5.5 7.5 2 11z" transform="translate(1 1)" />,
    <path d="M3 20h18v2H3z" />
  ),
  /** multi-view grid */
  grid: svg(
    <>
      <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm8-2h8v8h-8v-8zm2 2v4h4v-4h-4z" />
    </>
  ),
  /** plus — add to grid */
  plus: svg(<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z" />),
  /** expand pane to the main player */
  expand: svg(<path d="M4 4h6v2H7.4l4.3 4.3-1.4 1.4L6 7.4V10H4V4zm10 0h6v6h-2V7.4l-4.3 4.3-1.4-1.4L16.6 6H14V4zM4 14h2v2.6l4.3-4.3 1.4 1.4L7.4 18H10v2H4v-6zm14.6 0H20v6h-6v-2h2.6l-4.3-4.3 1.4-1.4 4.3 4.3V14z" transform="translate(0.5 0.5) rotate(180 12 12)" />),
  /** warning circle (off-air / info panels) */
  info: svg(<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5h-2v6h2V7zm0 8h-2v2h2v-2z" />),
  /** alert triangle (error panels) */
  warn: svg(<path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z" />),
  /** swap feeds (cycle) */
  swap: svg(<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />),
} as const;
