// apps/web/src/components/games/LobbyClient.tsx — lobby/games-list view (client).
// Receives SSR-fetched games as initialData; refetches + falls back to offline cache.
'use client';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { offlineDb } from '../../lib/app';
import { safeSession } from '../../lib/safe-storage';
import { Skeleton } from '../ui';
import { HomeCheckin } from '../HomeCheckin';
import { t, detectLang } from '../../lib/i18n';
import type { LobbyGame } from '../../lib/server-games';
import { lobbyListDto, lobbyUiDto } from '../../lib/dto';

const CATEGORIES = [
  'all',
  'popular',
  'crash',
  'mines',
  'dice',
  'cards',
  'wheel',
  'lottery',
  'new',
] as const;

async function fetchGames(): Promise<LobbyGame[]> {
  try {
    const g = await http.get<LobbyGame[]>('/games', { schema: lobbyListDto });
    void offlineDb.put('lobby', g); // offline cache — never throws
    return g;
  } catch {
    return ((await offlineDb.get('lobby')) as LobbyGame[] | undefined) ?? [];
  }
}

async function fetchLobbyUi(): Promise<{ showGameNames: boolean }> {
  try {
    return await http.get('/games/lobby-ui', { schema: lobbyUiDto });
  } catch {
    return { showGameNames: false };
  }
}

