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
import { startPlayCycle, stopPlayCycle, getCurrentTrack, getUpcomingTrack, skipCurrentTrack, isSkipLocked, isPlayCycleRunning, playerEvents, setKeepFiles, getJingleSettings, setJingleSettings, getJingleSelection, setJingleSelection, getJingleCatalog, invalidatePreload, invalidateNextReady, removeQueueItemFromPreload, setActiveFallbackGenre, setActiveFallbackGenres, setActiveSharedFallbackPlaylists, setSharedAutoPlaybackMode, resetSharedAutoPlaybackCycleForSelection, setQueueItemSelectionMeta } from './player.js';
import { youtubeSearch, soundcloudSearch, spotdlSearch } from './services/search.js';
import { startBridge } from './bridge.js';
import { startNowPlayingWatcher } from './nowPlaying.js';
import { StreamHub } from './streamHub.js';
import type { Mode, ModeSettings, ServerState, DurationVote, QueuePushVote, FallbackGenre } from './types.js';
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
import { parseExportifyUpload, type ExportifyPlaylistImport } from './services/exportifyImport.js';
import {
  createUserPlaylist,
  listUserPlaylists as listStoredUserPlaylists,
  getUserPlaylistTracks as getStoredUserPlaylistTracks,
  getUserPlaylistTracksPage as getStoredUserPlaylistTracksPage,
  deleteUserPlaylist as deleteStoredUserPlaylist,
  getUserPlaylistUsage,
  type PlaylistGenreMeta as UserPlaylistGenreMeta,
} from './services/userPlaylistStore.js';
import {
  ingestSharedPlaylist,
  listSharedPlaylists,
  getSharedPlaylistTracks,
  getSharedPlaylistTracksPage,
  getSharedStoreUsage,
  updateSharedPlaylistName,
  updateSharedPlaylistGenreMeta,
  deleteSharedPlaylist,
  appendTracksToSharedPlaylist,
  deleteSharedPlaylistTrack,
  getSharedPlaylistSummaryById,
  hasSharedPlaylist,
  parseSharedFallbackPlaylistId,
  parseSharedFallbackPlayMode,
  toSharedFallbackPlaylistId,
  type SharedStoreLimits,
  type PlaylistGenreMeta as SharedPlaylistGenreMeta,
} from './services/sharedPlaylistStore.js';
import {
  getFallbackPreset,
  listFallbackPresets,
  saveFallbackPreset,
} from './services/fallbackPresetStore.js';

function getErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : '';
    const details = typeof record.details === 'string' ? record.details : '';
    return `${message}\n${details}`.trim() || String(err);
  }
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
import { getStatsSummary, recordRequestEvent } from './services/statsStore.js';
import { recordMissingTrackLookup } from './services/missingTrackLog.js';

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
const SHARED_PLAYLIST_MAX_PLAYLISTS = 500;
const SHARED_PLAYLIST_MAX_TRACKS = 150_000;
const SHARED_PLAYLIST_MAX_TRACKS_PER_PLAYLIST = 1500;
const SHARED_EXPORTIFY_INBOX_DIR = process.env.SHARED_EXPORTIFY_INBOX_DIR ?? pathJoin(process.cwd(), 'data', 'exportify_inbox');
const SHARED_IMPORT_POLL_MS = Math.max(15_000, parseInt(process.env.SHARED_IMPORT_POLL_MS ?? '60000', 10) || 60_000);
const SPOTIFY_OEMBED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH ?? '';
const REKORDBOX_OUTPUT_PATH = process.env.REKORDBOX_OUTPUT_PATH ?? '';
const KEEP_FILES = process.env.KEEP_FILES === 'true';
const AUTO_PAUSE_WHEN_IDLE = String(process.env.AUTO_PAUSE_WHEN_IDLE ?? 'true').toLowerCase() !== 'false';
const AUTO_PAUSE_IDLE_GRACE_MS = Math.max(0, parseInt(process.env.AUTO_PAUSE_IDLE_GRACE_MS ?? '45000', 10) || 45_000);

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
let sharedInboxJobRunning = false;

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
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token, x-admin-token');
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

function readAdminToken(req: Request): string {
  const bodyToken = typeof (req.body as { token?: unknown } | undefined)?.token === 'string'
    ? String((req.body as { token?: string }).token ?? '')
    : '';
  const headerToken = String(req.headers['x-admin-token'] ?? '');
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  return bodyToken || headerToken || queryToken;
}

let appliedPlaybackMode: Mode | null = null;
interface ListenerPresenceState {
  nickname: string;
  listening: boolean;
  updatedAt: number;
}
const listenerPresenceBySocket = new Map<string, ListenerPresenceState>();
let idleNoListenerSince: number | null = null;
let playbackPausedForIdle = false;

function isStreamOnlineForStatus(): boolean {
  if (getCurrentTrack() !== null) return true;
  if (playbackPausedForIdle) return false;
  return isPlayCycleRunning() && getEffectiveListenerCount() > 0;
}

function emitStreamStatus(): void {
  io.emit('stream:status', {
    online: isStreamOnlineForStatus(),
    listeners: getEffectiveListenerCount(),
    pausedForIdle: playbackPausedForIdle,
  });
}

function applyPlaybackForMode(mode: Mode): void {
  if (appliedPlaybackMode === mode && (mode === 'dj' || isPlayCycleRunning())) return;
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

function evaluateIdlePlayback(mode: Mode): void {
  if (!AUTO_PAUSE_WHEN_IDLE) return;
  if (mode === 'dj') {
    idleNoListenerSince = null;
    playbackPausedForIdle = false;
    return;
  }
  const listeners = getEffectiveListenerCount();
  if (listeners > 0) {
    idleNoListenerSince = null;
    if (playbackPausedForIdle) {
      playbackPausedForIdle = false;
      applyPlaybackForMode(mode);
      emitStreamStatus();
      console.log('[player] Resumed play cycle: listeners detected');
    }
    return;
  }
  if (idleNoListenerSince === null) {
    idleNoListenerSince = Date.now();
    return;
  }
  if (playbackPausedForIdle) return;
  if (Date.now() - idleNoListenerSince < AUTO_PAUSE_IDLE_GRACE_MS) return;
  stopPlayCycle({ preserveCurrentTrack: true });
  playbackPausedForIdle = true;
  emitStreamStatus();
  console.log(`[player] Auto-paused play cycle: no listeners for ${Math.round(AUTO_PAUSE_IDLE_GRACE_MS / 1000)}s`);
}

const startTime = Date.now();
let lastStateLogKey: string | null = null;
let lastGoodServerState: ServerState | null = null;
const MODE_SYNC_INTERVAL_MS = Math.max(2_000, parseInt(process.env.MODE_SYNC_INTERVAL_MS ?? '8000', 10) || 8_000);
const MODE_SYNC_CONFIRM_POLLS = Math.max(1, parseInt(process.env.MODE_SYNC_CONFIRM_POLLS ?? '3', 10) || 3);
const MODE_SYNC_COOLDOWN_MS = Math.max(2_000, parseInt(process.env.MODE_SYNC_COOLDOWN_MS ?? '15000', 10) || 15_000);
const STATE_RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.STATE_RETRY_ATTEMPTS ?? '3', 10) || 3);
const STATE_RETRY_BASE_DELAY_MS = Math.max(100, parseInt(process.env.STATE_RETRY_BASE_DELAY_MS ?? '300', 10) || 300);
const STATE_ERROR_LOG_COOLDOWN_MS = Math.max(1_000, parseInt(process.env.STATE_ERROR_LOG_COOLDOWN_MS ?? '12000', 10) || 12_000);
const STATE_CIRCUIT_FAILURE_THRESHOLD = Math.max(2, parseInt(process.env.STATE_CIRCUIT_FAILURE_THRESHOLD ?? '4', 10) || 4);
const STATE_CIRCUIT_OPEN_MS = Math.max(2_000, parseInt(process.env.STATE_CIRCUIT_OPEN_MS ?? '30000', 10) || 30_000);
let lastStateErrorLogAt = 0;
let stateTransientFailureStreak = 0;
let stateCircuitOpenUntil = 0;
let lastStateCircuitLogAt = 0;

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

function isTransientStateError(err: unknown): boolean {
  const text = getErrorMessage(err).toLowerCase();
  return (
    text.includes('fetch failed')
    || text.includes('econnreset')
    || text.includes('econnaborted')
    || text.includes('etimedout')
    || text.includes('timeout')
    || text.includes('network socket disconnected')
  );
}

async function withStateRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < STATE_RETRY_ATTEMPTS) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt >= STATE_RETRY_ATTEMPTS || !isTransientStateError(err)) break;
      const delay = STATE_RETRY_BASE_DELAY_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

function markStateFetchSuccess(): void {
  stateTransientFailureStreak = 0;
  stateCircuitOpenUntil = 0;
}

