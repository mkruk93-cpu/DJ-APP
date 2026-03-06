import fetch from 'node-fetch';
import { spawn } from 'node:child_process';

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string | null;
  channel: string | null;
}

// Cache for search results
const searchCache = new Map<string, { results: SearchResult[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let scClientId: string | null = null;

async function getSoundCloudClientId(): Promise<string | null> {
  if (scClientId) return scClientId;

  try {
    const res = await fetch('https://soundcloud.com/', {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    const html = await res.text();
    
    // Try multiple patterns for client_id extraction
    const patterns = [
      /client_id["\s]*[:=]["\s]*([a-zA-Z0-9]{32})/,
      /"client_id":"([a-zA-Z0-9]{32})"/,
      /client_id=([a-zA-Z0-9]{32})/,
      /clientId["\s]*[:=]["\s]*"([a-zA-Z0-9]{32})"/,
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        scClientId = match[1];
        console.log(`[soundcloud] Got client_id: ${scClientId.slice(0, 8)}... (pattern: ${pattern.source})`);
        return scClientId;
      }
    }
    
    console.warn('[soundcloud] No client_id found in HTML response');
  } catch (err) {
    console.warn('[soundcloud] Failed to get client_id:', (err as Error).message);
  }
  return null;
}

export async function youtubeSearch(query: string, limit = 12): Promise<SearchResult[]> {
  const cacheKey = `yt:${query.toLowerCase().trim()}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.results;

  try {
    const payload = JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'nl',
          gl: 'NL',
        },
      },
      query,
    });

    const res = await fetch('https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: payload,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as any;
    const results: SearchResult[] = [];

    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    if (!Array.isArray(contents)) throw new Error('Invalid response structure');

    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents;
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        const video = item?.videoRenderer;
        if (!video?.videoId) continue;

        const title = video.title?.runs?.[0]?.text?.trim();
        if (!title) continue;

        const lengthText = video.lengthText?.simpleText;
        let duration: number | null = null;
        if (lengthText && /^\d+:\d+$/.test(lengthText)) {
          const [min, sec] = lengthText.split(':').map(Number);
          duration = min * 60 + sec;
        }

        const thumbnail = video.thumbnail?.thumbnails?.[0]?.url || null;
        const channel = video.ownerText?.runs?.[0]?.text?.trim() || null;

        results.push({
          id: video.videoId,
          title,
          url: `https://www.youtube.com/watch?v=${video.videoId}`,
          duration,
          thumbnail,
          channel,
        });

        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }

    searchCache.set(cacheKey, { results, ts: Date.now() });
    return results;
  } catch (err) {
    console.warn('[youtube] Search failed:', (err as Error).message);
    searchCache.set(cacheKey, { results: [], ts: Date.now() });
    return [];
  }
}

async function soundcloudSearchDirect(query: string, limit = 12): Promise<SearchResult[]> {
  const clientId = await getSoundCloudClientId();
  if (!clientId) throw new Error('No SoundCloud client_id');

  const params = new URLSearchParams({
    q: query,
    client_id: clientId,
    limit: String(limit),
    offset: '0',
    linked_partitioning: '1',
  });

  const res = await fetch(`https://api-v2.soundcloud.com/search/tracks?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) scClientId = null;
    throw new Error(`HTTP ${res.status}`);
  }

  const data = await res.json() as any;
  const results: SearchResult[] = [];

  if (Array.isArray(data.collection)) {
    for (const track of data.collection) {
      if (!track.id || !track.title) continue;

      const title = String(track.title).trim();
      if (!title) continue;

      const duration = typeof track.duration === 'number' && track.duration > 0
        ? Math.round(track.duration / 1000)
        : null;

      const thumbnail = track.artwork_url_template
        ? track.artwork_url_template.replace('{size}', 'large')
        : (track.artwork_url || null);

      const channel = track.user?.username || null;

      results.push({
        id: String(track.id),
        title,
        url: track.permalink_url || `https://soundcloud.com/track/${track.id}`,
        duration,
        thumbnail,
        channel,
      });

      if (results.length >= limit) break;
    }
  }

  return results;
}

async function soundcloudSearchFallback(query: string, limit = 12): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const proc = spawn('python', [
      '-m', 'yt_dlp',
      `scsearch${limit}:${query}`,
      '--flat-playlist',
      '-j',
      '--no-warnings',
    ], { timeout: 8000 });

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr?.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }

      const results: SearchResult[] = [];
      const rows = output.split('\n').map(line => line.trim()).filter(Boolean);

      for (const row of rows) {
        try {
          const item = JSON.parse(row) as Record<string, unknown>;
          const title = String(item.title ?? '').trim();
          if (!title) continue;

          const rawDuration = Number(item.duration ?? NaN);
          const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : null;

          const id = String(item.id ?? '').trim();
          const url = String(item.webpage_url ?? item.url ?? '').trim();
          if (!url) continue;

          const thumbnail = Array.isArray(item.thumbnails) && item.thumbnails.length > 0
            ? String((item.thumbnails[item.thumbnails.length - 1] as { url?: string })?.url ?? '').trim() || null
            : null;

          const channel = String(item.uploader ?? '').trim() || null;

          results.push({ id, title, url, duration, thumbnail, channel });
          if (results.length >= limit) break;
        } catch {
          // ignore malformed line
        }
      }

      resolve(results);
    });

    proc.on('error', () => resolve([]));
  });
}

export async function soundcloudSearch(query: string, limit = 12): Promise<SearchResult[]> {
  const cacheKey = `sc:${query.toLowerCase().trim()}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.results;

  try {
    const results = await soundcloudSearchDirect(query, limit);
    searchCache.set(cacheKey, { results, ts: Date.now() });
    return results;
  } catch (err) {
    console.warn('[soundcloud] Direct search failed, falling back to yt-dlp:', (err as Error).message);
    const results = await soundcloudSearchFallback(query, limit);
    searchCache.set(cacheKey, { results, ts: Date.now() });
    return results;
  }
}