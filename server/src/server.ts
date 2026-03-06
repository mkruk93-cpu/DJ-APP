import 'dotenv/config';
import express, { type Request } from 'express';
import http from 'node:http';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { join as pathJoin, extname, basename, resolve as pathResolve } from 'node:path';
import multer from 'multer';
import { Server as IOServer } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import { initCache } from './cleanup.js';
import { seedSettings, getActiveMode, getActiveFallbackGenre, getModeSettings, getSetting, setSetting } from './settings.js';
import { getQueue, addToQueue, removeFromQueue, reorderQueue, fetchVideoInfo, extractYoutubeId, extractSourceId, isSoundcloudUrl, getThumbnailUrl, encodeLocalFileUrl } from './queue.js';
import { canPerformAction } from './permissions.js';
import { startPlayCycle, stopPlayCycle, getCurrentTrack, getUpcomingTrack, skipCurrentTrack, isSkipLocked, playerEvents, setKeepFiles, invalidatePreload, invalidateNextReady, removeQueueItemFromPreload, setActiveFallbackGenre } from './player.js';
import { youtubeSearch, soundcloudSearch } from './services/search.js';
import { startBridge } from './bridge.js';
import { startNowPlayingWatcher } from './nowPlaying.js';
import { StreamHub } from './streamHub.js';
import type { Mode, ServerState, DurationVote, QueuePushVote, FallbackGenre } from './types.js';
import {
  searchGenres,
  getTopTracksByGenre,
  getPriorityArtistQuickHitsByGenre,
  getPriorityArtistsForGenre,
  resolveMergedGenreId,
  getMergedGenreTags,
  normalizeTrackIdentity,
  type GenreItem,
  type GenreHitItem,
} from './services/discovery.js';
import { parseExportifyUpload } from './services/exportifyImport.js';
import {
  createUserPlaylist,
  listUserPlaylists as listStoredUserPlaylists,
  getUserPlaylistTracks as getStoredUserPlaylistTracks,
  deleteUserPlaylist as deleteStoredUserPlaylist,
  getUserPlaylistUsage,
} from './services/userPlaylistStore.js';

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown');
}

// Simple cache for genre hits to avoid repeated searches
const genreHitsCache = new Map<string, { results: any[], timestamp: number }>();
const GENRE_HITS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
import { reloadFallbackGenres, listFallbackGenres, getDefaultFallbackGenreId, isKnownFallbackGenre, toAutoFallbackGenreId, parseAutoFallbackGenreId, LIKED_AUTO_GENRE_ID } from './fallbackGenres.js';
import { addPriorityArtistForGenre, addBlockedArtistForGenre, addPriorityTrackForGenre, addBlockedTrackForGenre, addLikedPlaylistTrack } from './services/genreCuratedConfig.js';
import genreManagementRouter from './routes/genreManagement.js';
import {
  hydrateGenreHitsCacheFromDisk,
  clearGenreHitsCache,
  getGenreHitsCacheEntry,
  hasGenreHitsCacheEntry,
  makeGenreHitsCacheKey,
  setGenreHitsCacheEntry,
} from './genreHitsStore.js';

// ── Environment ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const CACHE_DIR = process.env.CACHE_DIR ?? pathJoin(tmpdir(), 'radio_cache');
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const USER_PLAYLIST_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const USER_PLAYLIST_MAX_TRACKS_PER_IMPORT = 3000;
const USER_PLAYLIST_MAX_PLAYLISTS_PER_IMPORT = 20;
const USER_PLAYLIST_MAX_STORED_PLAYLISTS_PER_USER = 80;
const USER_PLAYLIST_MAX_STORED_TRACKS_PER_USER = 20_000;
const SPOTIFY_OEMBED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH ?? '';
const REKORDBOX_OUTPUT_PATH = process.env.REKORDBOX_OUTPUT_PATH ?? '';
const KEEP_FILES = process.env.KEEP_FILES === 'true';

const useIcecast = !!process.env.ICECAST_HOST;
const internalPlayerUseIcecast = String(process.env.INTERNAL_PLAYER_USE_ICECAST ?? '').toLowerCase() === 'true';

const ICECAST = useIcecast
  ? {
      host: process.env.ICECAST_HOST!,
      port: parseInt(process.env.ICECAST_PORT ?? '8000', 10),
      password: process.env.ICECAST_PASSWORD ?? '',
      mount: process.env.ICECAST_MOUNT ?? '/stream',
    }
  : null;

const streamHub = new StreamHub();
const spotifyOembedCache = new Map<string, { thumbnail_url: string | null; title: string | null; author_name: string | null; ts: number }>();

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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  },
});