function markStateFetchFailure(err: unknown): void {
  if (!isTransientStateError(err)) {
    stateTransientFailureStreak = 0;
    return;
  }
  stateTransientFailureStreak += 1;
  if (stateTransientFailureStreak < STATE_CIRCUIT_FAILURE_THRESHOLD) return;
  const now = Date.now();
  stateCircuitOpenUntil = Math.max(stateCircuitOpenUntil, now + STATE_CIRCUIT_OPEN_MS);
  if (now - lastStateCircuitLogAt >= STATE_ERROR_LOG_COOLDOWN_MS) {
    lastStateCircuitLogAt = now;
    console.warn(`[rest] /state circuit opened for ${Math.round(STATE_CIRCUIT_OPEN_MS / 1000)}s after ${stateTransientFailureStreak} transient failures`);
  }
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

function getAdminTokenFromRequest(req: Request): string | null {
  const token = getIdentityValueFromRequest(req, 'token');
  return token ? token.trim() : null;
}

function getSharedPlaylistNameFromRequest(req: Request): string | null {
  const fromBody = getIdentityValueFromRequest(req, 'playlist_name')
    ?? getIdentityValueFromRequest(req, 'name');
  if (!fromBody) return null;
  const trimmed = fromBody.trim().slice(0, 140);
  return trimmed || null;
}

function getPlaylistGenreMetaFromRequest(req: Request): UserPlaylistGenreMeta & SharedPlaylistGenreMeta {
  const groupRaw = getIdentityValueFromRequest(req, 'genre_group') ?? getIdentityValueFromRequest(req, 'genreGroup');
  const subgenreRaw = getIdentityValueFromRequest(req, 'subgenre') ?? getIdentityValueFromRequest(req, 'subGenre');
  const parentRaw = getIdentityValueFromRequest(req, 'related_parent_playlist_id')
    ?? getIdentityValueFromRequest(req, 'relatedParentPlaylistId')
    ?? getIdentityValueFromRequest(req, 'related_playlist_id');
  const coverRaw = getIdentityValueFromRequest(req, 'cover_url')
    ?? getIdentityValueFromRequest(req, 'coverUrl')
    ?? getIdentityValueFromRequest(req, 'cover');
  const genre_group = (groupRaw ?? '').trim().slice(0, 80) || null;
  const subgenre = (subgenreRaw ?? '').trim().slice(0, 120) || null;
  const related_parent_playlist_id = (parentRaw ?? '').trim() || null;
  const cover_url = /^https?:\/\//i.test((coverRaw ?? '').trim()) ? (coverRaw ?? '').trim().slice(0, 1200) : null;
  return { genre_group, subgenre, related_parent_playlist_id, cover_url };
}

function parseBooleanFlag(raw: string | null | undefined, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const value = raw.trim().toLowerCase();
  if (!value) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return defaultValue;
}

function getPlaylistCoverOptionsFromRequest(req: Request): { coverUrl: string | null; autoCover: boolean } {
  const coverRaw = getIdentityValueFromRequest(req, 'cover_url')
    ?? getIdentityValueFromRequest(req, 'coverUrl')
    ?? getIdentityValueFromRequest(req, 'cover');
  const autoRaw = getIdentityValueFromRequest(req, 'auto_cover')
    ?? getIdentityValueFromRequest(req, 'autoCover');
  const coverUrl = /^https?:\/\//i.test((coverRaw ?? '').trim()) ? (coverRaw ?? '').trim().slice(0, 1200) : null;
  const autoCover = parseBooleanFlag(autoRaw, true);
  return { coverUrl, autoCover };
}

function getSharedStoreLimits(): SharedStoreLimits {
  return {
    maxSharedPlaylists: SHARED_PLAYLIST_MAX_PLAYLISTS,
    maxSharedTracks: SHARED_PLAYLIST_MAX_TRACKS,
    maxTracksPerSharedPlaylist: SHARED_PLAYLIST_MAX_TRACKS_PER_PLAYLIST,
  };
}

interface SharedImportWarning {
  name: string;
  reason: string;
}

async function ingestParsedPlaylistsIntoShared(
  parsed: ExportifyPlaylistImport[],
  addedBy: string | null,
  source = 'exportify-shared',
  genreMeta?: SharedPlaylistGenreMeta,
  coverOptions?: { coverUrl: string | null; autoCover: boolean },
): Promise<{
  imported: Array<{ id: string; name: string; trackCount: number }>;
  warnings: SharedImportWarning[];
}> {
  const limits = getSharedStoreLimits();
  const imported: Array<{ id: string; name: string; trackCount: number }> = [];
  const warnings: SharedImportWarning[] = [];

  for (const playlist of parsed) {
    const safeName = playlist.name.trim().slice(0, 140) || 'Shared playlist';
    const trackInputs = playlist.tracks.map((track, index) => ({
      title: track.title.slice(0, 300),
      artist: track.artist.slice(0, 300),
      album: track.album?.slice(0, 300) ?? null,
      spotify_url: track.spotifyUrl?.slice(0, 600) ?? null,
      position: index + 1,
    }));
    const resolvedCoverUrl = await resolvePlaylistCoverUrlFromTracks(
      trackInputs,
      coverOptions?.coverUrl ?? genreMeta?.cover_url ?? null,
      coverOptions?.autoCover ?? false,
    );
    const result = await ingestSharedPlaylist(trackInputs, {
      name: safeName,
      source,
      addedBy,
      genreMeta: {
        ...(genreMeta ?? { genre_group: null, subgenre: null, related_parent_playlist_id: null }),
        cover_url: resolvedCoverUrl ?? genreMeta?.cover_url ?? null,
      },
    }, limits);
    if (result.imported && result.playlistId) {
      imported.push({
        id: result.playlistId,
        name: result.name,
        trackCount: result.trackCount,
      });
    } else {
      warnings.push({
        name: safeName,
        reason: result.reason ?? 'Onbekende ingest fout',
      });
    }
  }

  return { imported, warnings };
}

function ensureDir(path: string): void {
  if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
}

function moveFileWithTimestamp(sourcePath: string, targetDir: string): string {
  ensureDir(targetDir);
  const fileName = basename(sourcePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destinationPath = pathJoin(targetDir, `${stamp}_${fileName}`);
  fs.renameSync(sourcePath, destinationPath);
  return destinationPath;
}

async function runSharedInboxImportJob(trigger: 'poll' | 'manual' = 'poll'): Promise<{
  processedFiles: number;
  importedPlaylists: number;
  warnings: SharedImportWarning[];
}> {
  if (sharedInboxJobRunning) {
    return { processedFiles: 0, importedPlaylists: 0, warnings: [{ name: 'job', reason: 'Import job draait al' }] };
  }
  sharedInboxJobRunning = true;
  try {
    ensureDir(SHARED_EXPORTIFY_INBOX_DIR);
    const processedDir = pathJoin(SHARED_EXPORTIFY_INBOX_DIR, 'processed');
    const failedDir = pathJoin(SHARED_EXPORTIFY_INBOX_DIR, 'failed');
    ensureDir(processedDir);
    ensureDir(failedDir);

    const entries = fs.readdirSync(SHARED_EXPORTIFY_INBOX_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => {
        const lower = extname(entry.name).toLowerCase();
        return lower === '.csv' || lower === '.zip';
      });

    let processedFiles = 0;
    let importedPlaylists = 0;
    const warnings: SharedImportWarning[] = [];

    for (const entry of entries) {
      const fullPath = pathJoin(SHARED_EXPORTIFY_INBOX_DIR, entry.name);
      try {
        const buffer = fs.readFileSync(fullPath);
        const parsed = parseExportifyUpload(entry.name, buffer, {
          maxPlaylists: USER_PLAYLIST_MAX_PLAYLISTS_PER_IMPORT,
          maxTracksPerPlaylist: USER_PLAYLIST_MAX_TRACKS_PER_IMPORT,
        }).filter((playlist) => playlist.tracks.length > 0);
        if (parsed.length === 0) {
          warnings.push({ name: entry.name, reason: 'Geen geldige playlists gevonden' });
          moveFileWithTimestamp(fullPath, failedDir);
          processedFiles += 1;
          continue;
        }

        const result = await ingestParsedPlaylistsIntoShared(parsed, `inbox:${trigger}`, 'exportify-inbox');
        importedPlaylists += result.imported.length;
        warnings.push(...result.warnings.map((warning) => ({
          name: `${entry.name}:${warning.name}`,
          reason: warning.reason,
        })));
        moveFileWithTimestamp(fullPath, processedDir);
        processedFiles += 1;
      } catch (err) {
        warnings.push({ name: entry.name, reason: getErrorMessage(err) });
        try {
          moveFileWithTimestamp(fullPath, failedDir);
        } catch {}
        processedFiles += 1;
      }
    }

    if (processedFiles > 0 || trigger === 'manual') {
      console.log(`[shared-inbox] trigger=${trigger} processed=${processedFiles} imported=${importedPlaylists} warnings=${warnings.length}`);
    }
    return { processedFiles, importedPlaylists, warnings };
  } finally {
    sharedInboxJobRunning = false;
  }
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

async function fetchSpotifyOembedMeta(spotifyUrl: string): Promise<{
  thumbnail_url: string | null;
  title: string | null;
  author_name: string | null;
}> {
  const cached = spotifyOembedCache.get(spotifyUrl);
  if (cached && Date.now() - cached.ts < SPOTIFY_OEMBED_CACHE_TTL_MS) {
    return {
      thumbnail_url: cached.thumbnail_url,
      title: cached.title,
      author_name: cached.author_name,
    };
  }

  const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) {
    throw new Error(`Spotify oembed HTTP ${response.status}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const result = {
    thumbnail_url: typeof payload.thumbnail_url === 'string' ? payload.thumbnail_url : null,
    title: typeof payload.title === 'string' ? payload.title : null,
    author_name: typeof payload.author_name === 'string' ? payload.author_name : null,
    ts: Date.now(),
  };
  spotifyOembedCache.set(spotifyUrl, result);
  return {
    thumbnail_url: result.thumbnail_url,
    title: result.title,
    author_name: result.author_name,
  };
}

async function resolvePlaylistCoverUrlFromTracks(
  tracks: Array<{ spotify_url?: string | null }>,
  preferredCoverUrl: string | null,
  autoCover: boolean,
): Promise<string | null> {
  if (preferredCoverUrl) return preferredCoverUrl;
  if (!autoCover) return null;
  const candidates = Array.from(new Set(
    tracks
      .map((track) => normalizeSpotifyTrackUrl(String(track.spotify_url ?? '')))
      .filter((url): url is string => !!url),
  )).slice(0, 4);
  for (const spotifyUrl of candidates) {
    try {
      const meta = await fetchSpotifyOembedMeta(spotifyUrl);
      const thumb = (meta.thumbnail_url ?? '').trim();
      if (thumb) return thumb.slice(0, 1200);
    } catch {
      // Continue probing with next candidate URL.
    }
  }
  return null;
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

function normalizeSearchText(input: string | null | undefined): string {
  const confusableMap: Record<string, string> = {
    '\u056c': 'l', // Armenian small letter used in spoofed titles, e.g. S?UT
  };
  const withConfusablesFixed = Array.from(input ?? '')
    .map((char) => confusableMap[char] ?? char)
    .join('');
  return withConfusablesFixed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\*/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeNormalizedText(input: string | null | undefined): string[] {
  return normalizeSearchText(input)
    .split(' ')
    .filter((part) => part.length > 1);
}

function normalizeArtistString(artist: string | null | undefined): string[] {
  const raw = normalizeSearchText(artist);
  if (!raw) return [];
  const expanded = raw
    .replace(/\b(feat|ft|featuring|vs|versus)\b/g, ' & ')
    .replace(/\bx\b/g, ' & ')
    .replace(/[;,/|]+/g, ' & ')
    .replace(/\s*&\s*/g, ' & ');
  const parts = expanded
    .split(' & ')
    .map((part) => normalizeSearchText(part))
    .filter((part) => part.length > 1);
  return Array.from(new Set(parts));
}

function jaccardTokenSimilarity(a: string[] | Set<string>, b: string[] | Set<string>): number {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function tokenContainmentSimilarity(expected: string[] | Set<string>, actual: string[] | Set<string>): number {
  const expectedSet = expected instanceof Set ? expected : new Set(expected);
  const actualSet = actual instanceof Set ? actual : new Set(actual);
  if (expectedSet.size === 0 || actualSet.size === 0) return 0;
  let matched = 0;
  for (const token of expectedSet) {
    if (actualSet.has(token)) matched += 1;
  }
  return matched / expectedSet.size;
}

function isNearTokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length < 4 || b.length < 4) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

function fuzzyTokenCoverage(expected: string[] | Set<string>, actual: string[] | Set<string>): number {
  const expectedSet = expected instanceof Set ? expected : new Set(expected);
  const actualSet = actual instanceof Set ? actual : new Set(actual);
  if (expectedSet.size === 0 || actualSet.size === 0) return 0;
  const actualTokens = Array.from(actualSet);
  let matched = 0;
  for (const token of expectedSet) {
    if (actualSet.has(token) || actualTokens.some((candidate) => isNearTokenMatch(token, candidate))) {
      matched += 1;
    }
  }
  return matched / expectedSet.size;
}

function isVariousArtistsText(input: string | null | undefined): boolean {
  const value = normalizeSearchText(input);
  return value === 'various artists' || value === 'various artist' || value === 'va';
}

function parseArtistFromExpectedTitle(input: string | null | undefined): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const separators = [' - ', ' — ', ' – ', ' | '];
  for (const separator of separators) {
    const idx = raw.indexOf(separator);
    if (idx <= 0) continue;
    const artistPart = raw.slice(0, idx).trim();
    if (!artistPart) continue;
    return artistPart;
  }
  return null;
}

function tokenOverlap(a: string, b: string): number {
  const aSet = new Set(normalizeSearchText(a).split(' ').filter((part) => part.length > 1));
  const bSet = new Set(normalizeSearchText(b).split(' ').filter((part) => part.length > 1));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let matches = 0;
  for (const token of aSet) {
    if (bSet.has(token)) matches += 1;
  }
  return matches / Math.max(aSet.size, bSet.size);
}

const SEARCH_BLOCKED_KEYWORDS = [
  'advertisement',
  'ad break',
  'sponsored',
  'sponsor',
  'promo code',
  'trailer',
  'teaser',
  'reaction',
  'review',
  'tutorial',
  'how to',
  'podcast',
  'interview',
  'news',
  'talk show',
];

const SEARCH_HARD_VARIANT_KEYWORDS = [
  'remix',
  'cover',
  'tribute',
  'karaoke',
  'remake',
  'bootleg',
  'mashup',
  'nightcore',
  '8d',
  'sped up',
  'slowed',
  'reverb',
  'chipmunk',
  'bass boosted',
  'fan made',
  'ai cover',
  'version',
];

const SEARCH_SOFT_VARIANT_KEYWORDS = [
  'acoustic',
  'demo',
  'preview',
  'snippet',
  'mix',
  'dj set',
  'session',
];

const SEARCH_ALLOW_VERSION_KEYWORDS = [
  'original mix',
  'radio edit',
  'extended mix',
  'remaster',
  'official audio',
  'topic',
  'hq',
];

const SEARCH_LIVE_KEYWORDS = [
  'live',
  'live at',
  'live version',
  'concert',
];

const OPTIONAL_TITLE_STYLE_TOKENS = new Set([
  'hypertechno',
]);

function isBlockedSearchResult(title: string, channel: string): boolean {
  const haystack = `${title} ${channel}`.toLowerCase();
  return SEARCH_BLOCKED_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function includesKeywordOutsideExpected(
  haystackNorm: string,
  keyword: string,
  expectedTitleNorm: string,
): boolean {
  const keywordNorm = normalizeSearchText(keyword);
  if (!keywordNorm || !haystackNorm.includes(keywordNorm)) return false;
  return !expectedTitleNorm.includes(keywordNorm);
}

function hasUnexpectedKeyword(
  haystackNorm: string,
  expectedTitleNorm: string,
  keywords: string[],
): boolean {
  return keywords.some((keyword) => includesKeywordOutsideExpected(haystackNorm, keyword, expectedTitleNorm));
}

type SearchScoreResult = {
  score: number;
  reasons: string[];
  isLive: boolean;
};

function evaluateSearchResultForSubmission(
  result: { title?: string | null; channel?: string | null; duration?: number | null },
  expectedArtist: string | null,
  expectedTitle: string | null,
  options?: { strictMetadata?: boolean; allowLiveFallback?: boolean; matchMode?: 'strict' | 'semi' },
): SearchScoreResult {
  const title = String(result.title ?? '').trim();
  const channel = String(result.channel ?? '').trim();
  if (!title) return { score: -100, reasons: ['empty-title'], isLive: false };
  const strictMetadata = options?.strictMetadata === true;
  const allowLiveFallback = options?.allowLiveFallback === true;
  const matchMode = options?.matchMode ?? 'strict';
  const isSemiStrict = matchMode === 'semi';

  let score = 0;
  const titleNorm = normalizeSearchText(title);
  const channelNorm = normalizeSearchText(channel);
  const haystackNorm = `${titleNorm} ${channelNorm}`.trim();
  const expectedArtistFromTitle = parseArtistFromExpectedTitle(expectedTitle);
  const useParsedArtist = isVariousArtistsText(expectedArtist) && !!expectedArtistFromTitle;
  const expectedArtistRaw = useParsedArtist ? expectedArtistFromTitle : expectedArtist;
  const expectedArtistTokens = normalizeArtistString(expectedArtistRaw);
  const expectedArtistSet = new Set(expectedArtistTokens.flatMap((value) => tokenizeNormalizedText(value)));
  const wantedTitleNorm = normalizeSearchText(expectedTitle);
  const expectedTitleSet = new Set(tokenizeNormalizedText(expectedTitle));
  const expectedTitleRelaxedSet = new Set(
    Array.from(expectedTitleSet).filter((token) => !OPTIONAL_TITLE_STYLE_TOKENS.has(token)),
  );
  const resultTitleSet = new Set(tokenizeNormalizedText(title));
  const resultCombinedSet = new Set(tokenizeNormalizedText(`${title} ${channel}`));
  const expectedIncludesRemixLike = hasUnexpectedKeyword(
    wantedTitleNorm,
    '',
    ['remix', 'edit', 'bootleg', 'rework', 'version'],
  );
  const blocked = isBlockedSearchResult(title, channel);

  const titleTokenSimilarity = expectedTitleSet.size > 0
    ? jaccardTokenSimilarity(expectedTitleSet, resultTitleSet)
    : 1;
  const titleCombinedSimilarity = expectedTitleSet.size > 0
    ? jaccardTokenSimilarity(expectedTitleSet, resultCombinedSet)
    : 1;
  const titleTokenCoverage = expectedTitleSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleSet, resultTitleSet)
    : 1;
  const titleCombinedCoverage = expectedTitleSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleSet, resultCombinedSet)
    : 1;
  const titleRelaxedCoverage = expectedTitleRelaxedSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleRelaxedSet, resultTitleSet)
    : titleTokenCoverage;
  const titleRelaxedCombinedCoverage = expectedTitleRelaxedSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleRelaxedSet, resultCombinedSet)
    : titleCombinedCoverage;
  const titleStrongMatch = titleTokenSimilarity >= 0.8
    || titleCombinedSimilarity >= 0.8
    || titleTokenCoverage >= 0.8
    || titleCombinedCoverage >= 0.8
    || titleRelaxedCoverage >= 0.8
    || titleRelaxedCombinedCoverage >= 0.8
    || (wantedTitleNorm ? tokenOverlap(expectedTitle ?? '', title) >= 0.85 : true)
    || (wantedTitleNorm ? titleNorm.includes(wantedTitleNorm) : true);
  const titleNearPerfect = titleTokenSimilarity >= 0.95
    || titleCombinedSimilarity >= 0.95
    || titleTokenCoverage >= 0.95
    || titleCombinedCoverage >= 0.95
    || titleRelaxedCoverage >= 0.95
    || titleRelaxedCombinedCoverage >= 0.95;

  const resultArtistSet = new Set(tokenizeNormalizedText(`${title} ${channel}`));
  const artistSimilarity = expectedArtistSet.size > 0
    ? jaccardTokenSimilarity(expectedArtistSet, resultArtistSet)
    : 1;
  const artistContainment = expectedArtistSet.size > 0
    ? tokenContainmentSimilarity(expectedArtistSet, resultArtistSet)
    : 1;
  const artistHasSignal = expectedArtistSet.size > 0 ? artistContainment >= 0.34 : true;
  const strictArtistMatch = expectedArtistSet.size > 0
    ? (artistSimilarity >= 0.65 || artistContainment >= 0.6)
    : true;
  const strictTitleMatch = wantedTitleNorm ? titleStrongMatch : true;
  const artistRequirementDisabled = isVariousArtistsText(expectedArtist) && !useParsedArtist;

  if (!strictMetadata && blocked) return { score: -100, reasons: ['blocked-keyword'], isLive: false };
  if (strictMetadata && !artistRequirementDisabled) {
    if (!strictTitleMatch) return { score: -100, reasons: ['metadata-mismatch:title'], isLive: false };
    if (!strictArtistMatch) {
      // Semi-strict bridge pass: keep candidate in play if title is excellent.
      if (!isSemiStrict || !titleNearPerfect || !artistHasSignal) {
        return { score: -100, reasons: ['metadata-mismatch:artist'], isLive: false };
      }
      score -= 50;
    }
  } else if (strictMetadata && !strictTitleMatch) {
    return { score: -100, reasons: ['metadata-mismatch:title'], isLive: false };
  }

  const nonMusicBlocked = hasUnexpectedKeyword(haystackNorm, wantedTitleNorm, SEARCH_BLOCKED_KEYWORDS);
  if (nonMusicBlocked) {
    return { score: -100, reasons: ['non-music'], isLive: false };
  }

  const hardVariantKeywords = expectedIncludesRemixLike
    ? SEARCH_HARD_VARIANT_KEYWORDS.filter((keyword) => !['remix', 'edit', 'bootleg', 'rework', 'version'].includes(keyword))
    : SEARCH_HARD_VARIANT_KEYWORDS;
  const hardVariantBlocked = hasUnexpectedKeyword(haystackNorm, wantedTitleNorm, hardVariantKeywords);
  if (strictMetadata && hardVariantBlocked) {
    return { score: -100, reasons: ['wrong-version'], isLive: false };
  }

  const isLive = hasUnexpectedKeyword(haystackNorm, wantedTitleNorm, SEARCH_LIVE_KEYWORDS);
  if (strictMetadata && isLive && !allowLiveFallback) {
    return { score: -100, reasons: ['live-version'], isLive: true };
  }

  const reasons: string[] = [];

  if (strictMetadata) {
    score += 24;
    if (artistRequirementDisabled) score += 4;
  }

  if (expectedArtistSet.size > 0 && !artistRequirementDisabled) {
    if (strictArtistMatch) score += 6;
    else if (titleNearPerfect) {
      // Relax uploader/artist requirement for niche uploads with near-perfect title.
      score -= isSemiStrict ? 4 : 8;
      reasons.push('artist-relaxed-high-title');
    } else {
      score -= 8;
      reasons.push('artist-weak');
    }
  }

  if (wantedTitleNorm && expectedTitleSet.size > 0) {
    if (titleNearPerfect) score += 16;
    else if (titleStrongMatch) score += 10;
    else {
      score -= 10;
      reasons.push('title-weak');
    }
  }

  const hasAllowedVersion = SEARCH_ALLOW_VERSION_KEYWORDS
    .some((keyword) => haystackNorm.includes(normalizeSearchText(keyword)));
  if (hasAllowedVersion) score += 5;

  const hasSoftVariant = hasUnexpectedKeyword(haystackNorm, wantedTitleNorm, SEARCH_SOFT_VARIANT_KEYWORDS);
  if (hasSoftVariant) {
    score -= strictMetadata ? 5 : 8;
    reasons.push('variant-soft');
  }

  if (isLive) {
    score -= allowLiveFallback ? 6 : 12;
    reasons.push(allowLiveFallback ? 'live-fallback' : 'live');
  }

  const duration = result.duration ?? null;
  if (duration !== null) {
    if (duration < 95) score -= 4;
    if (duration > 11 * 60) score -= 5;
  }

  return { score, reasons, isLive };
}

function scoreSearchResultForSubmission(
  result: { title?: string | null; channel?: string | null; duration?: number | null },
  expectedArtist: string | null,
  expectedTitle: string | null,
  options?: { strictMetadata?: boolean; allowLiveFallback?: boolean; matchMode?: 'strict' | 'semi' },
): number {
  return evaluateSearchResultForSubmission(result, expectedArtist, expectedTitle, options).score;
}

async function resolveActiveFallbackGenre(persistFix = false): Promise<string | null> {
  const raw = await getActiveFallbackGenre(sb);
  const normalized = normalizeFallbackGenreId(raw);
  let resolved = normalized;
  if (resolved && !(await isKnownFallbackSelection(resolved))) {
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

function normalizeSharedPlaybackMode(value: unknown): 'random' | 'ordered' {
  if (typeof value !== 'string') return 'random';
  const normalized = value.trim().toLowerCase();
  return normalized === 'ordered' ? 'ordered' : 'random';
}

async function resolveSharedPlaybackMode(persistFix = false): Promise<'random' | 'ordered'> {
  const raw = await getSetting<string | null>(sb, 'fallback_shared_playback_mode');
  const mode = normalizeSharedPlaybackMode(raw);
  if (persistFix && raw !== mode) {
    await setSetting(sb, 'fallback_shared_playback_mode', mode);
  }
  return mode;
}

async function normalizeFallbackGenreIds(value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = normalizeFallbackGenreId(entry);
    if (!normalized) continue;
    if (!(await isKnownFallbackSelection(normalized))) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function resolveActiveFallbackGenres(
  activeGenreId: string | null,
  persistFix = false,
): Promise<string[]> {
  const raw = await getSetting<unknown>(sb, 'fallback_active_shared_playlist_ids');
  let normalized = await normalizeFallbackGenreIds(raw);
  if (activeGenreId) {
    if (!normalized.includes(activeGenreId)) {
      normalized = [activeGenreId, ...normalized];
    }
  }
  if (persistFix) {
    await setSetting(sb, 'fallback_active_shared_playlist_ids', normalized);
  }
  return normalized;
}

async function isKnownFallbackSelection(genreId: string | null): Promise<boolean> {
  if (!genreId) return false;
  if (isKnownFallbackGenre(genreId)) return true;
  const sharedPlaylistId = parseSharedFallbackPlaylistId(genreId);
  if (!sharedPlaylistId) return false;
  return hasSharedPlaylist(sharedPlaylistId);
}

async function emitFallbackGenreUpdate(target?: { emit: (event: string, payload: unknown) => void }): Promise<void> {
  const [activeGenreId, selectedBy, sharedMode] = await Promise.all([
    resolveActiveFallbackGenre(),
    getSetting<string | null>(sb, 'fallback_active_genre_by'),
    resolveSharedPlaybackMode(),
  ]);
  const activeGenreIds = await resolveActiveFallbackGenres(activeGenreId, true);
  setSharedAutoPlaybackMode(sharedMode);
  setActiveFallbackGenre(activeGenreId);
  setActiveFallbackGenres(activeGenreIds);
  setActiveSharedFallbackPlaylists(activeGenreIds);
  const genres = await getCombinedFallbackGenres();
  const payload = {
    activeGenreId,
    activeGenreIds,
    selectedBy: normalizeNickname(selectedBy),
    sharedPlaybackMode: sharedMode,
    genres,
  };
  if (target) target.emit('fallback:genre:update', payload);
  else io.emit('fallback:genre:update', payload);
}

function emitFallbackPresetUpdate(target?: { emit: (event: string, payload: unknown) => void }): void {
  const payload = { presets: listFallbackPresets() };
  if (target) target.emit('fallback:presets:update', payload);
  else io.emit('fallback:presets:update', payload);
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
  let sharedPlaylists: Awaited<ReturnType<typeof listSharedPlaylists>> = [];
  try {
    const pageSize = 250;
    const maxPages = 30;
    const allShared: Awaited<ReturnType<typeof listSharedPlaylists>> = [];
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const chunk = await listSharedPlaylists(pageSize, offset);
      allShared.push(...chunk);
      if (chunk.length < pageSize) break;
    }
    sharedPlaylists = allShared;
  } catch (err) {
    console.warn('[fallback] Shared playlist list unavailable:', (err as Error).message);
  }
  const sharedGenres: FallbackGenre[] = sharedPlaylists.map((playlist) => ({
    id: toSharedFallbackPlaylistId(playlist.id),
    label: `Playlist · ${playlist.name}`,
    trackCount: playlist.track_count,
    genre_group: playlist.genre_group ?? null,
    subgenre: playlist.subgenre ?? null,
    related_parent_playlist_id: playlist.related_parent_playlist_id ?? null,
  }));
  return [...localGenres, likedGenre, ...autoGenres, ...sharedGenres];
}

function getEffectiveListenerCount(): number {
  const activeWebListeners = new Set<string>();
  for (const [socketId, presence] of listenerPresenceBySocket.entries()) {
    if (!presence.listening) continue;
    const key = presence.nickname.trim().toLowerCase() || `socket:${socketId}`;
    activeWebListeners.add(key);
  }
  if (activeWebListeners.size > 0) return activeWebListeners.size;
  const streamListeners = streamHub.listenerCount;
  if (streamListeners > 0) return streamListeners;
  return io.engine.clientsCount;
}

function clampInt(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value) : min;
  return Math.max(min, Math.min(max, normalized));
}

function getModeQueueLimitConfig(mode: Mode, settings: ModeSettings): { base: number; min: number; step: number } {
  if (mode === 'dj') {
    return {
      base: settings.dj_queue_base_per_user,
      min: settings.dj_queue_min_per_user,
      step: settings.dj_queue_listener_step,
    };
  }
  if (mode === 'radio') {
    return {
      base: settings.radio_queue_base_per_user,
      min: settings.radio_queue_min_per_user,
      step: settings.radio_queue_listener_step,
    };
  }
  if (mode === 'democracy') {
    return {
      base: settings.democracy_queue_base_per_user,
      min: settings.democracy_queue_min_per_user,
      step: settings.democracy_queue_listener_step,
    };
  }
  if (mode === 'party') {
    return {
      base: settings.party_queue_base_per_user,
      min: settings.party_queue_min_per_user,
      step: settings.party_queue_listener_step,
    };
  }
  return {
    base: settings.jukebox_queue_base_per_user,
    min: settings.jukebox_queue_min_per_user,
    step: settings.jukebox_queue_listener_step,
  };
}

function getDynamicQueueLimitForMode(mode: Mode, listenerCount: number, settings: ModeSettings): number {
  const config = getModeQueueLimitConfig(mode, settings);
  const minLimit = clampInt(config.min, 1, 50);
  const baseLimit = clampInt(config.base, minLimit, 50);
  const step = clampInt(config.step, 1, 100);
  const listeners = Math.max(1, clampInt(listenerCount, 1, 10_000));
  const reduction = Math.floor(Math.max(0, listeners - 1) / step);
  return Math.max(minLimit, baseLimit - reduction);
}

interface DeferredQueueItem {
  id: string;
  youtube_url: string;
  title?: string | null;
  artist?: string | null;
  thumbnail?: string | null;
  source_type?: string | null;
  source_genre?: string | null;
  source_playlist?: string | null;
  created_at: number;
}

const deferredQueueByUser = new Map<string, DeferredQueueItem[]>();
const socketNicknameById = new Map<string, string>();
let deferredRoundRobinCursor = 0;
let lastObservedTrackKey: string | null = null;

function normalizeQueueUser(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed || 'anonymous';
}

function makeDeferredQueueItem(
  data: {
    youtube_url: string;
    title?: string | null;
    artist?: string | null;
    thumbnail?: string | null;
    source_type?: string | null;
    source_genre?: string | null;
    source_playlist?: string | null;
  },
): DeferredQueueItem {
  return {
    id: `dq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    youtube_url: String(data.youtube_url ?? ''),
    title: data.title ?? null,
    artist: data.artist ?? null,
    thumbnail: data.thumbnail ?? null,
    source_type: data.source_type ?? null,
    source_genre: data.source_genre ?? null,
    source_playlist: data.source_playlist ?? null,
    created_at: Date.now(),
  };
}

function getDeferredQueueForUser(addedBy: string): DeferredQueueItem[] {
  return deferredQueueByUser.get(addedBy) ?? [];
}

function emitDeferredQueueUpdateForUser(addedBy: string): void {
  const list = getDeferredQueueForUser(addedBy);
  const payload = {
    added_by: addedBy,
    items: list.map((item) => ({ ...item })),
  };
  for (const [socketId, nickname] of socketNicknameById.entries()) {
    if (nickname !== addedBy) continue;
    io.to(socketId).emit('deferredQueue:update', payload);
  }
}

function setSocketNickname(socketId: string, addedBy: string): void {
  socketNicknameById.set(socketId, addedBy);
  emitDeferredQueueUpdateForUser(addedBy);
}

function pushDeferredQueueItem(addedBy: string, item: DeferredQueueItem): number {
  const list = getDeferredQueueForUser(addedBy);
  list.push(item);
  deferredQueueByUser.set(addedBy, list);
  emitDeferredQueueUpdateForUser(addedBy);
  return list.length;
}

function removeDeferredQueueItem(addedBy: string, itemId: string): boolean {
  const list = getDeferredQueueForUser(addedBy);
  if (list.length === 0) return false;
  const next = list.filter((item) => item.id !== itemId);
  if (next.length === list.length) return false;
  if (next.length === 0) deferredQueueByUser.delete(addedBy);
  else deferredQueueByUser.set(addedBy, next);
  emitDeferredQueueUpdateForUser(addedBy);
  return true;
}

function popDeferredQueueItemRoundRobin(): { addedBy: string; item: DeferredQueueItem } | null {
  const users = Array.from(deferredQueueByUser.keys()).sort();
  if (users.length === 0) return null;
  const startIndex = deferredRoundRobinCursor % users.length;
  for (let i = 0; i < users.length; i += 1) {
    const idx = (startIndex + i) % users.length;
    const user = users[idx];
    const queue = deferredQueueByUser.get(user);
    if (!queue || queue.length === 0) {
      deferredQueueByUser.delete(user);
      continue;
    }
    const item = queue.shift()!;
    if (queue.length === 0) deferredQueueByUser.delete(user);
    deferredRoundRobinCursor = idx + 1;
    emitDeferredQueueUpdateForUser(user);
    return { addedBy: user, item };
  }
  return null;
}

async function getServerState(): Promise<ServerState> {
  const [mode, modeSettings, queue, activeFallbackGenre, activeFallbackGenreBy, fallbackGenres, activeFallbackSharedMode] = await withStateRetry(() => Promise.all([
    getActiveMode(sb),
    getModeSettings(sb),
    getQueue(sb),
    resolveActiveFallbackGenre(),
    getSetting<string | null>(sb, 'fallback_active_genre_by'),
    getCombinedFallbackGenres(),
    resolveSharedPlaybackMode(),
  ]));
  const activeFallbackGenres = await resolveActiveFallbackGenres(activeFallbackGenre, true);

  const jingleSettings = getJingleSettings();
  return {
    currentTrack: getCurrentTrack(),
    upcomingTrack: getUpcomingTrack(),
    queue,
    jingleEnabled: jingleSettings.enabled,
    jingleEveryTracks: jingleSettings.everyTracks,
    jingleSelectedKeys: getJingleSelection(),
    mode,
    modeSettings,
    fallbackGenres,
    activeFallbackGenre,
    activeFallbackGenres,
    activeFallbackGenreBy: normalizeNickname(activeFallbackGenreBy),
    activeFallbackSharedMode,
    listenerCount: getEffectiveListenerCount(),
    streamOnline: isStreamOnlineForStatus(),
    pausedForIdle: playbackPausedForIdle,
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
    const jingleSettings = getJingleSettings();
    return {
      ...lastGoodServerState,
      currentTrack: getCurrentTrack(),
      upcomingTrack: getUpcomingTrack(),
      jingleEnabled: jingleSettings.enabled,
      jingleEveryTracks: jingleSettings.everyTracks,
      jingleSelectedKeys: getJingleSelection(),
      listenerCount: getEffectiveListenerCount(),
      streamOnline: isStreamOnlineForStatus(),
      pausedForIdle: playbackPausedForIdle,
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
  const jingleSettings = getJingleSettings();
  return {
    currentTrack: getCurrentTrack(),
    upcomingTrack: getUpcomingTrack(),
    queue: [],
    jingleEnabled: jingleSettings.enabled,
    jingleEveryTracks: jingleSettings.everyTracks,
    jingleSelectedKeys: getJingleSelection(),
    mode: 'radio',
    modeSettings: {
      democracy_threshold: 60,
      democracy_timer: 15,
      jukebox_max_per_user: 2,
      party_skip_cooldown: 5,
      dj_queue_base_per_user: 3,
      dj_queue_min_per_user: 1,
      dj_queue_listener_step: 3,
      radio_queue_base_per_user: 3,
      radio_queue_min_per_user: 1,
      radio_queue_listener_step: 3,
      democracy_queue_base_per_user: 2,
      democracy_queue_min_per_user: 1,
      democracy_queue_listener_step: 3,
      jukebox_queue_base_per_user: 5,
      jukebox_queue_min_per_user: 1,
      jukebox_queue_listener_step: 2,
      party_queue_base_per_user: 6,
      party_queue_min_per_user: 1,
      party_queue_listener_step: 2,
    },
    fallbackGenres: [],
    activeFallbackGenre: null,
    activeFallbackGenres: [],
    activeFallbackGenreBy: null,
    activeFallbackSharedMode: 'random',
    listenerCount: getEffectiveListenerCount(),
    streamOnline: isStreamOnlineForStatus(),
    pausedForIdle: playbackPausedForIdle,
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
  const now = Date.now();
  if (now < stateCircuitOpenUntil) {
    const degraded = buildDegradedServerState();
    res.json({ ...degraded, degraded: true, circuitOpen: true });
    return;
  }
  try {
    const state = await getServerState();
    markStateFetchSuccess();
    lastGoodServerState = state;
    const stateLogKey = `${state.currentTrack?.title ?? 'none'}|${state.queue.length}|${state.mode}`;
    if (stateLogKey !== lastStateLogKey) {
      lastStateLogKey = stateLogKey;
      console.log(`[rest] /state → track: ${state.currentTrack?.title ?? 'none'}, queue: ${state.queue.length}, mode: ${state.mode}`);
    }
    res.json(state);
  } catch (err) {
    markStateFetchFailure(err);
    if (now - lastStateErrorLogAt >= STATE_ERROR_LOG_COOLDOWN_MS) {
      lastStateErrorLogAt = now;
      console.error('[rest] /state error:', err);
    }
    // Degraded fallback: never hard-fail /state for transient DB/network errors.
    const degraded = buildDegradedServerState();
    res.json({ ...degraded, degraded: true });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    listeners: getEffectiveListenerCount(),
  });
});

app.get('/api/stream-health', async (_req, res) => {
  const mode = await getActiveMode(sb).catch(() => 'radio' as Mode);
  const listeners = getEffectiveListenerCount();
  const streamOnline = isStreamOnlineForStatus();
  const shouldAlert = mode !== 'dj' && listeners > 0 && !streamOnline && !playbackPausedForIdle;
  const idleForSeconds = idleNoListenerSince ? Math.max(0, Math.floor((Date.now() - idleNoListenerSince) / 1000)) : 0;
  const payload = {
    status: shouldAlert ? 'down' : 'ok',
    mode,
    listeners,
    streamOnline,
    playCycleRunning: isPlayCycleRunning(),
    pausedForIdle: playbackPausedForIdle,
    idleForSeconds,
    shouldAlert,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
  res.status(shouldAlert ? 503 : 200).json(payload);
});

app.get('/api/stats/summary', async (req, res) => {
  const rawDays = Number.parseInt(String(req.query.days ?? '30'), 10);
  const days = Number.isFinite(rawDays) ? rawDays : 30;
  try {
    const summary = await getStatsSummary(days);
    res.json(summary);
  } catch (err) {
    console.error('[rest] /api/stats/summary error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
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
    const genreMeta = getPlaylistGenreMetaFromRequest(req);
    const coverOptions = getPlaylistCoverOptionsFromRequest(req);
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
      const resolvedCoverUrl = await resolvePlaylistCoverUrlFromTracks(
        tracksRows,
        coverOptions.coverUrl,
        coverOptions.autoCover,
      );

      const stored = await createUserPlaylist(identity, playlistName, tracksRows, 'exportify', {
        ...genreMeta,
        cover_url: resolvedCoverUrl ?? genreMeta.cover_url ?? null,
      });

      imported.push({
        id: stored.id,
        name: stored.name,
        trackCount: stored.trackCount,
      });
    }

    const sharedIngest = await ingestParsedPlaylistsIntoShared(parsed, identity.nickname, 'exportify-user', {
      ...genreMeta,
      cover_url: coverOptions.coverUrl ?? genreMeta.cover_url ?? null,
    }, coverOptions);
    const sharedUsage = await getSharedStoreUsage();

    res.json({
      ok: true,
      imported,
      totalPlaylists: imported.length,
      totalTracks,
      shared: {
        importedPlaylists: sharedIngest.imported.length,
        warnings: sharedIngest.warnings,
        usage: sharedUsage,
      },
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
    const hasPaging = typeof req.query.limit !== 'undefined' || typeof req.query.offset !== 'undefined';
    if (hasPaging) {
      const parsedLimit = parseInt(String(req.query.limit ?? '120'), 10);
      const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 300)) : 120;
      const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
      const page = await getStoredUserPlaylistTracksPage(identity, playlistId, limit, offset);
      if (!page) return res.status(404).json({ error: 'Playlist niet gevonden' });
      return res.json({
        items: page.items,
        paging: {
          total: page.total,
          limit: page.limit,
          offset: page.offset,
          hasMore: page.hasMore,
        },
      });
    }

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

app.get('/api/shared-playlists', async (req, res) => {
  const parsedLimit = parseInt(String(req.query.limit ?? '100'), 10);
  const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 250)) : 100;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  try {
    const [items, usage] = await Promise.all([
      listSharedPlaylists(limit, offset),
      getSharedStoreUsage(),
    ]);
    res.json({
      items,
      usage,
      paging: { limit, offset },
    });
  } catch (err) {
    console.error('[rest] /api/shared-playlists GET error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.post('/api/shared-playlists/import', upload.any(), async (req, res) => {
  const uploaded = Array.isArray(req.files) ? req.files : [];
  if (uploaded.length === 0) {
    return res.status(400).json({ error: 'Bestand ontbreekt (field: file/files)' });
  }
  const onlyCsv = uploaded.every((file) => extname(file.originalname ?? '').toLowerCase() === '.csv');
  if (!onlyCsv) {
    return res.status(400).json({ error: 'Alleen .csv bestanden zijn toegestaan voor gedeelde import' });
  }
  const requestedName = getSharedPlaylistNameFromRequest(req);
  if (!requestedName) {
    return res.status(400).json({ error: 'playlist_name is verplicht' });
  }
  const identity = getUserIdentityFromRequest(req);
  try {
    const genreMeta = getPlaylistGenreMetaFromRequest(req);
    const coverOptions = getPlaylistCoverOptionsFromRequest(req);
    const mergedTracks: Array<{
      title: string;
      artist: string;
      album: string | null;
      spotifyUrl: string | null;
    }> = [];
    const seenKeys = new Set<string>();
    const normalizeDedupe = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

    for (const file of uploaded) {
      const parsed = parseExportifyUpload(file.originalname ?? 'import.csv', file.buffer, {
        maxPlaylists: 1,
        maxTracksPerPlaylist: USER_PLAYLIST_MAX_TRACKS_PER_IMPORT,
      }).filter((playlist) => playlist.tracks.length > 0);
      for (const playlist of parsed) {
        for (const track of playlist.tracks) {
          const dedupeKey = `${normalizeDedupe(track.artist)}|${normalizeDedupe(track.title)}`;
          if (seenKeys.has(dedupeKey)) continue;
          seenKeys.add(dedupeKey);
          mergedTracks.push({
            title: track.title,
            artist: track.artist,
            album: track.album,
            spotifyUrl: track.spotifyUrl,
          });
        }
      }
    }

    if (mergedTracks.length === 0) {
      return res.status(400).json({ error: 'Geen geldige tracks gevonden in CSV' });
    }
    const trackInputs = mergedTracks.map((track, index) => ({
      title: track.title.slice(0, 300),
      artist: track.artist.slice(0, 300),
      album: track.album?.slice(0, 300) ?? null,
      spotify_url: track.spotifyUrl?.slice(0, 600) ?? null,
      position: index + 1,
    }));
    const result = await ingestSharedPlaylist(trackInputs, {
      name: requestedName,
      source: 'exportify-shared-upload',
      addedBy: identity?.nickname ?? null,
      genreMeta: {
        ...genreMeta,
        cover_url: await resolvePlaylistCoverUrlFromTracks(
          trackInputs,
          coverOptions.coverUrl ?? genreMeta.cover_url ?? null,
          coverOptions.autoCover,
        ),
      },
    }, getSharedStoreLimits());
    if (!result.imported || !result.playlistId) {
      return res.status(400).json({ error: result.reason ?? 'Import mislukt' });
    }
    const usage = await getSharedStoreUsage();
    return res.json({
      ok: true,
      playlist: {
        id: result.playlistId,
        name: result.name,
        trackCount: result.trackCount,
      },
      usage,
    });
  } catch (err) {
    console.error('[rest] /api/shared-playlists/import error:', err);
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.post('/api/shared-playlists/:id/import', upload.any(), async (req, res) => {
  const token = getAdminTokenFromRequest(req);
  if (!isAdmin(token ?? undefined)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const playlistId = String(req.params.id ?? '').trim();
  if (!playlistId) {
    return res.status(400).json({ error: 'Playlist id ontbreekt' });
  }
  const uploaded = Array.isArray(req.files) ? req.files : [];
  if (uploaded.length === 0) {
    return res.status(400).json({ error: 'Bestand ontbreekt (field: file/files)' });
  }
  const onlyCsv = uploaded.every((file) => extname(file.originalname ?? '').toLowerCase() === '.csv');
  if (!onlyCsv) {
    return res.status(400).json({ error: 'Alleen .csv bestanden zijn toegestaan voor gedeelde import' });
  }
  try {
    const mergedTracks: Array<{
      title: string;
      artist: string;
      album: string | null;
      spotifyUrl: string | null;
    }> = [];
    const seenKeys = new Set<string>();
    const normalizeDedupe = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const file of uploaded) {
      const parsed = parseExportifyUpload(file.originalname ?? 'import.csv', file.buffer, {
        maxPlaylists: 1,
        maxTracksPerPlaylist: USER_PLAYLIST_MAX_TRACKS_PER_IMPORT,
      }).filter((playlist) => playlist.tracks.length > 0);
      for (const playlist of parsed) {
        for (const track of playlist.tracks) {
          const dedupeKey = `${normalizeDedupe(track.artist)}|${normalizeDedupe(track.title)}`;
          if (seenKeys.has(dedupeKey)) continue;
          seenKeys.add(dedupeKey);
          mergedTracks.push({
            title: track.title,
            artist: track.artist,
            album: track.album,
            spotifyUrl: track.spotifyUrl,
          });
        }
      }
    }
    if (mergedTracks.length === 0) {
      return res.status(400).json({ error: 'Geen geldige tracks gevonden in CSV' });
    }
    const trackInputs = mergedTracks.map((track, index) => ({
      title: track.title.slice(0, 300),
      artist: track.artist.slice(0, 300),
      album: track.album?.slice(0, 300) ?? null,
      spotify_url: track.spotifyUrl?.slice(0, 600) ?? null,
      position: index + 1,
    }));
    const updated = await appendTracksToSharedPlaylist(playlistId, trackInputs, getSharedStoreLimits());
    if (!updated) return res.status(404).json({ error: 'Playlist niet gevonden' });
    const usage = await getSharedStoreUsage();
    return res.json({ ok: true, playlist: updated, usage });
  } catch (err) {
    console.error('[rest] /api/shared-playlists/:id/import error:', err);
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.get('/api/shared-playlists/:id/tracks', async (req, res) => {
  const playlistId = String(req.params.id ?? '').trim();
  if (!playlistId) {
    return res.status(400).json({ error: 'Playlist id ontbreekt' });
  }
  try {
    const hasPaging = typeof req.query.limit !== 'undefined' || typeof req.query.offset !== 'undefined';
    if (hasPaging) {
      const parsedLimit = parseInt(String(req.query.limit ?? '120'), 10);
      const parsedOffset = parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 300)) : 120;
      const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
      const page = await getSharedPlaylistTracksPage(playlistId, limit, offset);
      if (!page) return res.status(404).json({ error: 'Playlist niet gevonden' });
      return res.json({
        items: page.items,
        paging: {
          total: page.total,
          limit: page.limit,
          offset: page.offset,
          hasMore: page.hasMore,
        },
      });
    }

    const tracks = await getSharedPlaylistTracks(playlistId);
    if (!tracks) return res.status(404).json({ error: 'Playlist niet gevonden' });
    res.json(tracks);
  } catch (err) {
    console.error('[rest] /api/shared-playlists/:id/tracks error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.put('/api/shared-playlists/:id', async (req, res) => {
  const token = getAdminTokenFromRequest(req);
  if (!isAdmin(token ?? undefined)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const playlistId = String(req.params.id ?? '').trim();
  if (!playlistId) {
    return res.status(400).json({ error: 'Playlist id ontbreekt' });
  }
  const nextName = getSharedPlaylistNameFromRequest(req);
  const nextMeta = getPlaylistGenreMetaFromRequest(req);
  const coverOptions = getPlaylistCoverOptionsFromRequest(req);
  try {
    let updated: Awaited<ReturnType<typeof updateSharedPlaylistName>> = null;
    if (nextName) {
      updated = await updateSharedPlaylistName(playlistId, nextName);
      if (!updated) return res.status(404).json({ error: 'Playlist niet gevonden' });
    }
    const wantsMetaUpdate = req.body && typeof req.body === 'object'
      && (
        Object.prototype.hasOwnProperty.call(req.body, 'genre_group')
        || Object.prototype.hasOwnProperty.call(req.body, 'genreGroup')
        || Object.prototype.hasOwnProperty.call(req.body, 'subgenre')
        || Object.prototype.hasOwnProperty.call(req.body, 'subGenre')
        || Object.prototype.hasOwnProperty.call(req.body, 'related_parent_playlist_id')
        || Object.prototype.hasOwnProperty.call(req.body, 'relatedParentPlaylistId')
        || Object.prototype.hasOwnProperty.call(req.body, 'related_playlist_id')
        || Object.prototype.hasOwnProperty.call(req.body, 'cover_url')
        || Object.prototype.hasOwnProperty.call(req.body, 'coverUrl')
        || Object.prototype.hasOwnProperty.call(req.body, 'cover')
        || Object.prototype.hasOwnProperty.call(req.body, 'auto_cover')
        || Object.prototype.hasOwnProperty.call(req.body, 'autoCover')
      );
    if (wantsMetaUpdate) {
      const hasCoverField = req.body && typeof req.body === 'object'
        && (
          Object.prototype.hasOwnProperty.call(req.body, 'cover_url')
          || Object.prototype.hasOwnProperty.call(req.body, 'coverUrl')
          || Object.prototype.hasOwnProperty.call(req.body, 'cover')
        );
      const hasExplicitCover = !!(coverOptions.coverUrl ?? nextMeta.cover_url);
      let resolvedCover = coverOptions.coverUrl ?? nextMeta.cover_url ?? null;
      const hasAutoCoverFlag = req.body && typeof req.body === 'object'
        && (
          Object.prototype.hasOwnProperty.call(req.body, 'auto_cover')
          || Object.prototype.hasOwnProperty.call(req.body, 'autoCover')
        );
      if (!hasExplicitCover && hasAutoCoverFlag && coverOptions.autoCover) {
        const tracks = await getSharedPlaylistTracks(playlistId);
        if (tracks) {
          resolvedCover = await resolvePlaylistCoverUrlFromTracks(
            tracks,
            null,
            true,
          );
        }
      } else if (!hasCoverField && !hasAutoCoverFlag) {
        if (!updated) {
          updated = await getSharedPlaylistSummaryById(playlistId);
        }
        resolvedCover = updated?.cover_url ?? null;
      }
      const metaUpdated = await updateSharedPlaylistGenreMeta(playlistId, {
        ...nextMeta,
        cover_url: resolvedCover ?? null,
      });
      if (!metaUpdated) return res.status(404).json({ error: 'Playlist niet gevonden' });
      updated = metaUpdated;
    }
    if (!updated) {
      return res.status(400).json({ error: 'Geef minstens playlist_name, cover of genre/subgenre mee' });
    }
    return res.json({ ok: true, playlist: updated });
  } catch (err) {
    console.error('[rest] /api/shared-playlists/:id PUT error:', err);
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.delete('/api/shared-playlists/:id', async (req, res) => {
  const token = getAdminTokenFromRequest(req);
  if (!isAdmin(token ?? undefined)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const playlistId = String(req.params.id ?? '').trim();
  if (!playlistId) {
    return res.status(400).json({ error: 'Playlist id ontbreekt' });
  }
  try {
    const deleted = await deleteSharedPlaylist(playlistId);
    if (!deleted) return res.status(404).json({ error: 'Playlist niet gevonden' });
    const usage = await getSharedStoreUsage();
    return res.json({ ok: true, usage });
  } catch (err) {
    console.error('[rest] /api/shared-playlists/:id DELETE error:', err);
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.delete('/api/shared-playlists/:id/tracks/:trackId', async (req, res) => {
  const token = getAdminTokenFromRequest(req);
  if (!isAdmin(token ?? undefined)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const playlistId = String(req.params.id ?? '').trim();
  const trackId = String(req.params.trackId ?? '').trim();
  if (!playlistId || !trackId) {
    return res.status(400).json({ error: 'Playlist id en track id zijn verplicht' });
  }
  try {
    const updated = await deleteSharedPlaylistTrack(playlistId, trackId);
    if (!updated) return res.status(404).json({ error: 'Playlist of track niet gevonden' });
    const usage = await getSharedStoreUsage();
    return res.json({ ok: true, playlist: updated, usage });
  } catch (err) {
    console.error('[rest] /api/shared-playlists/:id/tracks/:trackId DELETE error:', err);
    return res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.post('/api/shared-playlists/refresh-inbox', async (req, res) => {
  const token = getAdminTokenFromRequest(req);
  if (!isAdmin(token ?? undefined)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runSharedInboxImportJob('manual');
    const usage = await getSharedStoreUsage();
    res.json({
      ok: true,
      ...result,
      usage,
    });
  } catch (err) {
    console.error('[rest] /api/shared-playlists/refresh-inbox error:', err);
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

app.get('/api/spotify/oembed', async (req, res) => {
  const rawUrl = String(req.query.url ?? '').trim();
  const spotifyUrl = normalizeSpotifyTrackUrl(rawUrl);
  if (!spotifyUrl) {
    return res.status(400).json({ error: 'Ongeldige Spotify track URL' });
  }

  try {
    const result = await fetchSpotifyOembedMeta(spotifyUrl);
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
  const current = getCurrentTrack();
  if (!current || !current.title) {
    return res.status(409).json({ error: 'Er speelt geen track om te liken' });
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
    const currentAutoGenre = parseAutoFallbackGenreId(current.selection_key ?? null);
    const canApplyOnlineAutoRule = current.youtube_id === 'local'
      && current.selection_tab === 'online'
      && !!currentAutoGenre;
    const artistRule = canApplyOnlineAutoRule
      ? addPriorityArtistForGenre(currentAutoGenre!, artist, currentAutoGenre!)
      : null;
    if (canApplyOnlineAutoRule) {
      addPriorityTrackForGenre(currentAutoGenre!, title, currentAutoGenre!);
    }
    addLikedPlaylistTrack(`${artist} - ${title}`);
    clearGenreHitsCache();
    genreCache.clear();
    return res.json({
      ok: true,
      genre: canApplyOnlineAutoRule ? currentAutoGenre : null,
      artist,
      title,
      artistCount: artistRule?.priorityArtists?.length ?? 0,
      appliedTo: canApplyOnlineAutoRule ? 'online-auto-and-liked' : 'liked-only',
    });
  } catch (err) {
    console.error('[rest] /api/genre-curation/like-current error:', err);
    return res.status(500).json({ error: 'Kon like niet opslaan' });
  }
});

app.post('/api/genre-curation/dislike-current', async (req, res) => {
  const current = getCurrentTrack();
  if (!current || !current.title || current.youtube_id !== 'local' || current.selection_tab !== 'online') {
    return res.status(409).json({ error: 'Dislike kan alleen bij autoplay uit Online' });
  }
  const activeGenreId = await resolveActiveFallbackGenre();
  const currentAutoGenre = parseAutoFallbackGenreId(current.selection_key ?? null);
  const fallbackAutoGenre = parseAutoFallbackGenreId(activeGenreId);
  const autoGenre = currentAutoGenre ?? fallbackAutoGenre;
  if (!autoGenre || autoGenre === LIKED_AUTO_GENRE_ID) {
    return res.status(409).json({ error: 'Dislike kan niet op deze autoplay bron' });
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
    evaluateIdlePlayback(mode as Mode);
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
      if (requested && !(await isKnownFallbackSelection(requested))) {
        return res.status(400).json({ error: 'Unknown fallback genre' });
      }
      const nextGenre = requested ?? getDefaultFallbackGenreId() ?? 'hardstyle';
      await setSetting(sb, key, nextGenre);
      await setSetting(sb, 'fallback_active_shared_playlist_ids', [nextGenre]);
      await setSetting(sb, 'fallback_active_genre_by', null);
      resetSharedAutoPlaybackCycleForSelection(nextGenre);
      setActiveFallbackGenre(nextGenre);
      setActiveFallbackGenres([nextGenre]);
      const sharedSingle = parseSharedFallbackPlaylistId(nextGenre) ? [nextGenre] : [];
      setActiveSharedFallbackPlaylists(sharedSingle);
      await emitFallbackGenreUpdate();
      console.log(`[rest] Setting updated: ${key}=${nextGenre ?? 'none'}`);
      return res.json({ ok: true });
    }
    if (key === 'fallback_shared_playback_mode') {
      const nextMode = normalizeSharedPlaybackMode(value);
      await setSetting(sb, key, nextMode);
      setSharedAutoPlaybackMode(nextMode);
      await emitFallbackGenreUpdate();
      console.log(`[rest] Setting updated: ${key}=${nextMode}`);
      return res.json({ ok: true });
    }
    if (key === 'jingle_enable') {
      const enabled = value !== false;
      await setSetting(sb, key, enabled);
      setJingleSettings({ enabled });
      const jingle = { ...getJingleSettings(), selectedKeys: getJingleSelection() };
      io.emit('settings:jingleChanged', jingle);
      console.log(`[rest] Setting updated: ${key}=${enabled}`);
      return res.json({ ok: true, jingle });
    }
    if (key === 'jingle_every_tracks') {
      const parsed = Math.max(1, Math.round(Number(value) || 4));
      await setSetting(sb, key, parsed);
      setJingleSettings({ everyTracks: parsed });
      const jingle = { ...getJingleSettings(), selectedKeys: getJingleSelection() };
      io.emit('settings:jingleChanged', jingle);
      console.log(`[rest] Setting updated: ${key}=${parsed}`);
      return res.json({ ok: true, jingle });
    }
    if (key === 'jingle_selected_keys') {
      const selectedKeys = Array.isArray(value)
        ? value.map((entry) => String(entry))
        : [];
      await setSetting(sb, key, selectedKeys);
      setJingleSelection(selectedKeys);
      const jingle = { ...getJingleSettings(), selectedKeys: getJingleSelection() };
      io.emit('settings:jingleChanged', jingle);
      console.log(`[rest] Setting updated: ${key} (${selectedKeys.length} selected)`);
      return res.json({ ok: true, jingle });
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

app.get('/api/jingles', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!isAdmin(token)) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const catalog = await getJingleCatalog();
    const selected = new Set(getJingleSelection());
    const jingleSettings = getJingleSettings();
    const items = catalog.map((item) => ({
      ...item,
      selected: selected.size === 0 ? true : selected.has(item.key),
      enabled: jingleSettings.enabled,
    }));
    res.json({ items, selectedKeys: Array.from(selected), everyTracks: jingleSettings.everyTracks, enabled: jingleSettings.enabled });
  } catch (err) {
    console.error('[rest] jingles list error:', err);
    res.status(500).json({ error: 'Failed to list jingles' });
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

app.post('/api/downloads/resolve', async (req, res) => {
  const {
    title,
    artist,
    source_type,
    source_playlist,
    source_genre,
    spotify_url,
  } = (req.body ?? {}) as {
    title?: unknown;
    artist?: unknown;
    source_type?: unknown;
    source_playlist?: unknown;
    source_genre?: unknown;
    spotify_url?: unknown;
  };
  const safeTitle = String(title ?? '').trim();
  const safeArtist = String(artist ?? '').trim();
  const safeSpotifyUrl = String(spotify_url ?? '').trim();
  if (!safeTitle && !safeSpotifyUrl) {
    return res.status(400).json({ error: 'title of spotify_url is verplicht' });
  }
  const submissionUrl = safeSpotifyUrl || (safeArtist ? `${safeArtist} - ${safeTitle}` : safeTitle);
  const submission: QueueAddSubmission = {
    youtube_url: submissionUrl,
    title: safeTitle || null,
    artist: safeArtist || null,
    source_type: String(source_type ?? 'shared_playlist').trim() || 'shared_playlist',
    source_playlist: String(source_playlist ?? '').trim() || null,
    source_genre: String(source_genre ?? '').trim() || null,
  };

  try {
    const result = await addQueueItemFromSubmission(submission, 'overlay-download', { resolveOnly: true });
    if (!result.resolved) {
      return res.status(404).json({
        ok: false,
        error: result.error ?? 'Geen bruikbare match gevonden',
        candidates: result.manualCandidates ?? [],
      });
    }
    return res.json({
      ok: true,
      item: result.resolved,
      candidates: result.manualCandidates ?? [],
    });
  } catch (err) {
    console.warn('[rest] /api/downloads/resolve error:', getErrorMessage(err));
    return res.status(500).json({ ok: false, error: getErrorMessage(err) });
  }
});

app.get('/api/live-polls', async (_req, res) => {
  try {
    const { data: poll, error } = await sb
      .from('live_polls')
      .select('id,question,options,status,created_at')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!poll) return res.json({ poll: null });

    const { data: votes, error: votesErr } = await sb
      .from('live_poll_votes')
      .select('option_index')
      .eq('poll_id', poll.id);
    if (votesErr) return res.status(500).json({ error: votesErr.message });

    const options = Array.isArray(poll.options) ? poll.options.map((opt) => String(opt)) : [];
    const counts = new Array(options.length).fill(0);
    for (const row of votes ?? []) {
      const idx = Number((row as { option_index?: unknown }).option_index);
      if (Number.isFinite(idx) && idx >= 0 && idx < counts.length) counts[idx] += 1;
    }

    return res.json({
      poll: {
        ...poll,
        options,
        counts,
        totalVotes: counts.reduce((sum, value) => sum + value, 0),
      },
    });
  } catch (err) {
    console.error('[rest] /api/live-polls GET error:', err);
    return res.status(500).json({ error: 'Failed to fetch live poll' });
  }
});

app.post('/api/live-polls', async (req, res) => {
  if (!isAdmin(readAdminToken(req))) return res.status(403).json({ error: 'Unauthorized' });
  const question = String((req.body as { question?: unknown })?.question ?? '').trim();
  const optionsRaw = (req.body as { options?: unknown })?.options;
  const options = Array.isArray(optionsRaw)
    ? optionsRaw.map((opt) => String(opt ?? '').trim()).filter(Boolean)
    : [];
  if (!question || options.length < 2) {
    return res.status(400).json({ error: 'Question and at least 2 options are required' });
  }
  try {
    await sb
      .from('live_polls')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('status', 'active');

    const { data, error } = await sb
      .from('live_polls')
      .insert({
        question,
        options,
        status: 'active',
        created_by: 'dj',
      })
      .select('id,question,options,status,created_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ poll: data });
  } catch (err) {
    console.error('[rest] /api/live-polls POST error:', err);
    return res.status(500).json({ error: 'Failed to create live poll' });
  }
});

app.patch('/api/live-polls/:id', async (req, res) => {
  if (!isAdmin(readAdminToken(req))) return res.status(403).json({ error: 'Unauthorized' });
  const id = String(req.params.id ?? '').trim();
  const status = String((req.body as { status?: unknown })?.status ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Missing poll id' });
  if (status !== 'active' && status !== 'closed') {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const payload: Record<string, unknown> = { status };
    if (status === 'closed') payload.closed_at = new Date().toISOString();
    const { data, error } = await sb
      .from('live_polls')
      .update(payload)
      .eq('id', id)
      .select('id,question,options,status,created_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ poll: data });
  } catch (err) {
    console.error('[rest] /api/live-polls/:id PATCH error:', err);
    return res.status(500).json({ error: 'Failed to update poll' });
  }
});

app.get('/api/shoutouts', async (_req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await sb
      .from('shoutouts')
      .select('id,nickname,message,created_at,expires_at')
      .eq('active', true)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ shoutout: data ?? null });
  } catch (err) {
    console.error('[rest] /api/shoutouts GET error:', err);
    return res.status(500).json({ error: 'Failed to fetch shoutout' });
  }
});

app.post('/api/shoutouts', async (req, res) => {
  if (!isAdmin(readAdminToken(req))) return res.status(403).json({ error: 'Unauthorized' });
  const nickname = String((req.body as { nickname?: unknown })?.nickname ?? '').trim().slice(0, 40);
  const message = String((req.body as { message?: unknown })?.message ?? '').trim().slice(0, 140);
  const durationSecondsRaw = Number((req.body as { durationSeconds?: unknown })?.durationSeconds ?? 18);
  const durationSeconds = Math.max(8, Math.min(45, Number.isFinite(durationSecondsRaw) ? durationSecondsRaw : 18));
  if (!nickname || !message) {
    return res.status(400).json({ error: 'Nickname and message are required' });
  }
  try {
    await sb
      .from('shoutouts')
      .update({ active: false })
      .eq('active', true);

    const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
    const { data, error } = await sb
      .from('shoutouts')
      .insert({ nickname, message, active: true, expires_at: expiresAt })
      .select('id,nickname,message,created_at,expires_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ shoutout: data });
  } catch (err) {
    console.error('[rest] /api/shoutouts POST error:', err);
    return res.status(500).json({ error: 'Failed to create shoutout' });
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

function getSkipVoteEligibleListenerCount(): number {
  const activeWebListeners = new Set<string>();
  for (const [socketId, presence] of listenerPresenceBySocket.entries()) {
    if (!presence.listening) continue;
    const key = presence.nickname.trim().toLowerCase() || `socket:${socketId}`;
    activeWebListeners.add(key);
  }
  if (activeWebListeners.size > 0) return activeWebListeners.size;
  if (streamHub.listenerCount > 0) return streamHub.listenerCount;
  // Prevent phantom extra sockets from forcing unnecessary second votes.
  return Math.max(1, voteSkipSet.size);
}

async function emitSkipVoteState(): Promise<void> {
  if (voteSkipSet.size <= 0) {
    io.emit('vote:update', null);
    return;
  }

  const settings = await getModeSettings(sb);
  const threshold = settings.democracy_threshold / 100;
  const required = Math.max(1, Math.ceil(getSkipVoteEligibleListenerCount() * threshold));
  const timer = getSkipVoteTimerSeconds();

  // If the threshold is already met, skip immediately and avoid
  // briefly broadcasting a stale "more votes needed" vote state.
  if (voteSkipSet.size >= required && !isSkipLocked()) {
    console.log(`[vote] Threshold reached — skipping (votes=${voteSkipSet.size}, required=${required})`);
    resetVotes();
    io.emit('vote:update', null);
    skipCurrentTrack();
    markSkipTriggered();
    return;
  }

  io.emit('vote:update', {
    votes: voteSkipSet.size,
    required,
    timer,
  });
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

interface QueueAddSubmission {
  youtube_url: string;
  title?: string | null;
  artist?: string | null;
  thumbnail?: string | null;
  source_type?: string | null;
  source_genre?: string | null;
  source_playlist?: string | null;
}

type SubmissionCandidate = {
  row: SearchResult;
  provider: 'youtube' | 'soundcloud' | 'spotdl';
};

type SubmissionManualCandidate = {
  provider: 'youtube' | 'soundcloud' | 'spotdl';
  url: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
  score: number;
  reasons: string[];
};

type SubmissionResolvedResult = {
  url: string;
  title: string;
  artist: string | null;
  thumbnail: string | null;
  duration: number | null;
};

async function addQueueItemFromSubmission(
  submission: QueueAddSubmission,
  addedBy: string,
  options?: { resolveOnly?: boolean },
): Promise<{
  item: Awaited<ReturnType<typeof addToQueue>> | null;
  error: string | null;
  manualCandidates: SubmissionManualCandidate[] | null;
  resolved: SubmissionResolvedResult | null;
  selectionMeta: {
    selectionLabel: string | null;
    selectionPlaylist: string | null;
    selectionTab: 'queue' | 'online' | 'playlists' | null;
    selectionKey: string | null;
  } | null;
}> {
  const sourceType = (submission.source_type ?? '').trim().toLowerCase();
  const expectedArtist = (submission.artist ?? '').trim() || null;
  const expectedTitle = (submission.title ?? '').trim() || null;
  let url = submission.youtube_url;
  let sourceId = extractSourceId(url);
  let discoveredTitle: string | null = null;
  let discoveredArtist: string | null = null;

  if (!sourceId) {
    const strictMetadata = sourceType === 'spotify'
      || sourceType === 'user_playlist'
      || sourceType === 'shared_playlist';
    const searchLimit = sourceType === 'spotify' || sourceType === 'user_playlist' || sourceType === 'shared_playlist'
      ? 10
      : 4;
    const [youtubeResults, soundcloudResults] = await Promise.all([
      youtubeSearchLocal(url, searchLimit),
      soundcloudSearchLocal(url, searchLimit),
    ]);
    const searchResults: SubmissionCandidate[] = [
      ...youtubeResults.map((row) => ({ row, provider: 'youtube' as const })),
      ...soundcloudResults.map((row) => ({ row, provider: 'soundcloud' as const })),
    ];
    if (searchResults.length === 0) {
      return { item: null, error: `Geen resultaat gevonden voor "${url}"`, manualCandidates: null, resolved: null, selectionMeta: null };
    }
    const rankedStrict = searchResults
      .map((candidate) => ({
        ...candidate,
        evaluation: evaluateSearchResultForSubmission(
          { title: candidate.row.title, channel: candidate.row.channel, duration: candidate.row.duration ?? null },
          expectedArtist,
          expectedTitle,
          { strictMetadata, allowLiveFallback: false },
        ),
      }))
      .sort((a, b) => b.evaluation.score - a.evaluation.score);

    const ranked = rankedStrict
      .filter(({ evaluation }) => evaluation.score > -100)
      .sort((a, b) => b.evaluation.score - a.evaluation.score);

    let selectedCandidate: SubmissionCandidate | null = ranked[0]
      ? { row: ranked[0].row, provider: ranked[0].provider }
      : (strictMetadata ? null : searchResults[0]);
    let selectedByLiveFallback = false;
    let selectedBySemiStrict = false;

    if (!selectedCandidate && strictMetadata) {
      const semiStrict = searchResults
        .map((candidate) => ({
          ...candidate,
          evaluation: evaluateSearchResultForSubmission(
            { title: candidate.row.title, channel: candidate.row.channel, duration: candidate.row.duration ?? null },
            expectedArtist,
            expectedTitle,
            { strictMetadata: true, allowLiveFallback: false, matchMode: 'semi' },
          ),
        }))
        .filter(({ evaluation }) => evaluation.score > -100)
        .sort((a, b) => b.evaluation.score - a.evaluation.score);
      if (semiStrict[0]) {
        selectedCandidate = { row: semiStrict[0].row, provider: semiStrict[0].provider };
        selectedBySemiStrict = true;
        console.log(`[queue] Semi-strict fallback selected for "${submission.youtube_url}"`);
      }
    }

    if (!selectedCandidate && strictMetadata) {
      const liveFallback = searchResults
        .map((candidate) => ({
          ...candidate,
          evaluation: evaluateSearchResultForSubmission(
            { title: candidate.row.title, channel: candidate.row.channel, duration: candidate.row.duration ?? null },
            expectedArtist,
            expectedTitle,
            { strictMetadata: true, allowLiveFallback: true },
          ),
        }))
        .filter(({ evaluation }) => evaluation.score > -100 && evaluation.isLive)
        .sort((a, b) => b.evaluation.score - a.evaluation.score);
      if (liveFallback[0]) {
        selectedCandidate = { row: liveFallback[0].row, provider: liveFallback[0].provider };
        selectedByLiveFallback = true;
        console.log(`[queue] Live fallback selected for strict metadata: "${submission.youtube_url}"`);
      }
    }

    if (!selectedCandidate && strictMetadata) {
      const spotdlResults = await spotdlSearch({
        spotifyUrl: sourceType === 'spotify' ? submission.youtube_url : null,
        artist: expectedArtist,
        title: expectedTitle,
        query: submission.youtube_url,
      }, 4);
      if (spotdlResults.length > 0) {
        const spotdlRanked = spotdlResults
          .map((row) => ({
            row,
            provider: 'spotdl' as const,
            evaluation: evaluateSearchResultForSubmission(
              { title: row.title, channel: row.channel, duration: row.duration ?? null },
              expectedArtist,
              expectedTitle,
              { strictMetadata: true, allowLiveFallback: false },
            ),
          }))
          .filter(({ evaluation }) => evaluation.score > -100)
          .sort((a, b) => b.evaluation.score - a.evaluation.score);
        if (spotdlRanked[0]) {
          selectedCandidate = {
            provider: 'spotdl',
            row: {
              id: spotdlRanked[0].row.id || extractSourceId(spotdlRanked[0].row.url) || 'spotdl',
              title: spotdlRanked[0].row.title || expectedTitle || 'Onbekend',
              url: spotdlRanked[0].row.url,
              duration: spotdlRanked[0].row.duration,
              thumbnail: spotdlRanked[0].row.thumbnail ?? '',
              channel: spotdlRanked[0].row.channel ?? '',
            },
          };
          console.log(`[queue] spotDL fallback selected: ${selectedCandidate.row.title} (${selectedCandidate.row.url})`);
        }
      }
    }

    if (!selectedCandidate) {
      const diagnostics = rankedStrict.slice(0, 5).map(({ row, provider, evaluation }) => ({
        title: row.title,
        channel: row.channel,
        provider,
        score: evaluation.score,
        reasons: evaluation.reasons.join('|') || 'none',
      }));
      recordMissingTrackLookup({
        source: 'queue_add',
        query: submission.youtube_url,
        strictMetadata,
        expectedArtist,
        expectedTitle,
        providerCandidates: searchResults.length,
        diagnostics,
      });
      console.warn(`[queue] No usable result for "${submission.youtube_url}" strict=${strictMetadata} candidates=${searchResults.length} diagnostics=${JSON.stringify(diagnostics)}`);
      const canPromptManualPick =
        sourceType === 'spotify'
        || sourceType === 'user_playlist'
        || sourceType === 'shared_playlist';
      const manualCandidates: SubmissionManualCandidate[] | null = canPromptManualPick
        ? rankedStrict
          .slice(0, 8)
          .map(({ row, provider, evaluation }) => ({
            provider,
            url: row.url,
            title: row.title ?? 'Onbekend',
            channel: row.channel ?? '',
            duration: row.duration ?? null,
            thumbnail: row.thumbnail ?? null,
            score: evaluation.score,
            reasons: evaluation.reasons,
          }))
          .filter((entry) => !!entry.url && !!entry.title)
        : null;
      return {
        item: null,
        error: `Geen bruikbaar resultaat gevonden voor "${url}"`,
        manualCandidates: manualCandidates && manualCandidates.length > 0 ? manualCandidates : null,
        resolved: null,
        selectionMeta: null,
      };
    }
    const selectedRow = selectedCandidate.row;
    url = selectedRow.url;
    sourceId = extractSourceId(url);
    if (!sourceId) {
      return { item: null, error: 'Kon geen geldig nummer vinden', manualCandidates: null, resolved: null, selectionMeta: null };
    }
    discoveredTitle = selectedRow.title ?? null;
    discoveredArtist = selectedRow.channel ?? null;
    const providerTag = selectedByLiveFallback
      ? `${selectedCandidate.provider}:live-fallback`
      : selectedBySemiStrict
        ? `${selectedCandidate.provider}:semi-strict`
      : selectedCandidate.provider;
    console.log(`[queue] Search "${submission.youtube_url}" → ${selectedRow.title} (${url}) [provider=${providerTag}]`);
  }

  const ytId = extractYoutubeId(url);
  const thumbnail = submission.thumbnail ?? (ytId ? getThumbnailUrl(ytId) : null);
  const isLocalSelection = url.startsWith('local://');
  const info = isLocalSelection
    ? { title: null, duration: null, thumbnail: null }
    : await fetchVideoInfo(url);

  if (info.duration !== null && info.duration > MAX_DURATION) {
    return {
      item: null,
      error: `Dit nummer is te lang (${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, '0')}). Maximum is 65 minuten.`,
      manualCandidates: null,
      resolved: null,
      selectionMeta: null,
    };
  }

  const thumbForQueue = thumbnail ?? info.thumbnail;
  const submittedTitle = expectedTitle;
  const submittedArtist = expectedArtist;
  const preferSubmittedArtistTitle =
    sourceType === 'spotify'
    || sourceType === 'user_playlist'
    || sourceType === 'shared_playlist';
  const submittedCombinedTitle =
    submittedArtist && submittedTitle
      ? `${submittedArtist} - ${submittedTitle}`
      : null;
  const playlistCombinedFallback =
    submittedArtist
      ? `${submittedArtist} - ${submittedTitle ?? discoveredTitle ?? info.title ?? sourceId}`
      : null;
  const discoveredCombinedTitle =
    discoveredArtist && discoveredTitle
      ? `${discoveredArtist} - ${discoveredTitle}`
      : null;

  const mergedTitle = preferSubmittedArtistTitle
    ? (
      submittedCombinedTitle
      ?? playlistCombinedFallback
      ?? submittedTitle
      ?? info.title
      ?? discoveredCombinedTitle
      ?? discoveredTitle
      ?? sourceId
    )
    : (
      info.title
      ?? submittedCombinedTitle
      ?? submittedTitle
      ?? discoveredCombinedTitle
      ?? discoveredTitle
      ?? sourceId
    );

  const resolved: SubmissionResolvedResult = {
    url,
    title: mergedTitle,
    artist: submittedArtist ?? discoveredArtist ?? null,
    thumbnail: thumbForQueue ?? null,
    duration: info.duration ?? null,
  };
  if (options?.resolveOnly) {
    return {
      item: null,
      error: null,
      manualCandidates: null,
      resolved,
      selectionMeta: null,
    };
  }
  const item = await addToQueue(sb, url, addedBy, mergedTitle, thumbForQueue);
  const sourceTypeNorm = (submission.source_type ?? '').trim().toLowerCase();
  const sourcePlaylistNorm = (submission.source_playlist ?? '').trim() || null;
  const sourceGenreNorm = (submission.source_genre ?? '').trim() || null;
  const fromPlaylist = sourceTypeNorm === 'shared_playlist' || sourceTypeNorm === 'user_playlist' || !!sourcePlaylistNorm;
  const sourceLabel = fromPlaylist
    ? 'Wachtrij vanuit playlist'
    : sourceTypeNorm === 'spotify'
      ? 'Wachtrij via Spotify'
      : 'Wachtrij';
  const selectionMeta = {
    selectionLabel: sourceLabel,
    selectionPlaylist: sourcePlaylistNorm,
    selectionTab: (fromPlaylist
      ? 'playlists'
      : sourceTypeNorm === 'spotify'
        ? 'online'
        : 'queue') as 'queue' | 'online' | 'playlists',
    selectionKey: sourceGenreNorm,
  };
  return { item, error: null, manualCandidates: null, resolved, selectionMeta };
}

async function promoteOneDeferredQueueItem(reason: 'track-ended' | 'manual'): Promise<void> {
  const next = popDeferredQueueItemRoundRobin();
  if (!next) return;

  const { addedBy, item } = next;
  try {
    const { item: created, error, selectionMeta } = await addQueueItemFromSubmission(item, addedBy);
    if (!created) {
      io.emit('info:toast', { message: `Uitgestelde aanvraag van ${addedBy} kon niet worden toegevoegd: ${error ?? 'onbekende fout'}` });
      return;
    }
    setQueueItemSelectionMeta(created.id, selectionMeta);
    const queue = await getQueue(sb);
    io.emit('queue:added', { id: created.id, title: created.title ?? created.youtube_id, added_by: created.added_by ?? addedBy });
    io.emit('queue:update', { items: queue });
    io.emit('info:toast', { message: `Uit eigen wachtrij toegevoegd: ${created.title ?? created.youtube_id}` });
    playerEvents.emit('queue:add');
    console.log(`[queue] Promoted deferred (${reason}): ${created.youtube_id} by ${addedBy}`);
  } catch (err) {
    console.error('[queue] Failed to promote deferred item:', err);
    io.emit('info:toast', { message: `Uitgestelde aanvraag van ${addedBy} kon niet worden toegevoegd.` });
  }
}

// ── Socket.io Events ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[socket] Client connected: ${socket.id}`);
  listenerPresenceBySocket.set(socket.id, {
    nickname: '',
    listening: false,
    updatedAt: Date.now(),
  });
  getActiveMode(sb).then((mode) => evaluateIdlePlayback(mode)).catch(() => {});
  emitStreamStatus();
  void emitSkipVoteState();
  socket.emit('upcoming:update', getUpcomingTrack());
  void emitFallbackGenreUpdate(socket);
  emitFallbackPresetUpdate(socket);
  if (activeQueuePushVote) socket.emit('queuePushVote:update', activeQueuePushVote);
  else socket.emit('queuePushVote:end', null);
  socket.emit('queuePush:lock', { locked: queuePushLocked });
  socket.emit('skip:lock', { locked: isSkipLocked() });

  // ── auth:verify ──
  socket.on('auth:verify', (data: { token: string }, callback?: (valid: boolean) => void) => {
    const valid = isAdmin(data.token);
    if (typeof callback === 'function') callback(valid);
  });

  socket.on('listener:state', (data: { nickname?: string; listening?: boolean }) => {
    const prev = listenerPresenceBySocket.get(socket.id);
    const nickname = normalizeNickname(data?.nickname) ?? prev?.nickname ?? '';
    const listening = !!data?.listening;
    listenerPresenceBySocket.set(socket.id, {
      nickname,
      listening,
      updatedAt: Date.now(),
    });
    emitStreamStatus();
    getActiveMode(sb).then((mode) => evaluateIdlePlayback(mode)).catch(() => {});
    void emitSkipVoteState();
  });

  // ── queue:add ──
  socket.on('queue:add', async (data: {
    youtube_url: string;
    added_by: string;
    token?: string;
    thumbnail?: string;
    title?: string;
    artist?: string;
    source_type?: string;
    source_genre?: string;
    source_playlist?: string;
  }, ack?: (payload: {
    ok: boolean;
    status?: 'added' | 'manual_select';
    error?: string;
    message?: string;
    candidates?: Array<{
      provider: 'youtube' | 'soundcloud' | 'spotdl';
      url: string;
      title: string;
      channel: string;
      duration: number | null;
      thumbnail: string | null;
      score: number;
      reasons: string[];
    }>;
  }) => void) => {
    try {
      const mode = await getActiveMode(sb);
      const admin = isAdmin(data.token);
      if (!canPerformAction(mode, 'add_to_queue', admin)) {
        socket.emit('error:toast', { message: 'Je mag geen nummers toevoegen in deze modus' });
        ack?.({ ok: false, error: 'Je mag geen nummers toevoegen in deze modus' });
        return;
      }
      const addedBy = normalizeQueueUser(data.added_by);
      setSocketNickname(socket.id, addedBy);
      const submission: QueueAddSubmission = {
        youtube_url: data.youtube_url,
        title: data.title ?? null,
        artist: data.artist ?? null,
        thumbnail: data.thumbnail ?? null,
        source_type: (data.source_type ?? '').trim() || null,
        source_genre: (data.source_genre ?? '').trim() || null,
        source_playlist: (data.source_playlist ?? '').trim() || null,
      };
      if (!admin) {
        const [modeSettings, queueSnapshot] = await Promise.all([
          getModeSettings(sb),
          getQueue(sb),
        ]);
        const listenerCount = getEffectiveListenerCount();
        const dynamicLimit = getDynamicQueueLimitForMode(mode, listenerCount, modeSettings);
        const queuedByUser = queueSnapshot.filter((entry) => (entry.added_by ?? '').trim() === addedBy).length;
        if (queuedByUser >= dynamicLimit) {
          const deferredItem = makeDeferredQueueItem(submission);
          const deferredTotal = pushDeferredQueueItem(addedBy, deferredItem);
          void recordRequestEvent({
            added_by: addedBy,
            title: submission.title ?? submission.youtube_url ?? null,
            artist: submission.artist ?? null,
            source_type: submission.source_type ?? 'deferred',
            source_genre: submission.source_genre ?? null,
            source_playlist: submission.source_playlist ?? null,
          });
          socket.emit('info:toast', {
            message: `Hoofdwachtrij vol (${queuedByUser}/${dynamicLimit}). Toegevoegd aan je eigen wachtrij (${deferredTotal}).`,
          });
          ack?.({ ok: true, status: 'added' });
          return;
        }
      }

      const { item, error, manualCandidates, selectionMeta } = await addQueueItemFromSubmission(submission, addedBy);
      if (!item) {
        if (manualCandidates && manualCandidates.length > 0) {
          ack?.({
            ok: true,
            status: 'manual_select',
            message: 'Geen exacte match gevonden. Kies handmatig een resultaat.',
            candidates: manualCandidates,
          });
        } else {
          socket.emit('error:toast', { message: error ?? 'Kon nummer niet toevoegen' });
          ack?.({ ok: false, error: error ?? 'Kon nummer niet toevoegen' });
        }
        return;
      }
      setQueueItemSelectionMeta(item.id, selectionMeta);
      const queue = await getQueue(sb);
      io.emit('queue:added', { id: item.id, title: item.title ?? item.youtube_id, added_by: item.added_by ?? addedBy ?? 'onbekend' });
      io.emit('queue:update', { items: queue });
      void recordRequestEvent({
        added_by: addedBy,
        title: item.title ?? null,
        artist: submission.artist ?? null,
        source_type: submission.source_type ?? null,
        source_genre: submission.source_genre ?? null,
        source_playlist: submission.source_playlist ?? null,
      });
      playerEvents.emit('queue:add');
      console.log(`[queue] Added: ${item.youtube_id} by ${addedBy}`);
      ack?.({ ok: true, status: 'added' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Kon nummer niet toevoegen';
      socket.emit('error:toast', { message: msg });
      ack?.({ ok: false, error: msg });
    }
  });

  socket.on('deferredQueue:sync', (data: { added_by?: string }) => {
    const addedBy = normalizeQueueUser(data?.added_by);
    setSocketNickname(socket.id, addedBy);
  });

  socket.on('deferredQueue:remove', (data: { id?: string; added_by?: string; token?: string }) => {
    const addedBy = normalizeQueueUser(data?.added_by);
    const itemId = String(data?.id ?? '').trim();
    if (!itemId) {
      socket.emit('error:toast', { message: 'Onbekend item in eigen wachtrij' });
      return;
    }
    if (!isAdmin(data?.token) && socketNicknameById.get(socket.id) !== addedBy) {
      socket.emit('error:toast', { message: 'Je mag alleen je eigen wachtrij aanpassen' });
      return;
    }
    const removed = removeDeferredQueueItem(addedBy, itemId);
    if (!removed) {
      socket.emit('error:toast', { message: 'Item niet gevonden in eigen wachtrij' });
      return;
    }
    socket.emit('info:toast', { message: 'Nummer verwijderd uit eigen wachtrij' });
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
    const totalClients = getEffectiveListenerCount();
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
      const required = Math.max(1, Math.ceil(getEffectiveListenerCount() * (settings.democracy_threshold / 100)));
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
      const currentPresence = listenerPresenceBySocket.get(socket.id);
      if (currentPresence && !currentPresence.listening) {
        listenerPresenceBySocket.set(socket.id, {
          ...currentPresence,
          listening: true,
          updatedAt: Date.now(),
        });
      }
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
      evaluateIdlePlayback(data.mode as Mode);
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
        if (requested && !(await isKnownFallbackSelection(requested))) {
          socket.emit('error:toast', { message: 'Onbekend fallback genre' });
          return;
        }
        const nextGenre = requested ?? getDefaultFallbackGenreId();
        await setSetting(sb, data.key, nextGenre);
        await setSetting(sb, 'fallback_active_genre_by', null);
        resetSharedAutoPlaybackCycleForSelection(nextGenre);
        setActiveFallbackGenre(nextGenre);
        await emitFallbackGenreUpdate();
        console.log(`[settings] Updated: ${data.key}=${nextGenre ?? 'none'}`);
        return;
      }
      if (data.key === 'fallback_shared_playback_mode') {
        const nextMode = normalizeSharedPlaybackMode(data.value);
        await setSetting(sb, data.key, nextMode);
        setSharedAutoPlaybackMode(nextMode);
        await emitFallbackGenreUpdate();
        console.log(`[settings] Updated: ${data.key}=${nextMode}`);
        return;
      }
      if (data.key === 'jingle_enable') {
        const enabled = data.value !== false;
        await setSetting(sb, data.key, enabled);
        setJingleSettings({ enabled });
        io.emit('settings:jingleChanged', { ...getJingleSettings(), selectedKeys: getJingleSelection() });
        console.log(`[settings] Updated: ${data.key}=${enabled}`);
        return;
      }
      if (data.key === 'jingle_every_tracks') {
        const parsed = Math.max(1, Math.round(Number(data.value) || 4));
        await setSetting(sb, data.key, parsed);
        setJingleSettings({ everyTracks: parsed });
        io.emit('settings:jingleChanged', { ...getJingleSettings(), selectedKeys: getJingleSelection() });
        console.log(`[settings] Updated: ${data.key}=${parsed}`);
        return;
      }
      if (data.key === 'jingle_selected_keys') {
        const selectedKeys = Array.isArray(data.value)
          ? data.value.map((entry) => String(entry))
          : [];
        await setSetting(sb, data.key, selectedKeys);
        setJingleSelection(selectedKeys);
        io.emit('settings:jingleChanged', { ...getJingleSettings(), selectedKeys: getJingleSelection() });
        console.log(`[settings] Updated: ${data.key} (${selectedKeys.length} selected)`);
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
  socket.on('fallback:presets:get', () => {
    emitFallbackPresetUpdate(socket);
  });

  socket.on('fallback:preset:save', (data: {
    name?: string;
    genreIds?: string[];
    sharedPlaybackMode?: string;
    selectedBy?: string;
  }) => {
    const name = String(data?.name ?? '').trim();
    const genreIds = Array.isArray(data?.genreIds) ? data.genreIds.map((entry) => String(entry)) : [];
    const selectedBy = normalizeNickname(data?.selectedBy) ?? 'onbekend';
    const sharedMode = normalizeSharedPlaybackMode(data?.sharedPlaybackMode);
    const saved = saveFallbackPreset({
      name,
      genreIds,
      sharedPlaybackMode: sharedMode,
      createdBy: selectedBy,
    });
    if (!saved) {
      socket.emit('error:toast', { message: 'Kon preset niet opslaan' });
      return;
    }
    emitFallbackPresetUpdate();
    socket.emit('info:toast', { message: `Preset opgeslagen: ${saved.name}` });
  });

  socket.on('fallback:preset:apply', async (data: { id?: string; selectedBy?: string }) => {
    const presetId = String(data?.id ?? '').trim();
    const preset = getFallbackPreset(presetId);
    if (!preset || preset.genreIds.length === 0) {
      socket.emit('error:toast', { message: 'Preset niet gevonden' });
      return;
    }
    const selectedBy = normalizeNickname(data?.selectedBy) ?? 'onbekend';
    try {
      const requestedList = await normalizeFallbackGenreIds(preset.genreIds);
      const requested = requestedList[0] ?? null;
      if (!requested) {
        socket.emit('error:toast', { message: 'Preset bevat geen geldige bronnen' });
        return;
      }
      await setSetting(sb, 'fallback_active_genre', requested);
      await setSetting(sb, 'fallback_active_shared_playlist_ids', requestedList);
      await setSetting(sb, 'fallback_active_genre_by', selectedBy);
      await setSetting(sb, 'fallback_shared_playback_mode', preset.sharedPlaybackMode);
      setSharedAutoPlaybackMode(preset.sharedPlaybackMode);
      resetSharedAutoPlaybackCycleForSelection(requested);
      setActiveFallbackGenre(requested);
      setActiveFallbackGenres(requestedList);
      setActiveSharedFallbackPlaylists(requestedList.filter((id) => !!parseSharedFallbackPlaylistId(id)));
      await emitFallbackGenreUpdate();
      socket.emit('info:toast', { message: `Preset actief: ${preset.name}` });
    } catch (err) {
      console.error('[socket] fallback:preset:apply error:', err);
      socket.emit('error:toast', { message: 'Preset toepassen mislukt' });
    }
  });

  socket.on('fallback:genre:set', async (data: { genreId?: string; genreIds?: string[]; selectedBy?: string; selectedLabel?: string; sharedPlaybackMode?: string }) => {
    const requestedList = await normalizeFallbackGenreIds(data.genreIds);
    const requestedSingle = normalizeFallbackGenreId(data.genreId);
    const requested = requestedSingle
      ?? requestedList[0]
      ?? null;
    if (!requested || !(await isKnownFallbackSelection(requested))) {
      socket.emit('error:toast', { message: 'Dit genre is niet beschikbaar' });
      return;
    }
    const selectedBy = normalizeNickname(data.selectedBy) ?? 'onbekend';
    const requestedSharedMode = normalizeSharedPlaybackMode(data.sharedPlaybackMode);
    try {
      await setSetting(sb, 'fallback_active_genre', requested);
      const activeGenreList = requestedList.length > 0
        ? requestedList
        : [requested];
      await setSetting(sb, 'fallback_active_shared_playlist_ids', activeGenreList);
      await setSetting(sb, 'fallback_active_genre_by', selectedBy);
      const sharedId = parseSharedFallbackPlaylistId(requested);
      if (sharedId) {
        await setSetting(sb, 'fallback_shared_playback_mode', requestedSharedMode);
        setSharedAutoPlaybackMode(requestedSharedMode);
      }
      resetSharedAutoPlaybackCycleForSelection(requested);
      setActiveFallbackGenre(requested);
      setActiveFallbackGenres(activeGenreList);
      setActiveSharedFallbackPlaylists(activeGenreList.filter((id) => !!parseSharedFallbackPlaylistId(id)));
      await emitFallbackGenreUpdate();
      if (activeGenreList.length > 1) {
        socket.emit('info:toast', { message: `Autoplay mix ingesteld: ${activeGenreList.length} bronnen actief` });
      } else if (parseSharedFallbackPlaylistId(requested)) {
        const selectedLabel = String(data.selectedLabel ?? requested).replace(/^Playlist ·\s*/i, '').trim();
        socket.emit('info:toast', { message: `Autoplay playlist: ${selectedLabel}` });
      } else {
        socket.emit('info:toast', { message: `Autoplay fallback ingesteld op ${requested}` });
      }
      console.log(`[fallback] Active genre changed: ${requested} by ${selectedBy}`);
    } catch (err) {
      console.error('[socket] fallback:genre:set error:', err);
      socket.emit('error:toast', { message: 'Kon genre niet opslaan' });
    }
  });

  socket.on('fallback:shared:mode:set', async (data: { mode: string; selectedBy?: string }) => {
    const nextMode = normalizeSharedPlaybackMode(data.mode);
    const selectedBy = normalizeNickname(data.selectedBy) ?? null;
    try {
      await setSetting(sb, 'fallback_shared_playback_mode', nextMode);
      if (selectedBy) {
        await setSetting(sb, 'fallback_active_genre_by', selectedBy);
      }
      setSharedAutoPlaybackMode(nextMode);
      await emitFallbackGenreUpdate();
      console.log(`[fallback] Shared playback mode changed: ${nextMode}`);
    } catch (err) {
      console.error('[socket] fallback:shared:mode:set error:', err);
      socket.emit('error:toast', { message: 'Kon playlist afspeelmodus niet opslaan' });
    }
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    listenerPresenceBySocket.delete(socket.id);
    socketNicknameById.delete(socket.id);
    voteSkipSet.delete(socket.id);
    emitStreamStatus();
    getActiveMode(sb).then((mode) => evaluateIdlePlayback(mode)).catch(() => {});
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
  const startupFallbackGenres = await resolveActiveFallbackGenres(startupFallbackGenre, true);
  const startupSharedMode = await resolveSharedPlaybackMode(true);
  setSharedAutoPlaybackMode(startupSharedMode);
  setActiveFallbackGenre(startupFallbackGenre);
  setActiveFallbackGenres(startupFallbackGenres);
  setActiveSharedFallbackPlaylists(startupFallbackGenres.filter((id) => !!parseSharedFallbackPlaylistId(id)));
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
  const startupJingleEnabled = await getSetting<boolean>(sb, 'jingle_enable');
  const startupJingleEveryTracks = await getSetting<number>(sb, 'jingle_every_tracks');
  const startupJingleSelectedKeys = await getSetting<string[]>(sb, 'jingle_selected_keys');
  setJingleSettings({
    enabled: startupJingleEnabled ?? undefined,
    everyTracks: startupJingleEveryTracks ?? undefined,
  });
  setJingleSelection(startupJingleSelectedKeys ?? []);
  const jingleState = getJingleSettings();
  console.log(`[server] Jingle config: enabled=${jingleState.enabled}, every=${jingleState.everyTracks} tracks, selected=${getJingleSelection().length}`);

  const initialMode = await getActiveMode(sb);
  console.log(`[mode] Initial mode: ${initialMode}`);
  applyPlaybackForMode(initialMode);
  evaluateIdlePlayback(initialMode);
  const initialTrack = getCurrentTrack();
  lastObservedTrackKey = initialTrack ? `${initialTrack.id}|${initialTrack.started_at}` : null;

  let lastSyncedMode = initialMode;
  let pendingSyncedMode: Mode | null = null;
  let pendingSyncedModeCount = 0;
  let lastModeApplyAt = Date.now();
  setInterval(() => {
    maybeReleaseQueuePushLock();
    const activeTrack = getCurrentTrack();
    const activeTrackKey = activeTrack ? `${activeTrack.id}|${activeTrack.started_at}` : null;
    const previousTrackKey = lastObservedTrackKey;
    const trackAdvanced = previousTrackKey !== null && activeTrackKey !== previousTrackKey;
    lastObservedTrackKey = activeTrackKey;
    if (trackAdvanced) {
      void promoteOneDeferredQueueItem('track-ended');
    }
    if (Date.now() < stateCircuitOpenUntil) {
      evaluateIdlePlayback(lastSyncedMode);
      return;
    }
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
        evaluateIdlePlayback(mode);
        const modeSettings = await getModeSettings(sb);
        io.emit('mode:change', { mode, settings: modeSettings });
        console.log(`[mode] Synced mode from settings: ${mode}`);
      })
      .catch(() => {});
    evaluateIdlePlayback(lastSyncedMode);
  }, MODE_SYNC_INTERVAL_MS);

  // Start the bridge (downloads approved requests)
  startBridge(sb, DOWNLOAD_PATH);

  // Start now-playing watcher (RekordBox output files)
  startNowPlayingWatcher(sb, REKORDBOX_OUTPUT_PATH);

  // Pre-load SoundCloud client_id in background
  getSoundCloudClientId().catch(() => {});

  console.log(`[shared-inbox] Watching ${SHARED_EXPORTIFY_INBOX_DIR} every ${Math.round(SHARED_IMPORT_POLL_MS / 1000)}s`);
  void runSharedInboxImportJob('poll').catch((err) => {
    console.warn('[shared-inbox] Initial import scan failed:', getErrorMessage(err));
  });
  setInterval(() => {
    void runSharedInboxImportJob('poll').catch((err) => {
      console.warn('[shared-inbox] Poll import failed:', getErrorMessage(err));
    });
  }, SHARED_IMPORT_POLL_MS);
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});

// Search functions are imported from services/search.js and used by player.ts
