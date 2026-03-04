import { getCuratedGenreRule, listCuratedGenreRules } from './genreCuratedConfig.js';
import { spawn } from 'node:child_process';

export interface GenreItem {
  id: string;
  name: string;
}

export interface GenreHitItem {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  sourceHint: string;
}

const LASTFM_API_KEY = process.env.LASTFM_API_KEY?.trim() ?? '';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID?.trim() ?? '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET?.trim() ?? '';
let spotifyTokenCache: { token: string; expiresAt: number } | null = null;

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_POPULAR_GENRES = [
  'hardcore',
  'uptempo',
  'gabber',
  'industrial hardcore',
  'krach',
  'terror',
  'terrorcore',
  'mainstream hardcore',
  'happy hardcore',
  'hardstyle',
  'euphoric hardstyle',
  'rawstyle',
  'frenchcore',
  'techno',
  'hard techno',
  'trance',
  'psy trance',
  'psytrance',
  'deep house',
  'future house',
  'house',
  'tech house',
  'progressive house',
  'electro house',
  'drum and bass',
  'liquid drum and bass',
  'neurofunk',
  'bass house',
  'big room',
  'melodic techno',
  'hard dance',
  'dubstep',
  'brostep',
  'uk garage',
  'rock',
  'alternative',
  'alternative rock',
  'indie rock',
  'metal',
  'heavy metal',
  'metalcore',
  'death metal',
  'punk',
  'pop punk',
  'edm',
  'dance',
  'hiphop',
  'nederlandse hiphop',
  'nederlands',
  'top 40',
  'pop',
];

const ALLOWED_GENRE_SET = new Set(DEFAULT_POPULAR_GENRES.map((g) => normalizeGenreName(g)));

interface GenreHints {
  spotifyQueries: string[];
  lastFmTags: string[];
  deezerQueries: string[];
  relevanceTokens: string[];
  avoidTokens: string[];
  requiredTokens?: string[];
  priorityArtists?: string[];
  blockedArtists?: string[];
  priorityTracks?: string[];
  blockedTracks?: string[];
  priorityLabels?: string[];
  minScore: number;
}

function normalizeGenreName(name: string): string {
  return name.trim().toLowerCase();
}

