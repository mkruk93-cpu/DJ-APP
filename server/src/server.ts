import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { join as pathJoin, extname, basename, resolve as pathResolve } from 'node:path';
import { Server as IOServer } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import { initCache } from './cleanup.js';
import { seedSettings, getActiveMode, getActiveFallbackGenre, getModeSettings, getSetting, setSetting } from './settings.js';
import { getQueue, addToQueue, removeFromQueue, reorderQueue, fetchVideoInfo, extractYoutubeId, extractSourceId, isSoundcloudUrl, getThumbnailUrl, encodeLocalFileUrl } from './queue.js';
import { canPerformAction } from './permissions.js';
import { startPlayCycle, stopPlayCycle, getCurrentTrack, getUpcomingTrack, skipCurrentTrack, isSkipLocked, playerEvents, setKeepFiles, invalidatePreload, invalidateNextReady, removeQueueItemFromPreload, setActiveFallbackGenre } from './player.js';
import { startBridge } from './bridge.js';
import { startNowPlayingWatcher } from './nowPlaying.js';
import { StreamHub } from './streamHub.js';
import type { Mode, ServerState, DurationVote, QueuePushVote, FallbackGenre } from './types.js';
import { searchGenres, getTopTracksByGenre, type GenreItem, type GenreHitItem } from './services/discovery.js';
import { reloadFallbackGenres, listFallbackGenres, getDefaultFallbackGenreId, isKnownFallbackGenre, toAutoFallbackGenreId, parseAutoFallbackGenreId, LIKED_AUTO_GENRE_ID } from './fallbackGenres.js';
import { addPriorityArtistForGenre, addBlockedArtistForGenre, addPriorityTrackForGenre, addBlockedTrackForGenre, addLikedPlaylistTrack } from './services/genreCuratedConfig.js';

// ── Environment ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const CACHE_DIR = process.env.CACHE_DIR ?? pathJoin(tmpdir(), 'radio_cache');
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';

const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH ?? '';
const REKORDBOX_OUTPUT_PATH = process.env.REKORDBOX_OUTPUT_PATH ?? '';
const KEEP_FILES = process.env.KEEP_FILES === 'true';

const useIcecast = !!process.env.ICECAST_HOST;

const ICECAST = useIcecast
  ? {
      host: process.env.ICECAST_HOST!,
      port: parseInt(process.env.ICECAST_PORT ?? '8000', 10),
      password: process.env.ICECAST_PASSWORD ?? '',
      mount: process.env.ICECAST_MOUNT ?? '/stream',
    }
  : null;

const streamHub = useIcecast ? null : new StreamHub();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Express + Socket.io ──────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

const io = new IOServer(httpServer, {
  cors: {
    origin: (_origin, callback) => callback(null, true),
    methods: ['GET', 'POST'],
  },
});

app.use((_req, res, next) => {
  const origin = _req.headers.origin ?? '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(token?: string): boolean {
  return !!token && token === ADMIN_TOKEN;
}

let appliedPlaybackMode: Mode | null = null;

function applyPlaybackForMode(mode: Mode): void {
  if (appliedPlaybackMode === mode) return;
  appliedPlaybackMode = mode;

  if (mode === 'dj') {
    stopPlayCycle();
    io.emit('track:change', null);
    console.log('[mode] DJ active — internal player paused (Icecast source takes over)');
    return;
  }
  startPlayCycle(sb, io, CACHE_DIR, ICECAST, streamHub);
}

const startTime = Date.now();
let lastStateLogKey: string | null = null;
const MODE_SYNC_INTERVAL_MS = 5_000;
const MODE_SYNC_CONFIRM_POLLS = 2;
const MODE_SYNC_COOLDOWN_MS = 10_000;

function normalizeFallbackGenreId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 40);
}

function parseArtistTitle(input: string): { artist: string | null; title: string | null } {
  const trimmed = input.trim();
  if (!trimmed) return { artist: null, title: null };
  const separators = [' - ', ' — ', ' – ', ' | '];
  for (const separator of separators) {
    const idx = trimmed.indexOf(separator);
    if (idx > 0 && idx < trimmed.length - separator.length) {
      const artist = trimmed.slice(0, idx).trim();
      const title = trimmed.slice(idx + separator.length).trim();
      if (artist && title) return { artist, title };
    }
  }
  return { artist: null, title: trimmed };
}

async function resolveActiveFallbackGenre(persistFix = false): Promise<string | null> {
  const raw = await getActiveFallbackGenre(sb);
  const normalized = normalizeFallbackGenreId(raw);
  let resolved = normalized;
  if (resolved && !isKnownFallbackGenre(resolved)) {
    resolved = null;
  }
  if (!resolved) {
    resolved = getDefaultFallbackGenreId();
  }
  if (persistFix && resolved !== normalized) {
    await setSetting(sb, 'fallback_active_genre', resolved);
  }
  return resolved;
}

async function emitFallbackGenreUpdate(target?: { emit: (event: string, payload: unknown) => void }): Promise<void> {
  const [activeGenreId, selectedBy] = await Promise.all([
    resolveActiveFallbackGenre(),
    getSetting<string | null>(sb, 'fallback_active_genre_by'),
  ]);
  setActiveFallbackGenre(activeGenreId);
  const genres = await getCombinedFallbackGenres();
  const payload = {
    activeGenreId,
    selectedBy: normalizeNickname(selectedBy),
    genres,
  };
  if (target) target.emit('fallback:genre:update', payload);
  else io.emit('fallback:genre:update', payload);
}

async function getCombinedFallbackGenres(): Promise<FallbackGenre[]> {
  const localGenres = listFallbackGenres() as FallbackGenre[];
  let autoGenreOptions: GenreItem[] = [];
  try {
    autoGenreOptions = await searchGenres('');
  } catch (err) {
    console.warn('[fallback] Auto genre list unavailable:', (err as Error).message);
  }
  const autoGenres: FallbackGenre[] = autoGenreOptions.map((genre) => ({
    id: toAutoFallbackGenreId(genre.id),
    label: `Auto playlist · ${genre.name}`,
    trackCount: 0,
  }));
  const likedGenre: FallbackGenre = {
    id: toAutoFallbackGenreId(LIKED_AUTO_GENRE_ID),
    label: 'Auto playlist · Liked tracks',
    trackCount: 0,
  };
  return [...localGenres, likedGenre, ...autoGenres];
}

async function getServerState(): Promise<ServerState> {
  const [mode, modeSettings, queue, activeFallbackGenre, activeFallbackGenreBy, fallbackGenres] = await Promise.all([
    getActiveMode(sb),
    getModeSettings(sb),
    getQueue(sb),
    resolveActiveFallbackGenre(),
    getSetting<string | null>(sb, 'fallback_active_genre_by'),
    getCombinedFallbackGenres(),
  ]);

  return {
    currentTrack: getCurrentTrack(),
    upcomingTrack: getUpcomingTrack(),
    queue,
    mode,
    modeSettings,
    fallbackGenres,
    activeFallbackGenre,
    activeFallbackGenreBy: normalizeNickname(activeFallbackGenreBy),
    listenerCount: io.engine.clientsCount,
    streamOnline: getCurrentTrack() !== null,
    voteState: null,
    durationVote: activeDurationVote,
    queuePushVote: activeQueuePushVote
      ? {
          id: activeQueuePushVote.id,
          item_id: activeQueuePushVote.item_id,
          title: activeQueuePushVote.title,
          thumbnail: activeQueuePushVote.thumbnail,
          added_by: activeQueuePushVote.added_by,
          proposed_by: activeQueuePushVote.proposed_by,
          required: activeQueuePushVote.required,
          yes: activeQueuePushVote.yes,
          no: activeQueuePushVote.no,
          expires_at: activeQueuePushVote.expires_at,
        }
      : null,
    queuePushLocked,
    skipLocked: isSkipLocked(),
  };
}

// ── YouTube Search (fast, direct API) ───────────────────────────────────────

