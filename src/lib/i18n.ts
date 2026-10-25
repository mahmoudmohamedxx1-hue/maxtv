// ─── MaxTV i18n — EN / AR dictionary ─────────────────────────────────────────
// Lightweight, client-side, zero-dependency. The app is a heavily client-side
// SPA-style experience (player, overlays, tabs), so a context-free zustand
// locale + pure translate() beats a routing-based i18n framework: no route
// changes, instant switching, localStorage persistence, and RTL flips via
// <html dir>. Keys are flat 'section.key' strings; params use {name}.
//
// Arabic targets Modern Standard Arabic with streaming-UI conventions
// (السيرفرات / مباشر / الجودة) so MENA users feel at home.

export type Locale = 'en' | 'ar';

export const LOCALES: ReadonlyArray<{ id: Locale; label: string; native: string; dir: 'ltr' | 'rtl' }> = [
  { id: 'en', label: 'English', native: 'English', dir: 'ltr' },
  { id: 'ar', label: 'Arabic', native: 'العربية', dir: 'rtl' },
];

export function localeDir(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/* ── English (source of truth) ─────────────────────────────────────────────── */
const en = {
  // common
  'common.live': 'Live',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
  'common.done': 'Done',
  'common.search': 'Search',
  'common.settings': 'Settings',
  'common.sports': 'Sports',
  'common.others': 'Others',
  'common.remove': 'Remove',
  'common.add': 'Add',

  // top nav
  'nav.searchLabel': 'Search channels and events',
  'nav.install': 'Install app',
  'nav.installHint': 'Add MaxTV to your home screen',
  'nav.grid': 'Multi-view',
  'nav.language': 'Language',

  // settings menu
  'settings.zap': 'Zap',
  'settings.zapDesc': 'Jump to a random live channel',
  'settings.videoQuality': 'Video quality',
  'settings.auto': 'Auto',
  'settings.mostStable': 'most stable',
  'settings.autoDesc':
    'Picks the most stable quality for your connection — starts safe, climbs when the link proves it, drops on stalls.',
  'settings.dataSaver': 'Quality ladder · Data saver',
  'settings.dsUnavailable':
    "Not available on this deployment — the server can't re-encode streams. Picks fall back to the nearest native quality.",
  'settings.dsNote': 'Any height, re-encoded in real time to save bandwidth — even heights the provider does not offer.',
  'settings.perfTitle': 'Streaming performance',
  'settings.perfFast': '⚡ Fast start',
  'settings.perfFastDesc':
    'Joins the live edge sooner and buffers less — quickest load, lowest lag. Best for normal connections.',
  'settings.perfSteady': '🛡️ Rock steady',
  'settings.perfSteadyDesc': 'Deeper buffer that rides out weak Wi-Fi and mobile data — starts a touch slower, rarely stalls.',
  'settings.playback': 'Playback',
  'settings.autoAdvance': 'Auto-switch on dead streams',
  'settings.autoAdvanceDesc': 'Surfs to the next channel after 10s',
  'settings.connection': 'Your connection:',
  'settings.connMeasuring': 'measuring…',
  'settings.dataSaverOn': 'data saver on',
  'settings.appliesEveryChannel': 'Applies to every channel — in the player you can also switch per stream.',
  'settings.appliesNextSwitch': 'Applies to every channel from your next stream switch.',

  // footer
  'footer.tagline': 'Sports-first free streaming',
  'footer.blurb': 'Live sports engine ported from live-sport-plugin · channel lineup from IPTV-Scraper-Zilla. MaxTV hosts no content — it aggregates publicly available streams for informational purposes.',

  // search
  'search.placeholder': 'Search live events, sports channels, TV channels…',
  'search.noResults': 'No results for',
  'search.noResultsHint': 'Try a channel name, a league, or a team.',
  'search.recents': 'Recently watched',
  'search.favorites': 'Your favorites',
  'search.minChars': 'Type at least 2 characters to search 12,000+ channels & live events',
  'search.liveSection': 'Live & upcoming events',
  'search.sportsSection': 'Sports channels',
  'search.tvSection': 'TV channels',

  // sports tab
  'sports.bigMatches': 'Big matches ahead',
  'sports.bigMatchesSub': 'Premier League · La Liga · Serie A · Bundesliga · Champions League & more',
  'sports.liveNow': 'Live now',
  'sports.liveNowSub': '{n} events streaming right now',
  'sports.football': 'Football',
  'sports.americanFootball': 'American Football',
  'sports.bein': 'beIN Sports',
  'sports.beinSub': '{n} verified networks — Arabic MENA football feeds first · every channel health-checked',
  'sports.world': 'World Sports',
  'sports.worldSub': '{n} multi-quality networks — pick any quality from 360p to 1080p in the player · every stream verified',
  'sports.yourFavorites': 'Your favorites',
  'sports.yourFavoritesSub': 'Saved sports channels & reminders',
  'sports.recentlyWatched': 'Recently watched',
  'sports.recentlyWatchedSub': 'Jump back in',
  'sports.channels247': '24/7 sports channels',
  'sports.channels247Sub': '{n} always-on sports networks · ESPN, Sky Sports, beIN, Willow & more',
  'sports.channels247Loading': 'Loading the always-on sports networks…',
  'sports.emptyHint': 'The schedule refreshes every minute — check the 24/7 channels above or',
  'sports.searchLink': 'search for a channel',
  'sports.upcoming': 'Upcoming events',
  'sports.upcomingSub': 'Kick off soon — times shown in your timezone',
  'sports.syncing': 'Syncing live sports schedule…',
  'sports.noLive': 'No live events right now',
  'sports.sportLive': '{sport} live',
  'sports.sportLiveSub': '{n} live {sport} events',

  // others tab
  'others.heading': 'Free IPTV channels',
  'others.headingA': 'Everything else,',
  'others.headingB': 'one tab',
  'others.blurb': '{n} free channels from Pluto TV, Samsung TV Plus, Plex, Xumo, Tubi, Roku, LG Channels, STIRR and more — refreshed hourly by IPTV-Scraper-Zilla.',
  'others.noMatch': 'No channels match this filter',
  'others.tryDifferent': 'Try a different category or source.',

  // player — top bar / actions
  'player.feed': 'Feed {i}/{n}',
  'player.switchFeedTitle': 'Switch feed — {n} feeds for this event',
  'player.favorite': 'Favorite (adds to Your favorites)',
  'player.share': 'Copy share link',
  'player.linkCopied': 'Link copied — share it anywhere',
  'player.tapSound': 'Tap for sound',
  'player.goLive': 'Go live',
  'player.liveChannel': 'Live channel',

  // player — quality menu
  'player.quality': 'Video quality',
  'player.streamQuality': 'Stream quality',
  'player.auto': 'Auto',
  'player.autoNote':
    'Picks the most stable quality for your connection — starts safe, climbs when the link proves it can hold more, drops instantly on stalls.',
  'player.singleQualityNote':
    "This channel's provider serves a single quality. When another source carries it with a real ladder, its rungs appear here automatically.",
  'player.moreQualitiesVia': 'More qualities · via {source}',
  'player.altRungNote': 'Same channel on {source}, with a real quality ladder — picking a rung switches there and pins your choice.',
  'player.dataSaverSection': 'Quality ladder · Data saver',
  'player.dsUnavailableHere':
    "Real-time re-encoding isn't available on this hosting — multi-quality comes from the source ladders above instead.",
  'player.dsNoteSeg':
    'Re-encoded live to save bandwidth — built for slow connections. Full 720p/1080p plays natively whenever the source carries them.',
  'player.dsNoteRelay': 'Any height, re-encoded in real time to save bandwidth — perfect for slow connections or capping quality.',
  'player.backToNative': '← back to the native feed',
  'player.choiceSaved': 'Your choice is saved and applied to every channel.',
  'player.dsChip': 'Data saver',
  'player.rung.ultraLow': 'ultra low',
  'player.rung.hd': 'HD',
  'player.rung.fullHd': 'Full HD',

  // player — Local Turbo (client-side low-latency pipeline)
  'player.localTurboSection': 'Local Turbo (beta)',
  'player.localTurboNote':
    "Decoded in your browser — rides ~1s behind the live edge instead of several segments. Doesn't reduce data usage.",
  'player.localTurboOn': 'Turbo on · {height}',
  'player.localTurboFail': 'Turbo unavailable here — back to standard playback',
  'player.localTurboExit': '← back to standard playback',
  'player.localTurboNoPip': 'Picture-in-picture needs standard playback — exit Turbo first',
  'player.turboChip': 'Turbo',
  'player.sourceRung': 'Source',

  // player — servers menu
  'player.servers': 'Servers',
  'player.streamingServers': 'Streaming servers',
  'player.serversAvail': '· {n} available',
  'player.backToLiveServers': 'Back to live servers',
  'player.backToLiveServersSub': '{name} · DaddyLive transports',
  'player.active': 'active',
  'player.playing': '· playing',
  'player.otherFeed': 'other feed',
  'player.differentFeed': '· different feed',
  'player.ladderRange': '· {a}–{b}p ladder',
  'player.realLadder': '· real quality ladder',
  'player.hdUp': 'HD↑',
  'player.moreSources': 'More sources · multi-quality',
  'player.playingNow': 'Playing now',
  'player.alternateStream': 'Alternate stream {n}',
  'player.altSameSourceSub': 'Same channel, different stream URL',
  'player.healthy': '· healthy',
  'player.geo': '· may be geo-blocked',
  'player.noOtherSource': 'No other source carries this channel right now.',
  'player.serversNoteDl':
    'Server 1 (Smart cache) pre-buffers the stream through MaxTV — the smoothest ride, and the default on cloud hosting. Server 2 (Direct CDN) streams straight through with no middle layer; Edge direct skips mirror parsing for the lowest latency.',
  'player.serversNoteAlts':
    ' Sources under "More sources" carry this channel elsewhere — same-channel ones also lend their quality rungs to the quality menu; entries marked "other feed" are related channels.',
  'player.serversNoteNoAlts':
    ' DaddyLive streams ship a single quality; pick a multi-quality source when one appears here.',
  'player.switchServerTitle': 'Switch streaming server (S)',

  // player — channel guide
  'player.guide': 'Channel guide',
  'player.closeGuide': 'Close guide',
  'player.guideLoading': 'Loading the guide…',
  'player.feedsGroup': 'Feeds for this event',
  'player.liveGroup': 'Live now',
  'player.channelsGroup': '24/7 channels',
  'player.alwaysOn': 'Always on',
  'player.addToGrid': 'Add to multi-view grid',
  'player.justStarted': 'just started',
  'player.startedMin': 'started {n} min ago',
  'player.startedHour': 'started {h}h {m}m ago',

  // player — state overlays
  'player.resolving': 'Resolving stream…',
  'player.buffering': 'Buffering…',
  'player.offairTitle': 'This channel is off-air right now',
  'player.offairText': "24/7 feeds activate when their live event starts. Surf to another channel —",
  'player.unavailable': 'Stream unavailable',
  'player.geoText': 'The channel may be geo-blocked from your region.',
  'player.manifestUnreachable': 'Stream manifest is unreachable — the channel may be offline or region-blocked.',
  'player.networkError': 'Network error ({detail}).',
  'player.mediaError': 'Media decode error.',
  'player.playbackError': 'Playback error ({detail}).',
  'player.upNext': 'Up next in {s}s — {name}',
  'player.switchServer': 'Switch server',
  'player.cancelAutoSwitch': 'Cancel auto-switch',
  'player.browseChannels': 'Browse channels',
  'player.tryAnotherFeed': 'Try another feed ({n})',
  'player.watchInstead': 'Watch {name} instead',
  'player.watchInsteadTitle': 'A related channel from the same network — not {name}',

  // player — HEVC panel
  'player.hevcTitle': '{name} is live — in a format this browser can’t play',
  'player.hevcText':
    'The channel is currently broadcasting in HEVC (a modern video codec). Play it converted to 480p right here, or open MaxTV in Safari, Edge, or on a phone — those play it natively.',
  'player.play480': 'Play at 480p',
  'player.play480Note': 'converted',
  'player.play480Title': 'The server converts this channel to H.264 at 480p in real time — same channel, same content',
  'player.watchFamily': 'Watch {name} instead',
  'player.differentChannel': 'different channel',
  'player.tryAnyway': 'Try playing anyway',

  // player — mismatch banner
  'player.mismatchTitle': 'This feed is showing {sport} right now',
  'player.mismatchText': 'Network channels sometimes preempt matches. Hop to another feed for this event.',
  'player.keepWatching': 'Keep watching',
  'player.switchFeed': 'Switch feed',

  // player — toasts
  'player.reconnecting': 'Reconnecting…',
  'player.routing': 'Routing this stream through MaxTV…',
  'player.switchingServer': 'Switching to {label} ({host})…',
  'player.tryingSource': 'Trying {name}…',
  'player.slowConn': 'Slow connection — switching to {h}p for stability',
  'player.slowConnDs': 'Slow connection — dropping to {h}p data saver',
  'player.improved': 'Connection improved — back to the native feed',
  'player.dsUnavailableToast': 'Data saver is unavailable on this server — playing the native feed',
  'player.dsHiPref': 'Your saved {h}p pick is not servable on this hosting — falling back to Auto',
  'player.dsStreamUnavailable': 'Data-saver stream unavailable — back to the native feed',
  'player.hiccup': 'Stream hiccup — reconnecting',
  'player.codecHop': 'Codec not supported here — trying {name}…',
  'player.pipUnsupported': 'Picture-in-picture is not supported here',
  'player.pipUnavailable': 'Picture-in-picture unavailable for this stream',
  'player.addedToGrid': 'Added to the multi-view grid',
  'player.gridFull': 'The grid is full — remove a pane first',
  'player.qualityAutoToast': 'Quality: Auto — most stable for your connection',
  'player.qualityToast': 'Quality: {label} — saved as your default',
  'player.dsEngaged': 'Data saver: {h}p — lighter stream, less bandwidth',
  'player.dsUnavailableChannel': 'Data saver is unavailable for this channel',
  'player.segRefuse': "{h}p re-encoding can't run smoothly here — Auto (native feed) restored",
  'player.nativeIsHp': 'Native feed is already {h}p — switching back to it',
  'player.topsAt': 'This channel tops out at {h}p — playing it natively',
  'player.topsAtBack': 'This channel tops out at {h}p — back to the native feed',
  'player.prefUnavailable': "{h}p isn't available on this channel — playing its native feed",
  'player.shareOpened': 'Share link opened',
  'player.altRungToast': 'Switching to {source} — {h}p',
  'player.switchingTo': 'Switching to {name}…',

  // player — keyboard hints
  'player.keysHint': 'Space play · M mute · F fullscreen · P pip · S servers · I stats · ←/→ change channel · type a number to jump · Esc close',

  // player — pip / fullscreen / misc a11y
  'player.playPause': 'Play / pause (Space)',
  'player.prevChannel': 'Previous channel (←)',
  'player.nextChannel': 'Next channel (→)',
  'player.toggleMute': 'Mute (M)',
  'player.toggleFullscreen': 'Fullscreen (F)',
  'player.pipLabel': 'Picture-in-picture (P)',
  'player.volume': 'Volume',
  'player.closePlayer': 'Close (Esc)',
  'player.playerFor': 'Player — {name}',
  'player.guideTitle': 'Browse channels — type a channel number anytime',

  // stats overlay
  'stats.title': 'Stats for nerds',
  'stats.close': 'Close stats',
  'stats.open': 'Stats (I)',
  'stats.resolution': 'Resolution',
  'stats.level': 'Level',
  'stats.bitrate': 'Bitrate',
  'stats.bandwidth': 'Est. bandwidth',
  'stats.buffer': 'Buffer ahead',
  'stats.backBuffer': 'Back buffer',
  'stats.dropped': 'Dropped frames',
  'stats.latency': 'Behind live',
  'stats.transport': 'Transport',
  'stats.edgeHost': 'Edge host',
  'stats.edgeRotations': 'Host rotations',
  'stats.edgeRotating': 'rotated {n}m ago — monitoring',
  'stats.cache': 'Manifest cache',
  'stats.cacheSaved': '{n} edge fetches saved',
  'stats.connection': 'Link',
  'stats.fps': 'fps',
  'stats.auto': 'Auto',
  'stats.off': 'off',
  'stats.directCdn': 'direct CDN',
  'stats.proxied': 'via MaxTV proxy',
  'stats.dataSaver': 'data saver {h}p',
  'stats.unknown': 'unknown',

  // multi-view grid
  'grid.title': 'Multi-view',
  'grid.open': 'Open the multi-view grid',
  'grid.empty': 'Watch up to 4 streams at once',
  'grid.emptyHint': 'Add live events and 24/7 channels to panes — tap a pane for sound, double-tap to expand it.',
  'grid.addChannels': 'Add channels',
  'grid.full': 'Grid full ({n}/{max})',
  'grid.pickerTitle': 'Add to the grid',
  'grid.pickerHint': 'Pick channels for your panes — {n}/{max} used',
  'grid.liveEvents': 'Live events',
  'grid.channels247': '24/7 channels',
  'grid.searchPlaceholder': 'Filter channels…',
  'grid.added': 'In grid',
  'grid.expand': 'Expand to the full player',
  'grid.removePane': 'Remove pane',
  'grid.audioOn': 'Sound on',
  'grid.audioOff': 'Muted',
  'grid.paneOffair': 'Off air',
  'grid.paneError': 'Stream failed',
  'grid.retryPane': 'Retry',
  'grid.active': 'Sound',
  'grid.closeGrid': 'Close multi-view',
  'grid.bandwidthWarn': 'Slow link detected — 4 panes may stall. Lower panes play at 480p max.',
  'grid.paneCount': '{n}/{max} panes',
} as const;

export type TKey = keyof typeof en;

/* ── Arabic ────────────────────────────────────────────────────────────────── */
const ar: Record<Exclude<TKey, never>, string> = {
  // common
  'common.live': 'مباشر',
  'common.close': 'إغلاق',
  'common.cancel': 'إلغاء',
  'common.retry': 'إعادة المحاولة',
  'common.done': 'تم',
  'common.search': 'بحث',
  'common.settings': 'الإعدادات',
  'common.sports': 'الرياضة',
  'common.others': 'أخرى',
  'common.remove': 'إزالة',
  'common.add': 'إضافة',

  // top nav
  'nav.searchLabel': 'ابحث في القنوات والأحداث',
  'nav.install': 'ثبّت التطبيق',
  'nav.installHint': 'أضف MaxTV إلى شاشتك الرئيسية',
  'nav.grid': 'العرض المتعدد',
  'nav.language': 'اللغة',

  // settings menu
  'settings.zap': 'زاب',
  'settings.zapDesc': 'انتقل إلى قناة مباشرة عشوائية',
  'settings.videoQuality': 'جودة الفيديو',
  'settings.auto': 'تلقائي',
  'settings.mostStable': 'الأكثر استقرارًا',
  'settings.autoDesc':
    'يختار الجودة الأكثر استقرارًا لاتصالك — يبدأ بحذر، ويرتفع عندما يثبت الاتصال قدرته، وينخفض فورًا عند التعثر.',
  'settings.dataSaver': 'سلم الجودة · موفّر البيانات',
  'settings.dsUnavailable':
    'غير متاح على هذا الخادم — لا يمكن إعادة ترميز البث. تعود الاختيارات إلى أقرب جودة أصلية.',
  'settings.dsNote': 'أي دقة تُعاد ترميزها لحظيًا لتوفير البيانات — حتى الدقات التي لا يوفرها المصدر.',
  'settings.perfTitle': 'أداء البث',
  'settings.perfFast': '⚡ بداية سريعة',
  'settings.perfFastDesc': 'ينضم إلى حافة البث أسرع ويخزّن أقل — أسرع تشغيل وأقل تأخير. الأنسب للاتصالات العادية.',
  'settings.perfSteady': '🛡️ ثابت كالصخر',
  'settings.perfSteadyDesc': 'تخزين مؤقت أعمق يقاوم الواي فاي الضعيف وبيانات الهاتف — يبدأ أبطأ قليلًا ونادرًا ما يتعثر.',
  'settings.playback': 'التشغيل',
  'settings.autoAdvance': 'التبديل التلقائي عند توقف البث',
  'settings.autoAdvanceDesc': 'ينتقل إلى القناة التالية بعد ١٠ ثوانٍ',
  'settings.connection': 'اتصالك:',
  'settings.connMeasuring': 'جارٍ القياس…',
  'settings.dataSaverOn': 'موفّر البيانات مفعّل',
  'settings.appliesEveryChannel': 'ينطبق على كل القنوات — ويمكنك أيضًا التبديل لكل بث من المشغّل.',
  'settings.appliesNextSwitch': 'ينطبق على كل القنوات بدءًا من بثك التالي.',

  // footer
  'footer.tagline': 'بث مجاني بالرياضة أولًا',
  'footer.blurb':
    'محرّك البث الرياضي منقول من live-sport-plugin · تشكيلة القنوات من IPTV-Scraper-Zilla. لا يستضيف MaxTV أي محتوى — بل يجمع بثوثًا متاحة علنًا لأغراض معلوماتية.',

  // search
  'search.placeholder': 'ابحث عن مباريات مباشرة، قنوات رياضية، قنوات تلفزيونية…',
  'search.noResults': 'لا نتائج لـ',
  'search.noResultsHint': 'جرّب اسم قناة أو دوريًا أو فريقًا.',
  'search.recents': 'شوهدت مؤخرًا',
  'search.favorites': 'المفضلة',
  'search.minChars': 'اكتب حرفين على الأقل للبحث في أكثر من ١٢٠٠٠ قناة وحدث مباشر',
  'search.liveSection': 'مباريات مباشرة وقادمة',
  'search.sportsSection': 'قنوات رياضية',
  'search.tvSection': 'قنوات تلفزيونية',

  // sports tab
  'sports.bigMatches': 'مباريات كبيرة قادمة',
  'sports.bigMatchesSub': 'الدوري الإنجليزي · الليغا · سيري آ · البوندسليغا · دوري الأبطال والمزيد',
  'sports.liveNow': 'يُبث الآن',
  'sports.liveNowSub': '{n} حدثًا يُبث الآن',
  'sports.football': 'كرة القدم',
  'sports.americanFootball': 'كرة القدم الأمريكية',
  'sports.bein': 'beIN Sports',
  'sports.beinSub': '{n} شبكات موثّقة — قنوات كرة القدم العربية أولًا · كل قناة مفحوصة',
  'sports.world': 'رياضات عالمية',
  'sports.worldSub': '{n} شبكات متعددة الجودة — اختر أي جودة من 360p إلى 1080p من المشغّل · كل بث موثّق',
  'sports.yourFavorites': 'المفضلة',
  'sports.yourFavoritesSub': 'قنوات رياضية محفوظة وتنبيهات',
  'sports.recentlyWatched': 'شوهدت مؤخرًا',
  'sports.recentlyWatchedSub': 'أكمل من حيث توقفت',
  'sports.channels247': 'قنوات رياضية ٢٤/٧',
  'sports.channels247Sub': '{n} شبكة رياضية على مدار الساعة · ESPN و Sky Sports و beIN و Willow والمزيد',
  'sports.channels247Loading': 'جارٍ تحميل الشبكات الرياضية الدائمة…',
  'sports.emptyHint': 'يتحدث الجدول كل دقيقة — تصفّح قنوات ٢٤/٧ أعلاه أو',
  'sports.searchLink': 'ابحث عن قناة',
  'sports.upcoming': 'أحداث قادمة',
  'sports.upcomingSub': 'تبدأ قريبًا — الأوقات بتوقيتك المحلي',
  'sports.syncing': 'جارٍ مزامنة جدول الرياضة المباشر…',
  'sports.noLive': 'لا أحداث مباشرة الآن',
  'sports.sportLive': '{sport} مباشر',
  'sports.sportLiveSub': '{n} حدث {sport} مباشر',

  // others tab
  'others.heading': 'قنوات IPTV مجانية',
  'others.headingA': 'كل شيء آخر،',
  'others.headingB': 'تبويب واحد',
  'others.blurb': '{n} قناة مجانية من Pluto TV و Samsung TV Plus و Plex و Xumo و Tubi و Roku و LG Channels و STIRR وغيرها — تتجدد كل ساعة عبر IPTV-Scraper-Zilla.',
  'others.noMatch': 'لا قنوات تطابق هذا الفلتر',
  'others.tryDifferent': 'جرّب فئة أو مصدرًا مختلفًا.',

  // player — top bar / actions
  'player.feed': 'بث {i}/{n}',
  'player.switchFeedTitle': 'تبديل البث — {n} بثوث لهذا الحدث',
  'player.favorite': 'المفضلة (يُضاف إلى المفضلة)',
  'player.share': 'نسخ رابط المشاركة',
  'player.linkCopied': 'تم نسخ الرابط — شاركه حيث تريد',
  'player.tapSound': 'اضغط لتشغيل الصوت',
  'player.goLive': 'العودة للمباشر',
  'player.liveChannel': 'قناة مباشرة',

  // player — quality menu
  'player.quality': 'جودة الفيديو',
  'player.streamQuality': 'جودة البث',
  'player.auto': 'تلقائي',
  'player.autoNote':
    'يختار الجودة الأكثر استقرارًا لاتصالك — يبدأ بحذر، ويرتفع عندما يثبت الاتصال قدرته، وينخفض فورًا عند التعثر.',
  'player.singleQualityNote':
    'مزوّد هذه القناة يقدم جودة واحدة. عندما يحمل مصدر آخر القناة نفسها بسلم جودة حقيقي، تظهر درجاته هنا تلقائيًا.',
  'player.moreQualitiesVia': 'جودات إضافية · عبر {source}',
  'player.altRungNote': 'القناة نفسها على {source} بسلم جودة حقيقي — اختيار درجة ينقلك إليها ويثبّت اختيارك.',
  'player.dataSaverSection': 'سلم الجودة · موفّر البيانات',
  'player.dsUnavailableHere': 'إعادة الترميز اللحظي غير متاحة على هذا الاستضافة — تأتي الجودات المتعددة من سلالم المصادر أعلاه.',
  'player.dsNoteSeg': 'يُعاد ترميزه مباشرة لتوفير البيانات — مصمم للاتصالات البطيئة. 720p/1080p الكاملة تعمل أصليًا متى حملها المصدر.',
  'player.dsNoteRelay': 'أي دقة، تُعاد ترميزها لحظيًا لتوفير البيانات — مثالي للاتصالات البطيئة أو لتحديد الجودة.',
  'player.backToNative': '→ العودة إلى البث الأصلي',
  'player.choiceSaved': 'اختيارك محفوظ ويُطبّق على كل القنوات.',
  'player.dsChip': 'موفّر البيانات',
  'player.rung.ultraLow': 'منخفضة جدًا',
  'player.rung.hd': 'HD',
  'player.rung.fullHd': 'Full HD',

  // player — Local Turbo (client-side low-latency pipeline)
  'player.localTurboSection': 'التُربو المحلي (تجريبي)',
  'player.localTurboNote':
    'يُفكّ ترميز البث داخل متصفحك — يلتصق بحدّ البث المباشر خلال ثانية تقريبًا بدل عدة مقاطع. لا يقلّل استهلاك البيانات.',
  'player.localTurboOn': 'التُربو مفعّل · {height}',
  'player.localTurboFail': 'التُربو غير متاح هنا — العودة للتشغيل القياسي',
  'player.localTurboExit': '→ العودة للتشغيل القياسي',
  'player.localTurboNoPip': 'الصورة داخل الصورة تحتاج التشغيل القياسي — اخرج من التُربو أولًا',
  'player.turboChip': 'تُربو',
  'player.sourceRung': 'الأصل',

  // player — servers menu
  'player.servers': 'السيرفرات',
  'player.streamingServers': 'سيرفرات البث',
  'player.serversAvail': '· {n} متاح',
  'player.backToLiveServers': 'العودة إلى السيرفرات المباشرة',
  'player.backToLiveServersSub': '{name} · نقل DaddyLive',
  'player.active': 'نشط',
  'player.playing': '· قيد التشغيل',
  'player.otherFeed': 'بث آخر',
  'player.differentFeed': '· بث مختلف',
  'player.ladderRange': '· سلم {a}–{b}p',
  'player.realLadder': '· سلم جودة حقيقي',
  'player.hdUp': 'HD↑',
  'player.moreSources': 'مصادر إضافية · متعددة الجودة',
  'player.playingNow': 'قيد التشغيل الآن',
  'player.alternateStream': 'بث بديل {n}',
  'player.altSameSourceSub': 'القناة نفسها، رابط بث مختلف',
  'player.healthy': '· سليم',
  'player.geo': '· قد يكون محجوبًا جغرافيًا',
  'player.noOtherSource': 'لا مصدر آخر يحمل هذه القناة الآن.',
  'player.serversNoteDl':
    'السيرفر ١ (الذاكرة الذكية) يخزّن البث مسبقًا عبر MaxTV — الأكثر سلاسة والافتراضي على الاستضافة السحابية. السيرفر ٢ (CDN مباشر) يبث مباشرة دون وسيط؛ والحواف المباشرة تتخطى تحليل المرايا لأقل تأخير.',
  'player.serversNoteAlts':
    ' المصادر تحت "مصادر إضافية" تحمل هذه القناة في مكان آخر — قنوات "القناة نفسها" تُعير درجات جودتها لقائمة الجودة أيضًا؛ والمدخلات المعلّمة "بث آخر" قنوات ذات صلة.',
  'player.serversNoteNoAlts': ' بثوث DaddyLive تأتي بجودة واحدة؛ اختر مصدرًا متعدد الجودة عندما يظهر هنا.',
  'player.switchServerTitle': 'تبديل سيرفر البث (S)',

  // player — channel guide
  'player.guide': 'دليل القنوات',
  'player.closeGuide': 'إغلاق الدليل',
  'player.guideLoading': 'جارٍ تحميل الدليل…',
  'player.feedsGroup': 'بثوث هذا الحدث',
  'player.liveGroup': 'يُبث الآن',
  'player.channelsGroup': 'قنوات ٢٤/٧',
  'player.alwaysOn': 'دائمًا',
  'player.addToGrid': 'أضف إلى العرض المتعدد',
  'player.justStarted': 'بدأ للتو',
  'player.startedMin': 'بدأ قبل {n} دقيقة',
  'player.startedHour': 'بدأ قبل {h} س {m} د',
  // player — state overlays
  'player.resolving': 'جارٍ تهيئة البث…',
  'player.buffering': 'جارٍ التحميل…',
  'player.offairTitle': 'هذه القناة غير متاحة الآن',
  'player.offairText': 'تبث القنوات ٢٤/٧ عند بدء حدثها المباشر. انتقل إلى قناة أخرى —',
  'player.unavailable': 'البث غير متاح',
  'player.geoText': 'قد تكون القناة محجوبة في منطقتك.',
  'player.manifestUnreachable': 'قائمة البث غير الوصول إليها — قد تكون القناة خارج الخدمة أو محجوبة جغرافيًا.',
  'player.networkError': 'خطأ شبكة ({detail}).',
  'player.mediaError': 'خطأ في فك ترميز الوسائط.',
  'player.playbackError': 'خطأ تشغيل ({detail}).',
  'player.upNext': 'التالي خلال {s} ث — {name}',
  'player.switchServer': 'تبديل السيرفر',
  'player.cancelAutoSwitch': 'إلغاء التبديل التلقائي',
  'player.browseChannels': 'تصفح القنوات',
  'player.tryAnotherFeed': 'جرّب بثًا آخر ({n})',
  'player.watchInstead': 'شاهد {name} بدلًا منها',
  'player.watchInsteadTitle': 'قناة ذات صلة من الشبكة نفسها — ليست {name}',

  // player — HEVC panel
  'player.hevcTitle': '{name} مباشرة — بصيغة لا يستطيع متصفحك تشغيلها',
  'player.hevcText':
    'تبث القناة حاليًا بصيغة HEVC (ترميز فيديو حديث). شاهدها محوّلة إلى 480p هنا، أو افتح MaxTV في سفاري أو إيدج أو على الهاتف — تلك تشغلها أصلًا.',
  'player.play480': 'شاهد بدقة 480p',
  'player.play480Note': 'محوّلة',
  'player.play480Title': 'يحوّل الخادم هذه القناة إلى H.264 بدقة 480p لحظيًا — القناة نفسها والمحتوى نفسه',
  'player.watchFamily': 'شاهد {name} بدلًا منها',
  'player.differentChannel': 'قناة مختلفة',
  'player.tryAnyway': 'جرّب التشغيل رغم ذلك',

  // player — mismatch banner
  'player.mismatchTitle': 'هذا البث يعرض {sport} الآن',
  'player.mismatchText': 'أحيانًا تستبعد القنواتُ الشبكية المباريات. انتقل إلى بث آخر لهذا الحدث.',
  'player.keepWatching': 'مواصلة المشاهدة',
  'player.switchFeed': 'تبديل البث',

  // player — toasts
  'player.reconnecting': 'جارٍ إعادة الاتصال…',
  'player.routing': 'جارٍ توجيه البث عبر MaxTV…',
  'player.switchingServer': 'جارٍ التبديل إلى {label} ({host})…',
  'player.tryingSource': 'جارٍ تجربة {name}…',
  'player.slowConn': 'اتصال بطيء — التبديل إلى {h}p للاستقرار',
  'player.slowConnDs': 'اتصال بطيء — النزول إلى {h}p موفّر البيانات',
  'player.improved': 'تحسّن الاتصال — العودة إلى البث الأصلي',
  'player.dsUnavailableToast': 'موفّر البيانات غير متاح على هذا الخادم — تشغيل البث الأصلي',
  'player.dsHiPref': 'اختيارك المحفوظ {h}p غير قابل للخدمة على هذه الاستضافة — عودة إلى تلقائي',
  'player.dsStreamUnavailable': 'بث موفّر البيانات غير متاح — العودة إلى البث الأصلي',
  'player.hiccup': 'اضطراب في البث — إعادة الاتصال',
  'player.codecHop': 'الترميز غير مدعوم هنا — جارٍ تجربة {name}…',
  'player.pipUnsupported': 'الصورة داخل الصورة غير مدعومة هنا',
  'player.pipUnavailable': 'الصورة داخل الصورة غير متاحة لهذا البث',
  'player.addedToGrid': 'أُضيف إلى العرض المتعدد',
  'player.gridFull': 'الشبكة ممتلئة — أزل لوحًا أولًا',
  'player.qualityAutoToast': 'الجودة: تلقائي — الأكثر استقرارًا لاتصالك',
  'player.qualityToast': 'الجودة: {label} — حُفظت كاختيارك الافتراضي',
  'player.dsEngaged': 'موفّر البيانات: {h}p — بث أخف وبيانات أقل',
  'player.dsUnavailableChannel': 'موفّر البيانات غير متاح لهذه القناة',
  'player.segRefuse': 'إعادة ترميز {h}p لا تعمل بسلاسة هنا — أُعيد ضبط تلقائي (البث الأصلي)',
  'player.nativeIsHp': 'البث الأصلي بالفعل {h}p — العودة إليه',
  'player.topsAt': 'أقصى دقة لهذه القناة {h}p — تشغيلها أصليًا',
  'player.topsAtBack': 'أقصى دقة لهذه القناة {h}p — العودة إلى البث الأصلي',
  'player.prefUnavailable': '{h}p غير متاحة على هذه القناة — تشغيل بثها الأصلي',
  'player.shareOpened': 'فُتح رابط المشاركة',
  'player.altRungToast': 'جارٍ التبديل إلى {source} — {h}p',
  'player.switchingTo': 'جارٍ التبديل إلى {name}…',

  // player — keyboard hints
  'player.keysHint': 'مسافة تشغيل · M كتم · F ملء الشاشة · P صورة داخل صورة · S السيرفرات · I الإحصاءات · ←/→ تغيير القناة · اكتب رقمًا للقفز · Esc خروج',

  // player — a11y
  'player.playPause': 'تشغيل / إيقاف (مسافة)',
  'player.prevChannel': 'القناة السابقة (→)',
  'player.nextChannel': 'القناة التالية (←)',
  'player.toggleMute': 'كتم (M)',
  'player.toggleFullscreen': 'ملء الشاشة (F)',
  'player.pipLabel': 'صورة داخل صورة (P)',
  'player.volume': 'مستوى الصوت',
  'player.closePlayer': 'إغلاق (Esc)',
  'player.playerFor': 'المشغّل — {name}',
  'player.guideTitle': 'تصفح القنوات — اكتب رقم قناة في أي وقت',

  // stats overlay
  'stats.title': 'إحصاءات للمتخصصين',
  'stats.close': 'إغلاق الإحصاءات',
  'stats.open': 'الإحصاءات (I)',
  'stats.resolution': 'الدقة',
  'stats.level': 'المستوى',
  'stats.bitrate': 'معدل البت',
  'stats.bandwidth': 'عرض النطاق التقديري',
  'stats.buffer': 'التخزين الأمامي',
  'stats.backBuffer': 'التخزين الخلفي',
  'stats.dropped': 'إطارات مُسقطة',
  'stats.latency': 'خلف المباشر',
  'stats.transport': 'النقل',
  'stats.edgeHost': 'سيرفر الحافة',
  'stats.edgeRotations': 'تغيّرات السيرفر',
  'stats.edgeRotating': 'تغيّر قبل {n} د — تحت المراقبة',
  'stats.cache': 'ذاكرة القوائم',
  'stats.cacheSaved': 'وفّر {n} طلب حافة',
  'stats.connection': 'الاتصال',
  'stats.fps': 'إطار/ث',
  'stats.auto': 'تلقائي',
  'stats.off': 'مغلق',
  'stats.directCdn': 'CDN مباشر',
  'stats.proxied': 'عبر وسيط MaxTV',
  'stats.dataSaver': 'موفّر بيانات {h}p',
  'stats.unknown': 'غير معروف',

  // multi-view grid
  'grid.title': 'العرض المتعدد',
  'grid.open': 'افتح العرض المتعدد',
  'grid.empty': 'شاهد حتى ٤ بثوث معًا',
  'grid.emptyHint': 'أضف مباريات مباشرة وقنوات ٢٤/٧ إلى الألواح — اضغط لوحًا للصوت واضغط مرتين لتكبيره.',
  'grid.addChannels': 'أضف قنوات',
  'grid.full': 'الشبكة ممتلئة ({n}/{max})',
  'grid.pickerTitle': 'أضف إلى العرض المتعدد',
  'grid.pickerHint': 'اختر قنوات لألواحك — {n}/{max} مستخدمة',
  'grid.liveEvents': 'مباريات مباشرة',
  'grid.channels247': 'قنوات ٢٤/٧',
  'grid.searchPlaceholder': 'تصفية القنوات…',
  'grid.added': 'في الشبكة',
  'grid.expand': 'تكبير إلى المشغّل الكامل',
  'grid.removePane': 'إزالة اللوح',
  'grid.audioOn': 'الصوت مفعّل',
  'grid.audioOff': 'مكتوم',
  'grid.paneOffair': 'خارج البث',
  'grid.paneError': 'فشل البث',
  'grid.retryPane': 'إعادة',
  'grid.active': 'الصوت',
  'grid.closeGrid': 'إغلاق العرض المتعدد',
  'grid.bandwidthWarn': 'رابط بطيء — قد تتعطل ٤ ألواح. الألواح تعمل بحد أقصى 480p.',
  'grid.paneCount': '{n}/{max} ألواح',
};

const DICTS: Record<Locale, Record<string, string>> = { en, ar };

/** translate a key with {param} interpolation; falls back to English then the key */
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  let s = DICTS[locale]?.[key] ?? DICTS.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
