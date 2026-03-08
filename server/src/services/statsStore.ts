import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { getAnyUserPlaylistMetaByName } from './userPlaylistStore.js';
import { getSharedPlaylistMetaByName } from './sharedPlaylistStore.js';

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
  genre_inferred?: boolean;
  source_inferred?: boolean;
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

function normalizeSourceType(value: string | null): string | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'shared' || raw === 'shared-playlist') return 'shared_playlist';
  if (raw === 'user' || raw === 'user-playlist') return 'user_playlist';
  if (raw === 'yt' || raw === 'youtube_search') return 'youtube';
  return raw;
}

function splitArtistAndTitle(rawTitle: string): { artist: string; title: string } | null {
  const separators = [' - ', ' — ', ' – ', ' | ', ': '];
  for (const separator of separators) {
    const idx = rawTitle.indexOf(separator);
    if (idx <= 0 || idx >= rawTitle.length - separator.length) continue;
    const left = rawTitle.slice(0, idx).trim();
    const right = rawTitle.slice(idx + separator.length).trim();
    if (!left || !right) continue;
    if (left.length > 90 || right.length > 190) continue;
    return { artist: left, title: right };
  }
  return null;
}

function combineGenre(genreGroup: string | null, subgenre: string | null): string | null {
  const group = (genreGroup ?? '').trim();
  const sub = (subgenre ?? '').trim();
  if (group && sub) return `${group} / ${sub}`;
  return group || sub || null;
}

async function enrichRequestInput(input: StatsRequestEventInput): Promise<{
  addedBy: string;
  title: string | null;
  artist: string | null;
  sourceType: string | null;
  sourceGenre: string | null;
  sourcePlaylist: string | null;
  genreInferred: boolean;
  sourceInferred: boolean;
}> {
  const addedBy = (input.added_by ?? '').trim() || 'anonymous';
  let title = (input.title ?? '').trim() || null;
  let artist = (input.artist ?? '').trim() || null;
  let sourceType = normalizeSourceType(input.source_type ?? null);
  let sourceGenre = (input.source_genre ?? '').trim() || null;
  const sourcePlaylist = (input.source_playlist ?? '').trim() || null;
  let genreInferred = false;
  let sourceInferred = false;

  if (!artist && title) {
    const parsed = splitArtistAndTitle(title);
    if (parsed) {
      artist = parsed.artist;
      title = parsed.title;
    }
  }

  if ((!sourceGenre || !sourceType) && sourcePlaylist) {
    if (!sourceType || sourceType === 'shared_playlist') {
      const sharedMeta = await getSharedPlaylistMetaByName(sourcePlaylist);
      if (sharedMeta) {
        if (!sourceGenre) {
          sourceGenre = combineGenre(sharedMeta.genre_group, sharedMeta.subgenre);
          genreInferred = !!sourceGenre;
        }
        if (!sourceType) {
          sourceType = 'shared_playlist';
          sourceInferred = true;
        }
      }
    }
    if (!sourceGenre && (!sourceType || sourceType === 'user_playlist')) {
      const userMeta = await getAnyUserPlaylistMetaByName(sourcePlaylist);
      if (userMeta) {
        sourceGenre = combineGenre(userMeta.genre_group, userMeta.subgenre);
        genreInferred = !!sourceGenre;
        if (!sourceType) {
          sourceType = 'user_playlist';
          sourceInferred = true;
        }
      }
    }
  }

  return {
    addedBy,
    title,
    artist,
    sourceType,
    sourceGenre,
    sourcePlaylist,
    genreInferred,
    sourceInferred,
  };
}

function clampRecent<T>(items: T[], maxItems: number): void {
  if (items.length <= maxItems) return;
  items.splice(0, items.length - maxItems);
}

export async function recordRequestEvent(input: StatsRequestEventInput): Promise<void> {
  const enriched = await enrichRequestInput(input);
  await withWriteLock((store) => {
    const event: StatsRequestEvent = {
      id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      added_by: enriched.addedBy,
      title: enriched.title,
      artist: enriched.artist,
      source_type: enriched.sourceType,
      source_genre: enriched.sourceGenre,
      source_playlist: enriched.sourcePlaylist,
      genre_inferred: enriched.genreInferred,
      source_inferred: enriched.sourceInferred,
      track_key: buildTrackKey(enriched.artist, enriched.title),
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
  topPlaylists: Array<{ name: string; count: number }>;
  dataQuality: {
    knownGenres: number;
    inferredGenres: number;
    missingGenres: number;
    knownSources: number;
    inferredSources: number;
    missingSources: number;
  };
  recentRequests: Array<{
    ts: number;
    added_by: string;
    title: string | null;
    artist: string | null;
    source_type: string | null;
    source_genre: string | null;
    source_playlist: string | null;
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
  const playlistCounts = new Map<string, number>();
  const uniqueTracks = new Set<string>();
  const uniqueRequesters = new Set<string>();
  let knownGenres = 0;
  let inferredGenres = 0;
  let missingGenres = 0;
  let knownSources = 0;
  let inferredSources = 0;
  let missingSources = 0;

  for (const row of requests) {
    requesterCounts.set(row.added_by, (requesterCounts.get(row.added_by) ?? 0) + 1);
    uniqueRequesters.add(row.added_by);

    const genre = row.source_genre?.trim() || 'Onbekend';
    genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    if (genre === 'Onbekend') {
      missingGenres += 1;
    } else if (row.genre_inferred) {
      inferredGenres += 1;
    } else {
      knownGenres += 1;
    }

    const source = row.source_type?.trim() || 'unknown';
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    if (source === 'unknown') {
      missingSources += 1;
    } else if (row.source_inferred) {
      inferredSources += 1;
    } else {
      knownSources += 1;
    }

    const playlist = row.source_playlist?.trim() || 'Onbekende playlist';
    playlistCounts.set(playlist, (playlistCounts.get(playlist) ?? 0) + 1);

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
    topPlaylists: topCounts(playlistCounts),
    dataQuality: {
      knownGenres,
      inferredGenres,
      missingGenres,
      knownSources,
      inferredSources,
      missingSources,
    },
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
        source_playlist: row.source_playlist,
      })),
  };
}