interface SearchResult {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string;
  channel: string;
}

interface LocalTrack {
  id: string;
  title: string;
  artist: string;
  filePath: string;
}

const MAX_LONG_CONTENT_SECONDS = 65 * 60;
const MAX_SET_LIKE_SECONDS = 12 * 60;
const MIN_SOUNDCLOUD_SECONDS = 30;

function isSetLikeTitle(title: string): boolean {
  return /\b(set|mix|liveset|live set|podcast|radio show|megamix|full mix|extended mix|dj set|hour mix|hours mix)\b/i.test(title);
}

function scoreResult(item: SearchResult, source: 'youtube' | 'soundcloud'): number {
  let score = 0;
  const title = item.title ?? '';
  const duration = item.duration;
  const setLike = isSetLikeTitle(title);

  if (duration !== null) {
    if (duration >= 120 && duration <= 6 * 60) score += 55;
    else if (duration > 6 * 60 && duration <= 10 * 60) score += 35;
    else if (duration > 10 * 60 && duration <= 15 * 60) score += 12;
    else if (duration < 30) score -= source === 'soundcloud' ? 45 : 20;
    else if (duration < 90) score -= source === 'soundcloud' ? 18 : 8;
    else if (duration > MAX_SET_LIKE_SECONDS) score -= 28;
    if (duration > 20 * 60) score -= 18;
    if (duration > 30 * 60) score -= 20;
  }

  if (setLike) score -= 34;
  if (/\b(official|audio|video|track|lyric video)\b/i.test(title)) score += 8;
  if (/\b(remix|bootleg|edit|vip)\b/i.test(title)) score += 2;

  return score;
}

function postProcessResults(
  input: SearchResult[],
  source: 'youtube' | 'soundcloud',
): SearchResult[] {
  const filtered = input.filter((item) => {
    const duration = item.duration;
    if (duration !== null && duration > MAX_LONG_CONTENT_SECONDS) return false;
    // Filter out short SoundCloud preview/sample clips (often 30s pro snippets).
    if (source === 'soundcloud' && duration !== null && duration <= MIN_SOUNDCLOUD_SECONDS) return false;
    return true;
  });

  return filtered.sort((a, b) => scoreResult(b, source) - scoreResult(a, source));
}

const searchCache = new Map<string, { results: SearchResult[]; ts: number }>();
const CACHE_TTL = 60_000;
const DISCOVERY_CACHE_TTL = 1_800_000;
const genreCache = new Map<string, { results: GenreItem[]; ts: number }>();
const genreHitsCache = new Map<string, { results: GenreHitItem[]; ts: number }>();
const genreHitsRefreshInFlight = new Set<string>();
const LOCAL_INDEX_TTL = 120_000;
const LOCAL_AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.alac', '.wma',
]);
let localTrackIndexCache: { rootsKey: string; tracks: LocalTrack[]; ts: number } | null = null;

function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTitleArtistFromFilename(fileName: string): { artist: string; title: string } {
  const clean = fileName.replace(/\[[^\]]+\]/g, ' ').replace(/\([^)]*\)/g, ' ').trim();
  const separators = [' - ', ' — ', ' – ', ' | '];
  for (const separator of separators) {
    const idx = clean.indexOf(separator);
    if (idx > 0 && idx < clean.length - separator.length) {
      const artist = clean.slice(0, idx).trim();
      const title = clean.slice(idx + separator.length).trim();
      if (artist && title) return { artist, title };
    }
  }
  return { artist: 'Local Library', title: clean || fileName };
}

function getLocalSearchRoots(): string[] {
  const fromEnv = (process.env.LOCAL_SEARCH_PATHS ?? '')
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const roots = [DOWNLOAD_PATH, ...fromEnv]
    .filter(Boolean)
    .map((root) => pathResolve(root));
  return Array.from(new Set(roots)).filter((root) => fs.existsSync(root));
}

function scanLocalTracks(roots: string[]): LocalTrack[] {
  const tracks: LocalTrack[] = [];
  const queue: string[] = [...roots];
  const seen = new Set<string>();
  const maxFiles = 12_000;

  while (queue.length > 0 && tracks.length < maxFiles) {
    const dir = queue.shift();
    if (!dir) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = pathJoin(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!LOCAL_AUDIO_EXTS.has(ext)) continue;
      const abs = pathResolve(full);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const stem = basename(entry.name, ext);
      const parsed = splitTitleArtistFromFilename(stem);
      tracks.push({
        id: `local-${normalizeLoose(abs).slice(-42)}`,
        title: parsed.title,
        artist: parsed.artist,
        filePath: abs,
      });
      if (tracks.length >= maxFiles) break;
    }
  }
  return tracks;
}

function getLocalTrackIndex(): LocalTrack[] {
  const roots = getLocalSearchRoots();
  const rootsKey = roots.join('|');
  const now = Date.now();
  if (
    localTrackIndexCache
    && localTrackIndexCache.rootsKey === rootsKey
    && now - localTrackIndexCache.ts < LOCAL_INDEX_TTL
  ) {
    return localTrackIndexCache.tracks;
  }
  const tracks = scanLocalTracks(roots);
  localTrackIndexCache = { rootsKey, tracks, ts: now };
  return tracks;
}

function localTrackToSearchResult(item: LocalTrack): SearchResult {
  return {
    id: item.id,
    title: item.title,
    url: encodeLocalFileUrl(item.filePath),
    duration: null,
    thumbnail: '',
    channel: item.artist,
  };
}

function searchLocalTracks(query: string, limit: number, offset: number): SearchResult[] {
  const q = normalizeLoose(query);
  if (q.length < 2) return [];
  const terms = q.split(' ').filter(Boolean);
  const scored = getLocalTrackIndex()
    .map((item) => {
      const hay = normalizeLoose(`${item.artist} ${item.title}`);
      let score = 0;
      for (const term of terms) {
        if (hay.includes(term)) score += 1;
      }
      if (normalizeLoose(item.title).includes(q)) score += 2;
      if (normalizeLoose(item.artist).includes(q)) score += 1;
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(offset, offset + limit).map((row) => localTrackToSearchResult(row.item));
}

function genreTokens(genre: string): string[] {
  const normalized = normalizeLoose(genre.replace(/_/g, ' '));
  const tokens = normalized.split(' ').filter((token) => token.length >= 3);
  if (normalized.includes('drum and bass')) tokens.push('dnb');
  if (normalized.includes('hardstyle')) tokens.push('rawstyle');
  if (normalized.includes('techno trance')) tokens.push('trance', 'techno');
  return Array.from(new Set(tokens));
}

function searchLocalGenreHits(genre: string, limit: number, offset: number): GenreHitItem[] {
  const tokens = genreTokens(genre);
  if (tokens.length === 0) return [];
  const scored = getLocalTrackIndex()
    .map((item) => {
      const hay = normalizeLoose(`${item.artist} ${item.title}`);
      let score = 0;
      for (const token of tokens) {
        if (hay.includes(token)) score += 1;
      }
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(offset, offset + limit).map((row) => ({
    id: row.item.id,
    title: row.item.title,
    artist: row.item.artist,
    thumbnail: '',
    sourceHint: encodeLocalFileUrl(row.item.filePath),
  }));
}

function refreshGenreHitsCache(cacheKey: string, genre: string, limit: number, offset: number, includeLocal: boolean): void {
  if (genreHitsRefreshInFlight.has(cacheKey)) return;
  genreHitsRefreshInFlight.add(cacheKey);
  void getTopTracksByGenre(genre, limit, offset)
    .then((results) => {
      const local = includeLocal ? searchLocalGenreHits(genre, Math.max(limit * 2, 20), offset) : [];
      const merged = Array.from(
        new Map(
          [...local, ...results]
            .map((item) => [`${item.artist}-${item.title}`.toLowerCase().replace(/\s+/g, ' ').trim(), item]),
        ).values(),
      ).slice(0, limit);
      genreHitsCache.set(cacheKey, { results: merged, ts: Date.now() });
    })
    .catch((err) => {
      console.warn('[rest] /api/genre-hits refresh failed:', (err as Error).message);
    })
    .finally(() => {
      genreHitsRefreshInFlight.delete(cacheKey);
    });
}

function parseDuration(text: string): number | null {
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

async function youtubeSearch(query: string, limit = 12): Promise<SearchResult[]> {
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
        'User-Agent': 'Mozilla/5.0',
      },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = await res.json() as Record<string, unknown>;
    const sections = (data as any)?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents ?? [];

    const results: SearchResult[] = [];

    for (const section of sections) {
      const items = section?.itemSectionRenderer?.contents ?? [];
      for (const item of items) {
        const v = item?.videoRenderer;
        if (!v?.videoId) continue;

        const title = v.title?.runs?.map((r: { text: string }) => r.text).join('') ?? 'Onbekend';
        const channel = v.ownerText?.runs?.[0]?.text ?? v.shortBylineText?.runs?.[0]?.text ?? '';
        const durText = v.lengthText?.simpleText ?? '';
        const duration = durText ? parseDuration(durText) : null;

        results.push({
          id: v.videoId,
          title,
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          duration,
          thumbnail: `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,
          channel,
        });

        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }

    const normalized = postProcessResults(results, 'youtube');
    searchCache.set(cacheKey, { results: normalized, ts: Date.now() });
    return normalized;
  } catch (err) {
    console.warn('[search] Innertube failed, falling back to yt-dlp:', (err as Error).message);
    return youtubeSearchFallback(query, limit);
  }
}

function youtubeSearchFallback(query: string, limit = 12): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const proc = spawn('python', [
      '-m', 'yt_dlp',
      `ytsearch${limit}:${query}`,
      '--flat-playlist',
      '-j',
      '--no-warnings',
    ], { timeout: 15_000 });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) { resolve([]); return; }

      const results: SearchResult[] = [];
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          results.push({
            id: item.id,
            title: item.title ?? 'Onbekend',
            url: item.url ?? `https://www.youtube.com/watch?v=${item.id}`,
            duration: typeof item.duration === 'number' ? Math.round(item.duration) : null,
            thumbnail: `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`,
            channel: item.channel ?? item.uploader ?? '',
          });
        } catch {}
      }
      resolve(postProcessResults(results, 'youtube'));
    });

    proc.on('error', () => resolve([]));
  });
}

