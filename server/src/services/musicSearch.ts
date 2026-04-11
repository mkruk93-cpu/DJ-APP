import fetch from 'node-fetch';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY?.trim() || '';

interface MusicBrainzArtist {
  id: string;
  name: string;
  country: string | null;
  type: string | null;
  disambiguation: string | null;
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

let lastMusicbrainzRequest = 0;
const MIN_REQUEST_INTERVAL = 1500; // 1.5 seconds between requests

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

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastMusicbrainzRequest;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }
  
  lastMusicbrainzRequest = Date.now();
  return fetch(url, options);
}

export async function musicBrainzAutocomplete(term: string, limit = 10): Promise<MusicBrainzArtist[]> {
  if (!term || term.length < 2) return [];
  
  const cacheKey = `mb:${term}:${limit}`;
  const cached = getCached<MusicBrainzArtist[]>(cacheKey);
  if (cached) {
    console.log('[musicbrainz] Cache hit for:', term);
    return cached;
  }

  try {
    const url = `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(term)}&limit=${limit}&fmt=json`;
    console.log('[musicbrainz] Fetching:', url);
    
    const res = await rateLimitedFetch(url, {
      headers: {
        'User-Agent': 'DJ-Stream-App/1.0 (https://stream.krukkex.nl, contact: admin@krukkex.nl)',
        'Accept': 'application/json',
      },
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json() as any;
    console.log('[musicbrainz] Response artists count:', data.artists?.length);
    const artists: MusicBrainzArtist[] = (data.artists || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      country: a.country || null,
      type: a.type || null,
      disambiguation: a.disambiguation || null,
    }));
    
    if (artists.length > 0) {
      setCache(cacheKey, artists);
    }
    return artists;
  } catch (err) {
    console.warn('[musicbrainz] Autocomplete failed:', (err as Error).message);
    return [];
  }
}

export async function lastFmGetArtistInfo(artistName: string): Promise<LastFmArtistInfo | null> {
  if (!LASTFM_API_KEY) {
    console.warn('[lastfm] API key not configured');
    return null;
  }
  if (!artistName) return null;
  
  const cacheKey = `lfm:info:${artistName}`;
  const cached = getCached<LastFmArtistInfo>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json() as any;
    if (data.error) throw new Error(data.message);
    
    const artist = data.artist;
    const info: LastFmArtistInfo = {
      name: artist.name,
      bio: artist.bio || null,
      stats: artist.stats || { listeners: '0', playcount: '0' },
      tags: (artist.tags?.tag || []).map((t: any) => ({ name: t.name, url: t.url })),
      image: artist.image || [],
      url: artist.url || '',
    };
    
    setCache(cacheKey, info);
    return info;
  } catch (err) {
    console.warn('[lastfm] Get artist info failed:', (err as Error).message);
    return null;
  }
}

export async function lastFmGetTopTracks(artistName: string, limit = 50): Promise<LastFmTrack[]> {
  if (!LASTFM_API_KEY) {
    console.warn('[lastfm] API key not configured');
    return [];
  }
  if (!artistName) return [];
  
  const cacheKey = `lfm:tracks:${artistName}:${limit}`;
  const cached = getCached<LastFmTrack[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopTracks&artist=${encodeURIComponent(artistName)}&limit=${limit}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json() as any;
    if (data.error) throw new Error(data.message);
    
    const tracks: LastFmTrack[] = (data.toptracks?.track || []).map((t: any, idx: number) => ({
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
  } catch (err) {
    console.warn('[lastfm] Get top tracks failed:', (err as Error).message);
    return [];
  }
}

export async function lastFmGetTopAlbums(artistName: string, limit = 10): Promise<LastFmAlbum[]> {
  if (!LASTFM_API_KEY) {
    console.warn('[lastfm] API key not configured');
    return [];
  }
  if (!artistName) return [];
  
  const cacheKey = `lfm:albums:${artistName}:${limit}`;
  const cached = getCached<LastFmAlbum[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopAlbums&artist=${encodeURIComponent(artistName)}&limit=${limit}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json() as any;
    if (data.error) throw new Error(data.message);
    
    const albums: LastFmAlbum[] = (data.topalbums?.album || []).map((a: any) => ({
      name: a.name,
      playcount: a.playcount || '0',
      url: a.url || '',
      image: a.image || [],
    }));
    
    setCache(cacheKey, albums);
    return albums;
  } catch (err) {
    console.warn('[lastfm] Get top albums failed:', (err as Error).message);
    return [];
  }
}

export async function iTunesSearchArtwork(artistName: string, limit = 10): Promise<ITunesAlbum[]> {
  if (!artistName) return [];
  
  const cacheKey = `itunes:${artistName}:${limit}`;
  const cached = getCached<ITunesAlbum[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=album&limit=${limit}&attribute=artistTerm`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'DJ-Stream-App/1.0',
      },
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json() as any;
    const albums: ITunesAlbum[] = (data.results || []).map((r: any) => ({
      collectionId: r.collectionId,
      collectionName: r.collectionName,
      artistName: r.artistName,
      artworkUrl100: r.artworkUrl100 || '',
    }));
    
    setCache(cacheKey, albums);
    return albums;
  } catch (err) {
    console.warn('[itunes] Search artwork failed:', (err as Error).message);
    return [];
  }
}

export function getArtworkUrl(url: string, size: '100' | '600' = '600'): string {
  if (!url) return '';
  return url.replace('100x100', `${size}x${size}`);
}