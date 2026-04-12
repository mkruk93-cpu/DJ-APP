import fetch from 'node-fetch';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY?.trim() || '';

// Stijlvolle SVG fallback
const FALLBACK_IMAGE = "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300' fill='%231f2937'%3E%3Crect width='300' height='300'/%3E%3Cpath d='M150 80v80c-4-3-9-5-15-5-14 0-25 11-25 25s11 25 25 25 25-11 25-25V105h40V80h-50z' fill='%234b5563'/%3E%3C/svg%3E";

interface MusicBrainzArtist {
  id: string;
  name: string;
  country: string | null;
  type: string | null;
  disambiguation: string | null;
  image: string | null;
}

interface LastFmTrack {
  name: string;
  rank: number;
  playcount: string;
  listeners: string;
  duration: number | null;
  artist: { name: string };
  url: string;
}

interface LastFmAlbum {
  name: string;
  playcount: string;
  url: string;
  image: Array<{ size: string; '#text': string }>;
}

interface LastFmArtistInfo {
  name: string;
  bio: { summary: string; content: string } | null;
  stats: { listeners: string; playcount: string };
  tags: Array<{ name: string; url: string }>;
  image: Array<{ size: string; '#text': string }>;
  url: string;
}

interface ITunesAlbum {
  collectionId: number;
  collectionName: string;
  artistName: string;
  artworkUrl100: string;
}

const searchCache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCached<T>(key: string): T | null {
  const entry = searchCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) {
    return entry.data as T;
  }
  return null;
}

function setCache(key: string, data: unknown): void {
  searchCache.set(key, { data, ts: Date.now() });
}

// --- HELPERS ---

async function fetchItunesArt(term: string, entity: 'album' | 'song' = 'album'): Promise<string | null> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'DJ-Stream-App/1.0' }});
    const data = await res.json() as any;
    return data.results?.[0]?.artworkUrl100 || null;
  } catch {
    return null;
  }
}

// --- EXPORTS ---

export async function musicBrainzAutocomplete(term: string, limit = 10): Promise<MusicBrainzArtist[]> {
  if (!term || term.length < 2) return [];
  const cacheKey = `mb:${term}:${limit}`;
  const cached = getCached<MusicBrainzArtist[]>(cacheKey);
  if (cached) return cached;

  try {
    if (!LASTFM_API_KEY) return [];
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.search&artist=${encodeURIComponent(term)}&limit=${limit}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    const data = await res.json() as any;
    const rawArtists = (data.results?.artistmatches?.artist || []) as any[];

    // Haal iTunes artwork op voor alle artiesten tegelijk (parallel)
    const artistsWithImages: MusicBrainzArtist[] = await Promise.all(
      rawArtists.map(async (a: any) => {
        const image = await fetchItunesArt(a.name, 'song');
        return {
          id: a.mbid || `lfm-${a.name}`,
          name: a.name,
          country: null,
          type: null,
          disambiguation: null,
          image: image ?? null,
        };
      })
    );

    setCache(cacheKey, artistsWithImages);
    return artistsWithImages;
  } catch (err) {
    return [];
  }
}

export async function lastFmGetArtistImage(artistName: string): Promise<string | null> {
  if (!artistName) return null;
  // Last.fm images zijn vaak ster-placeholders. We proberen iTunes voor een ECHTE artiestenfoto (via een track match)
  const cached = getCached<string>(`artimg:${artistName}`);
  if (cached) return cached;

  const itunesImg = await fetchItunesArt(artistName, 'song');
  if (itunesImg) {
    setCache(`artimg:${artistName}`, itunesImg);
    return itunesImg;
  }
  return null;
}

export async function lastFmGetArtistInfo(artistName: string): Promise<LastFmArtistInfo | null> {
  if (!LASTFM_API_KEY || !artistName) return null;
  const cacheKey = `lfm:info:${artistName}`;
  const cached = getCached<LastFmArtistInfo>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    const data = await res.json() as any;
    if (data.error) throw new Error(data.message);
    const info: LastFmArtistInfo = {
      name: data.artist.name,
      bio: data.artist.bio || null,
      stats: data.artist.stats || { listeners: '0', playcount: '0' },
      tags: (data.artist.tags?.tag || []).map((t: any) => ({ name: t.name, url: t.url })),
      image: data.artist.image || [],
      url: data.artist.url || '',
    };
    setCache(cacheKey, info);
    return info;
  } catch {
    return null;
  }
}