// ── SoundCloud Search (fast, direct API with yt-dlp fallback) ───────────────

let scClientId: string | null = null;
let scClientIdTs = 0;
const SC_CLIENT_ID_TTL = 24 * 3600_000;

async function getSoundCloudClientId(): Promise<string | null> {
  if (scClientId && Date.now() - scClientIdTs < SC_CLIENT_ID_TTL) return scClientId;

  try {
    const pageRes = await fetch('https://soundcloud.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });
    const html = await pageRes.text();

    const scriptMatches = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)];

    for (let i = scriptMatches.length - 1; i >= Math.max(0, scriptMatches.length - 5); i--) {
      const scriptRes = await fetch(scriptMatches[i][1]);
      const js = await scriptRes.text();
      const match = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"/);
      if (match) {
        scClientId = match[1];
        scClientIdTs = Date.now();
        console.log(`[soundcloud] Got client_id: ${scClientId.slice(0, 8)}...`);
        return scClientId;
      }
    }
    console.warn('[soundcloud] Could not find client_id in scripts');
  } catch (err) {
    console.warn('[soundcloud] Failed to extract client_id:', (err as Error).message);
  }
  return null;
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
    throw new Error(`SoundCloud API ${res.status}`);
  }

  const data = await res.json() as { collection?: Array<Record<string, unknown>> };
  const results: SearchResult[] = [];

  for (const item of data.collection ?? []) {
    if (!item?.permalink_url) continue;
    const artwork = typeof item.artwork_url === 'string'
      ? item.artwork_url.replace('-large', '-t300x300')
      : '';
    results.push({
      id: String(item.id ?? ''),
      title: String(item.title ?? 'Onbekend'),
      url: String(item.permalink_url),
      duration: typeof item.duration === 'number' ? Math.round(item.duration / 1000) : null,
      thumbnail: artwork,
      channel: (item.user as any)?.username ?? '',
    });
    if (results.length >= limit) break;
  }

  return postProcessResults(results, 'soundcloud');
}

function soundcloudSearchFallback(query: string, limit = 12): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    const proc = spawn('python', [
      '-m', 'yt_dlp',
      `scsearch${limit}:${query}`,
      '--flat-playlist',
      '-j',
      '--no-warnings',
    ], { timeout: 15_000 });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) { resolve([]); return; }

      const results: SearchResult[] = [];
      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          const thumbUrl = item.thumbnails?.length
            ? item.thumbnails[item.thumbnails.length - 1]?.url ?? ''
            : '';
          results.push({
            id: String(item.id ?? ''),
            title: item.title ?? 'Onbekend',
            url: item.url ?? item.webpage_url ?? '',
            duration: typeof item.duration === 'number' ? Math.round(item.duration) : null,
            thumbnail: thumbUrl,
            channel: item.uploader ?? '',
          });
        } catch {}
      }
      resolve(postProcessResults(results, 'soundcloud'));
    });

    proc.on('error', () => resolve([]));
  });
}

async function soundcloudSearch(query: string, limit = 12): Promise<SearchResult[]> {
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

// ── REST Endpoints ───────────────────────────────────────────────────────────

app.get('/state', async (_req, res) => {
  try {
    const state = await getServerState();
    const stateLogKey = `${state.currentTrack?.title ?? 'none'}|${state.queue.length}|${state.mode}`;
    if (stateLogKey !== lastStateLogKey) {
      lastStateLogKey = stateLogKey;
      console.log(`[rest] /state → track: ${state.currentTrack?.title ?? 'none'}, queue: ${state.queue.length}, mode: ${state.mode}`);
    }
    res.json(state);
  } catch (err) {
    console.error('[rest] /state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    listeners: io.engine.clientsCount,
  });
});

app.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const source = String(req.query.source ?? 'youtube').toLowerCase();
  const includeLocal = String(req.query.includeLocal ?? '1') !== '0';
  const parsedLimit = parseInt(String(req.query.limit ?? '12'), 10);
  const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 50)) : 12;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  if (!q || q.length < 2) {
    res.json([]);
    return;
  }

  try {
    const requested = Math.min(80, limit + offset + (includeLocal ? limit : 0));
    const allResults = source === 'soundcloud'
      ? await soundcloudSearch(q, requested)
      : await youtubeSearch(q, requested);
    const localResults = includeLocal ? searchLocalTracks(q, requested, 0) : [];
    const merged = Array.from(
      new Map(
        [...localResults, ...allResults]
          .map((item) => [item.url, item]),
      ).values(),
    );
    res.json(merged.slice(offset, offset + limit));
  } catch (err) {
    console.error('[rest] /search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/genres', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const cacheKey = q || '__all__';
  const cached = genreCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DISCOVERY_CACHE_TTL) {
    res.json(cached.results);
    return;
  }

  try {
    const results = await searchGenres(q);
    genreCache.set(cacheKey, { results, ts: Date.now() });
    res.json(results);
  } catch (err) {
    console.error('[rest] /api/genres error:', err);
    res.status(500).json({ error: 'Genres lookup failed' });
  }
});

