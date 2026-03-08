import fs from 'node:fs';
import { dirname, join } from 'node:path';

export interface StatsRequestEventInput {
  added_by: string;
  title: string | null;
  artist: string | null;
  source_type: string | null;
  source_genre: string | null;
  source_playlist: string | null;
}

interface StatsRequestEvent {
  id: string;
  ts: number;
  added_by: string;
  title: string | null;
  artist: string | null;
  source_type: string | null;
  source_genre: string | null;
  source_playlist: string | null;
  track_key: string;
}

interface StatsStoreShape {
  requests: StatsRequestEvent[];
}

const STORE_FILE = process.env.STATS_STORE_FILE
  ? process.env.STATS_STORE_FILE
  : join(process.cwd(), 'data', 'stats_store.json');
const MAX_REQUEST_EVENTS = 80_000;

let writeQueue: Promise<void> = Promise.resolve();

function ensureStoreDir(): void {
  const dir = dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readStore(): StatsStoreShape {
  ensureStoreDir();
  if (!fs.existsSync(STORE_FILE)) return { requests: [] };
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) return { requests: [] };
    const parsed = JSON.parse(raw) as Partial<StatsStoreShape>;
    return {
      requests: Array.isArray(parsed.requests) ? parsed.requests as StatsRequestEvent[] : [],
    };
  } catch {
    return { requests: [] };
  }
}

function writeStore(store: StatsStoreShape): void {
  ensureStoreDir();
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

async function withWriteLock<T>(operation: (store: StatsStoreShape) => T): Promise<T> {
  const run = writeQueue.then(() => {
    const store = readStore();
    const result = operation(store);
    writeStore(store);
    return result;
  });
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTrackKey(artist: string | null, title: string | null): string {
  return `${normalizeText(artist)}|${normalizeText(title)}`;
}

function clampRecent<T>(items: T[], maxItems: number): void {
  if (items.length <= maxItems) return;
  items.splice(0, items.length - maxItems);
}

export async function recordRequestEvent(input: StatsRequestEventInput): Promise<void> {
  await withWriteLock((store) => {
    const artist = (input.artist ?? '').trim() || null;
    const title = (input.title ?? '').trim() || null;
    const addedBy = (input.added_by ?? '').trim() || 'anonymous';
    const sourceType = (input.source_type ?? '').trim() || null;
    const sourceGenre = (input.source_genre ?? '').trim() || null;
    const sourcePlaylist = (input.source_playlist ?? '').trim() || null;
    const event: StatsRequestEvent = {
      id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      added_by: addedBy,
      title,
      artist,
      source_type: sourceType,
      source_genre: sourceGenre,
      source_playlist: sourcePlaylist,
      track_key: buildTrackKey(artist, title),
    };
    store.requests.push(event);
    clampRecent(store.requests, MAX_REQUEST_EVENTS);
  });
}

function topCounts(map: Map<string, number>, limit = 10): Array<{ name: string; count: number }> {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface StatsSummary {
  generatedAt: number;
  periodDays: number;
  totals: {
    requests: number;
    uniqueRequesters: number;
    uniqueTracks: number;
  };
  topRequesters: Array<{ name: string; count: number }>;
  topGenres: Array<{ name: string; count: number }>;
  topSources: Array<{ name: string; count: number }>;
  topArtists: Array<{ name: string; count: number }>;
  topTracks: Array<{ name: string; count: number }>;
  recentRequests: Array<{
    ts: number;
    added_by: string;
    title: string | null;
    artist: string | null;
    source_type: string | null;
    source_genre: string | null;
  }>;
}

export async function getStatsSummary(periodDays = 30): Promise<StatsSummary> {
  const safeDays = Math.max(1, Math.min(365, Math.round(periodDays)));
  const now = Date.now();
  const since = now - safeDays * 24 * 60 * 60 * 1000;
  const store = readStore();
  const requests = store.requests.filter((item) => item.ts >= since);

  const requesterCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const artistCounts = new Map<string, number>();
  const trackCounts = new Map<string, number>();
  const uniqueTracks = new Set<string>();
  const uniqueRequesters = new Set<string>();

  for (const row of requests) {
    requesterCounts.set(row.added_by, (requesterCounts.get(row.added_by) ?? 0) + 1);
    uniqueRequesters.add(row.added_by);

    const genre = row.source_genre?.trim() || 'Onbekend';
    genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);

    const source = row.source_type?.trim() || 'unknown';
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);

    const artist = row.artist?.trim() || 'Unknown artist';
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);

    const trackName = row.artist?.trim()
      ? `${row.artist} - ${row.title ?? 'Unknown title'}`
      : (row.title ?? 'Unknown title');
    trackCounts.set(trackName, (trackCounts.get(trackName) ?? 0) + 1);
    uniqueTracks.add(row.track_key);
  }

  return {
    generatedAt: now,
    periodDays: safeDays,
    totals: {
      requests: requests.length,
      uniqueRequesters: uniqueRequesters.size,
      uniqueTracks: uniqueTracks.size,
    },
    topRequesters: topCounts(requesterCounts),
    topGenres: topCounts(genreCounts),
    topSources: topCounts(sourceCounts),
    topArtists: topCounts(artistCounts),
    topTracks: topCounts(trackCounts),
    recentRequests: requests
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 12)
      .map((row) => ({
        ts: row.ts,
        added_by: row.added_by,
        title: row.title,
        artist: row.artist,
        source_type: row.source_type,
        source_genre: row.source_genre,
      })),
  };
}