app.use((_req, res, next) => {
  const origin = _req.headers.origin ?? '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});
app.use(express.json());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: USER_PLAYLIST_MAX_UPLOAD_BYTES },
});

// Genre management routes (admin only)
app.use('/api', genreManagementRouter);

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
  const encoderTarget = internalPlayerUseIcecast ? ICECAST : null;
  startPlayCycle(sb, io, CACHE_DIR, encoderTarget, streamHub);
}

const startTime = Date.now();
let lastStateLogKey: string | null = null;
let lastGoodServerState: ServerState | null = null;
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

function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function getIdentityValueFromRequest(req: Request, key: string): string | null {
  const fromBody = req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)[key]
    : undefined;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();

  const fromQuery = req.query?.[key];
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string' && fromQuery[0].trim()) {
    return fromQuery[0].trim();
  }
  return null;
}

function getUserIdentityFromRequest(req: Request): { nickname: string; deviceId: string } | null {
  const nickname = normalizeNickname(getIdentityValueFromRequest(req, 'nickname'));
  const deviceId = normalizeDeviceId(getIdentityValueFromRequest(req, 'device_id'));
  if (!nickname || !deviceId) return null;
  return { nickname, deviceId };
}

function normalizeSpotifyTrackUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'open.spotify.com') return null;
    if (!parsed.pathname.startsWith('/track/')) return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
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

function buildDegradedServerState(): ServerState {
  if (lastGoodServerState) {
    return {
      ...lastGoodServerState,
      currentTrack: getCurrentTrack(),
      upcomingTrack: getUpcomingTrack(),
      listenerCount: io.engine.clientsCount,
      streamOnline: getCurrentTrack() !== null,
      queuePushLocked,
      skipLocked: isSkipLocked(),
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
    };
  }
  return {
    currentTrack: getCurrentTrack(),
    upcomingTrack: getUpcomingTrack(),
    queue: [],
    mode: 'radio',
    modeSettings: {
      democracy_threshold: 60,
      democracy_timer: 15,
      jukebox_max_per_user: 2,
      party_skip_cooldown: 5,
    },
    fallbackGenres: [],
    activeFallbackGenre: null,
    activeFallbackGenreBy: null,
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
const EMPTY_GENRE_CACHE_TTL = 15_000;
const genreCache = new Map<string, { results: GenreItem[]; ts: number }>();
const activeRefreshes = new Set<string>();
const LOCAL_INDEX_TTL = 15 * 60_000;
const LOCAL_AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.alac', '.wma',
]);
/** Local files containing these words are blocked from genre hits. */
const LOCAL_SET_BLOCK_RE = /\b(podcast|set|mix|session|live|megamix|liveset)\b/i;
const LOCAL_GENRE_BLOCK_PHRASES: Record<string, string[]> = {
  // Avoid hardstyle artist "Digital Punk" when user searches for punk genre.
  punk: ['digital punk'],
};
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
  const streamIsActive = getCurrentTrack() !== null;
  if (
    localTrackIndexCache
    && localTrackIndexCache.rootsKey === rootsKey
    && (
      now - localTrackIndexCache.ts < LOCAL_INDEX_TTL
      // Avoid synchronous disk rescans while streaming; use stale cache to keep audio stable.
      || streamIsActive
    )
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

function matchesStrictQuery(haystack: string, query: string): boolean {
  const hay = normalizeLoose(haystack);
  const q = normalizeLoose(query);
  if (!hay || q.length < 2) return false;

  // Exact phrase match first.
  if (hay.includes(q)) return true;

  const parts = q.split(' ').filter(Boolean);
  if (parts.length <= 1) {
    // Single word query: allow contains for unfinished typing.
    return hay.includes(parts[0] ?? q);
  }

  // Multi-word query: all full words must match in order, last word may be prefix.
  const base = parts.slice(0, -1).join(' ');
  const last = parts[parts.length - 1];
  if (!base || !last) return false;

  let idx = hay.indexOf(`${base} `);
  while (idx !== -1) {
    const rest = hay.slice(idx + base.length + 1);
    const nextWord = rest.split(' ').find(Boolean) ?? '';
    if (nextWord.startsWith(last)) return true;
    idx = hay.indexOf(`${base} `, idx + 1);
  }

  return false;
}

function searchLocalTracks(query: string, limit: number, offset: number): SearchResult[] {
  const q = normalizeLoose(query);
  if (q.length < 2) return [];
  const scored = getLocalTrackIndex()
    .map((item) => {
      const hay = normalizeLoose(`${item.artist} ${item.title}`);
      const strict = matchesStrictQuery(hay, q);
      if (!strict) return null;
      const phraseIdx = hay.indexOf(q);
      const score = phraseIdx >= 0 ? 1000 - phraseIdx : 100;
      return { item, score, phraseIdx };
    })
    .filter((row): row is { item: LocalTrack; score: number; phraseIdx: number } => row !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.title.localeCompare(b.item.title, 'nl', { sensitivity: 'base' });
    });
  return scored.slice(offset, offset + limit).map((row) => localTrackToSearchResult(row.item));
}