export function LobbyClient({
  initialGames,
  title,
}: {
  initialGames: LobbyGame[];
  title?: string;
}) {
  const lang = detectLang();
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(safeSession.get('lastPlayed') || '[]') as string[];
    } catch {
      return [];
    }
  });

  const { data: games, isLoading } = useQuery({
    queryKey: ['games'],
    queryFn: fetchGames,
    initialData: initialGames,
    staleTime: 30_000,
    refetchOnMount: false,
  });
  const { data: lobbyUi } = useQuery({
    queryKey: ['lobby-ui'],
    queryFn: fetchLobbyUi,
    staleTime: 30_000,
  });
  const showNames = lobbyUi?.showGameNames === true;

  const filtered = useMemo(() => {
    if (!games) return [];
    const q = query.trim().toLowerCase();
    return games
      .filter((g) => {
        if (cat !== 'all' && !g.category.includes(cat) && !g.tags.includes(cat))
          return false;
        if (
          q &&
          !g.displayName.toLowerCase().includes(q) &&
          !g.category.some((c) => c.includes(q))
        )
          return false;
        return true;
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [games, cat, query]);

  const play = (slug: string) => {
    const next = [slug, ...recent.filter((s) => s !== slug)].slice(0, 5);
    setRecent(next);
    safeSession.set('lastPlayed', JSON.stringify(next));
  };

  return (
    <div className="px-4 pb-6 space-y-4">
      {title && <h1 className="t-title text-primary pt-2">{title}</h1>}

      {/* DAILY BONUS — hero at the very top (D-067) */}
      <HomeCheckin />

      {/* SEARCH (docs/18) */}
      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(lang, 'lobby.search')}
          className="w-full h-12 rounded-lg bg-layer-elevated border border-white/10 pl-10 pr-10 t-body outline-none focus:border-gold/40"
        />
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40">
          🔍
        </span>
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40"
          >
            ✕
          </button>
        )}
      </div>

      {/* CATEGORY PILLS (docs/18) */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`shrink-0 h-9 px-4 rounded-full t-label-md transition-all ${cat === c ? 'bg-gold/15 border border-gold/35 text-gold font-semibold' : 'bg-white/5 border border-white/8 text-white/60'}`}
          >
            {t(lang, `lobby.${c}`)}
          </button>
        ))}
      </div>

      {/* 🔥 HOT ROW (v1.4.0, operator request: hot games first). Pinned at the
          very start of the games area — before the banner, Recently Played
          and every grid — only in the unfiltered 'all' view (searching/
          filtering already narrows). Admin controls membership via the Hot
          toggle in /panel/games (adds the 'hot' tag). */}
      {cat === 'all' && !query.trim() && !isLoading && games && (
        <HotRow games={games} play={play} t={t} lang={lang} showNames={showNames} />
      )}

      {/* FEATURED BANNER (v4, D-069: rotates through hot games) */}
      {!isLoading && games && games.length > 0 && (
        <FeaturedBanner
          games={games}
          play={play}
          t={t}
          lang={lang}
          showNames={showNames}
        />
      )}

      {/* RECENTLY PLAYED (docs/16 §1) */}
      {recent.length > 0 && (
        <section>
          <h2 className="t-label-lg text-primary mb-2">
            {t(lang, 'lobby.recentlyPlayed')}
          </h2>
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {recent.map((slug) => {
              const g = games?.find((x) => x.slug === slug);
              return g ? (
                <Link
                  key={slug}
                  href={`/games/${slug}`}
                  onClick={() => play(slug)}
                  className={`shrink-0 w-32 rounded-xl bg-layer-surface border border-white/8 overflow-hidden ${showNames ? 'p-3 text-center' : ''}`}
                >
                  <Thumb slug={g.slug} name={g.displayName} />
                  {showNames && (
                    <p className="t-label-sm text-primary mt-2 truncate">
                      {g.displayName}
                    </p>
                  )}
                </Link>
              ) : null;
            })}
          </div>
        </section>
      )}

      {/* GAMES GRID (docs/18 cards) */}
      {isLoading && games.length === 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[16/10] rounded-xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-4xl text-white/30 mb-3">🔍</p>
          <p className="t-label-xl text-secondary">
            {t(lang, 'lobby.noResults', { query })}
          </p>
          <button onClick={() => setQuery('')} className="t-label-md text-gold mt-2">
            {t(lang, 'lobby.clearSearch')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map((g) => (
            <Link
              key={g.slug}
              href={`/games/${g.slug}`}
              onClick={() => play(g.slug)}
              className="group relative rounded-xl overflow-hidden bg-layer-surface border border-white/6 active:scale-95 transition-all duration-200 hover:border-gold/40 hover:shadow-[0_8px_28px_rgba(245,200,66,0.12)] hover:-translate-y-0.5"
            >
              <div className="relative aspect-[16/10]">
                <Thumb slug={g.slug} name={g.displayName} />
                {g.tags.includes('hot') && <Badge kind="hot" />}
                {!g.tags.includes('hot') && g.tags.includes('new') && (
                  <Badge kind="new" />
                )}
                {showNames && (
                  <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/85 to-transparent" />
                )}
              </div>
              {showNames && (
                <div className="absolute bottom-0 inset-x-0 p-2">
                  <p className="t-label-lg text-white truncate drop-shadow">
                    {g.displayName}
                  </p>
                  <p className="t-label-sm text-white/50">
                    {process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play'}
                  </p>
                </div>
              )}
              {g.demoEnabled && (
                <span className="absolute top-2 right-2 t-label-sm uppercase tracking-wide text-white/70 bg-black/50 rounded px-1.5 py-0.5">
                  {t(lang, 'games.demoMode')}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
      <style>{`.no-scrollbar::-webkit-scrollbar{display:none}.no-scrollbar{scrollbar-width:none}`}</style>
    </div>
  );
}

/** v1.4.0 — pinned hot row: hot-tagged games render FIRST on the lobby page. */
function HotRow({
  games,
  play,
  t,
  lang,
  showNames,
}: {
  games: LobbyGame[];
  play: (s: string) => void;
  t: (l: 'en' | 'ur', k: string, p?: Record<string, string | number>) => string;
  lang: 'en' | 'ur';
  showNames: boolean;
}) {
  const hot = games.filter((g) => g.tags.includes('hot'));
  if (hot.length === 0) return null;
  return (
    <section>
      <h2 className="t-label-lg text-primary mb-2">🔥 {t(lang, 'lobby.hot')}</h2>
      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {hot.map((g) => (
          <Link
            key={g.slug}
            href={`/games/${g.slug}`}
            onClick={() => play(g.slug)}
            className="group relative shrink-0 w-44 rounded-xl overflow-hidden bg-layer-surface border border-orange/20 active:scale-95 transition-all duration-200 hover:border-orange/50"
          >
            <div className="relative aspect-[16/10]">
              <Thumb slug={g.slug} name={g.displayName} />
              <span className="absolute top-2 left-2 t-label-sm uppercase tracking-wider px-2 py-0.5 rounded bg-[#99440e] text-white">
                Hot
              </span>
              {showNames && (
                <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/85 to-transparent" />
              )}
            </div>
            {showNames && (
              <div className="p-2">
                <p className="t-label-md text-white truncate">{g.displayName}</p>
                <p className="t-label-sm text-white/55">
                  {process.env.NEXT_PUBLIC_PLATFORM_NAME || '2 Win 2 Play'}
                </p>
              </div>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}

function FeaturedBanner({
  games,
  play,
  t,
  lang,
  showNames,
}: {
  games: LobbyGame[];
  play: (s: string) => void;
  t: (l: 'en' | 'ur', k: string, p?: Record<string, string | number>) => string;
  lang: 'en' | 'ur';
  showNames: boolean;
}) {
  const [idx, setIdx] = React.useState(0);
  const featured = games
    .filter((g) => g.tags.includes('hot') || g.slug === 'aviator')
    .slice(0, 3);
  const item = featured[idx % Math.max(1, featured.length)] ?? games[0];
  React.useEffect(() => {
    if (featured.length < 2) return;
    const iv = setInterval(() => setIdx((i) => i + 1), 7000);
    return () => clearInterval(iv);
  }, [featured.length]);
  if (!item) return null;
  const emojis: Record<string, string> = {
    aviator: '🚀',
    plinko: '🔴',
    wingo: '🎯',
    mines: '💎',
    roulette: '🎰',
    'crash-x': '🛸',
    wheel: '🎡',
    'coin-flip': '🪙',
    'ring-of-fortune': '💍',
  };
  const gradient: Record<string, string> = {
    aviator: 'from-[#1a1030] via-[#0f1b3d] to-[#0a0a14]',
    'crash-x': 'from-[#1a0a2a] via-[#2a1038] to-[#0a0a14]',
    wingo: 'from-[#200a2e] via-[#3a1040] to-[#0a0a14]',
    roulette: 'from-[#2e0a0a] via-[#3d1410] to-[#0a0a14]',
    plinko: 'from-[#0a1a2e] via-[#10305a] to-[#0a0a14]',
    mines: 'from-[#2e1c0a] via-[#3d2a10] to-[#0a0a14]',
    wheel: 'from-[#2e0f0a] via-[#3d1a10] to-[#0a0a14]',
    'coin-flip': 'from-[#2e240a] via-[#3d3010] to-[#0a0a14]',
  };
  const key = item.slug + '-' + idx;
  return (
    <Link
      key={key}
      href={`/games/${item.slug}`}
      onClick={() => play(item.slug)}
      className="block relative h-44 rounded-xl overflow-hidden border border-white/10 bg-gradient-to-br group"
      style={{
        background: `radial-gradient(120% 120% at 20% 0%, rgba(245,200,66,0.12), transparent 55%), radial-gradient(90% 90% at 85% 100%, rgba(77,159,255,0.10), transparent 60%)`,
      }}
    >
      <div
        className={`absolute inset-0 bg-gradient-to-br ${gradient[item.slug] ?? 'from-[#14142a] to-[#0a0a14]'}`}
      />
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '30px 30px',
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-7xl animate-float-slow drop-shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
        {emojis[item.slug] ?? '🎮'}
      </div>
      <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/85 to-transparent flex justify-between items-end">
        <div>
          {showNames && (
            <p className="t-title text-white drop-shadow">{item.displayName}</p>
          )}
          <p className="t-label-sm text-gold/80 uppercase tracking-widest">
            {item.category[0] ?? 'featured'} · {t(lang, 'games.playNow')}
          </p>
        </div>
        <span className="btn-primary px-5 !h-10 text-sm">
          {t(lang, 'games.playNow')}
        </span>
      </div>
      {featured.length > 1 && (
        <div className="absolute top-3 right-3 flex gap-1">
          {featured.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === idx % featured.length ? 'w-5 bg-gold' : 'w-1.5 bg-white/25'}`}
            />
          ))}
        </div>
      )}
    </Link>
  );
}

function Thumb({ slug, name }: { slug: string; name?: string }) {
  // D-084 self-heal: if the first load fails (e.g. a stale SW/browser cached a
  // 404 from an old build), retry ONCE with a cache-busting query param — the
  // unique URL forces a fresh network fetch past any poisoned cache.
  const [tryBust, setTryBust] = React.useState(false);
  const [err, setErr] = React.useState(false);
  if (err)
    return (
      <div className="w-full h-full bg-layer-elevated flex items-center justify-center text-3xl">
        {emoji(slug)}
      </div>
    );
  return (
    <img
      src={
        tryBust
          ? `/games/${slug}/thumbnail.webp?v=${Date.now()}`
          : `/games/${slug}/thumbnail.webp?v=2`
      }
      alt={name ?? ''}
      loading="lazy"
      className="w-full h-full object-cover"
      onError={() => {
        if (!tryBust) setTryBust(true);
        else setErr(true);
      }}
    />
  );
}
function Badge({ kind }: { kind: 'hot' | 'new' }) {
  return (
    <span
      className={`absolute top-2 left-2 t-label-sm uppercase tracking-wider px-2 py-0.5 rounded ${kind === 'hot' ? 'bg-[#99440e] text-white' : 'bg-green text-[#003d20]'}`}
    >
      {kind}
    </span>
  );
}
function emoji(slug: string): string {
  const map: Record<string, string> = {
    aviator: '✈️',
    plinko: '🔴',
    wingo: '🎯',
    mines: '💣',
    dice: '🎲',
    wheel: '🎡',
    'coin-flip': '🪙',
    tower: '🗼',
    'hi-lo': '🃏',
    limbo: '📈',
    keno: '🎱',
    'dragon-tiger': '🐉',
    roulette: '🎰',
    baccarat: '♠️',
    thimbles: '🥤',
    'ring-of-fortune': '💍',
    'crash-x': '🛸',
    stairs: '🪜',
    'scratch-card': '🎫',
    'lucky-number': '🍀',
  };
  return map[slug] ?? '🎮';
}