function dedupeNormalized(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = normalizeGenreName(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function isAllowedGenre(genre: string): boolean {
  const normalized = normalizeGenreName(genre);
  if (!normalized) return false;
  if (ALLOWED_GENRE_SET.has(normalized)) return true;
  return !!getCuratedGenreRule(normalized);
}

export function isKnownDiscoveryGenre(genre: string): boolean {
  return isAllowedGenre(genre);
}

function getGenreHints(genre: string): GenreHints {
  const normalized = normalizeGenreName(genre);
  const hints: Record<string, GenreHints> = {
    hardcore: {
      spotifyQueries: ['genre:"hardcore" gabber hardcore dance', 'gabber hardcore uptempo'],
      lastFmTags: ['gabber', 'hardcore'],
      deezerQueries: ['gabber hardcore', 'uptempo hardcore'],
      relevanceTokens: ['hardcore', 'gabber', 'uptempo', 'frenchcore', 'rawstyle'],
      avoidTokens: ['house', 'afrobeats', 'latin pop'],
      minScore: 2,
    },
    'industrial hardcore': {
      spotifyQueries: ['industrial hardcore darkcore gabber', 'hardcore industrial'],
      lastFmTags: ['industrial hardcore', 'hardcore'],
      deezerQueries: ['industrial hardcore', 'darkcore hardcore'],
      relevanceTokens: ['industrial', 'darkcore', 'hardcore', 'gabber'],
      avoidTokens: ['house', 'pop'],
      minScore: 2,
    },
    krach: {
      spotifyQueries: ['krach hardcore zaag', 'hardcore krach'],
      lastFmTags: ['gabber', 'hardcore'],
      deezerQueries: ['krach hardcore', 'deutscher krach'],
      relevanceTokens: ['krach', 'zaag', 'saw', 'hardcore'],
      avoidTokens: ['gabber', 'early hardcore', 'house', 'trance'],
      minScore: 2,
    },
    terror: {
      spotifyQueries: ['terror hardcore terrorcore', 'speedcore terror'],
      lastFmTags: ['terrorcore', 'hardcore'],
      deezerQueries: ['terrorcore hardcore', 'terror hardcore'],
      relevanceTokens: ['terror', 'terrorcore', 'speedcore', 'hardcore'],
      avoidTokens: ['house', 'afrobeats'],
      minScore: 2,
    },
    terrorcore: {
      spotifyQueries: ['terrorcore speedcore hardcore', 'terrorcore'],
      lastFmTags: ['terrorcore', 'speedcore'],
      deezerQueries: ['terrorcore', 'speedcore hardcore'],
      relevanceTokens: ['terrorcore', 'speedcore', 'terror', 'hardcore'],
      avoidTokens: ['house', 'pop'],
      minScore: 2,
    },
    hardstyle: {
      spotifyQueries: ['genre:"hardstyle" hardstyle rawstyle', 'hardstyle rawstyle euphoric'],
      lastFmTags: ['hardstyle', 'rawstyle'],
      deezerQueries: ['hardstyle rawstyle', 'hard dance hardstyle'],
      relevanceTokens: ['hardstyle', 'rawstyle', 'euphoric', 'defqon', 'qlimax'],
      avoidTokens: ['house', 'afrobeats', 'reggaeton'],
      minScore: 2,
    },
    'euphoric hardstyle': {
      spotifyQueries: ['euphoric hardstyle melodic hardstyle', 'hardstyle euphoric anthem'],
      lastFmTags: ['hardstyle', 'euphoric hardstyle'],
      deezerQueries: ['euphoric hardstyle', 'melodic hardstyle'],
      relevanceTokens: ['euphoric', 'hardstyle', 'melodic', 'anthem'],
      avoidTokens: ['terror', 'industrial'],
      minScore: 2,
    },
    techno: {
      spotifyQueries: ['genre:"techno" peak time techno', 'techno warehouse rave'],
      lastFmTags: ['techno'],
      deezerQueries: ['techno', 'peak time techno'],
      relevanceTokens: ['techno', 'acid', 'warehouse', 'rave', 'hard techno'],
      avoidTokens: ['hip hop', 'reggaeton', 'afrobeats'],
      minScore: 2,
    },
    trance: {
      spotifyQueries: ['trance uplifting trance vocal trance', 'trance progressive trance'],
      lastFmTags: ['trance'],
      deezerQueries: ['trance', 'uplifting trance'],
      relevanceTokens: ['trance', 'uplifting', 'vocal trance', 'asot', 'psy'],
      avoidTokens: ['hardcore', 'hip hop'],
      minScore: 2,
    },
    'psy trance': {
      spotifyQueries: ['psy trance psytrance full on', 'psychedelic trance'],
      lastFmTags: ['psytrance', 'psy trance'],
      deezerQueries: ['psy trance', 'psytrance'],
      relevanceTokens: ['psy', 'psytrance', 'psy trance', 'goa'],
      avoidTokens: ['house', 'hip hop'],
      minScore: 2,
    },
    psytrance: {
      spotifyQueries: ['psytrance psy trance full on', 'psychedelic trance'],
      lastFmTags: ['psytrance', 'psy trance'],
      deezerQueries: ['psytrance', 'psy trance'],
      relevanceTokens: ['psytrance', 'psy trance', 'goa', 'psy'],
      avoidTokens: ['house', 'hip hop'],
      minScore: 2,
    },
    'deep house': {
      spotifyQueries: ['deep house soulful deep house', 'deep house melodic house'],
      lastFmTags: ['deep house', 'house'],
      deezerQueries: ['deep house', 'melodic deep house'],
      relevanceTokens: ['deep house', 'deep', 'house', 'melodic'],
      avoidTokens: ['hardcore', 'terror'],
      minScore: 2,
    },
    'future house': {
      spotifyQueries: ['future house bass house', 'future house edm'],
      lastFmTags: ['future house', 'house'],
      deezerQueries: ['future house', 'future bass house'],
      relevanceTokens: ['future house', 'future', 'house', 'bass house'],
      avoidTokens: ['hardcore', 'terror'],
      minScore: 2,
    },
    dubstep: {
      spotifyQueries: ['dubstep brostep bass music', 'dubstep riddim'],
      lastFmTags: ['dubstep', 'brostep'],
      deezerQueries: ['dubstep', 'brostep'],
      relevanceTokens: ['dubstep', 'brostep', 'riddim', 'bass'],
      avoidTokens: ['trance', 'hardstyle'],
      minScore: 2,
    },
    rock: {
      spotifyQueries: ['rock anthems modern rock', 'classic rock alternative rock'],
      lastFmTags: ['rock'],
      deezerQueries: ['rock', 'modern rock'],
      relevanceTokens: ['rock', 'guitar', 'band', 'anthem'],
      avoidTokens: ['hardcore', 'techno'],
      minScore: 2,
    },
    alternative: {
      spotifyQueries: ['alternative alternative rock indie', 'alt rock'],
      lastFmTags: ['alternative', 'alternative rock'],
      deezerQueries: ['alternative rock', 'alternative'],
      relevanceTokens: ['alternative', 'alt', 'indie', 'rock'],
      avoidTokens: ['hardcore', 'terror'],
      minScore: 2,
    },
    metal: {
      spotifyQueries: ['metal heavy metal', 'metalcore melodic metal'],
      lastFmTags: ['metal', 'heavy metal'],
      deezerQueries: ['metal', 'heavy metal'],
      relevanceTokens: ['metal', 'heavy', 'riff', 'core'],
      avoidTokens: ['house', 'trance'],
      minScore: 2,
    },
    hiphop: {
      spotifyQueries: ['genre:"hip hop" hip hop rap', 'hip hop rap nl'],
      lastFmTags: ['hip-hop', 'rap'],
      deezerQueries: ['hip hop rap', 'nederlandse hiphop'],
      relevanceTokens: ['hip hop', 'hiphop', 'rap', 'drill', 'trap'],
      avoidTokens: ['hardstyle', 'trance', 'techno'],
      minScore: 2,
    },
    nederlands: {
      spotifyQueries: ['nederlandstalig nederlands hits dutch', 'nederlandse pop'],
      lastFmTags: ['dutch', 'nederlandstalig'],
      deezerQueries: ['nederlandstalig', 'nederlandse hits'],
      relevanceTokens: ['nederlands', 'nederlandstalig', 'dutch', 'holland'],
      avoidTokens: ['k-pop', 'afrobeats'],
      minScore: 2,
    },
  };

  const base = hints[normalized] ?? {
    spotifyQueries: [`genre:"${genre}" ${genre}`, genre],
    lastFmTags: [genre],
    deezerQueries: [genre],
    relevanceTokens: [normalized],
    avoidTokens: [],
    minScore: 1,
  };

  const curated = getCuratedGenreRule(normalized);
  if (!curated) {
    return {
      ...base,
      requiredTokens: base.requiredTokens ?? [],
      priorityArtists: base.priorityArtists ?? [],
      blockedArtists: [],
      priorityTracks: base.priorityTracks ?? [],
      blockedTracks: [],
      priorityLabels: base.priorityLabels ?? [],
    };
  }

  return {
    spotifyQueries: dedupeNormalized([...base.spotifyQueries, ...(curated.requiredTokens ?? [])]),
    lastFmTags: dedupeNormalized([...base.lastFmTags, ...(curated.requiredTokens ?? []).slice(0, 2)]),
    deezerQueries: dedupeNormalized([...base.deezerQueries, ...(curated.requiredTokens ?? [])]),
    relevanceTokens: dedupeNormalized([...base.relevanceTokens, ...(curated.requiredTokens ?? [])]),
    avoidTokens: dedupeNormalized([...base.avoidTokens, ...(curated.blockedTokens ?? [])]),
    requiredTokens: dedupeNormalized([...(base.requiredTokens ?? []), ...(curated.requiredTokens ?? [])]),
    priorityArtists: dedupeNormalized([...(base.priorityArtists ?? []), ...(curated.priorityArtists ?? [])]),
    blockedArtists: dedupeNormalized([...(curated.blockedArtists ?? [])]),
    priorityTracks: dedupeNormalized([...(base.priorityTracks ?? []), ...(curated.priorityTracks ?? [])]),
    blockedTracks: dedupeNormalized([...(curated.blockedTracks ?? [])]),
    priorityLabels: dedupeNormalized([...(base.priorityLabels ?? []), ...(curated.priorityLabels ?? [])]),
    minScore: Math.max(base.minScore, curated.minScore ?? base.minScore),
  };
}

function scoreGenreRelevance(item: GenreHitItem, hints: GenreHints): number {
  const text = `${item.artist} ${item.title} ${item.sourceHint}`.toLowerCase();
  let score = 0;
  for (const token of hints.relevanceTokens) {
    if (!token) continue;
    const normalized = token.toLowerCase();
    if (text.includes(normalized)) score += normalized.includes(' ') ? 4 : 3;
  }
  for (const token of hints.avoidTokens) {
    if (!token) continue;
    if (text.includes(token.toLowerCase())) score -= 5;
  }
  for (const artist of hints.priorityArtists ?? []) {
    if (!artist) continue;
    if (item.artist.toLowerCase().includes(artist.toLowerCase())) score += 16;
  }
  for (const track of hints.priorityTracks ?? []) {
    if (!track) continue;
    if (item.title.toLowerCase().includes(track.toLowerCase())) score += 11;
  }
  for (const label of hints.priorityLabels ?? []) {
    if (!label) continue;
    if (text.includes(label.toLowerCase())) score += 6;
  }
  return score;
}

function hasRequiredEvidence(item: GenreHitItem, hints: GenreHints): boolean {
  const required = hints.requiredTokens ?? [];
  const artistPriors = hints.priorityArtists ?? [];
  const labelPriors = hints.priorityLabels ?? [];
  if (required.length === 0 && artistPriors.length === 0 && labelPriors.length === 0) {
    return true;
  }

  const artistText = item.artist.toLowerCase();
  const fullText = `${item.artist} ${item.title} ${item.sourceHint}`.toLowerCase();
  if (artistPriors.some((value) => artistText.includes(value.toLowerCase()))) return true;
  if (labelPriors.some((value) => fullText.includes(value.toLowerCase()))) return true;
  if (required.some((value) => fullText.includes(value.toLowerCase()))) return true;
  return false;
}

function filterHitsByGenre(items: GenreHitItem[], hints: GenreHints, limit: number): GenreHitItem[] {
  const blocked = new Set((hints.blockedTracks ?? []).map((value) => value.toLowerCase()));
  const blockedArtists = (hints.blockedArtists ?? []).map((value) => value.toLowerCase());
  const scored = dedupeHits(items)
    .filter((item) => {
      if (isLikelyGenreNameOnlyHit(item, hints)) return false;
      const artist = item.artist.toLowerCase();
      if (blockedArtists.some((blockedArtist) => blockedArtist && artist.includes(blockedArtist))) {
        return false;
      }
      if (blocked.size === 0) return true;
      const title = item.title.toLowerCase();
      const artistTitle = `${item.artist} - ${item.title}`.toLowerCase();
      for (const blockedTrack of blocked) {
        if (!blockedTrack) continue;
        if (title.includes(blockedTrack) || artistTitle.includes(blockedTrack)) {
          return false;
        }
      }
      return true;
    })
    .map((item) => ({
      item,
      score: scoreGenreRelevance(item, hints),
      evidence: hasRequiredEvidence(item, hints),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Math.random() - 0.5;
    });

  const strict = scored
    .filter((row) => row.evidence && row.score >= hints.minScore)
    .map((row) => row.item);
  if (strict.length >= Math.min(limit, 5)) {
    return strict.slice(0, limit);
  }

  // Safety fallback: keep only positive rows with at least one required signal.
  const positive = scored
    .filter((row) => row.evidence && row.score > 0)
    .map((row) => row.item);
  return positive.slice(0, limit);
}

function filterBlockedTracksOnly(items: GenreHitItem[], hints: GenreHints, limit: number): GenreHitItem[] {
  const blocked = new Set((hints.blockedTracks ?? []).map((value) => value.toLowerCase()));
  const blockedArtists = (hints.blockedArtists ?? []).map((value) => value.toLowerCase());
  const filtered = dedupeHits(items).filter((item) => {
    if (isLikelyGenreNameOnlyHit(item, hints)) return false;
    const artist = item.artist.toLowerCase();
    if (blockedArtists.some((blockedArtist) => blockedArtist && artist.includes(blockedArtist))) {
      return false;
    }
    if (blocked.size === 0) return true;
    const title = item.title.toLowerCase();
    const artistTitle = `${item.artist} - ${item.title}`.toLowerCase();
    for (const blockedTrack of blocked) {
      if (!blockedTrack) continue;
      if (title.includes(blockedTrack) || artistTitle.includes(blockedTrack)) {
        return false;
      }
    }
    return true;
  });
  return shuffleCopy(filtered).slice(0, limit);
}

function dedupeHits(items: GenreHitItem[]): GenreHitItem[] {
  return Array.from(
    new Map(
      items.map((item) => [
        `${item.artist}-${item.title}`.toLowerCase().replace(/\s+/g, ' ').trim(),
        item,
      ]),
    ).values(),
  );
}

function normalizeLooseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyGenreNameOnlyHit(item: GenreHitItem, hints: GenreHints): boolean {
  const title = normalizeLooseText(item.title);
  const artist = normalizeLooseText(item.artist);
  if (!title) return true;

  const genreTokens = [
    ...hints.relevanceTokens,
    ...(hints.requiredTokens ?? []),
  ]
    .map(normalizeLooseText)
    .filter(Boolean);

  // Common wrong-hit pattern: title is just the genre keyword itself.
  if (genreTokens.some((token) => token === title)) return true;

  // Another wrong-hit pattern: both artist and title collapse to genre terms only.
  if (
    artist &&
    genreTokens.some((token) => artist === token || artist.includes(token)) &&
    genreTokens.some((token) => title.includes(token))
  ) {
    const titleWordCount = title.split(' ').filter(Boolean).length;
    if (titleWordCount <= 2) return true;
  }

  return false;
}

function makeUniqueGenreMap(): Map<string, GenreItem> {
  const map = new Map<string, GenreItem>();
  for (const genre of DEFAULT_POPULAR_GENRES) {
    const normalized = normalizeGenreName(genre);
    map.set(normalized, { id: normalized, name: genre });
  }
  for (const rule of listCuratedGenreRules()) {
    const normalized = normalizeGenreName(rule.id);
    if (!normalized || map.has(normalized)) continue;
    map.set(normalized, {
      id: normalized,
      name: rule.label?.trim() || normalized,
    });
  }
  return map;
}

async function fetchDeezerGenres(): Promise<GenreItem[]> {
  const res = await fetch('https://api.deezer.com/genre', {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Deezer genre HTTP ${res.status}`);
  }

  const data = await res.json() as { data?: Array<{ id?: number; name?: string }> };
  const genres = data.data ?? [];
  return genres
    .map((g) => {
      const name = (g.name ?? '').trim();
      if (!name || name.toLowerCase() === 'all') return null;
      return {
        id: String(g.id ?? normalizeGenreName(name)),
        name,
      } satisfies GenreItem;
    })
    .filter((item): item is GenreItem => item !== null);
}

export async function searchGenres(query?: string): Promise<GenreItem[]> {
  const uniqueGenres = makeUniqueGenreMap();
  const q = normalizeGenreName(query ?? '');
  const genreOrder = new Map<string, number>();
  DEFAULT_POPULAR_GENRES.forEach((name, index) => {
    genreOrder.set(normalizeGenreName(name), index);
  });
  const curatedRules = listCuratedGenreRules();
  for (const rule of curatedRules) {
    const normalized = normalizeGenreName(rule.id);
    if (!genreOrder.has(normalized)) {
      genreOrder.set(normalized, DEFAULT_POPULAR_GENRES.length + genreOrder.size);
    }
  }

  let items = [...uniqueGenres.values()];
  if (q) {
    items = items.filter((genre) => normalizeGenreName(genre.name).includes(q));
  }

  return items
    .sort((a, b) => {
      const orderA = genreOrder.get(normalizeGenreName(a.name)) ?? Number.MAX_SAFE_INTEGER;
      const orderB = genreOrder.get(normalizeGenreName(b.name)) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' });
    })
    .slice(0, 80);
}

function mapTrackToHit(item: Record<string, unknown>): GenreHitItem | null {
  const title = String(item.title ?? '').trim();
  const artist = String((item.artist as { name?: string } | undefined)?.name ?? '').trim();
  const link = String(item.link ?? '').trim();
  if (!title || !artist) return null;

  const cover = String((item.album as { cover_medium?: string } | undefined)?.cover_medium ?? '').trim();
  const id = String(item.id ?? `${artist}-${title}`);

  return {
    id,
    title,
    artist,
    thumbnail: cover,
    sourceHint: link,
  };
}

async function searchTopTracks(query: string, limit: number, offset: number): Promise<GenreHitItem[]> {
  const params = new URLSearchParams({
    q: query,
    order: 'RANKING',
    limit: String(limit),
    index: String(offset),
  });

  const res = await fetch(`https://api.deezer.com/search/track?${params}`, {
    signal: AbortSignal.timeout(3500),
  });

  if (!res.ok) {
    throw new Error(`Deezer track HTTP ${res.status}`);
  }

  const data = await res.json() as { data?: Array<Record<string, unknown>> };
  return (data.data ?? [])
    .map(mapTrackToHit)
    .filter((item): item is GenreHitItem => item !== null)
    .slice(0, limit);
}

async function getSpotifyAppToken(): Promise<string | null> {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
  if (spotifyTokenCache && Date.now() < spotifyTokenCache.expiresAt) {
    return spotifyTokenCache.token;
  }

  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    throw new Error(`Spotify token HTTP ${res.status}`);
  }

  const data = await res.json() as { access_token?: string; expires_in?: number };
  const token = data.access_token ?? '';
  if (!token) return null;
  const ttlMs = Math.max(60, (data.expires_in ?? 3600) - 60) * 1000;
  spotifyTokenCache = { token, expiresAt: Date.now() + ttlMs };
  return token;
}

async function fetchSpotifyTracksByGenre(
  genre: string,
  limit: number,
  offset: number,
  maxQueries = Number.POSITIVE_INFINITY,
): Promise<GenreHitItem[]> {
  const token = await getSpotifyAppToken();
  if (!token) return [];
  const hints = getGenreHints(genre);

  const buildQuery = (q: string): string => {
    const params = new URLSearchParams({
      q,
      type: 'track',
      market: 'NL',
      limit: String(limit),
      offset: String(offset),
    });
    return `https://api.spotify.com/v1/search?${params}`;
  };

  const mapItems = (items: Array<Record<string, unknown>>): GenreHitItem[] =>
    items
      .map((item) => {
        const title = String(item.name ?? '').trim();
        const artists = Array.isArray(item.artists)
          ? item.artists
              .map((a) => String((a as { name?: string }).name ?? '').trim())
              .filter(Boolean)
              .join(', ')
          : '';
        if (!title || !artists) return null;
        const album = (item.album as { images?: Array<{ url?: string }> } | undefined);
        const image = album?.images?.[1]?.url ?? album?.images?.[0]?.url ?? '';
        return {
          id: String(item.id ?? `${artists}-${title}`).toLowerCase(),
          title,
          artist: artists,
          thumbnail: image,
          sourceHint: String(((item.external_urls as { spotify?: string } | undefined)?.spotify) ?? ''),
        } satisfies GenreHitItem;
      })
      .filter((hit): hit is GenreHitItem => hit !== null);

  const run = async (q: string): Promise<GenreHitItem[]> => {
    const res = await fetch(buildQuery(q), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      throw new Error(`Spotify search HTTP ${res.status}`);
    }
    const data = await res.json() as { tracks?: { items?: Array<Record<string, unknown>> } };
    return mapItems(data.tracks?.items ?? []).slice(0, limit);
  };

  const merged: GenreHitItem[] = [];
  for (const query of hints.spotifyQueries.slice(0, Math.max(0, maxQueries))) {
    try {
      const result = await run(query);
      merged.push(...result);
      if (merged.length >= limit * 2) break;
    } catch (err) {
      console.warn('[discovery] Spotify tagged genre search failed:', (err as Error).message);
    }
  }

  return filterHitsByGenre(merged, hints, limit);
}

async function fetchLastFmTopTracksByGenre(
  genre: string,
  limit: number,
  offset: number,
  maxTags = Number.POSITIVE_INFINITY,
): Promise<GenreHitItem[]> {
  if (!LASTFM_API_KEY) return [];
  const hints = getGenreHints(genre);
  const page = Math.floor(offset / Math.max(1, limit)) + 1;
  const merged: GenreHitItem[] = [];

  for (const tag of hints.lastFmTags.slice(0, Math.max(0, maxTags))) {
    const params = new URLSearchParams({
      method: 'tag.gettoptracks',
      tag,
      api_key: LASTFM_API_KEY,
      format: 'json',
      limit: String(limit),
      page: String(page),
    });

    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`, {
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      throw new Error(`Last.fm HTTP ${res.status}`);
    }

    const data = await res.json() as {
      tracks?: {
        track?: Array<{
          name?: string;
          url?: string;
          artist?: { name?: string };
          image?: Array<{ '#text'?: string; size?: string }>;
        }>;
      };
    };

    merged.push(
      ...(data.tracks?.track ?? [])
        .map((track) => {
          const title = (track.name ?? '').trim();
          const artist = (track.artist?.name ?? '').trim();
          if (!title || !artist) return null;
          const image = track.image ?? [];
          const bestImage = image.find((img) => img.size === 'extralarge' && img['#text'])?.['#text']
            ?? image.find((img) => img.size === 'large' && img['#text'])?.['#text']
            ?? image.find((img) => img['#text'])?.['#text']
            ?? '';
          return {
            id: `${artist}-${title}`.toLowerCase(),
            title,
            artist,
            thumbnail: bestImage,
            sourceHint: track.url ?? '',
          } satisfies GenreHitItem;
        })
        .filter((item): item is GenreHitItem => item !== null),
    );
  }

  return filterHitsByGenre(merged, hints, limit);
}

async function fetchDeezerTracksByGenre(
  genre: string,
  limit: number,
  offset: number,
  maxQueries = Number.POSITIVE_INFINITY,
): Promise<GenreHitItem[]> {
  const hints = getGenreHints(genre);
  const merged: GenreHitItem[] = [];
  for (const query of hints.deezerQueries.slice(0, Math.max(0, maxQueries))) {
    try {
      const items = await searchTopTracks(query, limit, offset);
      merged.push(...items);
    } catch (err) {
      console.warn('[discovery] Deezer genre search failed:', (err as Error).message);
    }
  }
  return filterHitsByGenre(merged, hints, limit);
}

function normalizeHitKey(artist: string, title: string): string {
  return `${artist}-${title}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function shuffleCopy<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function ytdlpSearchPlatform(
  platform: 'yt' | 'sc',
  query: string,
  limit: number,
): Promise<GenreHitItem[]> {
  return new Promise((resolve) => {
    const prefix = platform === 'yt' ? 'ytsearch' : 'scsearch';
    const proc = spawn('python', [
      '-m', 'yt_dlp',
      `${prefix}${limit}:${query}`,
      '--flat-playlist',
      '-j',
      '--no-warnings',
    ], { timeout: 5_000 });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const hits: GenreHitItem[] = [];
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as Record<string, unknown>;
          const title = String(item.title ?? '').trim();
          const artist = String(item.uploader ?? item.channel ?? '').trim();
          if (!title || !artist) continue;
          const thumbnail = Array.isArray(item.thumbnails) && item.thumbnails.length > 0
            ? String((item.thumbnails[item.thumbnails.length - 1] as { url?: string })?.url ?? '').trim()
            : '';
          const sourceHint = String(item.url ?? item.webpage_url ?? '').trim();
          hits.push({
            id: `${platform}-${String(item.id ?? `${artist}-${title}`)}`,
            title,
            artist,
            thumbnail,
            sourceHint,
          });
        } catch {
          // ignore malformed line
        }
      }
      resolve(hits);
    });

    proc.on('error', () => resolve([]));
  });
}

