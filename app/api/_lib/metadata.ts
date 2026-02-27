export interface RequestMetadata {
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  duration_seconds: number | null;
}

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

async function fetchOEmbed(url: string): Promise<OEmbedResponse | null> {
  const isYouTube = /youtube\.com|youtu\.be/i.test(url);
  const isSoundCloud = /soundcloud\.com/i.test(url);

  let endpoint: string;
  if (isYouTube) {
    endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  } else if (isSoundCloud) {
    endpoint = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  } else {
    return null;
  }

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function parsePTDuration(pt: string): number {
  let seconds = 0;
  const h = pt.match(/(\d+)H/);
  const m = pt.match(/(\d+)M/);
  const s = pt.match(/(\d+)S/);
  if (h) seconds += parseInt(h[1], 10) * 3600;
  if (m) seconds += parseInt(m[1], 10) * 60;
  if (s) seconds += parseInt(s[1], 10);
  return seconds;
}

async function fetchDuration(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const ytMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (ytMatch) return parseInt(ytMatch[1], 10);

    const scMeta = html.match(/<meta\s+itemprop="duration"\s+content="PT([^"]+)"/i);
    if (scMeta) return parsePTDuration(scMeta[1]);

    const scJson = html.match(/"duration"\s*:\s*(\d{4,})/);
    if (scJson) return Math.round(parseInt(scJson[1], 10) / 1000);

    return null;
  } catch {
    return null;
  }
}

function getBestThumbnail(url: string, oembedThumb?: string): string | null {
  const ytMatch = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;
  return oembedThumb ?? null;
}

export async function getRequestMetadata(url: string): Promise<RequestMetadata> {
  const [oembed, duration] = await Promise.all([fetchOEmbed(url), fetchDuration(url)]);
  return {
    title: oembed?.title ?? null,
    artist: oembed?.author_name ?? null,
    thumbnail: getBestThumbnail(url, oembed?.thumbnail_url) ?? null,
    duration_seconds: duration,
  };
}