app.get('/api/genre-hits', async (req, res) => {
  const genre = String(req.query.genre ?? '').trim();
  if (genre.length < 2) {
    res.status(400).json({ error: 'Missing or invalid genre' });
    return;
  }

  const parsedLimit = parseInt(String(req.query.limit ?? '20'), 10);
  const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
  const includeLocal = String(req.query.includeLocal ?? '1') !== '0';
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 50)) : 20;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  const cacheKey = `${genre.toLowerCase()}::${limit}::${offset}::local=${includeLocal ? '1' : '0'}`;
  const nextOffset = offset + limit;
  const nextCacheKey = `${genre.toLowerCase()}::${limit}::${nextOffset}::local=${includeLocal ? '1' : '0'}`;
  const cached = genreHitsCache.get(cacheKey);
  if (cached) {
    const fresh = Date.now() - cached.ts < DISCOVERY_CACHE_TTL;
    if (!fresh) {
      refreshGenreHitsCache(cacheKey, genre, limit, offset, includeLocal);
    }
    if (cached.results.length >= Math.max(8, Math.ceil(limit * 0.6))) {
      const nextCached = genreHitsCache.get(nextCacheKey);
      if (!nextCached || Date.now() - nextCached.ts >= DISCOVERY_CACHE_TTL) {
        refreshGenreHitsCache(nextCacheKey, genre, limit, nextOffset, includeLocal);
      }
    }
    res.json(cached.results);
    return;
  }

  try {
    // Keep genre hit loading snappy: try one broad page first, then one backfill pass if needed.
    const localCollected = includeLocal ? searchLocalGenreHits(genre, Math.max(limit * 2, 20), offset) : [];
    const collected: GenreHitItem[] = [...localCollected];
    const seen = new Set<string>();
    for (const item of collected) {
      const key = `${item.artist}-${item.title}`.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key) continue;
      seen.add(key);
    }
    let probeOffset = offset;
    const probeLimit = Math.min(50, Math.max(limit * 2, 20));

    for (let pass = 0; pass < 2 && collected.length < limit; pass += 1) {
      const page = await getTopTracksByGenre(genre, probeLimit, probeOffset);
      if (!page.length) break;
      for (const item of page) {
        const key = `${item.artist}-${item.title}`.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        collected.push(item);
        if (collected.length >= limit) break;
      }
      // Only backfill if the page was clearly too sparse.
      if (pass === 0 && collected.length >= Math.max(8, Math.ceil(limit * 0.6))) break;
      probeOffset += probeLimit;
    }

    const results = collected.slice(0, limit);
    genreHitsCache.set(cacheKey, { results, ts: Date.now() });
    if (results.length >= Math.max(8, Math.ceil(limit * 0.6))) {
      refreshGenreHitsCache(nextCacheKey, genre, limit, nextOffset, includeLocal);
    }
    res.json(results);
  } catch (err) {
    console.error('[rest] /api/genre-hits error:', err);
    res.status(500).json({ error: 'Genre hitlist lookup failed' });
  }
});

app.post('/api/genre-curation/priority-artist', async (req, res) => {
  const { token, genre, artist, label } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  const genreName = String(genre ?? '').trim();
  const artistName = String(artist ?? '').trim();
  const genreLabel = String(label ?? '').trim();
  if (genreName.length < 2) {
    return res.status(400).json({ error: 'Missing or invalid genre' });
  }
  if (artistName.length < 2) {
    return res.status(400).json({ error: 'Missing or invalid artist' });
  }

  try {
    const rule = addPriorityArtistForGenre(genreName, artistName, genreLabel || undefined);
    genreHitsCache.clear();
    genreCache.clear();
    res.json({
      ok: true,
      genre: rule.id,
      artist: artistName,
      count: rule.priorityArtists?.length ?? 0,
    });
  } catch (err) {
    console.error('[rest] /api/genre-curation/priority-artist error:', err);
    res.status(500).json({ error: 'Failed to save priority artist' });
  }
});

app.post('/api/genre-curation/block-artist', async (req, res) => {
  const { token, genre, artist, label } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  const genreName = String(genre ?? '').trim();
  const artistName = String(artist ?? '').trim();
  const genreLabel = String(label ?? '').trim();
  if (genreName.length < 2) {
    return res.status(400).json({ error: 'Missing or invalid genre' });
  }
  if (artistName.length < 2) {
    return res.status(400).json({ error: 'Missing or invalid artist' });
  }

  try {
    const rule = addBlockedArtistForGenre(genreName, artistName, genreLabel || undefined);
    genreHitsCache.clear();
    genreCache.clear();
    res.json({
      ok: true,
      genre: rule.id,
      artist: artistName,
      blockedCount: rule.blockedArtists?.length ?? 0,
    });
  } catch (err) {
    console.error('[rest] /api/genre-curation/block-artist error:', err);
    res.status(500).json({ error: 'Failed to save blocked artist' });
  }
});

app.post('/api/genre-curation/like-current', async (req, res) => {
  const activeGenreId = await resolveActiveFallbackGenre();
  const autoGenre = parseAutoFallbackGenreId(activeGenreId);
  if (!autoGenre) {
    return res.status(409).json({ error: 'Auto playlist is niet actief' });
  }

  const current = getCurrentTrack();
  if (!current || current.youtube_id !== 'local' || !current.title) {
    return res.status(409).json({ error: 'Er speelt geen auto playlist track' });
  }

  const rawArtist = String(req.body?.artist ?? '').trim();
  const rawTitle = String(req.body?.title ?? '').trim();
  const parsed = parseArtistTitle(current.title ?? '');
  const artist = rawArtist || parsed.artist;
  const title = rawTitle || parsed.title;
  if (!artist || !title) {
    return res.status(400).json({ error: 'Kon artiest/titel niet bepalen voor like' });
  }

  try {
    const artistRule = addPriorityArtistForGenre(autoGenre, artist, autoGenre);
    addPriorityTrackForGenre(autoGenre, title, autoGenre);
    addLikedPlaylistTrack(`${artist} - ${title}`);
    genreHitsCache.clear();
    genreCache.clear();
    return res.json({
      ok: true,
      genre: autoGenre,
      artist,
      title,
      artistCount: artistRule.priorityArtists?.length ?? 0,
    });
  } catch (err) {
    console.error('[rest] /api/genre-curation/like-current error:', err);
    return res.status(500).json({ error: 'Kon like niet opslaan' });
  }
});

app.post('/api/genre-curation/dislike-current', async (req, res) => {
  const activeGenreId = await resolveActiveFallbackGenre();
  const autoGenre = parseAutoFallbackGenreId(activeGenreId);
  if (!autoGenre || autoGenre === LIKED_AUTO_GENRE_ID) {
    return res.status(409).json({ error: 'Genre auto playlist is niet actief' });
  }

  const current = getCurrentTrack();
  if (!current || current.youtube_id !== 'local' || !current.title) {
    return res.status(409).json({ error: 'Er speelt geen auto playlist track' });
  }

  const rawArtist = String(req.body?.artist ?? '').trim();
  const rawTitle = String(req.body?.title ?? '').trim();
  const parsed = parseArtistTitle(current.title ?? '');
  const artist = rawArtist || parsed.artist;
  const title = rawTitle || parsed.title;
  if (!artist || !title) {
    return res.status(400).json({ error: 'Kon artiest/titel niet bepalen voor dislike' });
  }

  try {
    const rule = addBlockedTrackForGenre(autoGenre, `${artist} - ${title}`, autoGenre);
    genreHitsCache.clear();
    genreCache.clear();
    return res.json({
      ok: true,
      genre: autoGenre,
      artist,
      title,
      blockedCount: rule.blockedTracks?.length ?? 0,
    });
  } catch (err) {
    console.error('[rest] /api/genre-curation/dislike-current error:', err);
    return res.status(500).json({ error: 'Kon dislike niet opslaan' });
  }
});

app.get('/listen', (req, res) => {
  const origin = req.headers.origin ?? '*';

  if (ICECAST) {
    const icecastStreamUrl = `http://${ICECAST.host}:${ICECAST.port}${ICECAST.mount}`;

    const proxyReq = http.get(icecastStreamUrl, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, {
        'Content-Type': proxyRes.headers['content-type'] ?? 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET',
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Icecast stream not available' });
      }
    });

    req.on('close', () => proxyReq.destroy());
  } else if (streamHub) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET',
    });

    const backlog = streamHub.getBacklog();
    if (backlog) res.write(backlog);

    const unsub = streamHub.subscribe((chunk) => {
      if (!res.destroyed) {
        try { res.write(chunk); } catch { unsub(); }
      }
    });

    req.on('close', unsub);
  } else {
    res.status(503).json({ error: 'Stream not configured' });
  }
});

