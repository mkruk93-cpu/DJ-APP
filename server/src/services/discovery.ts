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

const DEFAULT_POPULAR_GENRES = [
  'hardcore',
  'hardstyle',
  'house',
  'techno',
  'hiphop',
  'metal',
  'nederlands',
  'drum and bass',
  'trance',
  'dance',
  'pop',
  'rock',
  'reggaeton',
  'r&b',
  'afrobeats',
  'latin',
  'edm',
  'psytrance',
  'uptempo',
  'rawstyle',
  'frenchcore',
  'gabber',
];

function normalizeGenreName(name: string): string {
  return name.trim().toLowerCase();
}

function getGenreHints(genre: string): { spotify: string; lastFmTag: string; deezer: string } {
  const normalized = normalizeGenreName(genre);
  const hints: Record<string, { spotify: string; lastFmTag: string; deezer: string }> = {
    hardcore: {
      spotify: 'gabber hardcore dance 180 bpm 190 bpm',
      lastFmTag: 'gabber',
      deezer: 'gabber hardcore dance',
    },
    hardstyle: {
      spotify: 'hardstyle rawstyle euphoric hardstyle',
      lastFmTag: 'hardstyle',
      deezer: 'hardstyle',
    },
    techno: {
      spotify: 'techno peak time techno',
      lastFmTag: 'techno',
      deezer: 'techno',
    },
    hiphop: {
      spotify: 'hip hop rap',
      lastFmTag: 'hip-hop',
      deezer: 'hip hop',
    },
    nederlands: {
      spotify: 'nederlandse hits dutch',
      lastFmTag: 'dutch',
      deezer: 'nederlandstalig',
    },
  };

  return hints[normalized] ?? {
    spotify: genre,
    lastFmTag: genre,
    deezer: genre,
  };
}

function makeUniqueGenreMap(): Map<string, GenreItem> {
  const map = new Map<string, GenreItem>();
  for (const genre of DEFAULT_POPULAR_GENRES) {
    const normalized = normalizeGenreName(genre);
    map.set(normalized, { id: normalized, name: genre });
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

  try {
    const deezerGenres = await fetchDeezerGenres();
    for (const genre of deezerGenres) {
      uniqueGenres.set(normalizeGenreName(genre.name), genre);
    }
  } catch (err) {
    console.warn('[discovery] Genre provider failed, using fallback list:', (err as Error).message);
  }

  const q = normalizeGenreName(query ?? '');
  let items = [...uniqueGenres.values()];
  if (q) {
    items = items.filter((genre) => normalizeGenreName(genre.name).includes(q));
  }

  return items
    .sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }))
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
    signal: AbortSignal.timeout(7000),
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

async function fetchSpotifyTracksByGenre(genre: string, limit: number, offset: number): Promise<GenreHitItem[]> {
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

  try {
    const tagged = await run(`genre:"${hints.lastFmTag}" ${hints.spotify}`);
    if (tagged.length > 0) return tagged;
  } catch (err) {
    console.warn('[discovery] Spotify tagged genre search failed:', (err as Error).message);
  }

  return run(hints.spotify);
}

async function fetchLastFmTopTracksByGenre(genre: string, limit: number, offset: number): Promise<GenreHitItem[]> {
  if (!LASTFM_API_KEY) return [];
  const hints = getGenreHints(genre);
  const page = Math.floor(offset / Math.max(1, limit)) + 1;
  const params = new URLSearchParams({
    method: 'tag.gettoptracks',
    tag: hints.lastFmTag,
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

  return (data.tracks?.track ?? [])
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
    .filter((item): item is GenreHitItem => item !== null)
    .slice(0, limit);
}

export async function getTopTracksByGenre(genre: string, limit = 20, offset = 0): Promise<GenreHitItem[]> {
  const normalizedGenre = genre.trim();
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const safeOffset = Math.max(0, offset);
  const hints = getGenreHints(normalizedGenre);
  if (!normalizedGenre) return [];

  try {
    const spotify = await fetchSpotifyTracksByGenre(normalizedGenre, safeLimit, safeOffset);
    if (spotify.length > 0) return spotify;
  } catch (err) {
    console.warn('[discovery] Spotify genre search failed:', (err as Error).message);
  }

  try {
    const lastFm = await fetchLastFmTopTracksByGenre(normalizedGenre, safeLimit, safeOffset);
    if (lastFm.length > 0) return lastFm;
  } catch (err) {
    console.warn('[discovery] Last.fm genre search failed:', (err as Error).message);
  }

  try {
    const strict = await searchTopTracks(`genre:"${hints.deezer}"`, safeLimit, safeOffset);
    if (strict.length > 0) return strict;
  } catch (err) {
    console.warn('[discovery] Strict genre search failed:', (err as Error).message);
  }

  try {
    return await searchTopTracks(hints.deezer, safeLimit, safeOffset);
  } catch (err) {
    console.warn('[discovery] Fallback genre search failed:', (err as Error).message);
    return [];
  }
}