async function fetchPriorityArtistPlatformHits(
  genre: string,
  hints: GenreHints,
  limit: number,
  offset: number,
  options?: { artistSampleSize?: number; perPlatformLimit?: number; maxRuntimeMs?: number },
): Promise<GenreHitItem[]> {
  const normalizePriorityArtistSeed = (value: string): string => {
    return value
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? value.trim();
  };

  const artists = [...(hints.priorityArtists ?? [])]
    .map(normalizePriorityArtistSeed)
    .filter(Boolean);
  if (artists.length === 0) return [];
  const sampleSize = Math.max(1, Math.min(options?.artistSampleSize ?? 6, artists.length));
  const perPlatformLimit = Math.max(1, Math.min(options?.perPlatformLimit ?? 5, 8));
  const maxRuntimeMs = Math.max(300, Math.min(options?.maxRuntimeMs ?? 3500, 7000));
  const startedAt = Date.now();
  const page = Math.floor(offset / Math.max(1, limit));
  const start = (page * sampleSize) % artists.length;
  const selected = Array.from({ length: sampleSize }).map((_, index) => {
    const pos = (start + index) % artists.length;
    return artists[pos];
  });

  const results: GenreHitItem[] = [];
  const seen = new Set<string>();

  const settled = await Promise.allSettled(
    selected.map(async (artist) => {
      if (Date.now() - startedAt > maxRuntimeMs) return [] as GenreHitItem[];
      const query = `${artist} ${genre}`;
      const [ytRes, scRes] = await Promise.allSettled([
        withTimeout(ytdlpSearchPlatform('yt', query, perPlatformLimit), Math.min(2200, maxRuntimeMs), [] as GenreHitItem[]),
        withTimeout(ytdlpSearchPlatform('sc', query, perPlatformLimit), Math.min(2200, maxRuntimeMs), [] as GenreHitItem[]),
      ]);
      return [
        ...(ytRes.status === 'fulfilled' ? ytRes.value : []),
        ...(scRes.status === 'fulfilled' ? scRes.value : []),
      ];
    }),
  );

  for (const bucket of settled) {
    if (bucket.status !== 'fulfilled') continue;
    for (const item of bucket.value) {
      const key = normalizeHitKey(item.artist, item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  }

  return filterHitsByGenre(shuffleCopy(results), hints, limit);
}

async function fetchEmergencyGenreFallbackHits(
  genre: string,
  hints: GenreHints,
  limit: number,
  offset: number,
): Promise<GenreHitItem[]> {
  const query = genre.trim();
  if (!query) return [];

  const deezerPromise = withTimeout(
    searchTopTracks(query, Math.min(30, Math.max(limit * 2, 12)), offset),
    2800,
    [] as GenreHitItem[],
  );
  const ytPromise = withTimeout(
    ytdlpSearchPlatform('yt', `${query} music`, Math.min(10, Math.max(limit, 6))),
    2200,
    [] as GenreHitItem[],
  );
  const scPromise = withTimeout(
    ytdlpSearchPlatform('sc', `${query} music`, Math.min(10, Math.max(limit, 6))),
    2200,
    [] as GenreHitItem[],
  );

  const [deezer, yt, sc] = await Promise.all([deezerPromise, ytPromise, scPromise]);
  const combined = [...deezer, ...yt, ...sc];
  if (combined.length === 0) return [];
  return filterBlockedTracksOnly(combined, hints, limit);
}

export async function getTopTracksByGenre(genre: string, limit = 20, offset = 0): Promise<GenreHitItem[]> {
  const normalizedGenre = genre.trim();
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const safeOffset = Math.max(0, offset);
  if (!normalizedGenre) return [];
  if (!isAllowedGenre(normalizedGenre)) return [];

  const hints = getGenreHints(normalizedGenre);
  const isFastMode = safeOffset === 0 || safeOffset <= safeLimit * 2;
  const spotifyQueries = isFastMode ? 1 : 2;
  const deezerQueries = isFastMode ? 2 : 3;
  const lastFmTags = isFastMode ? 1 : 2;
  const priorityOptions = isFastMode
    ? { artistSampleSize: 7, perPlatformLimit: 4, maxRuntimeMs: 3200 }
    : { artistSampleSize: 10, perPlatformLimit: 5, maxRuntimeMs: 5500 };
  const [spotifyRes, deezerRes, lastFmRes, priorityRes] = await Promise.allSettled([
    spotifyQueries > 0
      ? fetchSpotifyTracksByGenre(normalizedGenre, safeLimit, safeOffset, spotifyQueries)
      : Promise.resolve<GenreHitItem[]>([]),
    isFastMode
      ? withTimeout(fetchDeezerTracksByGenre(normalizedGenre, safeLimit, safeOffset, deezerQueries), 2200, [] as GenreHitItem[])
      : fetchDeezerTracksByGenre(normalizedGenre, safeLimit, safeOffset, deezerQueries),
    fetchLastFmTopTracksByGenre(normalizedGenre, safeLimit, safeOffset, lastFmTags),
    isFastMode
      ? withTimeout(fetchPriorityArtistPlatformHits(normalizedGenre, hints, safeLimit, safeOffset, priorityOptions), 1200, [] as GenreHitItem[])
      : fetchPriorityArtistPlatformHits(normalizedGenre, hints, safeLimit, safeOffset, priorityOptions),
  ]);

  const collected: GenreHitItem[] = [];
  if (spotifyRes.status === 'fulfilled') collected.push(...spotifyRes.value);
  else console.warn('[discovery] Spotify genre search failed:', spotifyRes.reason);
  if (deezerRes.status === 'fulfilled') collected.push(...deezerRes.value);
  else console.warn('[discovery] Deezer genre search failed:', deezerRes.reason);
  if (lastFmRes.status === 'fulfilled') collected.push(...lastFmRes.value);
  else console.warn('[discovery] Last.fm genre search failed:', lastFmRes.reason);
  if (priorityRes.status === 'fulfilled') collected.push(...priorityRes.value);
  else console.warn('[discovery] Priority artist platform search failed:', priorityRes.reason);

  const strict = filterHitsByGenre(collected, hints, safeLimit);
  if (strict.length >= Math.min(safeLimit, 6)) return strict.slice(0, safeLimit);

  // Always provide data when possible, even if strict genre evidence is sparse.
  const emergency = await fetchEmergencyGenreFallbackHits(normalizedGenre, hints, safeLimit, safeOffset);
  const broadFallback = filterBlockedTracksOnly(collected, hints, safeLimit);

  const merged = dedupeHits([
    ...strict,
    ...emergency,
    ...broadFallback,
  ]).slice(0, safeLimit);

  if (merged.length > 0) return merged;

  // Last resort.
  return broadFallback;
}