// ── Admin REST endpoints (reliable through tunnels) ─────────────────────────

app.post('/api/mode', async (req, res) => {
  const { mode, token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  const validModes = ['dj', 'radio', 'democracy', 'jukebox', 'party'];
  if (!validModes.includes(mode)) return res.status(400).json({ error: 'Invalid mode' });

  try {
    await setSetting(sb, 'active_mode', mode);
    applyPlaybackForMode(mode as Mode);
    resetVotes();
    const modeSettings = await getModeSettings(sb);
    io.emit('mode:change', { mode: mode as Mode, settings: modeSettings });
    console.log(`[rest] Mode changed to: ${mode}`);
    res.json({ ok: true, mode });
  } catch (err) {
    console.error('[rest] mode error:', err);
    res.status(500).json({ error: 'Failed to set mode' });
  }
});

app.post('/api/settings', async (req, res) => {
  const { key, value, token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  try {
    if (key === 'fallback_active_genre') {
      const requested = normalizeFallbackGenreId(value);
      if (requested && !isKnownFallbackGenre(requested)) {
        return res.status(400).json({ error: 'Unknown fallback genre' });
      }
      const nextGenre = requested ?? getDefaultFallbackGenreId();
      await setSetting(sb, key, nextGenre);
      await setSetting(sb, 'fallback_active_genre_by', null);
      setActiveFallbackGenre(nextGenre);
      await emitFallbackGenreUpdate();
      console.log(`[rest] Setting updated: ${key}=${nextGenre ?? 'none'}`);
      return res.json({ ok: true });
    }

    await setSetting(sb, key, value);
    const modeSettings = await getModeSettings(sb);
    const mode = await getActiveMode(sb);
    io.emit('mode:change', { mode, settings: modeSettings });
    console.log(`[rest] Setting updated: ${key}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[rest] settings error:', err);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

app.post('/api/skip', async (req, res) => {
  const { token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });
  if (isSkipLocked()) return res.status(429).json({ error: 'Skip bezig — wacht tot het nieuwe nummer speelt' });
  const waitSeconds = getSkipCooldownRemainingSeconds();
  if (waitSeconds > 0) return res.status(429).json({ error: `Wacht nog ${waitSeconds}s tot je opnieuw kunt skippen` });

  skipCurrentTrack();
  markSkipTriggered();
  console.log('[rest] Track skipped by admin');
  res.json({ ok: true });
});

app.post('/api/keep-files', async (req, res) => {
  const { keep, token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  setKeepFiles(!!keep);
  io.emit('settings:keepFilesChanged', { keep: !!keep });
  console.log(`[rest] Keep files: ${keep}`);
  res.json({ ok: true, keep: !!keep });
});

app.post('/api/tunnel-url', async (req, res) => {
  const { url, token } = req.body ?? {};
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });

  const tunnelUrl = (url ?? '').replace(/\/+$/, '');
  if (!tunnelUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    const { data, error: dbErr } = await sb
      .from('settings')
      .update({ radio_server_url: tunnelUrl })
      .eq('id', 1)
      .select('radio_server_url')
      .single();

    if (dbErr) {
      console.error('[rest] Supabase update error:', dbErr.message, dbErr.details);
      return res.status(500).json({ error: dbErr.message });
    }

    io.emit('tunnel:url', { url: tunnelUrl });
    console.log(`[rest] Tunnel URL saved: ${data?.radio_server_url}`);
    res.json({ ok: true, url: data?.radio_server_url });
  } catch (err) {
    console.error('[rest] tunnel-url error:', err);
    res.status(500).json({ error: 'Failed to save tunnel URL' });
  }
});

// ── Vote skip state ──────────────────────────────────────────────────────────

let voteSkipSet = new Set<string>();
let voteTimer: ReturnType<typeof setTimeout> | null = null;
let voteTrackId: string | null = null;

function resetVotes(): void {
  voteSkipSet.clear();
  voteTrackId = null;
  if (voteTimer) {
    clearTimeout(voteTimer);
    voteTimer = null;
  }
}

// ── Duration vote state ─────────────────────────────────────────────────────

const MAX_DURATION = 3900;
const ANYONE_SKIP_AFTER = 300;
const DURATION_VOTE_TIMEOUT = 30_000;
const QUEUE_PUSH_VOTE_TIMEOUT = 45_000;
const MIN_SKIP_PLAY_SECONDS = 5;
let skipCooldownPending = false;
let skipCooldownFromTrackId: string | null = null;
let skipCooldownFromStartedAt: number | null = null;
let skipCooldownTriggeredAt: number | null = null;

function getSkipCooldownRemainingSeconds(): number {
  if (!skipCooldownPending) return 0;
  const now = Date.now();
  // Safety valve: never keep skip cooldown stuck forever on edge-cases.
  if (skipCooldownTriggeredAt && now - skipCooldownTriggeredAt > 45_000) {
    skipCooldownPending = false;
    skipCooldownFromTrackId = null;
    skipCooldownFromStartedAt = null;
    skipCooldownTriggeredAt = null;
    return 0;
  }
  const track = getCurrentTrack();
  if (!track) return MIN_SKIP_PLAY_SECONDS;
  const stillSameTrack = !!skipCooldownFromTrackId
    && track.id === skipCooldownFromTrackId
    && (skipCooldownFromStartedAt == null || track.started_at === skipCooldownFromStartedAt);
  if (stillSameTrack) return MIN_SKIP_PLAY_SECONDS;
  const elapsedSeconds = Math.max(0, (now - track.started_at) / 1000);
  const remaining = Math.max(0, Math.ceil(MIN_SKIP_PLAY_SECONDS - elapsedSeconds));
  if (remaining <= 0) {
    skipCooldownPending = false;
    skipCooldownFromTrackId = null;
    skipCooldownFromStartedAt = null;
    skipCooldownTriggeredAt = null;
    return 0;
  }
  return remaining;
}

function markSkipTriggered(): void {
  const track = getCurrentTrack();
  skipCooldownPending = true;
  skipCooldownFromTrackId = track?.id ?? null;
  skipCooldownFromStartedAt = track?.started_at ?? null;
  skipCooldownTriggeredAt = Date.now();
}

let activeDurationVote: DurationVote | null = null;
let durationVoteTimer: ReturnType<typeof setTimeout> | null = null;
let activeQueuePushVote: QueuePushVote | null = null;
let queuePushVoteTimer: ReturnType<typeof setTimeout> | null = null;
let queuePushLocked = false;
let queuePushUnlockTrackSignature: string | null = null;

function broadcastDurationVote(): void {
  if (activeDurationVote) {
    io.emit('durationVote:update', activeDurationVote);
  } else {
    io.emit('durationVote:end', null);
  }
}

function currentQueueTrackSignature(): string | null {
  const track = getCurrentTrack();
  if (!track || track.youtube_id === 'local') return null;
  return `${track.id}|${track.youtube_id}|${track.started_at}`;
}

function setQueuePushLockActive(): void {
  queuePushLocked = true;
  queuePushUnlockTrackSignature = currentQueueTrackSignature();
  io.emit('queuePush:lock', { locked: true });
}

function maybeReleaseQueuePushLock(): void {
  if (!queuePushLocked) return;
  const signature = currentQueueTrackSignature();
  if (!signature) return;
  if (signature === queuePushUnlockTrackSignature) return;
  queuePushLocked = false;
  queuePushUnlockTrackSignature = null;
  io.emit('queuePush:lock', { locked: false });
}

function broadcastQueuePushVote(): void {
  if (activeQueuePushVote) {
    io.emit('queuePushVote:update', activeQueuePushVote);
  } else {
    io.emit('queuePushVote:end', null);
  }
}

async function finalizeQueuePushVote(): Promise<void> {
  if (!activeQueuePushVote) return;
  try {
    const vote = activeQueuePushVote;
    activeQueuePushVote = null;
    if (queuePushVoteTimer) {
      clearTimeout(queuePushVoteTimer);
      queuePushVoteTimer = null;
    }

    const accepted = vote.yes >= vote.required;
    if (!accepted) {
      io.emit('queuePushVote:result', {
        accepted: false,
        title: vote.title,
        reason: 'Niet genoeg stemmen',
      });
      broadcastQueuePushVote();
      return;
    }

    if (queuePushLocked) {
      io.emit('queuePushVote:result', {
        accepted: false,
        title: vote.title,
        reason: 'Push is nog vergrendeld tot het volgende nummer start',
      });
      broadcastQueuePushVote();
      return;
    }

    const queue = await getQueue(sb);
    const target = queue.find((item) => item.id === vote.item_id);
    if (!target) {
      io.emit('queuePushVote:result', {
        accepted: false,
        title: vote.title,
        reason: 'Nummer staat niet meer in de wachtrij',
      });
      broadcastQueuePushVote();
      return;
    }

    await reorderQueue(sb, vote.item_id, 1);
    invalidateNextReady();
    playerEvents.emit('queue:add');
    const updatedQueue = await getQueue(sb);
    io.emit('queue:update', { items: updatedQueue });
    setQueuePushLockActive();
    io.emit('queuePushVote:result', { accepted: true, title: vote.title });
    console.log(`[queue-push] Accepted: ${vote.item_id} moved to next`);
    broadcastQueuePushVote();
  } catch (err) {
    console.error('[queue-push] finalize error:', err);
    io.emit('queuePushVote:result', {
      accepted: false,
      reason: 'Push-stemming kon niet worden afgerond',
    });
    activeQueuePushVote = null;
    broadcastQueuePushVote();
  }
}

function startQueuePushVote(
  item: { id: string; title: string | null; thumbnail: string | null; added_by: string },
  proposedBy: string,
  proposerSocketId: string,
  required: number,
  timeoutMs: number,
): QueuePushVote {
  if (activeQueuePushVote) {
    activeQueuePushVote = null;
    if (queuePushVoteTimer) {
      clearTimeout(queuePushVoteTimer);
      queuePushVoteTimer = null;
    }
  }

  const vote: QueuePushVote = {
    id: `qpv_${Date.now()}`,
    item_id: item.id,
    title: item.title,
    thumbnail: item.thumbnail,
    added_by: item.added_by,
    proposed_by: proposedBy,
    required,
    yes: 1,
    no: 0,
    voters: [proposerSocketId],
    expires_at: Date.now() + timeoutMs,
  };
  activeQueuePushVote = vote;
  broadcastQueuePushVote();

  queuePushVoteTimer = setTimeout(() => {
    void finalizeQueuePushVote();
  }, timeoutMs);

  return vote;
}

function finalizeDurationVote(): void {
  if (!activeDurationVote) return;
  const vote = activeDurationVote;

  if (durationVoteTimer) {
    clearTimeout(durationVoteTimer);
    durationVoteTimer = null;
  }

  const accepted = vote.yes > vote.no;
  console.log(`[duration-vote] Result: ${vote.yes} ja / ${vote.no} nee → ${accepted ? 'GEACCEPTEERD' : 'GEWEIGERD'}`);

  if (accepted) {
    fetchVideoInfo(vote.youtube_url)
      .catch(() => ({ title: null, duration: null, thumbnail: null }))
      .then((info) => {
        const fallbackTitle = vote.title ?? `Track ${Date.now().toString().slice(-4)}`;
        const resolvedTitle = info.title ?? fallbackTitle;
        const resolvedThumb = info.thumbnail ?? vote.thumbnail ?? null;
        return addToQueue(sb, vote.youtube_url, vote.added_by, resolvedTitle, resolvedThumb);
      })
      .then(async (item) => {
        const queue = await getQueue(sb);
        io.emit('queue:added', { id: item.id, title: item.title ?? item.youtube_id, added_by: item.added_by ?? vote.added_by ?? 'onbekend' });
        io.emit('queue:update', { items: queue });
        playerEvents.emit('queue:add');
        console.log(`[queue] Added after vote: ${item.youtube_id} by ${vote.added_by}`);
      })
      .catch((err) => {
        console.error('[duration-vote] Failed to add after vote:', err);
      });
    io.emit('durationVote:result', { accepted: true, title: vote.title });
  } else {
    io.emit('durationVote:result', { accepted: false, title: vote.title });
  }

  activeDurationVote = null;
  broadcastDurationVote();
}

function startDurationVote(
  youtubeUrl: string,
  title: string | null,
  thumbnail: string | null,
  duration: number,
  addedBy: string,
): void {
  // Cancel any existing vote
  if (activeDurationVote) {
    activeDurationVote = null;
    if (durationVoteTimer) {
      clearTimeout(durationVoteTimer);
      durationVoteTimer = null;
    }
  }

  activeDurationVote = {
    id: `dv_${Date.now()}`,
    youtube_url: youtubeUrl,
    title,
    thumbnail,
    duration,
    added_by: addedBy,
    yes: 0,
    no: 0,
    voters: [],
    expires_at: Date.now() + DURATION_VOTE_TIMEOUT,
  };

  console.log(`[duration-vote] Started for "${title}" (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')})`);
  broadcastDurationVote();

  durationVoteTimer = setTimeout(() => {
    console.log('[duration-vote] Timer expired');
    finalizeDurationVote();
  }, DURATION_VOTE_TIMEOUT);
}

// ── Socket.io Events ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[socket] Client connected: ${socket.id}`);
  io.emit('stream:status', { online: getCurrentTrack() !== null, listeners: io.engine.clientsCount });
  socket.emit('upcoming:update', getUpcomingTrack());
  void emitFallbackGenreUpdate(socket);
  if (activeQueuePushVote) socket.emit('queuePushVote:update', activeQueuePushVote);
  else socket.emit('queuePushVote:end', null);
  socket.emit('queuePush:lock', { locked: queuePushLocked });
  socket.emit('skip:lock', { locked: isSkipLocked() });

  // ── auth:verify ──
  socket.on('auth:verify', (data: { token: string }, callback?: (valid: boolean) => void) => {
    const valid = isAdmin(data.token);
    if (typeof callback === 'function') callback(valid);
  });

  // ── queue:add ──
  socket.on('queue:add', async (data: { youtube_url: string; added_by: string; token?: string; thumbnail?: string; title?: string; artist?: string }) => {
    try {
      const mode = await getActiveMode(sb);
      const admin = isAdmin(data.token);
      if (!canPerformAction(mode, 'add_to_queue', admin)) {
        socket.emit('error:toast', { message: 'Je mag geen nummers toevoegen in deze modus' });
        return;
      }

      let url = data.youtube_url;
      let sourceId = extractSourceId(url);
      let discoveredTitle: string | null = null;
      let discoveredArtist: string | null = null;

      // If not a valid URL, treat as a search query (e.g. from Spotify: "Artist - Title")
      if (!sourceId) {
        const searchResults = await youtubeSearch(url, 1);
        if (searchResults.length === 0) {
          socket.emit('error:toast', { message: `Geen resultaat gevonden voor "${url}"` });
          return;
        }
        url = searchResults[0].url;
        sourceId = extractSourceId(url);
        if (!sourceId) {
          socket.emit('error:toast', { message: 'Kon geen geldig nummer vinden' });
          return;
        }
        discoveredTitle = searchResults[0].title ?? null;
        discoveredArtist = searchResults[0].channel ?? null;
        console.log(`[queue] Search "${data.youtube_url}" → ${searchResults[0].title} (${url})`);
      }

      const ytId = extractYoutubeId(url);
      const thumbnail = data.thumbnail ?? (ytId ? getThumbnailUrl(ytId) : null);
      const isLocalSelection = url.startsWith('local://');
      const info = isLocalSelection
        ? { title: null, duration: null, thumbnail: null }
        : await fetchVideoInfo(url);

      if (info.duration !== null && info.duration > MAX_DURATION) {
        socket.emit('error:toast', {
          message: `Dit nummer is te lang (${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, '0')}). Maximum is 65 minuten.`,
        });
        return;
      }

      const thumbForQueue = thumbnail ?? info.thumbnail;
      const submittedTitle = (data.title ?? '').trim() || null;
      const submittedArtist = (data.artist ?? '').trim() || null;
      const mergedTitle =
        info.title ??
        (submittedArtist && submittedTitle ? `${submittedArtist} - ${submittedTitle}` : null) ??
        submittedTitle ??
        (discoveredArtist && discoveredTitle ? `${discoveredArtist} - ${discoveredTitle}` : null) ??
        discoveredTitle ??
        sourceId;

      const item = await addToQueue(sb, url, data.added_by || 'anonymous', mergedTitle, thumbForQueue);
      const queue = await getQueue(sb);
      io.emit('queue:added', { id: item.id, title: item.title ?? item.youtube_id, added_by: item.added_by ?? data.added_by ?? 'onbekend' });
      io.emit('queue:update', { items: queue });
      playerEvents.emit('queue:add');
      console.log(`[queue] Added: ${item.youtube_id} by ${data.added_by}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kon nummer niet toevoegen';
      socket.emit('error:toast', { message: msg });
    }
  });

  // ── durationVote:cast ──
  socket.on('durationVote:cast', (data: { vote: 'yes' | 'no' }) => {
    if (!activeDurationVote) {
      socket.emit('error:toast', { message: 'Geen actieve stemming' });
      return;
    }

    if (activeDurationVote.voters.includes(socket.id)) {
      socket.emit('error:toast', { message: 'Je hebt al gestemd' });
      return;
    }

    activeDurationVote.voters.push(socket.id);
    if (data.vote === 'yes') {
      activeDurationVote.yes++;
    } else {
      activeDurationVote.no++;
    }

    console.log(`[duration-vote] ${socket.id} voted ${data.vote} (${activeDurationVote.yes}/${activeDurationVote.no})`);
    broadcastDurationVote();

    // Check if all connected clients have voted
    const totalClients = io.engine.clientsCount;
    if (activeDurationVote.voters.length >= totalClients) {
      finalizeDurationVote();
    }
  });

  // ── queuePushVote:start ──
  socket.on('queuePushVote:start', async (data: { id: string; added_by?: string }) => {
    try {
      const mode = await getActiveMode(sb);
      if (mode === 'dj') {
        socket.emit('error:toast', { message: 'Push-stemmen is niet beschikbaar in DJ modus' });
        return;
      }
      if (queuePushLocked) {
        socket.emit('error:toast', { message: 'Je kunt nu nog niet pushen. Wacht tot het volgende nummer uit de wachtrij start.' });
        return;
      }
      if (activeQueuePushVote) {
        socket.emit('error:toast', { message: 'Er loopt al een actieve push-stemming' });
        return;
      }

      const queue = await getQueue(sb);
      const item = queue.find((q) => q.id === data.id);
      if (!item) {
        socket.emit('error:toast', { message: 'Nummer niet gevonden in wachtrij' });
        return;
      }
      if (queue[0]?.id === item.id) {
        socket.emit('error:toast', { message: 'Dit nummer staat al als volgende' });
        return;
      }

      const settings = await getModeSettings(sb);
      const required = Math.max(1, Math.ceil(io.engine.clientsCount * (settings.democracy_threshold / 100)));
      const proposedBy = normalizeNickname(data.added_by) ?? 'onbekend';
      const vote = startQueuePushVote(item, proposedBy, socket.id, required, QUEUE_PUSH_VOTE_TIMEOUT);
      socket.emit('info:toast', { message: 'Push-stemming gestart. Jouw stem telt al als ja.' });
      if (vote.yes >= required) {
        void finalizeQueuePushVote();
      }
      console.log(`[queue-push] Vote started for ${item.id} by ${proposedBy}`);
    } catch (err) {
      console.error('[socket] queuePushVote:start error:', err);
      socket.emit('error:toast', { message: 'Kon push-stemming niet starten' });
    }
  });

  // ── queuePushVote:cast ──
  socket.on('queuePushVote:cast', async (data: { vote: 'yes' | 'no' }) => {
    if (!activeQueuePushVote) {
      socket.emit('error:toast', { message: 'Geen actieve push-stemming' });
      return;
    }
    if (activeQueuePushVote.voters.includes(socket.id)) {
      socket.emit('error:toast', { message: 'Je hebt al gestemd' });
      return;
    }

    activeQueuePushVote.voters.push(socket.id);
    if (data.vote === 'yes') activeQueuePushVote.yes += 1;
    else activeQueuePushVote.no += 1;
    broadcastQueuePushVote();

    if (activeQueuePushVote.yes >= activeQueuePushVote.required) {
      void finalizeQueuePushVote();
    }
  });

  // ── track:skip ──
  socket.on('track:skip', async (data: { isAdmin?: boolean; token?: string }) => {
    try {
      const mode = await getActiveMode(sb);
      const admin = isAdmin(data.token);

      const track = getCurrentTrack();
      if (isSkipLocked()) {
        socket.emit('error:toast', { message: 'Skip bezig — wacht tot het nieuwe nummer speelt' });
        return;
      }
      const waitSeconds = getSkipCooldownRemainingSeconds();
      if (waitSeconds > 0) {
        socket.emit('error:toast', { message: `Wacht nog ${waitSeconds}s tot je opnieuw kunt skippen` });
        return;
      }

      const playingFor = track?.started_at ? (Date.now() - track.started_at) / 1000 : 0;
      const isLongTrack = (track?.duration ?? 0) > 600;
      const anyoneCanSkip = isLongTrack && playingFor >= ANYONE_SKIP_AFTER;

      if (!anyoneCanSkip && !canPerformAction(mode, 'skip', admin)) {
        socket.emit('error:toast', { message: 'Je mag niet skippen in deze modus' });
        return;
      }

      console.log(`[player] Skip requested by ${admin ? 'admin' : socket.id}`);
      resetVotes();
      io.emit('vote:update', null);
      skipCurrentTrack();
      markSkipTriggered();
    } catch (err) {
      console.error('[socket] track:skip error:', err);
    }
  });

  // ── vote:skip ──
  socket.on('vote:skip', async () => {
    try {
      const mode = await getActiveMode(sb);
      if (!canPerformAction(mode, 'vote_skip', false)) {
        socket.emit('error:toast', { message: 'Stemmen is niet beschikbaar in deze modus' });
        return;
      }
      const waitSeconds = getSkipCooldownRemainingSeconds();
      if (waitSeconds > 0) {
        socket.emit('error:toast', { message: `Nog ${waitSeconds}s wachten voordat skip-stemmen actief is` });
        return;
      }

      const trackId = getCurrentTrack()?.id ?? null;
      if (trackId !== voteTrackId) {
        resetVotes();
        voteTrackId = trackId;
      }

      voteSkipSet.add(socket.id);
      const settings = await getModeSettings(sb);
      const threshold = settings.democracy_threshold / 100;
      const required = Math.max(1, Math.ceil(io.engine.clientsCount * threshold));
      const timerSeconds = settings.democracy_timer;

      // Start timer on first vote
      if (voteSkipSet.size === 1 && !voteTimer) {
        voteTimer = setTimeout(() => {
          console.log('[vote] Timer expired — votes reset');
          resetVotes();
          io.emit('vote:update', { votes: 0, required, timer: 0 });
        }, timerSeconds * 1000);
      }

      io.emit('vote:update', {
        votes: voteSkipSet.size,
        required,
        timer: timerSeconds,
      });

      if (voteSkipSet.size >= required && !isSkipLocked()) {
        console.log('[vote] Threshold reached — skipping');
        resetVotes();
        io.emit('vote:update', null);
        skipCurrentTrack();
        markSkipTriggered();
      }
    } catch (err) {
      console.error('[socket] vote:skip error:', err);
    }
  });

  // ── mode:set ──
  socket.on('mode:set', async (data: { mode: string; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }

    const validModes = ['dj', 'radio', 'democracy', 'jukebox', 'party'];
    if (!validModes.includes(data.mode)) {
      socket.emit('error:toast', { message: 'Ongeldige modus' });
      return;
    }

    try {
      await setSetting(sb, 'active_mode', data.mode);
      applyPlaybackForMode(data.mode as Mode);
      resetVotes();
      const modeSettings = await getModeSettings(sb);
      io.emit('mode:change', { mode: data.mode as Mode, settings: modeSettings });
      console.log(`[mode] Changed to: ${data.mode}`);
    } catch (err) {
      console.error('[socket] mode:set error:', err);
    }
  });

  // ── settings:update ──
  socket.on('settings:update', async (data: { key: string; value: unknown; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }

    try {
      if (data.key === 'fallback_active_genre') {
        const requested = normalizeFallbackGenreId(data.value);
        if (requested && !isKnownFallbackGenre(requested)) {
          socket.emit('error:toast', { message: 'Onbekend fallback genre' });
          return;
        }
        const nextGenre = requested ?? getDefaultFallbackGenreId();
        await setSetting(sb, data.key, nextGenre);
        await setSetting(sb, 'fallback_active_genre_by', null);
        setActiveFallbackGenre(nextGenre);
        await emitFallbackGenreUpdate();
        console.log(`[settings] Updated: ${data.key}=${nextGenre ?? 'none'}`);
        return;
      }

      await setSetting(sb, data.key, data.value);
      const modeSettings = await getModeSettings(sb);
      const mode = await getActiveMode(sb);
      io.emit('mode:change', { mode, settings: modeSettings });
      console.log(`[settings] Updated: ${data.key}`);
    } catch (err) {
      console.error('[socket] settings:update error:', err);
    }
  });

  // ── queue:reorder ──
  socket.on('queue:reorder', async (data: { id: string; newPosition: number; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }

    try {
      await reorderQueue(sb, data.id, data.newPosition);
      invalidateNextReady();
      playerEvents.emit('queue:add');
      const queue = await getQueue(sb);
      io.emit('queue:update', { items: queue });
      console.log(`[queue] Reordered: ${data.id} → position ${data.newPosition}`);
    } catch (err) {
      console.error('[socket] queue:reorder error:', err);
    }
  });

  // ── queue:remove ──
  socket.on('queue:remove', async (data: { id: string; token?: string; added_by?: string }) => {
    const mode = await getActiveMode(sb);
    const admin = isAdmin(data.token);
    const requester = normalizeNickname(data.added_by) ?? null;
    const queue = await getQueue(sb);
    const target = queue.find((item) => item.id === data.id);
    const isOwner = mode !== 'dj' && !!(target && requester && normalizeNickname(target.added_by) === requester);
    if (!isOwner && !canPerformAction(mode, 'remove_from_queue', admin)) {
      socket.emit('error:toast', { message: 'Je mag geen nummers verwijderen in deze modus' });
      return;
    }

    try {
      await removeFromQueue(sb, data.id);
      removeQueueItemFromPreload(data.id);
      invalidateNextReady();
      playerEvents.emit('queue:add');
      const queue = await getQueue(sb);
      io.emit('queue:update', { items: queue });
      console.log(`[queue] Removed: ${data.id}`);
    } catch (err) {
      console.error('[socket] queue:remove error:', err);
    }
  });

  // ── settings:keepFiles ──
  socket.on('settings:keepFiles', (data: { keep: boolean; token: string }) => {
    if (!isAdmin(data.token)) {
      socket.emit('error:toast', { message: 'Geen admin rechten' });
      return;
    }
    setKeepFiles(data.keep);
    io.emit('settings:keepFilesChanged', { keep: data.keep });
    console.log(`[settings] Keep files: ${data.keep}`);
  });

  // ── fallback:genre:set (global, all listeners) ──
  socket.on('fallback:genre:set', async (data: { genreId: string; selectedBy?: string }) => {
    const requested = normalizeFallbackGenreId(data.genreId);
    if (!requested || !isKnownFallbackGenre(requested)) {
      socket.emit('error:toast', { message: 'Dit genre is niet beschikbaar' });
      return;
    }
    const selectedBy = normalizeNickname(data.selectedBy) ?? 'onbekend';
    try {
      await setSetting(sb, 'fallback_active_genre', requested);
      await setSetting(sb, 'fallback_active_genre_by', selectedBy);
      setActiveFallbackGenre(requested);
      await emitFallbackGenreUpdate();
      console.log(`[fallback] Active genre changed: ${requested} by ${selectedBy}`);
    } catch (err) {
      console.error('[socket] fallback:genre:set error:', err);
      socket.emit('error:toast', { message: 'Kon genre niet opslaan' });
    }
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    voteSkipSet.delete(socket.id);
    io.emit('stream:status', { online: getCurrentTrack() !== null, listeners: io.engine.clientsCount });
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[server] Starting radio control server...');

  // Initialize cache
  initCache(CACHE_DIR);

  // Seed default settings
  await seedSettings(sb);
  console.log('[server] Settings seeded');
  reloadFallbackGenres();
  const startupFallbackGenre = await resolveActiveFallbackGenre(true);
  setActiveFallbackGenre(startupFallbackGenre);
  console.log(`[fallback] Active genre: ${startupFallbackGenre ?? 'none'}`);

  httpServer.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
    console.log(`[server] CORS allowed: ${FRONTEND_URL}`);
    if (ICECAST) {
      console.log(`[server] Streaming via Icecast: ${ICECAST.host}:${ICECAST.port}${ICECAST.mount}`);
    } else {
      console.log('[server] Streaming via built-in StreamHub (no Icecast)');
    }
  });

  setKeepFiles(KEEP_FILES);
  console.log(`[server] Keep files after streaming: ${KEEP_FILES}`);

  const initialMode = await getActiveMode(sb);
  console.log(`[mode] Initial mode: ${initialMode}`);
  applyPlaybackForMode(initialMode);

  let lastSyncedMode = initialMode;
  let pendingSyncedMode: Mode | null = null;
  let pendingSyncedModeCount = 0;
  let lastModeApplyAt = Date.now();
  setInterval(() => {
    maybeReleaseQueuePushLock();
    getActiveMode(sb)
      .then(async (mode) => {
        if (mode === lastSyncedMode) {
          pendingSyncedMode = null;
          pendingSyncedModeCount = 0;
          return;
        }
        if (pendingSyncedMode !== mode) {
          pendingSyncedMode = mode;
          pendingSyncedModeCount = 1;
          return;
        }
        pendingSyncedModeCount += 1;
        if (pendingSyncedModeCount < MODE_SYNC_CONFIRM_POLLS) return;
        if (Date.now() - lastModeApplyAt < MODE_SYNC_COOLDOWN_MS) return;
        lastSyncedMode = mode;
        pendingSyncedMode = null;
        pendingSyncedModeCount = 0;
        lastModeApplyAt = Date.now();
        applyPlaybackForMode(mode);
        const modeSettings = await getModeSettings(sb);
        io.emit('mode:change', { mode, settings: modeSettings });
        console.log(`[mode] Synced mode from settings: ${mode}`);
      })
      .catch(() => {});
  }, MODE_SYNC_INTERVAL_MS);

  // Start the bridge (downloads approved requests)
  startBridge(sb, DOWNLOAD_PATH);

  // Start now-playing watcher (RekordBox output files)
  startNowPlayingWatcher(sb, REKORDBOX_OUTPUT_PATH);

  // Pre-load SoundCloud client_id in background
  getSoundCloudClientId().catch(() => {});
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
