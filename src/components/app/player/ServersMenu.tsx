'use client';

// ─── Player module: the servers / sources menu (presentational) ──────────────
// Extracted from the old PlayerOverlay monolith. For DaddyLive channels it
// lists the transport servers + cross-source alternates; for IPTV channels
// the cross-PLAYLIST alternates (same channel on Pluto / Samsung TV+ /
// Roku / …) — the manual half of the cross-playlist failover engine.

import { cn } from '@/lib/utils';
import { logoSrc } from '../ChannelCard';
import type { Translator } from '@/lib/locale';
import type { AltServer, ServerOption } from './constants';
import { Icon } from './icons';

export interface ServersMenuProps {
  t: Translator['t'];
  isDaddylive: boolean;
  serverOptions: ServerOption[];
  alternates: AltServer[];
  activeServer: string;
  altUrl: string | null;
  channelName: string;
  channelSource?: string;
  onSwitchServer: (serverId: string) => void;
  onSwitchAlternate: (alt: AltServer) => void;
  onBackToLiveServers: () => void;
}

export function ServersMenu({
  t,
  isDaddylive,
  serverOptions,
  alternates,
  activeServer,
  altUrl,
  channelName,
  channelSource,
  onSwitchServer,
  onSwitchAlternate,
  onBackToLiveServers,
}: ServersMenuProps) {
  const availCount = isDaddylive ? serverOptions.length + alternates.length : 1 + alternates.length;
  return (
    <div className="absolute bottom-12 end-0 z-30 w-72 max-w-[86vw] overflow-hidden rounded-xl border border-zilla-line bg-zilla-bg/97 shadow-2xl backdrop-blur">
      <p className="border-b border-zilla-line/60 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
        {t('player.streamingServers')} {t('player.serversAvail', { n: availCount })}
      </p>
      <div className="styled-scrollbar max-h-72 overflow-y-auto">
        {isDaddylive ? (
          <>
            {altUrl && (
              <button
                onClick={onBackToLiveServers}
                className="flex w-full items-center gap-2 border-b border-zilla-line/60 px-4 py-2.5 text-start transition-colors hover:bg-white/5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10 text-[10px] font-black text-zilla-dim">
                  ↩
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold text-zilla-yellow">
                    {t('player.backToLiveServers')}
                  </span>
                  <span className="block truncate text-[10px] font-medium text-zilla-dim">
                    {t('player.backToLiveServersSub', { name: channelName })}
                  </span>
                </span>
              </button>
            )}
            {serverOptions.map((s) => {
              const isActive = (altUrl === null || altUrl === undefined) && (activeServer === s.id || (!s.id && activeServer === s.host));
              return (
                <button
                  key={s.id}
                  onClick={() => onSwitchServer(s.id)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-white/5',
                    isActive && 'bg-zilla-yellow/10'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-black',
                      isActive ? 'bg-zilla-yellow text-black' : 'bg-white/10 text-zilla-dim'
                    )}
                  >
                    {s.label.replace(/\D/g, '') || '•'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-xs font-bold',
                        isActive ? 'text-zilla-yellow' : 'text-zilla-text'
                      )}
                    >
                      {s.label}
                    </span>
                    <span className="block truncate text-[10px] font-medium text-zilla-dim">{s.host}</span>
                  </span>
                  {isActive && (
                    <span className="shrink-0 rounded-full bg-zilla-yellow/20 px-2 py-0.5 text-[9px] font-black uppercase text-zilla-yellow">
                      {t('player.active')}
                    </span>
                  )}
                </button>
              );
            })}
            {alternates.length > 0 && (
              <>
                <p className="border-y border-zilla-line/60 bg-white/[0.03] px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                  {t('player.moreSources')}
                </p>
                {alternates.map((alt) => {
                  const isActive = altUrl === alt.url;
                  return (
                    <button
                      key={alt.id}
                      onClick={() => onSwitchAlternate(alt)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-white/5',
                        isActive && 'bg-zilla-yellow/10'
                      )}
                    >
                      {alt.logo ? (
                        <img
                          src={logoSrc(alt.logo, alt.name)}
                          alt=""
                          loading="lazy"
                          className="h-7 w-11 shrink-0 rounded object-contain"
                        />
                      ) : (
                        <span className="flex h-7 w-11 shrink-0 items-center justify-center rounded bg-white/5 text-[10px] font-black text-zilla-dim">
                          TV
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-bold text-zilla-text">
                          {alt.sourceName}
                          {isActive && <span className="ms-1.5 text-zilla-yellow">{t('player.playing')}</span>}
                        </span>
                        <span className="block truncate text-[10px] font-medium text-zilla-dim">
                          {alt.name}
                          {alt.sameChannel === false
                            ? ` ${t('player.differentFeed')}`
                            : alt.ladder?.length
                              ? ` ${t('player.ladderRange', { a: alt.ladder[0], b: alt.ladder[alt.ladder.length - 1] })}`
                              : alt.source === 'worldsports'
                                ? ` ${t('player.realLadder')}`
                                : ''}
                        </span>
                      </span>
                      {alt.sameChannel === false ? (
                        <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[9px] font-black uppercase text-zilla-dim">
                          {t('player.otherFeed')}
                        </span>
                      ) : (
                        (alt.ladder?.length || alt.source === 'worldsports') && (
                          <span className="shrink-0 rounded-full bg-zilla-yellow/15 px-2 py-0.5 text-[9px] font-black uppercase text-zilla-yellow/90">
                            {alt.ladder?.length
                              ? `${alt.ladder[0]}–${alt.ladder[alt.ladder.length - 1]}p`
                              : t('player.hdUp')}
                          </span>
                        )
                      )}
                    </button>
                  );
                })}
              </>
            )}
            <p className="px-4 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
              {t('player.serversNoteDl')}
              {alternates.length > 0 ? t('player.serversNoteAlts') : t('player.serversNoteNoAlts')}
            </p>
          </>
        ) : (
          <>
            <div className="flex w-full items-center gap-3 px-4 py-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zilla-yellow text-[10px] font-black text-black">
                ●
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-bold text-zilla-yellow">
                  {channelSource || t('player.currentSource')}
                </span>
                <span className="block truncate text-[10px] font-medium text-zilla-dim">{t('player.playingNow')}</span>
              </span>
            </div>
            {alternates.map((alt, ai) => {
              const sameSource = alt.sourceName === (channelSource || '');
              return (
                <button
                  key={alt.id}
                  onClick={() => onSwitchAlternate(alt)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-white/5"
                >
                  {alt.logo ? (
                    <img
                      src={logoSrc(alt.logo, alt.name)}
                      alt=""
                      loading="lazy"
                      className="h-7 w-11 shrink-0 rounded object-contain"
                    />
                  ) : (
                    <span className="flex h-7 w-11 shrink-0 items-center justify-center rounded bg-white/5 text-[10px] font-black text-zilla-dim">
                      TV
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-zilla-text">
                      {sameSource ? t('player.alternateStream', { n: ai + 2 }) : alt.sourceName}
                    </span>
                    <span className="block truncate text-[10px] font-medium text-zilla-dim">
                      {sameSource ? t('player.altSameSourceSub') : alt.name}
                      {alt.health === 'ok' ? ` ${t('player.healthy')}` : alt.health === 'geo' ? ` ${t('player.geo')}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
            {alternates.length === 0 && (
              <p className="px-4 py-3 text-[10px] font-medium leading-snug text-zilla-dim">{t('player.noOtherSource')}</p>
            )}
          </>
        )}
      </div>
      <p className="flex items-center gap-1.5 border-t border-zilla-line/60 px-4 py-2 text-[9px] font-bold uppercase tracking-wider text-zilla-dim/70">
        <span className="h-3 w-3 shrink-0">{Icon.server}</span>
        {t('player.switchServerTitle')}
      </p>
    </div>
  );
}
