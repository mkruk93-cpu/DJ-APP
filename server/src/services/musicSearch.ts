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
const MIN_REQUEST_INTERVAL = 1500;

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

export async function musicBrainzAutocomplete(term: string, limit = 10): Promise<MusicBrainzArtist[]> {
  if (!term || term.length < 2) return [];
  
  const cacheKey = `mb:${term}:${limit}`;
  const cached = getCached<MusicBrainzArtist[]>(cacheKey);
  if (cached) return cached;

  try {
    // Try Last.fm as fallback since MusicBrainz is not accessible
    if (!LASTFM_API_KEY) {
      console.log('[musicbrainz] No Last.fm key, skipping');
      return [];
    }
    
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.search&artist=${encodeURIComponent(term)}&limit=${limit}&api_key=${LASTFM_API_KEY}&format=json`;
    console.log('[musicbrainz] Fetching from Last.fm:', url);
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json() as any;
    const artists: MusicBrainzArtist[] = (data.results?.artistmatches?.artist || []).map((a: any) => ({
      id: a.mbid || `lfm-${a.name}`,
      name: a.name,
      country: null,
      type: null,
      disambiguation: null,
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

export async function lastFmGetArtistImage(artistName: string): Promise<string | null> {
  if (!LASTFM_API_KEY) return null;
  if (!artistName) return null;
  
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    
    const data = await res.json() as any;
    if (data.error || !data.artist?.image) return null;
    
    const images = data.artist.image as Array<{size: string; '#text': string}>;
    
    // Try to get largest real image, skip placeholder
    const sizes = ['extralarge', 'large', 'medium', 'small'];
    for (const size of sizes) {
      const img = images.find(i => i.size === size && i['#text']);
      if (img) {
        const url = img['#text'];
        // Skip Last.fm's generic star placeholder
        if (!url.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
          return url;
        }
      }
    }
    return null;
  } catch {
    return null;
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
    // Step 1: Search by artist + album
    let url = `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=album&limit=${limit}&attribute=artistTerm`;
    let res = await fetch(url, { headers: { 'User-Agent': 'DJ-Stream-App/1.0' }});
    let data = await res.json() as any;
    let albums: ITunesAlbum[] = (data.results || []).map((r: any) => ({
      collectionId: r.collectionId,
      collectionName: r.collectionName,
      artistName: r.artistName,
      artworkUrl100: r.artworkUrl100 || '',
    }));
    
    // Step 2: If not enough with artwork, also search by track
    const albumsWithArt = albums.filter(a => a.artworkUrl100);
    if (albumsWithArt.length < 3) {
      const trackUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=song&limit=${limit}`;
      const trackRes = await fetch(trackUrl, { headers: { 'User-Agent': 'DJ-Stream-App/1.0' }});
      const trackData = await trackRes.json() as any;
      const trackAlbums = (trackData.results || [])
        .filter((r: any) => r.artworkUrl100)
        .map((r: any) => ({
          collectionId: r.collectionId,
          collectionName: r.collectionName || r.trackName,
          artistName: r.artistName,
          artworkUrl100: r.artworkUrl100 || '',
        }));
      
      albums = [...albumsWithArt, ...trackAlbums].slice(0, limit);
    }
    
    setCache(cacheKey, albums);
    return albums;
  } catch (err) {
    console.warn('[itunes] Search artwork failed:', (err as Error).message);
    return [];
  }
}

export function getArtworkUrl(url: string, size: '100' | '300' = '300'): string {
  if (!url) return '';
  return url.replace('100x100', `${size}x${size}`);
}