function genreTokens(genre: string): string[] {
  const normalized = normalizeLoose(resolveMergedGenreId(genre).replace(/_/g, ' '));
  const mergedTags = getMergedGenreTags(genre)
    .map((tag) => normalizeLoose(tag.replace(/_/g, ' ')))
    .filter(Boolean);
  const tokens = mergedTags
    .flatMap((tag) => tag.split(' ').filter((token) => token.length >= 3));
  if (normalized.includes('drum and bass')) tokens.push('dnb');
  if (normalized.includes('hardstyle')) tokens.push('rawstyle');
  if (normalized.includes('techno trance')) tokens.push('trance', 'techno');
  return Array.from(new Set(tokens));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchLocalGenreHits(genre: string, limit: number, offset: number): GenreHitItem[] {
  const tokens = genreTokens(genre);
  if (tokens.length === 0) return [];
  const genreKey = normalizeLoose(genre.replace(/_/g, ' '));
  const blockedPhrases = LOCAL_GENRE_BLOCK_PHRASES[genreKey] ?? [];
  /** Match whole words only, so "techno" won't match "technoboy". */
  const tokenPatterns = tokens.map((token) => new RegExp(`\\b${escapeRegex(token)}\\b`, 'i'));
  const scored = getLocalTrackIndex()
    .filter((item) => {
      const hay = `${item.artist} ${item.title}`;
      if (LOCAL_SET_BLOCK_RE.test(hay)) return false;
      const normalized = normalizeLoose(hay);
      if (blockedPhrases.some((phrase) => normalized.includes(phrase))) return false;
      return true;
    })
    .map((item) => {
      const hay = `${item.artist} ${item.title}`;
      let score = 0;
      for (const pattern of tokenPatterns) {
        if (pattern.test(hay)) score += 1;
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
  // LIGHTWEIGHT: Skip heavy refresh during UI interactions to prevent stream interruption
  console.log(`[genre-hits] LIGHTWEIGHT skipping heavy refresh for ${genre} to protect stream stability`);
  
  // Only do very light local operations
  if (activeRefreshes.has(cacheKey)) return;
  activeRefreshes.add(cacheKey);
  
  // Only use local data - no external API calls
  try {
    const local = searchLocalGenreHits(genre, Math.max(limit * 2, 20), offset);
    if (local.length > 0) {
      console.log(`[genre-hits] LIGHTWEIGHT cached ${local.length} local results for ${genre}`);
      setGenreHitsCacheEntry(cacheKey, local.slice(0, limit));
    }
  } catch (err) {
    console.warn('[genre-hits] LIGHTWEIGHT local search failed:', (err as Error).message);
  } finally {
      activeRefreshes.delete(cacheKey);
  }
}

function parseDuration(text: string): number | null {
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

async function youtubeSearchLocal(query: string, limit = 12): Promise<SearchResult[]> {
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

async function soundcloudSearchLocal(query: string, limit = 12): Promise<SearchResult[]> {
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
    lastGoodServerState = state;
    const stateLogKey = `${state.currentTrack?.title ?? 'none'}|${state.queue.length}|${state.mode}`;
    if (stateLogKey !== lastStateLogKey) {
      lastStateLogKey = stateLogKey;
      console.log(`[rest] /state → track: ${state.currentTrack?.title ?? 'none'}, queue: ${state.queue.length}, mode: ${state.mode}`);
    }
    res.json(state);
  } catch (err) {
    console.error('[rest] /state error:', err);
    // Degraded fallback: never hard-fail /state for transient DB/network errors.
    const degraded = buildDegradedServerState();
    res.json({ ...degraded, degraded: true });
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
    const LOCAL_BUCKET_MAX = 20;

    if (includeLocal) {
      // Keep local results discoverable without blocking remote pagination forever.
      const localWindowOffset = Math.min(offset, LOCAL_BUCKET_MAX);
      const localBudget = Math.max(0, Math.min(limit, LOCAL_BUCKET_MAX - localWindowOffset));
      const localSlice = localBudget > 0 ? searchLocalTracks(q, localBudget, localWindowOffset) : [];

      const remoteBudget = Math.max(0, limit - localSlice.length);
      const remoteOffset = Math.max(0, offset - LOCAL_BUCKET_MAX);
      // Ensure we always try to get some remote results when local budget is exhausted
      const minRemoteRequest = localSlice.length < limit ? Math.max(remoteBudget, 5) : remoteBudget;
      const remoteRequested = Math.min(120, remoteOffset + minRemoteRequest);
      const remotePool = source === 'soundcloud'
        ? await soundcloudSearchLocal(q, remoteRequested)
        : await youtubeSearchLocal(q, remoteRequested);
      const remoteFiltered = remotePool
        .filter((item) => matchesStrictQuery(`${item.channel} ${item.title}`, q))
        .slice(remoteOffset, remoteOffset + remoteBudget);

      const page = Array.from(
        new Map(
          [...localSlice, ...remoteFiltered]
            .map((item) => [item.url, item]),
        ).values(),
      );
      res.json(page);
      return;
    }

    const requested = Math.min(120, limit + offset);
    const remotePool = source === 'soundcloud'
      ? await soundcloudSearchLocal(q, requested)
      : await youtubeSearchLocal(q, requested);
    const remoteFiltered = remotePool
      .filter((item) => matchesStrictQuery(`${item.channel} ${item.title}`, q))
      .slice(offset, offset + limit);
    res.json(remoteFiltered);
  } catch (err) {
    console.error('[rest] /search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/api/user-playlists/import', upload.single('file'), async (req, res) => {
  const identity = getUserIdentityFromRequest(req);
  if (!identity) {
    return res.status(400).json({ error: 'nickname en device_id zijn verplicht' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Bestand ontbreekt (field: file)' });
  }

  const originalName = req.file.originalname ?? 'import.csv';
  const extension = extname(originalName).toLowerCase();
  if (extension !== '.csv' && extension !== '.zip') {
    return res.status(400).json({ error: 'Alleen .csv of .zip toegestaan' });
  }

  try {
    const parsed = parseExportifyUpload(originalName, req.file.buffer, {
      maxPlaylists: USER_PLAYLIST_MAX_PLAYLISTS_PER_IMPORT,
      maxTracksPerPlaylist: USER_PLAYLIST_MAX_TRACKS_PER_IMPORT,
    }).filter((playlist) => playlist.tracks.length > 0);

    if (parsed.length === 0) {
      return res.status(400).json({ error: 'Geen geldige tracks gevonden in upload' });
    }

    const totalTracks = parsed.reduce((sum, playlist) => sum + playlist.tracks.length, 0);
    if (totalTracks > USER_PLAYLIST_MAX_TRACKS_PER_IMPORT) {
      return res.status(400).json({
        error: `Te veel tracks in 1 import (max ${USER_PLAYLIST_MAX_TRACKS_PER_IMPORT})`,
      });
    }

    const usage = await getUserPlaylistUsage(identity);
    if (usage.playlists + parsed.length > USER_PLAYLIST_MAX_STORED_PLAYLISTS_PER_USER) {
      return res.status(400).json({
        error: `Te veel opgeslagen playlists (max ${USER_PLAYLIST_MAX_STORED_PLAYLISTS_PER_USER})`,
      });
    }
    if (usage.tracks + totalTracks > USER_PLAYLIST_MAX_STORED_TRACKS_PER_USER) {
      return res.status(400).json({
        error: `Te veel opgeslagen tracks (max ${USER_PLAYLIST_MAX_STORED_TRACKS_PER_USER})`,
      });
    }

    const imported: Array<{ id: string; name: string; trackCount: number }> = [];
    for (const playlist of parsed) {
      const playlistName = playlist.name.trim().slice(0, 120) || 'Imported playlist';
      const tracksRows = playlist.tracks.map((track, index) => ({
        title: track.title.slice(0, 300),
        artist: track.artist.slice(0, 300),
        album: track.album?.slice(0, 300) ?? null,
        spotify_url: track.spotifyUrl?.slice(0, 600) ?? null,
        position: index + 1,
      }));

      const stored = await createUserPlaylist(identity, playlistName, tracksRows, 'exportify');

      imported.push({
        id: stored.id,
        name: stored.name,
        trackCount: stored.trackCount,
      });
    }

    res.json({
      ok: true,
      imported,
      totalPlaylists: imported.length,
      totalTracks,
    });
  } catch (err) {
    console.error('[rest] /api/user-playlists/import error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.get('/api/user-playlists', async (req, res) => {
  const identity = getUserIdentityFromRequest(req);
  if (!identity) {
    return res.status(400).json({ error: 'nickname en device_id zijn verplicht' });
  }

  try {
    const items = await listStoredUserPlaylists(identity);
    res.json(items);
  } catch (err) {
    console.error('[rest] /api/user-playlists GET error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.get('/api/user-playlists/:id/tracks', async (req, res) => {
  const identity = getUserIdentityFromRequest(req);
  if (!identity) {
    return res.status(400).json({ error: 'nickname en device_id zijn verplicht' });
  }

  const playlistId = String(req.params.id ?? '').trim();
  if (!playlistId) {
    return res.status(400).json({ error: 'Playlist id ontbreekt' });
  }

  try {
    const tracks = await getStoredUserPlaylistTracks(identity, playlistId);
    if (!tracks) return res.status(404).json({ error: 'Playlist niet gevonden' });
    res.json(tracks);
  } catch (err) {
    console.error('[rest] /api/user-playlists/:id/tracks error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.delete('/api/user-playlists/:id', async (req, res) => {
  const identity = getUserIdentityFromRequest(req);
  if (!identity) {
    return res.status(400).json({ error: 'nickname en device_id zijn verplicht' });
  }

  const playlistId = String(req.params.id ?? '').trim();
  if (!playlistId) {
    return res.status(400).json({ error: 'Playlist id ontbreekt' });
  }

  try {
    await deleteStoredUserPlaylist(identity, playlistId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[rest] /api/user-playlists/:id DELETE error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.get('/api/spotify/oembed', async (req, res) => {
  const rawUrl = String(req.query.url ?? '').trim();
  const spotifyUrl = normalizeSpotifyTrackUrl(rawUrl);
  if (!spotifyUrl) {
    return res.status(400).json({ error: 'Ongeldige Spotify track URL' });
  }

  const cached = spotifyOembedCache.get(spotifyUrl);
  if (cached && Date.now() - cached.ts < SPOTIFY_OEMBED_CACHE_TTL_MS) {
    return res.json({
      thumbnail_url: cached.thumbnail_url,
      title: cached.title,
      author_name: cached.author_name,
    });
  }

  try {
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
      return res.status(404).json({ error: 'Spotify metadata niet gevonden' });
    }
    const payload = await response.json() as Record<string, unknown>;
    const result = {
      thumbnail_url: typeof payload.thumbnail_url === 'string' ? payload.thumbnail_url : null,
      title: typeof payload.title === 'string' ? payload.title : null,
      author_name: typeof payload.author_name === 'string' ? payload.author_name : null,
      ts: Date.now(),
    };
    spotifyOembedCache.set(spotifyUrl, result);
    res.json({
      thumbnail_url: result.thumbnail_url,
      title: result.title,
      author_name: result.author_name,
    });
  } catch (err) {
    console.warn('[rest] /api/spotify/oembed error:', getErrorMessage(err));
    res.status(502).json({ error: 'Spotify metadata tijdelijk niet beschikbaar' });
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
  const requestedGenre = String(req.query.genre ?? '').trim();
  console.log(`[genre-hits] LIGHTWEIGHT search request for: ${requestedGenre}`);
  
  if (requestedGenre.length < 2) {
    res.status(400).json({ error: 'Missing or invalid genre' });
    return;
  }
  
  const genre = resolveMergedGenreId(requestedGenre);
  const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 20);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
  
  try {
    // Check cache first (shorter TTL for more variety)
    const cacheKey = `${genre}:${limit}:${offset}`;
    const cached = genreHitsCache.get(cacheKey);
    const shortCacheTTL = 60000; // 1 minute instead of 5 minutes for more variety
    if (cached && Date.now() - cached.timestamp < shortCacheTTL) {
      console.log(`[genre-hits] CACHE HIT for ${genre}, returning ${cached.results.length} results instantly`);
      res.json(cached.results);
      return;
    }
    
    // Get whitelisted artists for this genre
    const priorityArtists = getPriorityArtistsForGenre(genre);
    console.log(`[genre-hits] Found ${priorityArtists.length} priority artists for ${genre}`);
    
    if (priorityArtists.length === 0) {
      console.log(`[genre-hits] No priority artists for ${genre}, returning empty`);
      res.json([]);
      return;
    }
    
    // BALANCED: Use more artists to get desired number of results
    const targetResults = limit;
    const maxArtists = Math.min(10, priorityArtists.length); // Max 10 artists for better results
    const artistsPerPage = Math.min(maxArtists, Math.max(5, Math.ceil(targetResults / 2))); // 5-10 artists
    
    // RANDOMIZED: Use different random artists each time for variety
    const selectedArtists: string[] = [];
    const availableArtists = [...priorityArtists]; // Copy array
    
    for (let i = 0; i < artistsPerPage && availableArtists.length > 0; i++) {
      const randomIndex = Math.floor(Math.random() * availableArtists.length);
      selectedArtists.push(availableArtists[randomIndex]);
      availableArtists.splice(randomIndex, 1); // Remove to avoid duplicates
    }
    
    console.log(`[genre-hits] Searching for artists: ${selectedArtists.join(', ')}`);
    
    // Do ultra-fast searches with aggressive timeouts
    const searchPromises = selectedArtists.map(async (artist, index) => {
      // Search only artist name for better, more relevant matches
      // For some genres, add genre context to improve results
      const needsGenreContext = ['deep house', 'tech house', 'progressive house', 'melodic techno'].includes(genre.toLowerCase());
      const searchQuery = needsGenreContext ? `${artist} ${genre}` : artist;
      const searchLimit = Math.ceil(limit / selectedArtists.length) + 5; // Extra buffer for filtering
      
      try {
        // Alternate between YouTube and SoundCloud for variety
        const useYoutube = (offset + index) % 2 === 0;
        
        // Race each individual search with longer timeout to prevent crashes
        const results = await Promise.race([
          useYoutube
            ? youtubeSearchLocal(searchQuery, searchLimit)
            : soundcloudSearchLocal(searchQuery, searchLimit),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Individual search timeout')), 2000)
          )
        ]);
          
        return results
          .filter(result => {
            // Filter out extremely long tracks, but be more lenient for certain genres
            const maxDuration = (genre.includes('house') || genre.includes('techno') || genre.includes('trance')) ? 1200 : 900; // 20 min for house/techno, 15 min for others
            if (result.duration && result.duration > maxDuration) {
              console.log(`[genre-hits] Filtered out very long track: ${result.title} (${Math.floor(result.duration / 60)}:${String(result.duration % 60).padStart(2, '0')})`);
              return false;
            }
            
            // Ensure the track is actually from the whitelisted artist
            const normalizeText = (text: string) => text
              .toLowerCase()
              .trim()
              .normalize('NFD') // Decompose accented characters
              .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
              .replace(/[^\w\s&-]/g, ' ') // Keep only word chars, spaces, & and -
              .replace(/\s+/g, ' ')
              .trim();
            
            const artistNorm = normalizeText(artist);
            const titleNorm = normalizeText(result.title || '');
            const channelNorm = normalizeText(result.channel || '');
            
            // Use word boundary matching to prevent partial matches
            const createArtistRegex = (name: string) => {
              // Escape special regex characters and create word boundary pattern
              const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              return new RegExp(`\\b${escaped}\\b`, 'i');
            };
            
            const artistRegex = createArtistRegex(artistNorm);
            const artistInTitle = artistRegex.test(titleNorm);
            const artistInChannel = artistRegex.test(channelNorm);
            
            // Also check for simple contains match for better recall
            const simpleMatch = titleNorm.includes(artistNorm) || channelNorm.includes(artistNorm);
            
            // Additional check: if artist name is very short (<=3 chars), be extra strict
            if (artistNorm.length <= 3) {
              // For short names, require exact match at start of title or channel, or after " - "
              const strictPatterns = [
                new RegExp(`^${artistNorm}\\s`, 'i'),           // "dj something"
                new RegExp(`\\s-\\s${artistNorm}\\s`, 'i'),     // "title - dj something"
                new RegExp(`^${artistNorm}\\s*-`, 'i'),         // "dj - something"
                new RegExp(`\\(${artistNorm}\\)`, 'i'),         // "(dj)"
                new RegExp(`\\[${artistNorm}\\]`, 'i'),         // "[dj]"
              ];
              
              const strictMatch = strictPatterns.some(pattern => 
                pattern.test(titleNorm) || pattern.test(channelNorm)
              );
              
              if (!strictMatch && !artistInTitle && !artistInChannel) {
                console.log(`[genre-hits] Filtered out non-matching short artist: "${result.title}" by "${result.channel}" (expected: ${artist})`);
                return false;
              }
            } else if (!artistInTitle && !artistInChannel && !simpleMatch) {
              console.log(`[genre-hits] Filtered out non-matching artist: "${result.title}" by "${result.channel}" (expected: ${artist})`);
              return false;
            }
            
            return true;
          })
          .map(result => ({
            id: result.id,
            title: result.title,
            artist: artist, // Always use the whitelisted artist, not the channel name
            thumbnail: result.thumbnail,
            sourceHint: result.url,
            duration: result.duration
          }));
      } catch (error) {
        console.warn(`[genre-hits] Fast search failed for ${artist}:`, getErrorMessage(error));
        return [];
      }
    });
    
    // Wait for all searches with longer total timeout to prevent crashes
    const searchResults = await Promise.race([
      Promise.allSettled(searchPromises),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Total search timeout')), 4000)
      )
    ]);
    
    // Collect results
    const allResults = searchResults.flatMap(result => 
      result.status === 'fulfilled' ? result.value : []
    );
    
    // Remove duplicates
    let uniqueResults = Array.from(
      new Map(allResults.map(item => [item.id, item])).values()
    );
    
    // If we don't have enough results, try more artists quickly
    if (uniqueResults.length < limit && selectedArtists.length < Math.min(15, priorityArtists.length)) {
      console.log(`[genre-hits] Only got ${uniqueResults.length}/${limit} results, trying more artists...`);
      
      const additionalArtists: string[] = [];
      const remainingArtists = priorityArtists.filter(artist => !selectedArtists.includes(artist));
      const additionalCount = Math.min(8, remainingArtists.length); // Try up to 8 more
      
      // Randomly select additional artists
      const shuffledRemaining = [...remainingArtists];
      for (let i = shuffledRemaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledRemaining[i], shuffledRemaining[j]] = [shuffledRemaining[j], shuffledRemaining[i]];
      }
      
      for (let i = 0; i < additionalCount; i++) {
        additionalArtists.push(shuffledRemaining[i]);
      }
      
      if (additionalArtists.length > 0) {
        try {
          const additionalPromises = additionalArtists.map(async (artist, index) => {
            const searchQuery = artist; // Search only artist name
            const useYoutube = (offset + selectedArtists.length + index) % 2 === 0;
            
            try {
              const results = await Promise.race([
                useYoutube
                  ? youtubeSearchLocal(searchQuery, 4)
                  : soundcloudSearchLocal(searchQuery, 4),
                new Promise<never>((_, reject) => 
                  setTimeout(() => reject(new Error('Additional search timeout')), 500)
                )
              ]);
              
              return results
                .filter(result => !result.duration || result.duration <= 420)
                .map(result => ({
                  id: result.id,
                  title: result.title,
                  artist: result.channel || artist,
                  thumbnail: result.thumbnail,
                  sourceHint: result.url,
                  duration: result.duration
                }));
            } catch (error) {
              return [];
            }
          });
          
          const additionalResults = await Promise.race([
            Promise.allSettled(additionalPromises),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('Additional search timeout')), 800)
            )
          ]);
          
          const moreResults = additionalResults.flatMap(result => 
            result.status === 'fulfilled' ? result.value : []
          );
          
          // Merge with existing results
          const allCombined = [...uniqueResults, ...moreResults];
          uniqueResults = Array.from(
            new Map(allCombined.map(item => [item.id, item])).values()
          );
          
          console.log(`[genre-hits] Got ${moreResults.length} additional results, total: ${uniqueResults.length}`);
        } catch (error) {
          console.warn(`[genre-hits] Additional search failed:`, getErrorMessage(error));
        }
      }
    }
    
    // Final limit
    const finalResults = uniqueResults.slice(0, limit);
    
    // Cache the results
    genreHitsCache.set(cacheKey, {
      results: finalResults,
      timestamp: Date.now()
    });
    
    console.log(`[genre-hits] Returning ${finalResults.length}/${limit} search results for ${genre} (cached for 1min)`);
    res.json(finalResults);
    
  } catch (error) {
    console.error(`[genre-hits] Error searching ${genre}:`, getErrorMessage(error));
    res.json([]);
  }
});

app.get('/api/genre-health', async (req, res) => {
  const requestedGenre = String(req.query.genre ?? '').trim();
  const doProbe = String(req.query.probe ?? '0') === '1';
  const probeLimitRaw = parseInt(String(req.query.probeLimit ?? '12'), 10);
  const probeLimit = Number.isFinite(probeLimitRaw) ? Math.max(4, Math.min(probeLimitRaw, 30)) : 12;

  const withTimeout = async <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    const allGenres = await searchGenres('');
    const scope = requestedGenre
      ? allGenres.filter((genre) => resolveMergedGenreId(genre.id) === resolveMergedGenreId(requestedGenre))
      : allGenres;

    const probeGenreSet = new Set(
      doProbe
        ? (requestedGenre
            ? [resolveMergedGenreId(requestedGenre)]
            : scope.slice(0, 8).map((item) => resolveMergedGenreId(item.id)))
        : [],
    );

    const healthRows = await Promise.all(scope.map(async (genre) => {
      const canonical = resolveMergedGenreId(genre.id);
      const seedArtists = getPriorityArtistsForGenre(canonical);
      const cacheKey0 = makeGenreHitsCacheKey(canonical, 20, 0, false);
      const cacheKey20 = makeGenreHitsCacheKey(canonical, 20, 20, false);
      const cache0 = getGenreHitsCacheEntry(cacheKey0);
      const cache20 = getGenreHitsCacheEntry(cacheKey20);
      const cachedCount = (cache0?.results.length ?? 0) + (cache20?.results.length ?? 0);
      const cacheAgeMs = cache0 ? (Date.now() - cache0.ts) : null;

      const shouldProbeThisGenre = probeGenreSet.has(canonical);
      const probedStrictCount = shouldProbeThisGenre
        ? await withTimeout(
            getTopTracksByGenre(canonical, probeLimit, 0).then((items) => items.length).catch(() => 0),
            2500,
            0,
          )
        : null;

      const health = seedArtists.length >= 3
        ? (cachedCount >= 8 || (probedStrictCount ?? 0) >= 5 ? 'ok' : 'degraded')
        : 'needs_seeds';

      return {
        genre: canonical,
        label: genre.name,
        mergedTags: getMergedGenreTags(canonical),
        seedArtistsCount: seedArtists.length,
        seedArtistsPreview: seedArtists.slice(0, 8),
        cachedStrictCount: cachedCount,
        cacheAgeMs,
        probedStrictCount,
        health,
      };
    }));

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      probe: doProbe,
      probeScope: requestedGenre ? 'single' : (doProbe ? 'top8' : 'none'),
      count: healthRows.length,
      genres: healthRows,
    });
  } catch (err) {
    console.error('[rest] /api/genre-health error:', err);
    res.status(500).json({ ok: false, error: 'Genre health lookup failed' });
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
    clearGenreHitsCache();
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
    clearGenreHitsCache();
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
    clearGenreHitsCache();
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
    clearGenreHitsCache();
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
  const internalTrackActive = getCurrentTrack() !== null;

  // Internal autoplay stream should not depend on Icecast socket stability.
  if (internalTrackActive && streamHub) {
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
    return;
  }

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
let voteExpiresAt: number | null = null;

function resetVotes(): void {
  voteSkipSet.clear();
  voteTrackId = null;
  voteExpiresAt = null;
  if (voteTimer) {
    clearTimeout(voteTimer);
    voteTimer = null;
  }
}

function getSkipVoteTimerSeconds(): number {
  if (!voteExpiresAt) return 0;
  return Math.max(0, Math.ceil((voteExpiresAt - Date.now()) / 1000));
}

async function emitSkipVoteState(): Promise<void> {
  if (voteSkipSet.size <= 0) {
    io.emit('vote:update', null);
    return;
  }

  const settings = await getModeSettings(sb);
  const threshold = settings.democracy_threshold / 100;
  const required = Math.max(1, Math.ceil(io.engine.clientsCount * threshold));
  const timer = getSkipVoteTimerSeconds();

  io.emit('vote:update', {
    votes: voteSkipSet.size,
    required,
    timer,
  });

  if (voteSkipSet.size >= required && !isSkipLocked()) {
    console.log('[vote] Threshold reached — skipping');
    resetVotes();
    io.emit('vote:update', null);
    skipCurrentTrack();
    markSkipTriggered();
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
  void emitSkipVoteState();
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
        const searchResults = await youtubeSearchLocal(url, 1);
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
      const timerSeconds = settings.democracy_timer;

      // Start timer on first vote
      if (voteSkipSet.size === 1 && !voteTimer) {
        voteExpiresAt = Date.now() + (timerSeconds * 1000);
        voteTimer = setTimeout(() => {
          console.log('[vote] Timer expired — votes reset');
          resetVotes();
          io.emit('vote:update', null);
        }, timerSeconds * 1000);
      }

      await emitSkipVoteState();
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
    void emitSkipVoteState();
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[server] Starting radio control server...');

  // Initialize cache
  initCache(CACHE_DIR);
  hydrateGenreHitsCacheFromDisk();

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

// Search functions are imported from services/search.js and used by player.ts