export async function lastFmGetTopTracks(artistName: string, limit = 50): Promise<LastFmTrack[]> {
  if (!LASTFM_API_KEY || !artistName) return [];
  const cacheKey = `lfm:tracks:${artistName}:${limit}`;
  const cached = getCached<LastFmTrack[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopTracks&artist=${encodeURIComponent(artistName)}&limit=${limit}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    const data = await res.json() as any;
    const tracks = (data.toptracks?.track || []).map((t: any, idx: number) => ({
      name: t.name,
      rank: idx + 1,
      playcount: t.playcount || '0',
      listeners: t.listeners || '0',
      duration: t.duration ? parseInt(t.duration, 10) : null,
      artist: { name: t.artist?.name || artistName },
      url: t.url || '',
    }));
    setCache(cacheKey, tracks);
    return tracks;
  } catch {
    return [];
  }
}

export async function lastFmGetTopAlbums(artistName: string, limit = 10): Promise<LastFmAlbum[]> {
  if (!LASTFM_API_KEY || !artistName) return [];
  const cacheKey = `lfm:albums:${artistName}:${limit}`;
  const cached = getCached<LastFmAlbum[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopAlbums&artist=${encodeURIComponent(artistName)}&limit=${limit}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    const data = await res.json() as any;
    
    const albums = await Promise.all((data.topalbums?.album || []).map(async (a: any) => {
      let img = a.image?.find((i: any) => i['#text'] && !i['#text'].includes('2a96cbd8'))?.['#text'];
      
      // Geen beeld van Last.fm? Probeer iTunes specifiek voor dit album
      if (!img) {
        img = await fetchItunesArt(`${artistName} ${a.name}`) || FALLBACK_IMAGE;
      }

      return {
        name: a.name,
        playcount: a.playcount || '0',
        url: a.url || '',
        image: [{ size: 'extralarge', '#text': img }],
      };
    }));
    
    setCache(cacheKey, albums);
    return albums;
  } catch {
    return [];
  }
}

export async function iTunesSearchArtwork(artistName: string, limit = 10): Promise<ITunesAlbum[]> {
  if (!artistName) return [];
  const cacheKey = `itunes:v2:${artistName}:${limit}`;
  const cached = getCached<ITunesAlbum[]>(cacheKey);
  if (cached) return cached;

  try {
    // Zoek breder: zowel op album als op song om de kans op artwork te maximaliseren
    const [albumRes, songRes] = await Promise.all([
        fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=album&limit=${limit}`, { headers: { 'User-Agent': 'DJ-Stream-App' }}),
        fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=song&limit=${limit}`, { headers: { 'User-Agent': 'DJ-Stream-App' }})
    ]);

    const albumData = await albumRes.json() as any;
    const songData = await songRes.json() as any;

    const combined = [...(albumData.results || []), ...(songData.results || [])]
        .filter(r => r.artworkUrl100)
        .map(r => ({
            collectionId: r.collectionId || r.trackId,
            collectionName: r.collectionName || r.trackName,
            artistName: r.artistName,
            artworkUrl100: r.artworkUrl100
        }));

    // Verwijder duplicaten op basis van collectionName
    const unique = Array.from(new Map(combined.map(item => [item.collectionName, item])).values()).slice(0, limit);

    if (unique.length === 0) {
        unique.push({
            collectionId: Date.now(),
            collectionName: "Geen artwork gevonden",
            artistName: artistName,
            artworkUrl100: FALLBACK_IMAGE
        });
    }

    setCache(cacheKey, unique);
    return unique;
  } catch {
    return [];
  }
}

export function getArtworkUrl(url: string, size: '100' | '300' = '300'): string {
  if (!url || url === FALLBACK_IMAGE) return FALLBACK_IMAGE;
  if (url.startsWith('data:image')) return url;
  return url.replace('100x100', `${size}x${size}`).replace('60x60', `${size}x${size}`);
}