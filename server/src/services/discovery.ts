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

async function searchTopTracks(query: string, limit: number): Promise<GenreHitItem[]> {
  const params = new URLSearchParams({
    q: query,
    order: 'RANKING',
    limit: String(limit),
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

export async function getTopTracksByGenre(genre: string, limit = 20): Promise<GenreHitItem[]> {
  const normalizedGenre = genre.trim();
  const safeLimit = Math.max(1, Math.min(limit, 50));
  if (!normalizedGenre) return [];

  try {
    const strict = await searchTopTracks(`genre:"${normalizedGenre}"`, safeLimit);
    if (strict.length > 0) return strict;
  } catch (err) {
    console.warn('[discovery] Strict genre search failed:', (err as Error).message);
  }

  try {
    return await searchTopTracks(normalizedGenre, safeLimit);
  } catch (err) {
    console.warn('[discovery] Fallback genre search failed:', (err as Error).message);
    return [];
  }
}
