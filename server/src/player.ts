import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SupabaseClient } from '@supabase/supabase-js';
import type { Server as IOServer } from 'socket.io';
import type { QueueItem, Track, UpcomingTrack } from './types.js';
import { clearQueueItem, getQueue, fetchVideoInfo, decodeLocalFileUrl, isLocalUrl } from './queue.js';
import { cleanupFile } from './cleanup.js';
import type { StreamHub } from './streamHub.js';
import { pickRandomFallbackForGenre, parseAutoFallbackGenreId, LIKED_AUTO_GENRE_ID } from './fallbackGenres.js';
import { fetchArtworkCandidate } from './artwork.js';
import { listLikedPlaylistTracks } from './services/genreCuratedConfig.js';
import { getSharedPlaylistTracks, parseSharedFallbackPlaylistId } from './services/sharedPlaylistStore.js';
import { getTopTracksByGenre, getMergedGenreTags, getPriorityArtistsForGenre, resolveMergedGenreId, type GenreHitItem } from './services/discovery.js';
import { getCachedGenreHits, makeGenreHitsCacheKey, setGenreHitsCacheEntry } from './genreHitsStore.js';
import { recordMissingTrackLookup } from './services/missingTrackLog.js';

export const playerEvents = new EventEmitter();

let currentTrack: Track | null = null;
let currentDecoder: ChildProcess | null = null;
let encoder: ChildProcess | null = null;
let isRunning = false;
let keepFiles = false;
let lastKeepFilesPruneAt = 0;

// ── Seamless skip: hot-swap mechanism ──
// When a skip is requested and a next track is ready, we pre-spawn
// the new decoder while the OLD track keeps playing. Once the new
// decoder produces its first audio chunk we atomically switch —
// zero silence, zero gap.

interface PendingSwap {
  newDecoder: ChildProcess;
  ready: ReadyTrack;
  firstChunk: Buffer | null;
}

interface CompletedSwap {
  decoder: ChildProcess;
  ready: ReadyTrack;
}

let pendingSwap: PendingSwap | null = null;
let completedSwap: CompletedSwap | null = null;
let skipLocked = false;
let skipWhenReady = false;
let skipLockWatchdog: ReturnType<typeof setTimeout> | null = null;
let selfHealTimer: ReturnType<typeof setInterval> | null = null;
let lastAudioProgressAt = 0;
let lastTrackAnnouncedAt = 0;
let lastPrepareKickAt = 0;
let lastSelfHealAt = 0;
let stallConsecutiveChecks = 0;
let selfHealGraceUntil = 0;
let expectedEncoderShutdownUntil = 0;
let _io: IOServer | null = null;

const SELF_HEAL_CHECK_MS = 5_000;
const SELF_HEAL_COOLDOWN_MS = 6_000;
const SELF_HEAL_STALL_MS = Math.max(20_000, parseInt(process.env.SELF_HEAL_STALL_MS ?? '55000', 10) || 55_000);
const SELF_HEAL_STALL_CONFIRM_CHECKS = Math.max(1, parseInt(process.env.SELF_HEAL_STALL_CONFIRM_CHECKS ?? '2', 10) || 2);
const SELF_HEAL_DURATION_GRACE_SECONDS = 45;
const SELF_HEAL_START_GRACE_MS = Math.max(5_000, parseInt(process.env.SELF_HEAL_START_GRACE_MS ?? '25000', 10) || 25_000);
const KEEP_FILES_MAX_COUNT = Math.max(8, parseInt(process.env.KEEP_FILES_MAX_COUNT ?? '24', 10) || 24);
const KEEP_FILES_MAX_AGE_MS = Math.max(5 * 60_000, parseInt(process.env.KEEP_FILES_MAX_AGE_MS ?? String(6 * 60 * 60_000), 10) || (6 * 60 * 60_000));
const KEEP_FILES_PRUNE_INTERVAL_MS = Math.max(30_000, parseInt(process.env.KEEP_FILES_PRUNE_INTERVAL_MS ?? '120000', 10) || 120_000);

function toWindowsSystemErrorCode(exitCode: number | null): number | null {
  if (exitCode === null) return null;
  // Node can report Windows process exit codes as unsigned 32-bit numbers.
  return exitCode > 0x7fffffff ? (0x1_0000_0000 - exitCode) : null;
}

function isBrokenPipeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /\bEPIPE\b/i.test(msg) || /\bbroken pipe\b/i.test(msg);
}

function isWriteAfterEndError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /\bwrite after end\b/i.test(msg);
}

function markExpectedEncoderShutdown(ms = 7_000): void {
  expectedEncoderShutdownUntil = Date.now() + ms;
}

function isExpectedEncoderShutdownWindow(): boolean {
  return Date.now() < expectedEncoderShutdownUntil;
}

export function isSkipLocked(): boolean {
  return skipLocked;
}

function setSkipLock(locked: boolean): void {
  if (skipLocked === locked) return;
  skipLocked = locked;
  if (skipLockWatchdog) {
    clearTimeout(skipLockWatchdog);
    skipLockWatchdog = null;
  }
  if (locked) {
    // Never leave skip button stuck disabled on edge-case paths.
    skipLockWatchdog = setTimeout(() => {
      if (skipLocked) {
        skipLocked = false;
        _io?.emit('skip:lock', { locked: false });
        console.warn('[player] Skip lock watchdog released stale lock');
      }
      skipLockWatchdog = null;
    }, 15_000);
  }
  _io?.emit('skip:lock', { locked });
}

const STREAM_DELAY_MS = parseInt(process.env.STREAM_DELAY_MS ?? '8000', 10);
const STREAM_BITRATE_RAW = (process.env.STREAM_BITRATE ?? '256k').trim().toLowerCase();
const STREAM_USE_SOURCE_MODE = STREAM_BITRATE_RAW === 'source' || STREAM_BITRATE_RAW === 'true';
const STREAM_BITRATE = STREAM_USE_SOURCE_MODE ? '256k' : STREAM_BITRATE_RAW;
const STREAM_NORMALIZE = String(process.env.STREAM_NORMALIZE ?? 'true').toLowerCase() !== 'false';
const STREAM_AUDIO_FILTER =
  (process.env.STREAM_AUDIO_FILTER ?? '').trim()
  || 'acompressor=threshold=-18dB:ratio=3.0:attack=8:release=140:makeup=4,alimiter=limit=0.95';
const STREAM_TRIM_SILENCE = String(process.env.STREAM_TRIM_SILENCE ?? 'true').toLowerCase() !== 'false';
const STREAM_SILENCE_FILTER =
  (process.env.STREAM_SILENCE_FILTER ?? '').trim()
  || 'silenceremove=start_periods=1:start_duration=0.25:start_threshold=-42dB:stop_periods=1:stop_duration=0.35:stop_threshold=-42dB';
const STREAM_CHANNEL_REPAIR_ENABLE = String(process.env.STREAM_CHANNEL_REPAIR_ENABLE ?? 'true').toLowerCase() !== 'false';
const STREAM_CHANNEL_REPAIR_DIFF_DB = Math.max(10, parseFloat(process.env.STREAM_CHANNEL_REPAIR_DIFF_DB ?? '16') || 16);
const STREAM_CHANNEL_REPAIR_SILENT_DB = Math.min(-35, parseFloat(process.env.STREAM_CHANNEL_REPAIR_SILENT_DB ?? '-55') || -55);
const STREAM_CHANNEL_REPAIR_FILTER =
  (process.env.STREAM_CHANNEL_REPAIR_FILTER ?? '').trim()
  || 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1';
const JINGLE_ENABLE = String(process.env.JINGLE_ENABLE ?? 'true').toLowerCase() !== 'false';
const JINGLE_DIR = (process.env.JINGLE_DIR ?? path.join(process.cwd(), 'data', 'jingles')).trim();
const JINGLE_EVERY_TRACKS = Math.max(1, parseInt(process.env.JINGLE_EVERY_TRACKS ?? '4', 10) || 4);
let activeFallbackGenre: string | null = null;
let activeFallbackGenreIds: string[] = [];
let activeSharedFallbackPlaylistIds: string[] = [];
type SharedAutoPlaybackMode = 'random' | 'ordered';
let activeSharedAutoPlaybackMode: SharedAutoPlaybackMode = 'random';
const sharedPlaylistOrderCursor = new Map<string, number>();
const sharedPlaylistRandomPlayedKeys = new Map<string, Set<string>>();
let mixedAutoSourceCursor = 0;
let localFallbackCursor = 0;

type AutoSourceItem =
  | { type: 'genre'; key: string; genreId: string }
  | { type: 'liked'; key: string }
  | { type: 'shared'; key: string; playlistId: string; playbackMode: SharedAutoPlaybackMode };

type ActiveAutoSource =
  | AutoSourceItem
  | { type: 'mixed'; key: string; items: AutoSourceItem[]; playbackMode: SharedAutoPlaybackMode };

type SelectionTab = 'queue' | 'local' | 'online' | 'playlists' | 'mixed';

type QueueSelectionMeta = {
  selectionLabel?: string | null;
  selectionPlaylist?: string | null;
  selectionTab?: SelectionTab | null;
  selectionKey?: string | null;
};

const queueSelectionMetaByItemId = new Map<string, QueueSelectionMeta>();

export function setQueueItemSelectionMeta(itemId: string, meta: QueueSelectionMeta | null | undefined): void {
  const id = itemId.trim();
  if (!id) return;
  if (!meta) {
    queueSelectionMetaByItemId.delete(id);
    return;
  }
  queueSelectionMetaByItemId.set(id, {
    selectionLabel: meta.selectionLabel ?? null,
    selectionPlaylist: meta.selectionPlaylist ?? null,
    selectionTab: meta.selectionTab ?? null,
    selectionKey: meta.selectionKey ?? null,
  });
}

function normalizeSharedAutoPlaybackMode(value: unknown): SharedAutoPlaybackMode {
  if (typeof value !== 'string') return 'random';
  const normalized = value.trim().toLowerCase();
  return normalized === 'ordered' ? 'ordered' : 'random';
}

export function setSharedAutoPlaybackMode(mode: string | null | undefined): void {
  activeSharedAutoPlaybackMode = normalizeSharedAutoPlaybackMode(mode);
}

export function resetSharedAutoPlaybackCycleForSelection(genreId: string | null): void {
  const sharedPlaylistId = parseSharedFallbackPlaylistId(genreId);
  if (!sharedPlaylistId) return;
  sharedPlaylistOrderCursor.delete(sharedPlaylistId);
  sharedPlaylistRandomPlayedKeys.delete(sharedPlaylistId);
}

export function setActiveSharedFallbackPlaylists(genreIds: string[] | null | undefined): void {
  const nextIds = Array.from(new Set((genreIds ?? [])
    .map((id) => parseSharedFallbackPlaylistId(id))
    .filter((id): id is string => !!id)));
  const prev = activeSharedFallbackPlaylistIds;
  const changed = prev.length !== nextIds.length || prev.some((id, index) => id !== nextIds[index]);
  activeSharedFallbackPlaylistIds = nextIds;
  if (!changed) return;
  if (prev.length > 0 || nextIds.length > 0) {
    pendingAutoUpcoming = null;
    if (autoReadyBuffer.length > 0) {
      for (const entry of autoReadyBuffer) {
        if (entry.cleanupAfterUse) cleanupFileIfSafe(entry.audioFile, 'setActiveSharedFallbackPlaylists:changed:autoReadyBuffer');
      }
      autoReadyBuffer = [];
    }
    if (nextReady?.isFallback) {
      if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'setActiveSharedFallbackPlaylists:changed:nextReady');
      nextReady = null;
    }
    lastFallbackFile = null;
    lastAutoPreloadAttemptAt = 0;
    broadcastUpcomingTrack();
  }
}

export function setActiveFallbackGenres(genreIds: string[] | null | undefined): void {
  const nextIds = Array.from(new Set((genreIds ?? []).map((id) => (id ?? '').trim()).filter(Boolean)));
  const prev = activeFallbackGenreIds;
  const changed = prev.length !== nextIds.length || prev.some((id, index) => id !== nextIds[index]);
  activeFallbackGenreIds = nextIds;
  if (!changed) return;
  mixedAutoSourceCursor = 0;
  localFallbackCursor = 0;
  pendingAutoUpcoming = null;
  if (autoReadyBuffer.length > 0) {
    for (const entry of autoReadyBuffer) {
      if (entry.cleanupAfterUse) cleanupFileIfSafe(entry.audioFile, 'setActiveFallbackGenres:changed:autoReadyBuffer');
    }
    autoReadyBuffer = [];
  }
  if (nextReady?.isFallback) {
    if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'setActiveFallbackGenres:changed:nextReady');
    nextReady = null;
  }
  lastFallbackFile = null;
  lastAutoPreloadAttemptAt = 0;
  broadcastUpcomingTrack();
}

function getActiveLocalFallbackGenres(): string[] {
  const selected = activeFallbackGenreIds.length > 0
    ? activeFallbackGenreIds
    : (activeFallbackGenre ? [activeFallbackGenre] : []);
  return selected.filter((id) => !id.startsWith('auto:') && !id.startsWith('shared:'));
}

function pickRandomFallbackForActiveSelections(exclude?: string | null): string | null {
  const localGenres = getActiveLocalFallbackGenres();
  if (localGenres.length === 0) return pickRandomFallbackForGenre(activeFallbackGenre, exclude ?? null);
  const start = localFallbackCursor % localGenres.length;
  for (let attempt = 0; attempt < localGenres.length; attempt += 1) {
    const idx = (start + attempt) % localGenres.length;
    const genreId = localGenres[idx];
    const hit = pickRandomFallbackForGenre(genreId, exclude ?? null);
    if (hit) {
      localFallbackCursor = (idx + 1) % localGenres.length;
      return hit;
    }
  }
  return null;
}

function getActiveAutoSource(): ActiveAutoSource | null {
  const selected = activeFallbackGenreIds.length > 0
    ? activeFallbackGenreIds
    : (activeFallbackGenre ? [activeFallbackGenre] : []);
  const items: AutoSourceItem[] = [];
  for (const id of selected) {
    const sharedPlaylistId = parseSharedFallbackPlaylistId(id);
    if (sharedPlaylistId) {
      items.push({
        type: 'shared',
        key: `shared:${sharedPlaylistId}`,
        playlistId: sharedPlaylistId,
        playbackMode: activeSharedAutoPlaybackMode,
      });
      continue;
    }
    const activeAuto = parseAutoFallbackGenreId(id);
    if (!activeAuto) continue;
    if (activeAuto === LIKED_AUTO_GENRE_ID) {
      items.push({ type: 'liked', key: `auto:${LIKED_AUTO_GENRE_ID}` });
      continue;
    }
    const genreId = resolveMergedGenreId(activeAuto);
    items.push({ type: 'genre', key: `auto:${genreId}`, genreId });
  }
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return {
    type: 'mixed',
    key: `mixed:${items.map((item) => item.key).join('|')}`,
    items,
    playbackMode: activeSharedAutoPlaybackMode,
  };
}

function isAutoSourceStillActive(expectedKey: string): boolean {
  const active = getActiveAutoSource();
  if (!active) return false;
  return active.key === expectedKey;
}

function getEncoderRateArgs(): string[] {
  // "source"/"true": use high-quality VBR instead of fixed CBR cap.
  if (STREAM_USE_SOURCE_MODE) return ['-q:a', '0'];
  return ['-b:a', STREAM_BITRATE];
}

function getEncoderFilterArgs(): string[] {
  if (!STREAM_NORMALIZE) return [];
  if (!STREAM_AUDIO_FILTER) return [];
  return ['-af', STREAM_AUDIO_FILTER];
}

function getDecoderFilterArgs(forceDualMono = false): string[] {
  const filters: string[] = [];
  if (STREAM_TRIM_SILENCE && STREAM_SILENCE_FILTER) {
    filters.push(STREAM_SILENCE_FILTER);
  }
  if (forceDualMono && STREAM_CHANNEL_REPAIR_FILTER) {
    filters.push(STREAM_CHANNEL_REPAIR_FILTER);
  }
  if (filters.length === 0) return [];
  return ['-af', filters.join(',')];
}

export function setActiveFallbackGenre(genreId: string | null): void {
  const previousGenre = activeFallbackGenre;
  const previousSharedPlaylistId = parseSharedFallbackPlaylistId(previousGenre);
  const nextSharedPlaylistId = parseSharedFallbackPlaylistId(genreId);
  activeFallbackGenre = genreId;
  const changed = (previousGenre ?? '').trim().toLowerCase() !== (genreId ?? '').trim().toLowerCase();
  const activeAuto = getActiveAutoSource();
  if (changed) {
    if (previousSharedPlaylistId) {
      sharedPlaylistOrderCursor.delete(previousSharedPlaylistId);
      sharedPlaylistRandomPlayedKeys.delete(previousSharedPlaylistId);
    }
    if (nextSharedPlaylistId) {
      // Start each new shared playlist selection as a fresh cycle.
      sharedPlaylistOrderCursor.delete(nextSharedPlaylistId);
      sharedPlaylistRandomPlayedKeys.delete(nextSharedPlaylistId);
    }
    pendingAutoUpcoming = null;
    if (autoReadyBuffer.length > 0) {
      for (const entry of autoReadyBuffer) {
        if (entry.cleanupAfterUse) cleanupFileIfSafe(entry.audioFile, 'setActiveFallbackGenre:changed:autoReadyBuffer');
      }
      autoReadyBuffer = [];
    }
    if (nextReady?.isFallback) {
      if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'setActiveFallbackGenre:changed:nextReady');
      nextReady = null;
    }
    lastFallbackFile = null;
    lastAutoPreloadAttemptAt = 0;
    broadcastUpcomingTrack();
    if (_sb && isRunning) {
      void prepareNextTrack(_sb, _cacheDir, currentTrack?.id ?? null);
      void ensureAutoReadyBuffer(_sb, _cacheDir);
    }
    return;
  }
  if (!activeAuto) {
    pendingAutoUpcoming = null;
    if (autoReadyBuffer.length > 0) {
      for (const entry of autoReadyBuffer) {
        if (entry.cleanupAfterUse) cleanupFileIfSafe(entry.audioFile, 'setActiveFallbackGenre:inactive:autoReadyBuffer');
      }
      autoReadyBuffer = [];
    }
    if (nextReady?.isAutoFallback) {
      if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'setActiveFallbackGenre:inactive:nextReady');
      nextReady = null;
    }
    broadcastUpcomingTrack();
  }
}

function titleFromFilename(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
    .replace(/^\d{2,4}\s*[-.]?\s*/, '')
    .trim();
}

function autoTrackTitle(artist: string, title: string): string {
  const cleanArtist = sanitizeDisplayText(artist);
  const cleanTitle = sanitizeDisplayText(title);
  // For generic genre names as title, just use the artist
  const genericTitles = ['melodic techno', 'hard techno', 'euphoric hardstyle', 'hardstyle', 'trance', 'house', 'techno'];
  if (!cleanTitle || cleanTitle === cleanArtist || genericTitles.some(g => cleanTitle.toLowerCase().includes(g))) {
    return cleanArtist;
  }
  return `${cleanArtist} - ${cleanTitle}`.trim();
}

const DISPLAY_TITLE_SEPARATORS = [' - ', ' – ', ' — ', ' | ', ': '];
const ARTIST_WORD_STOPWORDS = new Set(['the', 'dj', 'mc', 'and', 'feat', 'ft', 'featuring', 'vs', 'x']);
const TITLE_WORD_STOPWORDS = new Set([
  'official', 'video', 'visualizer', 'visualiser', 'audio', 'hq', 'hd', 'lyrics', 'lyric', 'edit',
  'remix', 'bootleg', 'extended', 'mix', 'version', 'release', 'records', 'recordings',
]);

function sanitizeDisplayText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArtistSearchQuery(artist: string): string {
  return sanitizeDisplayText(
    artist
      .replace(/[;/|]+/g, ' & ')
      .replace(/\s*&\s*/g, ' & '),
  );
}

function normalizeWordLoose(word: string): string {
  let out = word.trim();
  if (out.length > 4 && out.endsWith('ies')) return `${out.slice(0, -3)}y`;
  if (out.length > 3 && out.endsWith('s')) out = out.slice(0, -1);
  return out;
}

function toLooseWords(value: string, stopwords: Set<string>): string[] {
  return value
    .split(' ')
    .map((part) => normalizeWordLoose(part.trim()))
    .filter((part) => part.length > 1 && !stopwords.has(part));
}

function hasLooseArtistMatch(expectedNorm: string, candidateNorm: string): boolean {
  if (!expectedNorm || !candidateNorm) return false;
  if (expectedNorm.includes(candidateNorm) || candidateNorm.includes(expectedNorm)) return true;
  const expectedWords = toLooseWords(expectedNorm, ARTIST_WORD_STOPWORDS);
  const candidateWords = toLooseWords(candidateNorm, ARTIST_WORD_STOPWORDS);
  if (expectedWords.length === 0 || candidateWords.length === 0) return false;
  const candidateSet = new Set(candidateWords);
  const matched = expectedWords.filter((word) => candidateSet.has(word)).length;
  if (expectedWords.length <= 2) return matched >= 1;
  return matched >= Math.max(2, Math.ceil(expectedWords.length * 0.6));
}

function hasSufficientTitleMatch(expectedTitleNorm: string, actualTitleNorm: string): boolean {
  const expectedWords = toLooseWords(expectedTitleNorm, TITLE_WORD_STOPWORDS);
  if (expectedWords.length === 0) return true;
  const actualWords = toLooseWords(actualTitleNorm, TITLE_WORD_STOPWORDS);
  if (actualWords.length === 0) return false;
  const actualSet = new Set(actualWords);
  const matched = expectedWords.filter((word) => actualSet.has(word)).length;
  if (expectedWords.length <= 2) return matched >= 1;
  return matched >= Math.max(2, Math.ceil(expectedWords.length * 0.45));
}

function hasStrictTitleMatch(expectedTitleNorm: string, actualTitleNorm: string): boolean {
  if (!expectedTitleNorm) return true;
  if (!actualTitleNorm) return false;
  if (actualTitleNorm.includes(expectedTitleNorm)) return true;
  const expectedWords = toLooseWords(expectedTitleNorm, TITLE_WORD_STOPWORDS);
  if (expectedWords.length === 0) return true;
  const actualWords = toLooseWords(actualTitleNorm, TITLE_WORD_STOPWORDS);
  if (actualWords.length === 0) return false;
  const actualSet = new Set(actualWords);
  const matched = expectedWords.filter((word) => actualSet.has(word)).length;
  if (expectedWords.length <= 2) return matched === expectedWords.length;
  if (expectedWords.length <= 4) return matched >= expectedWords.length - 1;
  return matched >= Math.ceil(expectedWords.length * 0.75);
}

function splitNormalizedWords(value: string): string[] {
  return value
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function hasVeryStrictArtistMatch(expectedArtistNorm: string, candidateNorm: string): boolean {
  if (!expectedArtistNorm || !candidateNorm) return false;
  if (candidateNorm === expectedArtistNorm) return true;
  const expectedWords = splitNormalizedWords(expectedArtistNorm);
  const candidateWords = splitNormalizedWords(candidateNorm);
  if (expectedWords.length === 0 || candidateWords.length === 0) return false;
  const candidateSet = new Set(candidateWords);
  const matched = expectedWords.filter((word) => candidateSet.has(word)).length;
  if (matched < expectedWords.length) return false;
  // Allow tiny suffixes like "topic", "official", "music", but block large drift.
  return candidateWords.length <= expectedWords.length + 2;
}

const STRICT_TITLE_TRAILING_ALLOW = new Set([
  'original',
  'mix',
  'edit',
  'radio',
  'extended',
  'version',
  'vip',
  'bootleg',
  'rework',
  'remaster',
]);

function hasVeryStrictTitleMatch(expectedTitleNorm: string, resultTitleNorm: string): boolean {
  if (!expectedTitleNorm || !resultTitleNorm) return false;
  if (resultTitleNorm === expectedTitleNorm) return true;
  if (!resultTitleNorm.startsWith(expectedTitleNorm)) return false;
  const trailing = resultTitleNorm.slice(expectedTitleNorm.length).trim();
  if (!trailing) return true;
  const trailingWords = splitNormalizedWords(trailing);
  if (trailingWords.length === 0) return true;
  if (trailingWords.length > 3) return false;
  return trailingWords.every((word) => STRICT_TITLE_TRAILING_ALLOW.has(word));
}

function hasDisplayArtistSeparator(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return DISPLAY_TITLE_SEPARATORS.some((sep) => {
    const idx = text.indexOf(sep);
    return idx > 0 && idx < text.length - sep.length;
  });
}

function parseDisplayArtistTitle(value: string): { artist: string | null; title: string } {
  const text = sanitizeDisplayText(value);
  for (const sep of DISPLAY_TITLE_SEPARATORS) {
    const idx = text.indexOf(sep);
    if (idx <= 0 || idx >= text.length - sep.length) continue;
    const artist = text.slice(0, idx).trim();
    const title = text.slice(idx + sep.length).trim();
    if (artist && title) return { artist, title };
  }
  return { artist: null, title: text };
}

function stripLeadingArtistFromTitle(title: string, artist: string): string {
  const cleanTitle = sanitizeDisplayText(title);
  const cleanArtist = sanitizeDisplayText(artist);
  if (!cleanTitle || !cleanArtist) return cleanTitle;
  for (const sep of DISPLAY_TITLE_SEPARATORS) {
    const prefix = `${cleanArtist}${sep}`.toLowerCase();
    if (cleanTitle.toLowerCase().startsWith(prefix)) {
      return cleanTitle.slice(prefix.length).trim();
    }
  }
  return cleanTitle;
}

function normalizeArtistMatchText(text: string): string {
  const confusableMap: Record<string, string> = {
    '\u056c': 'l', // Armenian small letter used in spoofed titles, e.g. SԼUT
  };
  const withConfusablesFixed = Array.from(text ?? '')
    .map((char) => confusableMap[char] ?? char)
    .join('');
  return withConfusablesFixed
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\*/g, '')
    .replace(/[^\w\s&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeArtistText(text: string): string[] {
  return normalizeArtistMatchText(text)
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function normalizeArtistString(artist: string | null | undefined): string[] {
  const raw = normalizeArtistMatchText(artist ?? '');
  if (!raw) return [];
  const expanded = raw
    .replace(/\b(feat|ft|featuring|vs|versus)\b/g, ' & ')
    .replace(/\bx\b/g, ' & ')
    .replace(/[;,/|]+/g, ' & ')
    .replace(/\s*&\s*/g, ' & ');
  const parts = expanded
    .split(' & ')
    .map((part) => normalizeArtistMatchText(part))
    .filter((part) => part.length > 1);
  return Array.from(new Set(parts));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function tokenContainmentSimilarity(expected: Set<string>, actual: Set<string>): number {
  if (expected.size === 0 || actual.size === 0) return 0;
  let matched = 0;
  for (const token of expected) {
    if (actual.has(token)) matched += 1;
  }
  return matched / expected.size;
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

function fuzzyTokenCoverage(expected: Set<string>, actual: Set<string>): number {
  if (expected.size === 0 || actual.size === 0) return 0;
  const actualTokens = Array.from(actual);
  let matched = 0;
  for (const token of expected) {
    if (actual.has(token) || actualTokens.some((candidate) => isNearTokenMatch(token, candidate))) {
      matched += 1;
    }
  }
  return matched / expected.size;
}

function isVariousArtistsText(input: string | null | undefined): boolean {
  const normalized = normalizeArtistMatchText(input ?? '');
  return normalized === 'various artists' || normalized === 'various artist' || normalized === 'va';
}

function extractLeadingTitleArtistNormalized(title: string): string | null {
  const raw = sanitizeDisplayText(title);
  if (!raw) return null;
  for (const sep of DISPLAY_TITLE_SEPARATORS) {
    const idx = raw.indexOf(sep);
    if (idx <= 0 || idx >= raw.length - sep.length) continue;
    const part = raw.slice(0, idx).trim();
    const normalized = normalizeArtistMatchText(part);
    if (normalized) return normalized;
  }
  return null;
}

function hasArtistCreditInTitleNormalized(titleNorm: string, artistNorm: string): boolean {
  if (!titleNorm || !artistNorm) return false;
  const escapedArtist = artistNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const looseRemixCredit = new RegExp(`${escapedArtist}(?:\\s+[a-z0-9&]+){0,6}\\s+(remix|edit|bootleg|rework)`, 'i');
  if (looseRemixCredit.test(titleNorm)) return true;
  const patterns = [
    `${artistNorm} remix`,
    `${artistNorm} edit`,
    `${artistNorm} bootleg`,
    `${artistNorm} rework`,
    `feat ${artistNorm}`,
    `ft ${artistNorm}`,
    `featuring ${artistNorm}`,
    `vs ${artistNorm}`,
    `x ${artistNorm}`,
    `${artistNorm} x`,
  ];
  return patterns.some((pattern) => titleNorm.includes(pattern));
}

function buildAutoDisplayTitle(
  detectedTitle: string | null | undefined,
  fallbackArtist: string | null | undefined,
  fallbackTitle: string | null | undefined,
): string {
  const detected = sanitizeDisplayText(detectedTitle ?? '');
  if (detected && hasDisplayArtistSeparator(detected)) return detected;
  const artist = sanitizeDisplayText(fallbackArtist ?? '');
  const baseTitle = sanitizeDisplayText(fallbackTitle ?? '');
  if (!artist) return detected || baseTitle || 'Unknown title';
  const candidate = stripLeadingArtistFromTitle(detected || baseTitle, artist) || baseTitle || detected;
  return sanitizeDisplayText(autoTrackTitle(artist, candidate || 'Unknown title'));
}

function getNormalizedDisplayArtist(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const parsed = parseDisplayArtistTitle(text);
  if (!parsed.artist) return null;
  const normalized = normalizeArtistMatchText(parsed.artist);
  return normalized || null;
}

function sanitizeAutoId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) || 'auto';
}

function normalizeAutoKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAutoFallbackSource(
  genreId: string,
  artist: string,
  title: string,
  mergedTags: string[] = [],
  withGenreTags = false,
): QueueItem {
  const baseSearch = autoTrackTitle(artist, title);
  const tagBlock = Array.from(new Set([genreId, ...mergedTags]))
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  const search = withGenreTags && tagBlock
    ? `${baseSearch} ${tagBlock}`.trim()
    : baseSearch;
  return {
    id: `auto-${Date.now()}`,
    youtube_url: `ytsearch1:${search}`,
    youtube_id: `auto_${sanitizeAutoId(genreId)}_${sanitizeAutoId(search)}`,
    title: search,
    thumbnail: null,
    added_by: 'auto',
    position: 0,
    created_at: new Date().toISOString(),
  };
}

function buildAutoFallbackSourceForQuery(sourceId: string, search: string): QueueItem {
  return {
    id: `auto-${Date.now()}`,
    youtube_url: `ytsearch1:${search}`,
    youtube_id: `auto_${sanitizeAutoId(sourceId)}_${sanitizeAutoId(search)}`,
    title: search,
    thumbnail: null,
    added_by: 'auto',
    position: 0,
    created_at: new Date().toISOString(),
  };
}

interface AutoSearchCandidate {
  url: string;
  title: string | null;
  duration: number | null;
  thumbnail: string | null;
  source: 'youtube' | 'soundcloud';
}

interface AutoCandidateMatchOptions {
  expectedArtist?: string | null;
  expectedTitle?: string | null;
  strictMetadata?: boolean;
}

const AUTO_BLOCKED_KEYWORDS = [
  'advertisement',
  'ad break',
  'sponsored',
  'sponsor',
  'vlog',
  'promo code',
  'trailer',
  'teaser',
  'reaction',
  'review',
  'interview',
  'podcast',
  'tutorial',
  'how to',
  'analysis',
  'news',
  'talk show',
];

const STRICT_METADATA_BLOCKED_KEYWORDS = [
  'advertisement',
  'ad break',
  'sponsored',
  'vlog',
  'promo code',
  'trailer',
  'teaser',
  'reaction',
  'review',
  'interview',
  'podcast',
  'news',
  'talk show',
  'lyrics video',
  'videoclip',
  'official clip',
  'official hardstyle clip',
  'live at',
  'live version',
  'concert',
  'piano',
  'piano cover',
  'cover',
  'tutorial',
  'lesson',
  'sheet music',
  'midi',
  'lyrics',
  'full set',
  'hour mix',
  'radio show',
  'instrumental',
];

const OPTIONAL_TITLE_STYLE_TOKENS = new Set([
  'hypertechno',
]);

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

type AutoSearchScoreResult = {
  score: number;
  reasons: string[];
  isLive: boolean;
};

function includesKeywordOutsideExpected(
  haystackNorm: string,
  keyword: string,
  expectedTitleNorm: string,
): boolean {
  const keywordNorm = normalizeArtistMatchText(keyword);
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

function tokenOverlap(a: string, b: string): number {
  const aSet = new Set(tokenizeArtistText(a));
  const bSet = new Set(tokenizeArtistText(b));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let matches = 0;
  for (const token of aSet) {
    if (bSet.has(token)) matches += 1;
  }
  return matches / Math.max(aSet.size, bSet.size);
}

function evaluateSearchResultForAutoSubmission(
  result: { title?: string | null; channel?: string | null; duration?: number | null },
  expectedArtist: string | null,
  expectedTitle: string | null,
  options?: { strictMetadata?: boolean; allowLiveFallback?: boolean; matchMode?: 'strict' | 'semi' },
): AutoSearchScoreResult {
  const title = String(result.title ?? '').trim();
  const channel = String(result.channel ?? '').trim();
  if (!title) return { score: -100, reasons: ['empty-title'], isLive: false };
  const strictMetadata = options?.strictMetadata === true;
  const allowLiveFallback = options?.allowLiveFallback === true;
  const matchMode = options?.matchMode ?? 'strict';
  const isSemiStrict = matchMode === 'semi';

  let score = 0;
  const titleNorm = normalizeArtistMatchText(title);
  const channelNorm = normalizeArtistMatchText(channel);
  const haystackNorm = `${titleNorm} ${channelNorm}`.trim();
  const expectedArtistFromTitle = isVariousArtistsText(expectedArtist)
    ? parseDisplayArtistTitle(expectedTitle ?? '').artist
    : null;
  const useParsedArtist = isVariousArtistsText(expectedArtist) && !!expectedArtistFromTitle;
  const expectedArtistRaw = useParsedArtist ? expectedArtistFromTitle : expectedArtist;
  const expectedArtistTokens = normalizeArtistString(expectedArtistRaw);
  const expectedArtistSet = new Set(expectedArtistTokens.flatMap((value) => tokenizeArtistText(value)));
  const wantedTitleNorm = normalizeArtistMatchText(expectedTitle ?? '');
  const expectedTitleSet = new Set(tokenizeArtistText(expectedTitle ?? ''));
  const expectedTitleRelaxedSet = new Set(
    Array.from(expectedTitleSet).filter((token) => !OPTIONAL_TITLE_STYLE_TOKENS.has(token)),
  );
  const resultTitleSet = new Set(tokenizeArtistText(title));
  const resultCombinedSet = new Set(tokenizeArtistText(`${title} ${channel}`));
  const expectedIncludesRemixLike = hasUnexpectedKeyword(
    wantedTitleNorm,
    '',
    ['remix', 'edit', 'bootleg', 'rework', 'version'],
  );
  const blocked = hasBlockedAutoKeyword(titleNorm, channelNorm);

  const titleTokenSimilarity = expectedTitleSet.size > 0
    ? jaccardSimilarity(expectedTitleSet, resultTitleSet)
    : 1;
  const titleCombinedSimilarity = expectedTitleSet.size > 0
    ? jaccardSimilarity(expectedTitleSet, resultCombinedSet)
    : 1;
  const titleCoverage = expectedTitleSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleSet, resultTitleSet)
    : 1;
  const combinedTitleCoverage = expectedTitleSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleSet, resultCombinedSet)
    : 1;
  const titleRelaxedCoverage = expectedTitleRelaxedSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleRelaxedSet, resultTitleSet)
    : titleCoverage;
  const combinedTitleRelaxedCoverage = expectedTitleRelaxedSet.size > 0
    ? fuzzyTokenCoverage(expectedTitleRelaxedSet, resultCombinedSet)
    : combinedTitleCoverage;
  const titleStrongMatch = titleTokenSimilarity >= 0.8
    || titleCombinedSimilarity >= 0.8
    || titleCoverage >= 0.8
    || combinedTitleCoverage >= 0.8
    || titleRelaxedCoverage >= 0.8
    || combinedTitleRelaxedCoverage >= 0.8
    || (wantedTitleNorm ? tokenOverlap(expectedTitle ?? '', title) >= 0.85 : true)
    || (wantedTitleNorm ? titleNorm.includes(wantedTitleNorm) : true);
  const titleNearPerfect = titleTokenSimilarity >= 0.95
    || titleCombinedSimilarity >= 0.95
    || titleCoverage >= 0.95
    || combinedTitleCoverage >= 0.95
    || titleRelaxedCoverage >= 0.95
    || combinedTitleRelaxedCoverage >= 0.95;

  const resultArtistSet = new Set(tokenizeArtistText(`${title} ${channel}`));
  const artistSimilarity = expectedArtistSet.size > 0
    ? jaccardSimilarity(expectedArtistSet, resultArtistSet)
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
      if (!isSemiStrict || !titleNearPerfect || !artistHasSignal) {
        return { score: -100, reasons: ['metadata-mismatch:artist'], isLive: false };
      }
      score -= 50;
    }
  } else if (strictMetadata && !strictTitleMatch) {
    return { score: -100, reasons: ['metadata-mismatch:title'], isLive: false };
  }

  const nonMusicBlocked = hasUnexpectedKeyword(haystackNorm, wantedTitleNorm, STRICT_METADATA_BLOCKED_KEYWORDS);
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
    .some((keyword) => haystackNorm.includes(normalizeArtistMatchText(keyword)));
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

function hasBlockedAutoKeyword(title: string, channel = ''): boolean {
  const haystack = `${title} ${channel}`.toLowerCase();
  return AUTO_BLOCKED_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function hasUnexpectedStrictKeyword(
  title: string,
  channel: string,
  expectedTitleNorm: string,
): boolean {
  const haystack = `${title} ${channel}`.toLowerCase();
  return STRICT_METADATA_BLOCKED_KEYWORDS.some((keyword) => (
    haystack.includes(keyword) && !expectedTitleNorm.includes(keyword)
  ));
}

async function resolveShortAutoCandidate(
  query: string,
  genreId?: string,
  options?: AutoCandidateMatchOptions,
): Promise<AutoSearchCandidate | null> {
  try {
    const { youtubeSearch, soundcloudSearch, spotdlSearch } = await import('./services/search.js');

    let genreHints: any = null;
    if (genreId) {
      try {
        const { getGenreHints } = await import('./services/discovery.js');
        genreHints = getGenreHints(genreId);
      } catch (err) {
        console.warn(`[auto-filter] Failed to get genre hints for ${genreId}:`, (err as Error).message);
      }
    }

    const searchQuery = sanitizeDisplayText(query);
    const parsedQuery = parseDisplayArtistTitle(searchQuery);
    let expectedArtistRaw = options?.expectedArtist?.trim() || parsedQuery.artist || '';
    const expectedTitleRaw = options?.expectedTitle?.trim() || parsedQuery.title || '';
    if (isVariousArtistsText(expectedArtistRaw)) {
      const parsedFromTitle = parseDisplayArtistTitle(expectedTitleRaw).artist;
      if (parsedFromTitle) expectedArtistRaw = parsedFromTitle;
    }
    const strictMetadata = options?.strictMetadata === true;

    const hasGenreHintBlock = (resultTitle: string, resultChannel: string): boolean => {
      if (!genreHints) return false;
      const title = resultTitle.toLowerCase();
      const channel = resultChannel.toLowerCase();
      const artistTitle = `${channel} - ${resultTitle}`.toLowerCase();
      if (genreHints.blockedTracks) {
        const blockedTracks = genreHints.blockedTracks.map((track: string) => track.toLowerCase());
        for (const blockedTrack of blockedTracks) {
          if (blockedTrack && (title.includes(blockedTrack) || artistTitle.includes(blockedTrack))) return true;
        }
      }
      if (genreHints.blockedTokens) {
        const blockedTokens = genreHints.blockedTokens.map((token: string) => token.toLowerCase());
        for (const token of blockedTokens) {
          if (token && (title.includes(token) || channel.includes(token) || artistTitle.includes(token))) return true;
        }
      }
      if (genreHints.blockedArtists) {
        const blockedArtists = genreHints.blockedArtists.map((artist: string) => artist.toLowerCase());
        for (const blockedArtist of blockedArtists) {
          if (blockedArtist && channel.includes(blockedArtist)) return true;
        }
      }
      return false;
    };

    const [ytResults, scResults] = await Promise.all([
      Promise.race([
        youtubeSearch(searchQuery, strictMetadata ? 10 : 8),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
      ]).catch(() => []),
      Promise.race([
        soundcloudSearch(searchQuery, strictMetadata ? 10 : 6),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]).catch(() => []),
    ]);

    const baseCandidates = [
      ...ytResults.map((row) => ({ row, provider: 'youtube' as const })),
      ...scResults.map((row) => ({ row, provider: 'soundcloud' as const })),
    ].filter(({ row }) => {
      if (!row.title || isSetLikeAutoTitle(row.title)) return false;
      if (!row.duration || row.duration < 120 || row.duration > AUTO_MAX_DURATION_SECONDS) return false;
      if (hasGenreHintBlock(row.title, row.channel || '')) return false;
      return true;
    });

    if (baseCandidates.length === 0) return null;

    if (!strictMetadata) {
      const fallback = baseCandidates
        .filter(({ row }) => !hasBlockedAutoKeyword((row.title || '').toLowerCase(), (row.channel || '').toLowerCase()))
        .sort((a, b) => (a.row.duration || 0) - (b.row.duration || 0))[0];
      if (!fallback) return null;
      return {
        url: fallback.row.url,
        title: fallback.row.title,
        duration: fallback.row.duration,
        thumbnail: fallback.row.thumbnail,
        source: fallback.provider,
      };
    }

    const strictRanked = baseCandidates
      .map((candidate) => ({
        ...candidate,
        evaluation: evaluateSearchResultForAutoSubmission(
          { title: candidate.row.title, channel: candidate.row.channel, duration: candidate.row.duration ?? null },
          expectedArtistRaw || null,
          expectedTitleRaw || null,
          { strictMetadata: true, allowLiveFallback: false },
        ),
      }))
      .filter(({ evaluation }) => evaluation.score > -100)
      .sort((a, b) => b.evaluation.score - a.evaluation.score);

    let selected = strictRanked[0] ?? null;

    if (!selected) {
      const semiRanked = baseCandidates
        .map((candidate) => ({
          ...candidate,
          evaluation: evaluateSearchResultForAutoSubmission(
            { title: candidate.row.title, channel: candidate.row.channel, duration: candidate.row.duration ?? null },
            expectedArtistRaw || null,
            expectedTitleRaw || null,
            { strictMetadata: true, allowLiveFallback: false, matchMode: 'semi' },
          ),
        }))
        .filter(({ evaluation }) => evaluation.score > -100)
        .sort((a, b) => b.evaluation.score - a.evaluation.score);
      selected = semiRanked[0] ?? null;
    }

    if (!selected) {
      const liveRanked = baseCandidates
        .map((candidate) => ({
          ...candidate,
          evaluation: evaluateSearchResultForAutoSubmission(
            { title: candidate.row.title, channel: candidate.row.channel, duration: candidate.row.duration ?? null },
            expectedArtistRaw || null,
            expectedTitleRaw || null,
            { strictMetadata: true, allowLiveFallback: true },
          ),
        }))
        .filter(({ evaluation }) => evaluation.score > -100 && evaluation.isLive)
        .sort((a, b) => b.evaluation.score - a.evaluation.score);
      selected = liveRanked[0] ?? null;
    }

    if (!selected) {
      const spotdlResults = await spotdlSearch({
        artist: expectedArtistRaw || null,
        title: expectedTitleRaw || null,
        query: searchQuery,
        spotifyUrl: null,
      }, 4);
      const spotdlRanked = spotdlResults
        .map((row) => ({
          row,
          provider: 'youtube' as const,
          evaluation: evaluateSearchResultForAutoSubmission(
            { title: row.title, channel: row.channel, duration: row.duration ?? null },
            expectedArtistRaw || null,
            expectedTitleRaw || null,
            { strictMetadata: true, allowLiveFallback: false },
          ),
        }))
        .filter(({ evaluation }) => evaluation.score > -100)
        .sort((a, b) => b.evaluation.score - a.evaluation.score);
      const bestSpotdl = spotdlRanked[0];
      if (bestSpotdl) {
        return {
          url: bestSpotdl.row.url,
          title: bestSpotdl.row.title,
          duration: bestSpotdl.row.duration,
          thumbnail: bestSpotdl.row.thumbnail,
          source: 'youtube',
        };
      }
    }

    if (!selected) return null;

    return {
      url: selected.row.url,
      title: selected.row.title,
      duration: selected.row.duration,
      thumbnail: selected.row.thumbnail,
      source: selected.provider,
    };
  } catch (error) {
    console.warn('[auto-download] Fast search failed, no fallback available:', (error as Error).message);
    return null;
  }
}

const AUTO_RECENT_WINDOW = 60;
const AUTO_MAX_DURATION_SECONDS = 7 * 60;
const recentAutoTrackKeys: string[] = [];
const inFlightAutoTrackKeys = new Set<string>();
const DAILY_AUTO_HISTORY_REFRESH_MS = 60_000;
let dailyAutoPlayedKeys = new Set<string>();
let dailyAutoPlayedDayKey = '';
let dailyAutoPlayedLoadedAt = 0;
let lastLowBufferWarningAt = 0;

function isSetLikeAutoTitle(title: string): boolean {
  return /\b(set|mix|liveset|live set|podcast|radio show|megamix|full mix|dj set|hour mix|hours mix)\b/i.test(title);
}

function isAllowedAutoTrack(title: string, duration: number | null): boolean {
  if (!title.trim()) return false;
  if (isSetLikeAutoTitle(title)) return false;
  if (duration !== null && (duration < 120 || duration > AUTO_MAX_DURATION_SECONDS)) return false;
  return true;
}

function isRecentAutoTrack(artist: string, title: string): boolean {
  const key = normalizeAutoKey(`${artist} ${title}`);
  return recentAutoTrackKeys.includes(key);
}

function getUtcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function toAutoHistoryId(title: string | null | undefined): string {
  const normalized = normalizeAutoKey(title ?? '');
  return `auto:${sanitizeAutoId(normalized || 'unknown')}`;
}

async function refreshDailyAutoPlayedKeys(force = false): Promise<void> {
  if (!_sb) return;
  const dayKey = getUtcDayKey();
  const now = Date.now();
  if (!force && dailyAutoPlayedDayKey === dayKey && now - dailyAutoPlayedLoadedAt < DAILY_AUTO_HISTORY_REFRESH_MS) {
    return;
  }
  const dayStartIso = `${dayKey}T00:00:00.000Z`;
  const { data, error } = await _sb
    .from('played_history')
    .select('title,youtube_id,played_at')
    .gte('played_at', dayStartIso)
    .like('youtube_id', 'auto:%')
    .order('played_at', { ascending: false })
    .limit(2000);
  if (error) {
    console.warn(`[player] Failed loading daily auto history: ${error.message}`);
    return;
  }
  const next = new Set<string>();
  for (const row of data ?? []) {
    const key = normalizeAutoKey(String((row as { title?: string | null }).title ?? ''));
    if (!key) continue;
    next.add(key);
  }
  dailyAutoPlayedKeys = next;
  dailyAutoPlayedDayKey = dayKey;
  dailyAutoPlayedLoadedAt = now;
}

function wasPlayedAutoToday(title: string | null | undefined): boolean {
  const dayKey = getUtcDayKey();
  if (dailyAutoPlayedDayKey !== dayKey) {
    dailyAutoPlayedKeys = new Set();
    dailyAutoPlayedDayKey = dayKey;
    dailyAutoPlayedLoadedAt = 0;
  }
  const key = normalizeAutoKey(title ?? '');
  if (!key) return false;
  return dailyAutoPlayedKeys.has(key);
}

function markPlayedAutoToday(title: string | null | undefined): void {
  const key = normalizeAutoKey(title ?? '');
  if (!key) return;
  const dayKey = getUtcDayKey();
  if (dailyAutoPlayedDayKey !== dayKey) {
    dailyAutoPlayedKeys = new Set();
    dailyAutoPlayedDayKey = dayKey;
  }
  dailyAutoPlayedKeys.add(key);
  dailyAutoPlayedLoadedAt = Date.now();
}

function rememberAutoTrack(artist: string, title: string): void {
  const key = normalizeAutoKey(`${artist} ${title}`);
  rememberAutoTrackKey(key);
}

function collectReservedAutoKeys(): Set<string> {
  const keys = new Set<string>();
  const addKey = (value: string | null | undefined): void => {
    const key = normalizeAutoKey(value ?? '');
    if (!key) return;
    keys.add(key);
  };
  addKey(currentTrack?.title);
  addKey(nextReady?.title);
  addKey(pendingAutoUpcoming?.title);
  for (const buffered of autoReadyBuffer) {
    addKey(buffered.title);
  }
  for (const key of inFlightAutoTrackKeys) {
    if (key) keys.add(key);
  }
  return keys;
}

function rememberAutoTrackKey(raw: string): void {
  const key = normalizeAutoKey(raw);
  if (!key) return;
  const idx = recentAutoTrackKeys.indexOf(key);
  if (idx >= 0) recentAutoTrackKeys.splice(idx, 1);
  recentAutoTrackKeys.unshift(key);
  if (recentAutoTrackKeys.length > AUTO_RECENT_WINDOW) {
    recentAutoTrackKeys.length = AUTO_RECENT_WINDOW;
  }
}

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

async function prepareAutoFallbackByGenre(genreId: string, expectedSourceKeyOverride?: string): Promise<ReadyTrack | null> {
  try {
    const canonicalGenreId = resolveMergedGenreId(genreId);
    const expectedSourceKey = expectedSourceKeyOverride ?? `auto:${canonicalGenreId}`;
    if (!isAutoSourceStillActive(expectedSourceKey)) return null;
    const mergedGenreTags = getMergedGenreTags(canonicalGenreId);
    await refreshDailyAutoPlayedKeys();
    
    // Use the same fast search system as genre hits with whitelisted artists
    const { youtubeSearch, soundcloudSearch } = await import('./services/search.js');
    const priorityArtists = getPriorityArtistsForGenre(canonicalGenreId);
    
    const mergedHits: Array<{ title: string; artist: string; thumbnail: string | null }> = [];
    const seen = new Set<string>();
    
    console.log(`[auto-playlist] Searching for ${canonicalGenreId} tracks from ${priorityArtists.length} whitelisted artists`);
    
    // Search for tracks from whitelisted artists (same as genre hits system)
    // RANDOMIZED: Use different random artists each time for variety
    const maxArtistsToSearch = Math.min(6, priorityArtists.length);
    const artistsToSearch = [];
    const availableArtists = [...priorityArtists]; // Copy array
    
    for (let i = 0; i < maxArtistsToSearch && availableArtists.length > 0; i++) {
      const randomIndex = Math.floor(Math.random() * availableArtists.length);
      artistsToSearch.push(availableArtists[randomIndex]);
      availableArtists.splice(randomIndex, 1); // Remove to avoid duplicates
    }
    
    console.log(`[auto-playlist] Selected artists: ${artistsToSearch.join(', ')}`);
    const searchPromises = artistsToSearch.map(async (artist) => {
      if (!isAutoSourceStillActive(expectedSourceKey)) return [];
      
      try {
        // Create better search queries - just search for the artist name
        // The genre filtering will happen through the whitelisted artist pool
        const [ytResults, scResults] = await Promise.allSettled([
          Promise.race([
            youtubeSearch(artist, 5), // Search only artist name for better matches
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
          ]),
          Promise.race([
            soundcloudSearch(artist, 5), // Search only artist name for better matches  
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
          ])
        ]);
        
        const results = [
          ...(ytResults.status === 'fulfilled' ? ytResults.value : []),
          ...(scResults.status === 'fulfilled' ? scResults.value : [])
        ];
        
        return results
          .filter(result => {
            // Apply same filtering as genre hits
            if (!result.title || !result.duration) return false;
            if (result.duration > 900) return false; // 15 minutes max (allow longer tracks)
            if (result.duration < 120) return false; // 2 minutes min
            
            // Ensure track has credible artist linkage without requiring uploader name equality.
            const artistNorm = normalizeArtistMatchText(artist);
            const titleNorm = normalizeArtistMatchText(result.title || '');
            const channelNorm = normalizeArtistMatchText(result.channel || '');
            const leadingArtistNorm = extractLeadingTitleArtistNormalized(result.title || '');
            const leadingArtistMatches = !!leadingArtistNorm && (
              leadingArtistNorm.includes(artistNorm) || artistNorm.includes(leadingArtistNorm)
            );
            const creditedInTitle = hasArtistCreditInTitleNormalized(titleNorm, artistNorm);
            
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

            // Reject obvious non-music / promo material that often sneaks through.
            const nonMusicKeywords = ['trailer', 'teaser', 'sample', 'scene', 'official trailer'];
            if (nonMusicKeywords.some((keyword) => titleNorm.includes(keyword))) return false;

            // If title is "Artist - Track", leading artist must match expected artist,
            // unless expected artist is explicitly credited as remix/feat.
            if (leadingArtistNorm && !leadingArtistMatches && !creditedInTitle) {
              console.log(`[auto-playlist] Filtered out mismatched leading artist: "${result.title}" by "${result.channel}" (expected: ${artist})`);
              return false;
            }
            
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
              
              if (!strictMatch && !artistInTitle && !artistInChannel && !creditedInTitle) {
                console.log(`[auto-playlist] Filtered out non-matching short artist: "${result.title}" by "${result.channel}" (expected: ${artist})`);
                return false;
              }
            } else if (!artistInTitle && !artistInChannel && !simpleMatch && !creditedInTitle) {
              console.log(`[auto-playlist] Filtered out non-matching artist: "${result.title}" by "${result.channel}" (expected: ${artist})`);
              return false;
            }
            
            return true;
          })
          .map(result => ({
            title: result.title,
            artist: artist, // Always use the whitelisted artist, not the channel name
            thumbnail: result.thumbnail
          }));
      } catch (error) {
        console.warn(`[auto-playlist] Search failed for artist ${artist}:`, (error as Error).message);
        return [];
      }
    });
    
    const searchResults = await Promise.allSettled(searchPromises);
    
    // Collect all results
    for (const result of searchResults) {
      if (result.status !== 'fulfilled') continue;
      for (const hit of result.value) {
        if (!isAutoSourceStillActive(expectedSourceKey)) return null;
        const title = hit.title?.trim() || '';
        const artist = hit.artist?.trim() || '';
        const thumbnail = hit.thumbnail?.trim() || null;
        if (!title || !artist) continue;
        const key = normalizeAutoKey(`${artist} ${title}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        mergedHits.push({ title, artist, thumbnail });
      }
    }
    
    console.log(`[auto-playlist] Found ${mergedHits.length} whitelisted tracks for ${canonicalGenreId}`);

    if (mergedHits.length === 0) {
      // Ultimate fallback: search for popular tracks by genre using well-known artists
      console.log(`[auto-playlist] No direct results found, trying fallback searches for ${canonicalGenreId}`);
      
      const fallbackArtists = getPriorityArtistsForGenre(canonicalGenreId).slice(0, 8);
      const genreTags = getMergedGenreTags(canonicalGenreId);
      
      // Try searching for each artist with their most popular tracks
      for (const artist of fallbackArtists) {
        if (!isAutoSourceStillActive(expectedSourceKey)) return null;
        
        try {
          // Search for just the artist name to get their popular tracks
          const [ytResults] = await Promise.allSettled([
            Promise.race([
              youtubeSearch(artist, 3),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ])
          ]);
          
          if (ytResults.status === 'fulfilled' && ytResults.value.length > 0) {
            for (const result of ytResults.value.slice(0, 2)) { // Take top 2 results per artist
              if (!result.title || !result.duration) continue;
              if (result.duration > 900 || result.duration < 120) continue;
              
              const key = normalizeAutoKey(`${artist} ${result.title}`);
              if (!key || seen.has(key)) continue;
              seen.add(key);
              
              mergedHits.push({
                artist: artist,
                title: result.title,
                thumbnail: result.thumbnail,
              });
            }
          }
        } catch (err) {
          console.warn(`[auto-playlist] Fallback search failed for ${artist}:`, (err as Error).message);
        }
      }
      
      // If still no results, create synthetic entries as last resort
      if (mergedHits.length === 0) {
        const titleSeed = genreTags[0] ?? canonicalGenreId;
        for (const artist of fallbackArtists.slice(0, 12)) {
          const cleanArtist = artist.trim();
          if (!cleanArtist) continue;
          const key = normalizeAutoKey(`${cleanArtist} ${titleSeed}`);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          mergedHits.push({
            artist: cleanArtist,
            title: titleSeed,
            thumbnail: null,
          });
        }
      }
    }

    if (mergedHits.length < 10) {
      const now = Date.now();
      if (now - lastLowBufferWarningAt > 30_000) {
        lastLowBufferWarningAt = now;
        console.warn(`[auto-playlist] Low buffer for genre "${genreId}": only ${mergedHits.length} candidates available.`);
      }
    }
    if (mergedHits.length === 0) return null;
    const reservedKeys = collectReservedAutoKeys();
    const freshCandidates = mergedHits.filter((hit) =>
      !isRecentAutoTrack(hit.artist, hit.title)
      && !wasPlayedAutoToday(autoTrackTitle(hit.artist, hit.title)),
    ).filter((hit) => {
      const key = normalizeAutoKey(`${hit.artist} ${hit.title}`);
      return !!key && !reservedKeys.has(key);
    });
    let candidates = freshCandidates;
    if (candidates.length === 0) {
      const queueEmpty = _sb ? (await getQueue(_sb)).length === 0 : true;
      const encoderUnavailable = !encoder || encoder.killed || encoder.exitCode !== null || !encoder.stdin || encoder.stdin.destroyed;
      const streamIdle = (!currentTrack || encoderUnavailable) && queueEmpty;
      if (streamIdle) {
        // Self-heal guard: allow strict replay if 24h pool is exhausted while stream is idle.
        console.warn(`[auto-playlist] 24h pool exhausted for "${genreId}" while idle; allowing strict replay to avoid silence`);
        candidates = mergedHits.filter((hit) => {
          const key = normalizeAutoKey(`${hit.artist} ${hit.title}`);
          return !!key && !reservedKeys.has(key);
        });
      }
    }
    if (candidates.length === 0) {
      console.warn(`[auto-playlist] Exhausted 24h candidate pool for genre "${genreId}"`);
      return null;
    }
    // Keep auto probing lightweight so UI/API calls stay responsive.
    const choices = shuffleInPlace([...candidates]).slice(0, Math.min(3, candidates.length));
    for (const choice of choices) {
      if (!isAutoSourceStillActive(expectedSourceKey)) return null;
      const choiceKey = normalizeAutoKey(`${choice.artist} ${choice.title}`);
      if (!choiceKey || inFlightAutoTrackKeys.has(choiceKey)) {
        continue;
      }
      inFlightAutoTrackKeys.add(choiceKey);
      try {
        for (const withGenreTags of [false, true]) {
          if (!isAutoSourceStillActive(expectedSourceKey)) return null;
          const pseudo = buildAutoFallbackSource(canonicalGenreId, choice.artist, choice.title, mergedGenreTags, withGenreTags);
          const query = pseudo.youtube_url.replace(/^ytsearch1:/, '').trim();
          const selected = await resolveShortAutoCandidate(query, genreId);
          if (!isAutoSourceStillActive(expectedSourceKey)) return null;
          if (!selected) {
            // Only log first attempt failure to reduce spam
            if (!withGenreTags) {
              console.warn(`[auto-download] No candidate (${genreId}) for: ${choice.artist} - ${choice.title}`);
            }
            continue;
          }
          console.log(`[auto-download] Selected ${selected.source} candidate (${genreId}): ${selected.title ?? query} (${selected.duration ?? '?'}s)`);
          // Use the direct URL from the search result for better reliability
          const selectedPseudo: QueueItem = {
            ...pseudo,
            youtube_url: selected.url,
            title: selected.title ?? pseudo.title,
          };
          const resolvedTitle = buildAutoDisplayTitle(selected.title, choice.artist, choice.title);
          const hintedDuration = selected.duration;
          if (!isAllowedAutoTrack(resolvedTitle, hintedDuration)) {
            console.warn(`[auto-download] Rejected by metadata (${genreId}): ${resolvedTitle} (${hintedDuration ?? '?'}s)`);
            continue;
          }
          if (!isAutoSourceStillActive(expectedSourceKey)) return null;
          pendingAutoUpcoming = {
            youtube_id: 'auto',
            title: resolvedTitle,
            thumbnail: choice.thumbnail ?? selected.thumbnail ?? null,
            duration: hintedDuration,
            added_by: null,
            isFallback: true,
            selection_label: `Autoplay online (${genreId})`,
            selection_playlist: null,
            selection_tab: 'online',
            selection_key: `auto:${genreId}`,
          };
          broadcastUpcomingTrack();
          try {
            const audioFile = await downloadAudio(selectedPseudo, _cacheDir);
            if (!isAutoSourceStillActive(expectedSourceKey)) {
              if (!keepFiles) cleanupFile(audioFile);
              pendingAutoUpcoming = null;
              broadcastUpcomingTrack();
              return null;
            }
            const fileDuration = await getAudioDuration(audioFile);
            if (fileDuration === null) {
              if (!keepFiles) cleanupFile(audioFile);
              pendingAutoUpcoming = null;
              broadcastUpcomingTrack();
              console.warn(`[auto-download] Rejected (unknown duration) (${genreId}): ${resolvedTitle}`);
              continue;
            }
            const finalDuration = hintedDuration ?? fileDuration;
            if (!isAllowedAutoTrack(resolvedTitle, finalDuration)) {
              if (!keepFiles) cleanupFile(audioFile);
              pendingAutoUpcoming = null;
              broadcastUpcomingTrack();
              console.warn(`[auto-download] Rejected by duration (${genreId}): ${resolvedTitle} (${finalDuration}s)`);
              continue;
            }
            rememberAutoTrack(choice.artist, choice.title);
            pendingAutoUpcoming = null;
            const forceDualMono = await shouldForceDualMono(audioFile);
            console.log(`[auto-download] Ready (${genreId}): ${resolvedTitle} (${finalDuration}s)`);
            return {
              audioFile,
              title: resolvedTitle,
              thumbnail: choice.thumbnail ?? selected.thumbnail ?? null,
              youtubeId: 'local',
              duration: finalDuration,
              addedBy: null,
              queueItemId: null,
              isFallback: true,
              isAutoFallback: true,
              cleanupAfterUse: true,
              forceDualMono,
              selectionLabel: `Autoplay online (${genreId})`,
              selectionPlaylist: null,
              selectionTab: 'online',
              selectionKey: `auto:${genreId}`,
            };
          } catch {
            pendingAutoUpcoming = null;
            broadcastUpcomingTrack();
          }
        }
      } finally {
        inFlightAutoTrackKeys.delete(choiceKey);
      }
    }
    pendingAutoUpcoming = null;
    broadcastUpcomingTrack();
    return null;
  } catch (err) {
    pendingAutoUpcoming = null;
    broadcastUpcomingTrack();
    console.warn(`[player] Auto fallback prepare failed (${genreId}): ${(err as Error).message}`);
    return null;
  }
}

async function prepareLikedAutoFallbackTrack(expectedSourceKeyOverride?: string): Promise<ReadyTrack | null> {
  const expectedSourceKey = expectedSourceKeyOverride ?? `auto:${LIKED_AUTO_GENRE_ID}`;
  try {
    if (!isAutoSourceStillActive(expectedSourceKey)) return null;
    await refreshDailyAutoPlayedKeys();
    const likedTracks = listLikedPlaylistTracks();
    if (likedTracks.length === 0) return null;

    const fresh = likedTracks.filter((track) =>
      !recentAutoTrackKeys.includes(normalizeAutoKey(track))
      && !wasPlayedAutoToday(track),
    );
    if (fresh.length === 0) {
      console.warn('[auto-playlist] Exhausted 24h candidate pool for liked tracks');
      return null;
    }
    const choice = fresh[Math.floor(Math.random() * fresh.length)];
    if (!choice) return null;

    console.log(`[auto-download] Trying (liked): ${choice}`);
    const pseudo = buildAutoFallbackSourceForQuery(LIKED_AUTO_GENRE_ID, choice);
    const query = pseudo.youtube_url.replace(/^ytsearch1:/, '').trim();
    const selected = await resolveShortAutoCandidate(query); // No genreId for liked tracks
    if (!isAutoSourceStillActive(expectedSourceKey)) return null;
    if (!selected) {
      recordMissingTrackLookup({
        source: 'auto_liked',
        query,
      });
      console.warn(`[auto-download] No short candidate (liked) for query: ${query}`);
      return null;
    }
    console.log(`[auto-download] Selected ${selected.source} candidate (liked): ${selected.title ?? query} (${selected.duration ?? '?'}s)`);
    // Use the direct URL from the search result
    const selectedPseudo: QueueItem = {
      ...pseudo,
      youtube_url: selected.url,
      title: selected.title ?? pseudo.title,
    };
    const parsedChoice = parseDisplayArtistTitle(choice);
    const resolvedTitle = buildAutoDisplayTitle(selected.title, parsedChoice.artist, parsedChoice.title);
    const hintedDuration = selected.duration;
    if (!isAllowedAutoTrack(resolvedTitle, hintedDuration)) {
      return null;
    }
    pendingAutoUpcoming = {
      youtube_id: 'auto',
      title: resolvedTitle,
      thumbnail: selected.thumbnail ?? null,
      duration: hintedDuration,
      added_by: null,
      isFallback: true,
      selection_label: 'Autoplay online (liked)',
      selection_playlist: null,
      selection_tab: 'online',
      selection_key: `auto:${LIKED_AUTO_GENRE_ID}`,
    };
    broadcastUpcomingTrack();
    const audioFile = await downloadAudio(selectedPseudo, _cacheDir);
    if (!isAutoSourceStillActive(expectedSourceKey)) {
      if (!keepFiles) cleanupFile(audioFile);
      pendingAutoUpcoming = null;
      broadcastUpcomingTrack();
      return null;
    }
    const fileDuration = await getAudioDuration(audioFile);
    if (fileDuration === null) {
      if (!keepFiles) cleanupFile(audioFile);
      pendingAutoUpcoming = null;
      broadcastUpcomingTrack();
      console.warn(`[auto-download] Rejected (unknown duration) (liked): ${resolvedTitle}`);
      return null;
    }
    const finalDuration = hintedDuration ?? fileDuration;
    if (!isAllowedAutoTrack(resolvedTitle, finalDuration)) {
      if (!keepFiles) cleanupFile(audioFile);
      pendingAutoUpcoming = null;
      broadcastUpcomingTrack();
      console.warn(`[auto-download] Rejected by duration (liked): ${resolvedTitle} (${finalDuration}s)`);
      return null;
    }
    rememberAutoTrackKey(choice);
    pendingAutoUpcoming = null;
    const forceDualMono = await shouldForceDualMono(audioFile);
    console.log(`[auto-download] Ready (liked): ${resolvedTitle} (${finalDuration}s)`);
    return {
      audioFile,
      title: resolvedTitle,
      thumbnail: selected.thumbnail ?? null,
      youtubeId: 'local',
      duration: finalDuration,
      addedBy: null,
      queueItemId: null,
      isFallback: true,
      isAutoFallback: true,
      cleanupAfterUse: true,
      forceDualMono,
      selectionLabel: 'Autoplay online (liked)',
      selectionPlaylist: null,
      selectionTab: 'online',
      selectionKey: `auto:${LIKED_AUTO_GENRE_ID}`,
    };
  } catch (err) {
    pendingAutoUpcoming = null;
    broadcastUpcomingTrack();
    console.warn(`[player] Liked auto fallback prepare failed: ${(err as Error).message}`);
    return null;
  }
}

async function prepareSharedAutoFallbackTrack(
  playlistId: string,
  playbackMode: SharedAutoPlaybackMode = 'random',
  expectedSourceKeyOverride?: string,
): Promise<ReadyTrack | null> {
  const expectedSourceKey = expectedSourceKeyOverride ?? `shared:${playlistId}`;
  try {
    if (!isAutoSourceStillActive(expectedSourceKey)) return null;
    const tracks = await getSharedPlaylistTracks(playlistId);
    if (!tracks || tracks.length === 0) return null;

    const candidates = tracks
      .map((track) => {
        const title = (track.title ?? '').trim();
        const artist = (track.artist ?? '').trim();
        const searchArtist = artist ? normalizeArtistSearchQuery(artist) : '';
        const query = searchArtist ? `${searchArtist} - ${title}` : title;
        const recentKey = artist ? `${artist} - ${title}` : title;
        return {
          title,
          artist: artist || null,
          query: query.trim(),
          recentKey: sanitizeDisplayText(recentKey),
          cycleKey: normalizeAutoKey(`${artist} ${title}`),
          thumbnail: null as string | null,
        };
      })
      .filter((entry) => entry.title.length > 0 && entry.query.length > 0);

    if (candidates.length === 0) return null;

    const fresh = candidates.filter((entry) =>
      !recentAutoTrackKeys.includes(normalizeAutoKey(entry.recentKey)),
    );
    const pool = fresh.length > 0 ? fresh : candidates;
    let choice: typeof pool[number] | undefined;
    if (playbackMode === 'ordered') {
      const cursor = sharedPlaylistOrderCursor.get(playlistId) ?? 0;
      const index = ((cursor % pool.length) + pool.length) % pool.length;
      choice = pool[index];
      sharedPlaylistOrderCursor.set(playlistId, (index + 1) % pool.length);
    } else {
      const playedSet = sharedPlaylistRandomPlayedKeys.get(playlistId) ?? new Set<string>();
      let randomPool = pool.filter((entry) => !playedSet.has(entry.cycleKey));
      if (randomPool.length === 0) {
        playedSet.clear();
        randomPool = pool;
      }
      choice = randomPool[Math.floor(Math.random() * randomPool.length)];
      sharedPlaylistRandomPlayedKeys.set(playlistId, playedSet);
    }
    if (!choice) return null;

    console.log(`[auto-download] Trying (shared:${playlistId}): ${choice.query}`);
    const pseudo = buildAutoFallbackSourceForQuery(`shared_${playlistId}`, choice.query);
    let selected = await resolveShortAutoCandidate(choice.query, undefined, {
      expectedArtist: choice.artist,
      expectedTitle: choice.title,
      strictMetadata: true,
    });
    if (!selected && choice.title) {
      // Retry with a looser query to handle edge-cases where artist-prefix blocks discovery.
      selected = await resolveShortAutoCandidate(choice.title, undefined, {
        expectedArtist: choice.artist,
        expectedTitle: choice.title,
        strictMetadata: true,
      });
    }
    if (!isAutoSourceStillActive(expectedSourceKey)) return null;
    if (!selected) {
      recordMissingTrackLookup({
        source: 'auto_shared',
        query: choice.query,
        strictMetadata: true,
        expectedArtist: choice.artist,
        expectedTitle: choice.title,
      });
      console.warn(`[auto-download] No short candidate (shared:${playlistId}) for query: ${choice.query}`);
      return null;
    }

    const selectedPseudo: QueueItem = {
      ...pseudo,
      youtube_url: selected.url,
      title: selected.title ?? pseudo.title,
    };
    const resolvedTitle = buildAutoDisplayTitle(selected.title, choice.artist, choice.title);
    const hintedDuration = selected.duration;
    if (!isAllowedAutoTrack(resolvedTitle, hintedDuration)) {
      return null;
    }

    pendingAutoUpcoming = {
      youtube_id: 'auto',
      title: resolvedTitle,
      thumbnail: selected.thumbnail ?? null,
      duration: hintedDuration,
      added_by: null,
      isFallback: true,
      selection_label: 'Autoplay playlist',
      selection_playlist: null,
      selection_tab: 'playlists',
      selection_key: `shared:${playlistId}`,
    };
    broadcastUpcomingTrack();

    const audioFile = await downloadAudio(selectedPseudo, _cacheDir);
    if (!isAutoSourceStillActive(expectedSourceKey)) {
      if (!keepFiles) cleanupFile(audioFile);
      pendingAutoUpcoming = null;
      broadcastUpcomingTrack();
      return null;
    }

    const fileDuration = await getAudioDuration(audioFile);
    if (fileDuration === null) {
      if (!keepFiles) cleanupFile(audioFile);
      pendingAutoUpcoming = null;
      broadcastUpcomingTrack();
      console.warn(`[auto-download] Rejected (unknown duration) (shared:${playlistId}): ${resolvedTitle}`);
      return null;
    }

    const finalDuration = hintedDuration ?? fileDuration;
    if (!isAllowedAutoTrack(resolvedTitle, finalDuration)) {
      if (!keepFiles) cleanupFile(audioFile);
      pendingAutoUpcoming = null;
      broadcastUpcomingTrack();
      console.warn(`[auto-download] Rejected by duration (shared:${playlistId}): ${resolvedTitle} (${finalDuration}s)`);
      return null;
    }

    const playedSet = sharedPlaylistRandomPlayedKeys.get(playlistId) ?? new Set<string>();
    playedSet.add(choice.cycleKey);
    sharedPlaylistRandomPlayedKeys.set(playlistId, playedSet);
    rememberAutoTrackKey(choice.recentKey);
    pendingAutoUpcoming = null;
    const forceDualMono = await shouldForceDualMono(audioFile);
    console.log(`[auto-download] Ready (shared:${playlistId}): ${resolvedTitle} (${finalDuration}s)`);
    return {
      audioFile,
      title: resolvedTitle,
      thumbnail: selected.thumbnail ?? null,
      youtubeId: 'local',
      duration: finalDuration,
      addedBy: null,
      queueItemId: null,
      isFallback: true,
      isAutoFallback: true,
      cleanupAfterUse: true,
      forceDualMono,
      selectionLabel: 'Autoplay playlist',
      selectionPlaylist: null,
      selectionTab: 'playlists',
      selectionKey: `shared:${playlistId}`,
    };
  } catch (err) {
    pendingAutoUpcoming = null;
    broadcastUpcomingTrack();
    console.warn(`[player] Shared auto fallback prepare failed (${playlistId}): ${(err as Error).message}`);
    return null;
  }
}

async function prepareAutoSourceTrack(source: ActiveAutoSource): Promise<ReadyTrack | null> {
  if (source.type === 'liked') return prepareLikedAutoFallbackTrack();
  if (source.type === 'genre') return prepareAutoFallbackByGenre(source.genreId);
  if (source.type === 'shared') return prepareSharedAutoFallbackTrack(source.playlistId, source.playbackMode);
  if (source.items.length === 0) return null;

  const start = mixedAutoSourceCursor % source.items.length;
  for (let attempt = 0; attempt < source.items.length; attempt += 1) {
    const idx = (start + attempt) % source.items.length;
    const item = source.items[idx];
    let ready: ReadyTrack | null = null;
    if (item.type === 'liked') {
      ready = await prepareLikedAutoFallbackTrack(source.key);
    } else if (item.type === 'genre') {
      ready = await prepareAutoFallbackByGenre(item.genreId, source.key);
    } else {
      ready = await prepareSharedAutoFallbackTrack(item.playlistId, item.playbackMode, source.key);
    }
    if (ready) {
      mixedAutoSourceCursor = (idx + 1) % source.items.length;
      return ready;
    }
  }
  return null;
}

async function waitForAutoReadyMinimum(sb: SupabaseClient, cacheDir: string, minCount: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isRunning && Date.now() < deadline && getAutoReadyCount() < minCount) {
    await ensureAutoReadyBuffer(sb, cacheDir, minCount);
    if (getAutoReadyCount() >= minCount) break;
    await sleep(AUTO_READY_WAIT_STEP_MS);
  }
}

function getAudioDuration(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 10_000 });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('close', () => {
      const dur = parseFloat(output.trim());
      resolve(isNaN(dur) ? null : Math.round(dur));
    });
    proc.on('error', () => resolve(null));
  });
}

const fallbackArtworkCache = new Map<string, string | null>();
const FALLBACK_ART_MAX_BYTES = 2 * 1024 * 1024;

function normalizeTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function tokenOverlapRatio(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  let hits = 0;
  for (const token of ta) {
    if (setB.has(token)) hits += 1;
  }
  return hits / ta.length;
}

function mimeForImageExtension(ext: string): string | null {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

function toDataUrlFromFile(imagePath: string): string | null {
  try {
    const ext = path.extname(imagePath);
    const mime = mimeForImageExtension(ext);
    if (!mime) return null;
    const stat = fs.statSync(imagePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > FALLBACK_ART_MAX_BYTES) return null;
    const buf = fs.readFileSync(imagePath);
    if (buf.length === 0) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function extractEmbeddedArtworkDataUrl(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-an',
      '-vcodec', 'mjpeg',
      '-frames:v', '1',
      '-f', 'image2pipe',
      'pipe:1',
    ], { timeout: 12_000 });

    const chunks: Buffer[] = [];
    let total = 0;
    let resolved = false;

    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (resolved) return;
      total += chunk.length;
      if (total > FALLBACK_ART_MAX_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });

    proc.on('close', () => {
      if (resolved) return;
      if (chunks.length === 0) {
        finish(null);
        return;
      }
      const img = Buffer.concat(chunks);
      if (img.length === 0) {
        finish(null);
        return;
      }
      finish(`data:image/jpeg;base64,${img.toString('base64')}`);
    });

    proc.on('error', () => finish(null));
  });
}

async function getFallbackArtworkDataUrl(filePath: string): Promise<string | null> {
  if (fallbackArtworkCache.has(filePath)) {
    return fallbackArtworkCache.get(filePath) ?? null;
  }

  const guessedTitle = titleFromFilename(filePath);
  const splitIdx = guessedTitle.indexOf(' - ');
  const guessedArtist = splitIdx > 0 ? guessedTitle.slice(0, splitIdx).trim() : '';
  const guessedTrackTitle = splitIdx > 0 ? guessedTitle.slice(splitIdx + 3).trim() : guessedTitle;

  // Match DJ-mode source, but only trust remote artwork for high-confidence artist/title matches.
  if (guessedArtist && guessedTrackTitle) {
    const candidate = await fetchArtworkCandidate(guessedArtist, guessedTrackTitle);
    if (candidate?.artworkUrl) {
      const artistScore = tokenOverlapRatio(guessedArtist, candidate.artistName ?? '');
      const titleScore = tokenOverlapRatio(guessedTrackTitle, candidate.trackName ?? '');
      if (artistScore >= 0.5 && titleScore >= 0.4) {
        fallbackArtworkCache.set(filePath, candidate.artworkUrl);
        return candidate.artworkUrl;
      }
    }
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const sidecarCandidates = [
    path.join(dir, `${base}.jpg`),
    path.join(dir, `${base}.jpeg`),
    path.join(dir, `${base}.png`),
    path.join(dir, `${base}.webp`),
    path.join(dir, 'cover.jpg'),
    path.join(dir, 'cover.jpeg'),
    path.join(dir, 'cover.png'),
    path.join(dir, 'folder.jpg'),
    path.join(dir, 'folder.jpeg'),
    path.join(dir, 'folder.png'),
    path.join(dir, 'AlbumArtSmall.jpg'),
  ];

  for (const candidate of sidecarCandidates) {
    const dataUrl = toDataUrlFromFile(candidate);
    if (dataUrl) {
      fallbackArtworkCache.set(filePath, dataUrl);
      return dataUrl;
    }
  }

  const embedded = await extractEmbeddedArtworkDataUrl(filePath);
  fallbackArtworkCache.set(filePath, embedded);
  return embedded;
}

const MAX_PRELOAD = 5;
const PRELOAD_REFRESH_MS = 5000;
const AUTO_READY_START_MIN = 1; // start streaming as soon as first auto track is ready
const AUTO_READY_MIN = 5; // keep warming buffer up to target
const AUTO_READY_MAX = 5;
const AUTO_PRELOAD_COOLDOWN_MS = 7000;
const AUTO_IMMEDIATE_PREPARE_TIMEOUT_MS = 1400;
const AUTO_READY_WAIT_TIMEOUT_MS = 14_000;
const AUTO_READY_WAIT_STEP_MS = 350;

interface PreloadedTrack {
  item: QueueItem;
  audioFile: string;
  duration: number | null;
  forceDualMono: boolean;
}

let preloadBuffer: PreloadedTrack[] = [];
let preloading = false;
let preloadRefreshTimer: ReturnType<typeof setInterval> | null = null;

let _sb: SupabaseClient | null = null;
let _cacheDir = '';

interface ReadyTrack {
  audioFile: string;
  title: string | null;
  thumbnail: string | null;
  youtubeId: string;
  duration: number | null;
  addedBy: string | null;
  queueItemId: string | null;
  isFallback: boolean;
  isAutoFallback: boolean;
  cleanupAfterUse: boolean;
  forceDualMono: boolean;
  selectionLabel: string | null;
  selectionPlaylist: string | null;
  selectionTab: SelectionTab | null;
  selectionKey: string | null;
}

let nextReady: ReadyTrack | null = null;
let preparingNext = false;
let autoBufferFilling = false;
let lastAutoPreloadAttemptAt = 0;
let activePlaybackFile: string | null = null;
let currentQueueItemId: string | null = null;
let lastUpcomingKey: string | null = null;
let lastFallbackFile: string | null = null;
let pendingQueueUpcoming: UpcomingTrack | null = null;
let pendingAutoUpcoming: UpcomingTrack | null = null;
let autoReadyBuffer: ReadyTrack[] = [];
const prepareFailCounts = new Map<string, number>();
const PREPARE_FAIL_MAX = 3;
let tracksSinceLastJingle = 0;
let lastJinglePath: string | null = null;
const channelRepairCache = new Map<string, boolean>();

function listJingleFiles(): string[] {
  if (!JINGLE_ENABLE || !JINGLE_DIR) return [];
  try {
    const entries = fs.readdirSync(JINGLE_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(JINGLE_DIR, entry.name))
      .filter((fullPath) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(fullPath));
  } catch {
    return [];
  }
}

function pickJingleFile(): string | null {
  const files = listJingleFiles();
  if (files.length === 0) return null;
  if (files.length === 1) return files[0] ?? null;
  const pool = files.filter((fullPath) => fullPath !== lastJinglePath);
  const pickedPool = pool.length > 0 ? pool : files;
  const picked = pickedPool[Math.floor(Math.random() * pickedPool.length)] ?? null;
  return picked;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

async function shouldForceDualMono(audioFile: string): Promise<boolean> {
  if (!STREAM_CHANNEL_REPAIR_ENABLE) return false;
  const cached = channelRepairCache.get(audioFile);
  if (cached !== undefined) return cached;

  const decision = await new Promise<boolean>((resolve) => {
    const probe = spawn('ffmpeg', [
      '-hide_banner',
      '-t', '12',
      '-i', audioFile,
      '-vn',
      '-af', 'astats=metadata=1:reset=1',
      '-f', 'null',
      '-',
    ], { timeout: 12_000 });

    let stderr = '';
    probe.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 300_000) stderr = stderr.slice(-300_000);
    });

    probe.on('close', () => {
      const left: number[] = [];
      const right: number[] = [];
      let channel = 0;
      for (const rawLine of stderr.split(/\r?\n/)) {
        const line = rawLine.trim();
        const channelMatch = line.match(/Channel:\s*([12])/i);
        if (channelMatch?.[1]) {
          channel = Number.parseInt(channelMatch[1], 10);
          continue;
        }
        const rmsMatch = line.match(/RMS level dB:\s*(-?[\d.]+|-\s*inf)/i);
        if (!rmsMatch?.[1] || (channel !== 1 && channel !== 2)) continue;
        const token = rmsMatch[1].replace(/\s+/g, '').toLowerCase();
        const value = token.includes('inf') ? -120 : Number.parseFloat(token);
        if (!Number.isFinite(value)) continue;
        if (channel === 1) left.push(value);
        else right.push(value);
      }

      const leftAvg = average(left);
      const rightAvg = average(right);
      if (leftAvg === null || rightAvg === null) {
        resolve(false);
        return;
      }
      const weaker = Math.min(leftAvg, rightAvg);
      const diff = Math.abs(leftAvg - rightAvg);
      resolve(weaker <= STREAM_CHANNEL_REPAIR_SILENT_DB && diff >= STREAM_CHANNEL_REPAIR_DIFF_DB);
    });

    probe.on('error', () => resolve(false));
  });

  channelRepairCache.set(audioFile, decision);
  if (decision) {
    console.warn(`[audio] Channel repair enabled for ${path.basename(audioFile)} (likely one-sided source)`);
  }
  return decision;
}

function isProtectedPlaybackFile(filePath: string): boolean {
  if (!filePath) return false;
  if (activePlaybackFile === filePath) return true;
  if (nextReady?.audioFile === filePath) return true;
  if (autoReadyBuffer.some((entry) => entry.audioFile === filePath)) return true;
  if (preloadBuffer.some((entry) => entry.audioFile === filePath)) return true;
  if (pendingSwap?.ready.audioFile === filePath) return true;
  if (completedSwap?.ready.audioFile === filePath) return true;
  return false;
}

function cleanupFileIfSafe(filePath: string, reason: string): void {
  if (!filePath || keepFiles) return;
  if (isProtectedPlaybackFile(filePath)) {
    console.warn(`[cleanup] Skipped protected file (${reason}): ${filePath}`);
    return;
  }
  cleanupFile(filePath);
}

function maybePruneKeptFiles(reason: string): void {
  if (!keepFiles || !_cacheDir) return;
  const now = Date.now();
  if (now - lastKeepFilesPruneAt < KEEP_FILES_PRUNE_INTERVAL_MS) return;
  lastKeepFilesPruneAt = now;
  try {
    const names = fs.readdirSync(_cacheDir);
    const entries = names
      .map((name) => {
        const fullPath = path.join(_cacheDir, name);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) return null;
          return { fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    let prunedCount = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const tooOld = now - entry.mtimeMs > KEEP_FILES_MAX_AGE_MS;
      const overflow = i >= KEEP_FILES_MAX_COUNT;
      if (!tooOld && !overflow) continue;
      if (isProtectedPlaybackFile(entry.fullPath)) continue;
      cleanupFile(entry.fullPath);
      prunedCount += 1;
    }
    if (prunedCount > 0) {
      console.log(`[cleanup] Pruned ${prunedCount} kept cache file(s) (${reason}); keep max=${KEEP_FILES_MAX_COUNT}, age<=${Math.round(KEEP_FILES_MAX_AGE_MS / 60000)}m`);
    }
  } catch (err) {
    console.warn('[cleanup] Keep-files prune failed:', err);
  }
}

export function getCurrentTrack(): Track | null {
  return currentTrack;
}

export function isPlayCycleRunning(): boolean {
  return isRunning;
}

export function getUpcomingTrack(): UpcomingTrack | null {
  if (nextReady) {
    return {
      youtube_id: nextReady.youtubeId,
      title: nextReady.title,
      thumbnail: nextReady.thumbnail,
      duration: nextReady.duration,
      added_by: nextReady.addedBy,
      isFallback: nextReady.isFallback,
      selection_label: null,
      selection_playlist: null,
      selection_tab: null,
      selection_key: null,
    };
  }
  if (preloadBuffer.length > 0) {
    const first = preloadBuffer[0];
    return {
      youtube_id: first.item.youtube_id,
      title: first.item.title ?? null,
      thumbnail: first.item.thumbnail ?? null,
      duration: first.duration,
      added_by: first.item.added_by ?? null,
      isFallback: false,
      selection_label: queueSelectionMetaByItemId.get(first.item.id)?.selectionLabel ?? null,
      selection_playlist: queueSelectionMetaByItemId.get(first.item.id)?.selectionPlaylist ?? null,
      selection_tab: queueSelectionMetaByItemId.get(first.item.id)?.selectionTab ?? 'queue',
      selection_key: queueSelectionMetaByItemId.get(first.item.id)?.selectionKey ?? null,
    };
  }
  if (pendingQueueUpcoming) {
    return pendingQueueUpcoming;
  }
  if (autoReadyBuffer.length > 0) {
    const first = autoReadyBuffer[0];
    return {
      youtube_id: first.youtubeId,
      title: first.title,
      thumbnail: first.thumbnail,
      duration: first.duration,
      added_by: first.addedBy,
      isFallback: first.isFallback,
      selection_label: null,
      selection_playlist: null,
      selection_tab: null,
      selection_key: null,
    };
  }
  if (pendingAutoUpcoming) {
    return pendingAutoUpcoming;
  }
  return null;
}

async function refreshPendingQueueUpcoming(sb: SupabaseClient, currentItemId: string | null): Promise<void> {
  try {
    const queue = await getQueue(sb);
    const next = pickNextQueueItem(queue, currentItemId, currentQueueItemId);
    if (!next) {
      pendingQueueUpcoming = null;
      broadcastUpcomingTrack();
      return;
    }
    pendingQueueUpcoming = {
      youtube_id: next.youtube_id,
      title: next.title ?? null,
      thumbnail: next.thumbnail ?? null,
      duration: null,
      added_by: next.added_by ?? null,
      isFallback: false,
      selection_label: queueSelectionMetaByItemId.get(next.id)?.selectionLabel ?? null,
      selection_playlist: queueSelectionMetaByItemId.get(next.id)?.selectionPlaylist ?? null,
      selection_tab: queueSelectionMetaByItemId.get(next.id)?.selectionTab ?? 'queue',
      selection_key: queueSelectionMetaByItemId.get(next.id)?.selectionKey ?? null,
    };
    broadcastUpcomingTrack();
  } catch {
    // Keep current preview if queue can't be read now.
  }
}

function broadcastUpcomingTrack(): void {
  const upcoming = getUpcomingTrack();
  const key = upcoming
    ? `${upcoming.youtube_id}|${upcoming.title ?? ''}|${upcoming.isFallback ? '1' : '0'}`
    : 'none';
  if (key === lastUpcomingKey) return;
  lastUpcomingKey = key;
  _io?.emit('upcoming:update', upcoming);
}

function killDecoderProcess(dec: ChildProcess | null): void {
  if (!dec || !dec.pid || dec.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(dec.pid), '/f', '/t']);
    } else {
      process.kill(dec.pid, 'SIGTERM');
    }
  } catch {}
}

function killEncoderProcess(enc: ChildProcess | null): void {
  if (!enc || !enc.pid || enc.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(enc.pid), '/f', '/t']);
    } else {
      process.kill(enc.pid, 'SIGTERM');
    }
  } catch {}
}

function markAudioProgress(): void {
  lastAudioProgressAt = Date.now();
  stallConsecutiveChecks = 0;
}

function triggerSelfHeal(reason: string): void {
  if (!isRunning) return;
  const now = Date.now();
  if (now - lastSelfHealAt < SELF_HEAL_COOLDOWN_MS) return;
  lastSelfHealAt = now;
  console.warn(`[self-heal] ${reason}`);

  if (pendingSwap) {
    killDecoderProcess(pendingSwap.newDecoder);
    pendingSwap = null;
  }
  completedSwap = null;
  skipWhenReady = false;
  setSkipLock(false);

  if (nextReady?.cleanupAfterUse) {
    cleanupFileIfSafe(nextReady.audioFile, 'triggerSelfHeal:nextReady');
  }
  nextReady = null;
  pendingQueueUpcoming = null;
  pendingAutoUpcoming = null;
  broadcastUpcomingTrack();

  killDecoderProcess(currentDecoder);
  currentDecoder = null;

  if (encoder?.stdin && !encoder.stdin.destroyed) {
    try { encoder.stdin.end(); } catch {}
  }
  killEncoderProcess(encoder);
  encoder = null;

  if (_sb && isRunning) {
    lastPrepareKickAt = Date.now();
    void refreshPendingQueueUpcoming(_sb, currentTrack?.id ?? null);
    void fillPreloadBuffer(_sb, _cacheDir, currentTrack?.id ?? null);
    void ensureAutoReadyBuffer(_sb, _cacheDir);
    void prepareNextTrack(_sb, _cacheDir, currentTrack?.id ?? null);
  }
}

function runSelfHealChecks(): void {
  if (!isRunning || !_sb) return;
  const now = Date.now();
  maybePruneKeptFiles('runtime');
  const inStartupGrace = now < selfHealGraceUntil;

  if (skipWhenReady && nextReady && (!encoder?.stdin || encoder.stdin.destroyed)) {
    triggerSelfHeal('skip pending while encoder unavailable');
    return;
  }

  if (!inStartupGrace && currentTrack?.duration && Number.isFinite(currentTrack.duration) && currentTrack.duration > 0) {
    const startedAt = currentTrack.started_at - STREAM_DELAY_MS;
    const elapsedMs = now - startedAt;
    const maxExpectedMs = (currentTrack.duration + SELF_HEAL_DURATION_GRACE_SECONDS) * 1000;
    if (elapsedMs > maxExpectedMs) {
      triggerSelfHeal(`track runtime exceeded (${Math.round(elapsedMs / 1000)}s)`);
      return;
    }
  }

  if (!inStartupGrace && currentTrack) {
    const idleMs = now - Math.max(lastAudioProgressAt, lastTrackAnnouncedAt);
    if (idleMs > SELF_HEAL_STALL_MS) {
      stallConsecutiveChecks += 1;
      if (stallConsecutiveChecks < SELF_HEAL_STALL_CONFIRM_CHECKS) {
        console.warn(`[self-heal] stall detected (${Math.round(idleMs / 1000)}s), waiting confirm ${stallConsecutiveChecks}/${SELF_HEAL_STALL_CONFIRM_CHECKS}`);
        return;
      }
      triggerSelfHeal(`audio stalled for ${Math.round(idleMs / 1000)}s`);
      return;
    }
    stallConsecutiveChecks = 0;
  } else {
    stallConsecutiveChecks = 0;
  }

  if (!nextReady && now - lastPrepareKickAt > 15_000) {
    lastPrepareKickAt = now;
    void prepareNextTrack(_sb, _cacheDir, currentTrack?.id ?? null);
    void ensureAutoReadyBuffer(_sb, _cacheDir);
  }
}

function beginSeamlessSwap(ready: ReadyTrack): void {
  const newDecoder = spawn('ffmpeg', [
    '-hide_banner', '-re',
    '-i', ready.audioFile,
    ...getDecoderFilterArgs(ready.forceDualMono),
    '-vn', '-f', 's16le', '-ar', '44100', '-ac', '2',
    'pipe:1',
  ]);

  const swap: PendingSwap = { newDecoder, ready, firstChunk: null };
  pendingSwap = swap;

  newDecoder.stdout?.once('data', (chunk: Buffer) => {
    swap.firstChunk = chunk;
    newDecoder.stdout?.pause();
  });

  newDecoder.stderr?.on('data', () => {});
  newDecoder.on('error', () => {
    if (pendingSwap === swap) {
      pendingSwap = null;
      setSkipLock(false);
    }
  });
}

export function skipCurrentTrack(): void {
  if (skipLocked) return;

  // Cancel any in-flight swap first
  if (pendingSwap) {
    killDecoderProcess(pendingSwap.newDecoder);
    pendingSwap = null;
  }

  setSkipLock(true);

  if (nextReady && encoder?.stdin && !encoder.stdin.destroyed) {
    // ── Seamless skip: pre-spawn new decoder, old track keeps playing ──
    const ready = nextReady;
    nextReady = null;
    broadcastUpcomingTrack();
    beginSeamlessSwap(ready);
    console.log('[player] Skip: old track continues until new decoder is ready');
  } else {
    // No next track ready yet — old track keeps playing until prepareNextTrack finishes
    skipWhenReady = true;
    console.log('[player] Skip: waiting for next track to be ready (old track keeps playing)');
  }
}

export function setKeepFiles(keep: boolean): void {
  keepFiles = keep;
}

export function invalidatePreload(): void {
  if (nextReady && nextReady.cleanupAfterUse) {
    cleanupFileIfSafe(nextReady.audioFile, 'invalidatePreload:nextReady');
  }
  nextReady = null;
  broadcastUpcomingTrack();
  if (preloadBuffer.length === 0) return;
  for (const p of preloadBuffer) {
    cleanupFileIfSafe(p.audioFile, 'invalidatePreload:preloadBuffer');
  }
  preloadBuffer = [];
  for (const entry of autoReadyBuffer) {
    if (entry.cleanupAfterUse) cleanupFileIfSafe(entry.audioFile, 'invalidatePreload:autoReadyBuffer');
  }
  autoReadyBuffer = [];
  console.log('[preload] Buffer invalidated');
  broadcastUpcomingTrack();
}

export function invalidateNextReady(): void {
  if (!nextReady) return;
  if (nextReady.cleanupAfterUse) {
    cleanupFileIfSafe(nextReady.audioFile, 'invalidateNextReady');
  }
  nextReady = null;
  broadcastUpcomingTrack();
}

export function removeQueueItemFromPreload(itemId: string): void {
  if (!itemId) return;

  if (nextReady?.queueItemId === itemId) {
    if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'removeQueueItemFromPreload:nextReady');
    nextReady = null;
  }

  const removed = preloadBuffer.filter((p) => p.item.id === itemId);
  if (removed.length > 0) {
    for (const entry of removed) {
      cleanupFileIfSafe(entry.audioFile, 'removeQueueItemFromPreload:preloadBuffer');
    }
    preloadBuffer = preloadBuffer.filter((p) => p.item.id !== itemId);
  }

  if (removed.length > 0) {
    console.log(`[preload] Removed stale preloaded item: ${itemId}`);
  }
  broadcastUpcomingTrack();
}

function takeFromBuffer(itemId: string): PreloadedTrack | null {
  const idx = preloadBuffer.findIndex((p) => p.item.id === itemId);
  if (idx === -1) return null;
  const [found] = preloadBuffer.splice(idx, 1);
  broadcastUpcomingTrack();
  return found;
}

function isInBuffer(itemId: string): boolean {
  return preloadBuffer.some((p) => p.item.id === itemId);
}

function takeAutoReadyFromBuffer(previousTitle?: string | null): ReadyTrack | null {
  if (autoReadyBuffer.length === 0) return null;
  const previousArtist = getNormalizedDisplayArtist(previousTitle);
  let next: ReadyTrack | null = null;

  if (previousArtist) {
    const preferredIdx = autoReadyBuffer.findIndex((entry) => {
      const artist = getNormalizedDisplayArtist(entry.title);
      return !!artist && artist !== previousArtist;
    });
    if (preferredIdx > 0) {
      const [picked] = autoReadyBuffer.splice(preferredIdx, 1);
      next = picked ?? null;
      if (next) {
        const nextArtist = getNormalizedDisplayArtist(next.title);
        console.log(`[auto-playlist] Avoided back-to-back artist: ${previousArtist} -> ${nextArtist ?? 'unknown'}`);
      }
    } else if (preferredIdx === 0) {
      next = autoReadyBuffer.shift() ?? null;
    }
  }

  if (!next) {
    next = autoReadyBuffer.shift() ?? null;
  }
  broadcastUpcomingTrack();
  return next;
}

function getAutoReadyCount(): number {
  return autoReadyBuffer.length + (nextReady?.isAutoFallback ? 1 : 0);
}

function pickNextQueueItem(
  queue: QueueItem[],
  currentItemId: string | null,
  reservedItemId: string | null,
): QueueItem | null {
  const next = queue.find((q) => q.id !== currentItemId && q.id !== reservedItemId);
  return next ?? null;
}

function clearPrepareFailure(itemId: string | null | undefined): void {
  if (!itemId) return;
  prepareFailCounts.delete(itemId);
}

async function markUnplayableQueueItem(
  sb: SupabaseClient,
  item: QueueItem,
  context: 'prepare' | 'preload',
  reason: string,
): Promise<boolean> {
  const fails = (prepareFailCounts.get(item.id) ?? 0) + 1;
  prepareFailCounts.set(item.id, fails);

  if (fails < PREPARE_FAIL_MAX) {
    console.warn(`[${context}] Failed ${fails}/${PREPARE_FAIL_MAX} for ${item.title ?? item.youtube_id}: ${reason}`);
    return false;
  }

  console.warn(`[${context}] Removing unplayable queue item after ${fails} failed attempts: ${item.title ?? item.youtube_id}`);
  clearPrepareFailure(item.id);

  try {
    await clearQueueItem(sb, item.id);
  } catch (err) {
    console.warn(`[${context}] Failed to remove broken queue item: ${(err as Error).message}`);
    return false;
  }

  // Remove stale preloaded files for this queue item.
  const stalePreloads = preloadBuffer.filter((p) => p.item.id === item.id);
  if (stalePreloads.length > 0) {
    for (const p of stalePreloads) {
      if (!keepFiles) cleanupFile(p.audioFile);
    }
    preloadBuffer = preloadBuffer.filter((p) => p.item.id !== item.id);
  }

  // If the queued item was already prepared as nextReady, invalidate it.
  if (nextReady?.queueItemId === item.id) {
    if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'markUnplayableQueueItem:nextReady');
    nextReady = null;
  }

  _io?.emit('error:toast', { message: `Overgeslagen: ${item.title ?? item.youtube_id} (niet beschikbaar)` });
  const q = await getQueue(sb);
  _io?.emit('queue:update', { items: q });
  broadcastUpcomingTrack();
  return true;
}

export type IcecastConfig = { host: string; port: number; password: string; mount: string };

let _streamHub: StreamHub | null = null;
let _icecast: IcecastConfig | null = null;

function ensureEncoder(): ChildProcess {
  const encoderHasWritableStdin = !!encoder?.stdin && !encoder.stdin.destroyed && encoder.stdin.writable;
  if (encoder && !encoder.killed && encoder.exitCode === null && encoderHasWritableStdin) return encoder;
  if (encoder && (!encoderHasWritableStdin || encoder.killed || encoder.exitCode !== null)) {
    // Stale encoder process: force replacement so decode never writes into dead stdin.
    killEncoderProcess(encoder);
    encoder = null;
  }

  let nextEncoder: ChildProcess;
  if (_icecast) {
    const icecastUrl = `icecast://source:${_icecast.password}@${_icecast.host}:${_icecast.port}${_icecast.mount}`;
    console.log('[encoder] Starting persistent encoder → Icecast');

    nextEncoder = spawn('ffmpeg', [
      '-hide_banner',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-i', 'pipe:0',
      ...getEncoderFilterArgs(),
      '-acodec', 'libmp3lame',
      ...getEncoderRateArgs(),
      '-f', 'mp3',
      '-content_type', 'audio/mpeg',
      icecastUrl,
    ]);
  } else {
    console.log('[encoder] Starting persistent encoder → StreamHub (stdout)');

    nextEncoder = spawn('ffmpeg', [
      '-hide_banner',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-i', 'pipe:0',
      ...getEncoderFilterArgs(),
      '-acodec', 'libmp3lame',
      ...getEncoderRateArgs(),
      '-f', 'mp3',
      'pipe:1',
    ]);

    nextEncoder.stdout?.on('data', (chunk: Buffer) => {
      _streamHub?.broadcast(chunk);
    });
  }

  encoder = nextEncoder;

  let encoderStderrTail = '';
  nextEncoder.stderr?.on('data', (chunk: Buffer) => {
    encoderStderrTail += chunk.toString();
    if (encoderStderrTail.length > 4000) {
      encoderStderrTail = encoderStderrTail.slice(-4000);
    }
  });
  nextEncoder.stdin?.on('error', (err) => {
    // Ignore stale error events from an older encoder process.
    if (encoder !== nextEncoder) return;
    if ((!isRunning || isExpectedEncoderShutdownWindow()) && (isWriteAfterEndError(err) || isBrokenPipeError(err))) return;
    if (!isBrokenPipeError(err)) {
      console.warn(`[encoder] stdin error: ${err.message}`);
    }
    // Don't null the encoder here as it might still be usable for reading
  });

  nextEncoder.on('close', (code) => {
    // Ignore stale close events from an older encoder process.
    if (encoder !== nextEncoder) return;
    const winSystemCode = toWindowsSystemErrorCode(code);
    const tail = encoderStderrTail.trim().split('\n').slice(-2).join(' | ').trim();
    const suffix = tail ? ` — ${tail}` : '';
    if (isExpectedEncoderShutdownWindow() && (code === 0 || code === null || winSystemCode === 10053)) {
      console.log(`[encoder] Exited after expected stop${suffix}`);
    } else if (winSystemCode === 10053) {
      console.warn(`[encoder] Exited with code ${code} (Windows socket 10053: verbinding met Icecast verbroken)${suffix}`);
    } else if (code !== 0 && code !== null) {
      console.warn(`[encoder] Exited with error code ${code}${suffix}`);
    } else {
      console.log(`[encoder] Exited cleanly${suffix}`);
    }
    encoder = null;
    if (isRunning) {
      // Add a small delay to prevent rapid restart loops
      setTimeout(() => triggerSelfHeal(`encoder exited (${code})`), 500);
    }
  });

  nextEncoder.on('error', (err) => {
    // Ignore stale error events from an older encoder process.
    if (encoder !== nextEncoder) return;
    if (isExpectedEncoderShutdownWindow()) {
      console.log(`[encoder] Ignored expected error during shutdown: ${err.message}`);
      encoder = null;
      return;
    }
    console.error(`[encoder] Error: ${err.message}`);
    encoder = null;
    if (isRunning) {
      setTimeout(() => triggerSelfHeal(`encoder error (${err.message})`), 100);
    }
  });

  return nextEncoder;
}

export async function startPlayCycle(
  sb: SupabaseClient,
  io: IOServer,
  cacheDir: string,
  icecast: IcecastConfig | null,
  streamHub?: StreamHub | null,
): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  _sb = sb;
  _io = io;
  _cacheDir = cacheDir;
  _icecast = icecast;
  _streamHub = streamHub ?? null;
  selfHealGraceUntil = Date.now() + SELF_HEAL_START_GRACE_MS;
  expectedEncoderShutdownUntil = 0;
  lastAudioProgressAt = Date.now();
  lastTrackAnnouncedAt = Date.now();
  lastPrepareKickAt = Date.now();
  lastSelfHealAt = 0;
  stallConsecutiveChecks = 0;

  playerEvents.on('queue:add', () => {
    // Invalidate fallback nextReady so queued track gets priority
    if (nextReady?.isFallback) {
      if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'queue:add:invalidateFallbackNextReady');
      console.log('[prepare] Invalidated fallback — queue item added');
      nextReady = null;
    }
    pendingAutoUpcoming = null;
    pendingQueueUpcoming = null;
    broadcastUpcomingTrack();
    if (_sb) {
      void refreshPendingQueueUpcoming(_sb, currentTrack?.id ?? null);
      void fillPreloadBuffer(_sb, _cacheDir, currentTrack?.id ?? null);
      void ensureAutoReadyBuffer(_sb, _cacheDir);
      void prepareNextTrack(_sb, _cacheDir, currentTrack?.id ?? null);
    }
  });

  if (!preloadRefreshTimer) {
    preloadRefreshTimer = setInterval(() => {
      if (!_sb || !isRunning) return;
      void fillPreloadBuffer(_sb, _cacheDir, currentTrack?.id ?? null);
      void ensureAutoReadyBuffer(_sb, _cacheDir);
      void prepareNextTrack(_sb, _cacheDir, currentTrack?.id ?? null);
    }, PRELOAD_REFRESH_MS);
  }

  if (!selfHealTimer) {
    selfHealTimer = setInterval(() => {
      runSelfHealChecks();
    }, SELF_HEAL_CHECK_MS);
  }

  console.log('[player] Play cycle started');
  const failCounts = new Map<string, number>();
  const MAX_RETRIES = 2;

  while (isRunning) {
    try {
      await playNext(sb, io, cacheDir, failCounts, MAX_RETRIES);
    } catch (err) {
      console.error('[player] Cycle error:', err);
      io.emit('error:toast', { message: 'Afspeelfout — volgende nummer wordt geladen' });
      await sleep(2000);
    }
  }
}

export function stopPlayCycle(options?: { preserveCurrentTrack?: boolean }): void {
  isRunning = false;
  markExpectedEncoderShutdown();
  skipWhenReady = false;
  setSkipLock(false);
  if (skipLockWatchdog) {
    clearTimeout(skipLockWatchdog);
    skipLockWatchdog = null;
  }
  if (pendingSwap) {
    killDecoderProcess(pendingSwap.newDecoder);
    pendingSwap = null;
  }
  completedSwap = null;
  killDecoderProcess(currentDecoder);
  if (encoder && encoder.stdin) {
    encoder.stdin.end();
  }
  if (preloadRefreshTimer) {
    clearInterval(preloadRefreshTimer);
    preloadRefreshTimer = null;
  }
  if (selfHealTimer) {
    clearInterval(selfHealTimer);
    selfHealTimer = null;
  }
  if (autoReadyBuffer.length > 0) {
    for (const entry of autoReadyBuffer) {
      if (entry.cleanupAfterUse) cleanupFileIfSafe(entry.audioFile, 'stopPlayCycle:autoReadyBuffer');
    }
    autoReadyBuffer = [];
  }
  if (!options?.preserveCurrentTrack) {
    currentTrack = null;
  }
  pendingAutoUpcoming = null;
  pendingQueueUpcoming = null;
  broadcastUpcomingTrack();
}

async function fillPreloadBuffer(sb: SupabaseClient, cacheDir: string, currentId: string | null): Promise<void> {
  if (preloading) return;
  preloading = true;

  try {
    const queue = await getQueue(sb);
    const upcoming = queue
      .filter((q) => q.id !== currentId)
      .slice(0, MAX_PRELOAD);
    const upcomingIds = new Set(upcoming.map((q) => q.id));

    // Keep only tracks that are still in the first 5 upcoming queue slots.
    const stale = preloadBuffer.filter((p) => !upcomingIds.has(p.item.id));
    if (stale.length > 0) {
      for (const p of stale) {
        if (!keepFiles) cleanupFile(p.audioFile);
      }
      preloadBuffer = preloadBuffer.filter((p) => upcomingIds.has(p.item.id));
      console.log(`[preload] Dropped ${stale.length} stale preloaded track(s)`);
      broadcastUpcomingTrack();
    }

    const readyCount = preloadBuffer.length + (nextReady?.queueItemId ? 1 : 0);
    const slotsAvailable = Math.max(0, MAX_PRELOAD - readyCount);
    const toPreload = upcoming
      .filter((q) => !isInBuffer(q.id) && q.id !== nextReady?.queueItemId && !queueDownloadInFlight.has(q.id))
      .slice(0, slotsAvailable);

    for (const next of toPreload) {
      if (!isRunning) break;

      try {
        console.log(`[preload] Downloading (${preloadBuffer.length + 1}/${MAX_PRELOAD}): ${next.title ?? next.youtube_id}`);
        const { info, audioFile, forceDualMono } = await downloadQueueItemShared(next, cacheDir);

        const freshQueue = await getQueue(sb);
        if (!freshQueue.some((q) => q.id === next.id)) {
          if (!keepFiles) cleanupFile(audioFile);
          console.log(`[preload] Discarded (removed from queue): ${next.title ?? next.youtube_id}`);
          continue;
        }

        if (nextReady?.queueItemId === next.id) {
          if (!keepFiles && nextReady.audioFile !== audioFile) cleanupFile(audioFile);
          continue;
        }

        const existingBuffered = preloadBuffer.find((p) => p.item.id === next.id);
        if (existingBuffered) {
          if (!keepFiles && existingBuffered.audioFile !== audioFile) cleanupFile(audioFile);
          continue;
        }

        preloadBuffer.push({ item: next, audioFile, duration: info.duration, forceDualMono });
        console.log(`[preload] Ready (${preloadBuffer.length}/${MAX_PRELOAD}): ${next.title ?? next.youtube_id}`);
        broadcastUpcomingTrack();
      } catch (err) {
        const msg = describeError(err);
        console.warn(`[preload] Failed: ${next.title ?? next.youtube_id} — ${msg}`);
        await markUnplayableQueueItem(sb, next, 'preload', msg);
      }
    }
  } catch (err) {
    const msg = describeError(err);
    console.warn(`[preload] Buffer fill error: ${msg}`);
  } finally {
    preloading = false;
  }
}

async function ensureAutoReadyBuffer(sb: SupabaseClient, cacheDir: string, targetCount = AUTO_READY_MIN): Promise<void> {
  void sb;
  void cacheDir;
  const autoSource = getActiveAutoSource();
  if (!autoSource) return;
  if (autoBufferFilling) return;
  const now = Date.now();
  if (now - lastAutoPreloadAttemptAt < AUTO_PRELOAD_COOLDOWN_MS) return;
  lastAutoPreloadAttemptAt = now;
  autoBufferFilling = true;

  try {
    while (isRunning && getAutoReadyCount() < targetCount && autoReadyBuffer.length < AUTO_READY_MAX) {
      const ready = await prepareAutoSourceTrack(autoSource);
      if (!ready) break;
      if (!isAutoSourceStillActive(autoSource.key)) {
        if (ready.cleanupAfterUse) cleanupFileIfSafe(ready.audioFile, 'ensureAutoReadyBuffer:genreChanged');
        break;
      }
      const readyKey = normalizeAutoKey(ready.title ?? '');
      const reservedKeys = collectReservedAutoKeys();
      if (readyKey && reservedKeys.has(readyKey)) {
        if (ready.cleanupAfterUse) cleanupFileIfSafe(ready.audioFile, 'ensureAutoReadyBuffer:reservedKey');
        continue;
      }
      autoReadyBuffer.push(ready);
      console.log(`[auto-preload] Buffered auto track (${getAutoReadyCount()}/${AUTO_READY_MAX}): ${ready.title ?? autoSource.key}`);
      broadcastUpcomingTrack();
    }
  } catch (err) {
    console.warn(`[auto-preload] Failed: ${(err as Error).message}`);
  } finally {
    autoBufferFilling = false;
  }
}

async function playNext(
  sb: SupabaseClient,
  io: IOServer,
  cacheDir: string,
  failCounts: Map<string, number>,
  maxRetries: number,
): Promise<void> {
  let audioFile: string | null = null;
  let trackTitle: string | null = null;
  let trackThumbnail: string | null = null;
  let trackYoutubeId = '';
  let trackDuration: number | null = null;
  let trackAddedBy: string | null = null;
  let trackQueueId: string | null = null;
  let isFallback = false;
  let trackIsAutoFallback = false;
  let trackCleanupAfterUse = false;
  let trackForceDualMono = false;
  let selectionLabel: string | null = null;
  let selectionPlaylist: string | null = null;
  let selectionTab: SelectionTab | null = null;
  let selectionKey: string | null = null;
  let source = '';
  const activeAutoSource = getActiveAutoSource();

  const persistPlayedHistory = (): void => {
    if (!audioFile) return;
    const shouldPersist = !isFallback || trackIsAutoFallback;
    if (!shouldPersist) return;
    const historyYoutubeId = trackIsAutoFallback
      ? toAutoHistoryId(trackTitle)
      : trackYoutubeId;
    sb.from('played_history').insert({
      youtube_id: historyYoutubeId,
      title: trackTitle,
      thumbnail: trackThumbnail,
      duration_s: trackDuration,
    }).then(() => {}, () => {});
    if (trackIsAutoFallback) {
      markPlayedAutoToday(trackTitle);
    }
  };

  async function pickImmediateFallback(quickMeta = true, allowWhenAuto = false): Promise<boolean> {
    if (activeAutoSource && !allowWhenAuto) return false;
    let selectedFile: string | null = null;
    let exclude = lastFallbackFile;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = pickRandomFallbackForActiveSelections(exclude);
      if (!candidate) break;
      const candidateTitle = titleFromFilename(candidate);
      if (isSetLikeAutoTitle(candidateTitle)) {
        exclude = candidate;
        continue;
      }
      selectedFile = candidate;
      break;
    }
    const fallbackFile = selectedFile ?? pickRandomFallbackForActiveSelections(lastFallbackFile);
    if (!fallbackFile) return false;
    audioFile = fallbackFile;
    trackTitle = titleFromFilename(fallbackFile);
    trackYoutubeId = 'local';
    trackDuration = quickMeta ? null : await getAudioDuration(fallbackFile);
    trackThumbnail = quickMeta ? null : await getFallbackArtworkDataUrl(fallbackFile);
    trackAddedBy = null;
    isFallback = true;
    trackIsAutoFallback = false;
    trackCleanupAfterUse = false;
    trackForceDualMono = false;
    selectionLabel = 'Lokale random fallback';
    selectionPlaylist = null;
    selectionTab = 'local';
    selectionKey = activeFallbackGenre;
    source = quickMeta ? 'random/gap-guard' : 'random';
    if (activeAutoSource && allowWhenAuto) {
      console.warn(`[player] Emergency local fallback while auto "${activeAutoSource.key}" is buffering`);
    }
    currentQueueItemId = null;
    return true;
  }

  async function pickImmediateAutoFallback(timeoutMs = AUTO_IMMEDIATE_PREPARE_TIMEOUT_MS): Promise<boolean> {
    if (!activeAutoSource) return false;
    if (getAutoReadyCount() < AUTO_READY_START_MIN) {
      await waitForAutoReadyMinimum(sb, cacheDir, AUTO_READY_START_MIN, AUTO_READY_WAIT_TIMEOUT_MS);
    }
    let ready = takeAutoReadyFromBuffer(currentTrack?.title ?? null);
    if (!ready) {
      const preparePromise = prepareAutoSourceTrack(activeAutoSource);
      if (timeoutMs > 0) {
        ready = await Promise.race([
          preparePromise,
          new Promise<ReadyTrack | null>((resolve) => {
            setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
      } else {
        ready = await preparePromise;
      }

      // Prefer a different artist than the currently playing track when possible.
      if (ready) {
        const currentArtist = getNormalizedDisplayArtist(currentTrack?.title ?? null);
        const readyArtist = getNormalizedDisplayArtist(ready.title);
        if (currentArtist && readyArtist && currentArtist === readyArtist && autoReadyBuffer.length > 0) {
          const alternative = takeAutoReadyFromBuffer(currentTrack?.title ?? null);
          if (alternative) {
            autoReadyBuffer.push(ready);
            ready = alternative;
            broadcastUpcomingTrack();
          }
        }
      }
    }
    if (!isAutoSourceStillActive(activeAutoSource.key)) return false;
    if (!ready) {
      // Keep warming auto candidates in background so a next cycle can promote them.
      void ensureAutoReadyBuffer(sb, cacheDir);
      return false;
    }
    audioFile = ready.audioFile;
    trackTitle = ready.title;
    trackThumbnail = ready.thumbnail;
    trackYoutubeId = ready.youtubeId;
    trackDuration = ready.duration;
    trackAddedBy = null;
    isFallback = true;
    trackIsAutoFallback = true;
    trackCleanupAfterUse = ready.cleanupAfterUse;
    trackForceDualMono = ready.forceDualMono;
    selectionLabel = ready.selectionLabel;
    selectionPlaylist = ready.selectionPlaylist;
    selectionTab = ready.selectionTab;
    selectionKey = ready.selectionKey;
    source = (activeAutoSource.type === 'shared' || activeAutoSource.type === 'mixed') && activeAutoSource.playbackMode === 'ordered'
      ? 'auto/ordered'
      : 'auto/random';
    currentQueueItemId = null;
    // Refill asynchronously; do not block current playback on buffer refill.
    void ensureAutoReadyBuffer(sb, cacheDir);
    return true;
  }

  async function pickJingleBreak(): Promise<boolean> {
    if (!JINGLE_ENABLE) return false;
    if ((currentTrack?.youtube_id ?? '') === 'jingle') return false;
    if (tracksSinceLastJingle < JINGLE_EVERY_TRACKS) return false;
    const jingleFile = pickJingleFile();
    if (!jingleFile) return false;

    audioFile = jingleFile;
    trackTitle = titleFromFilename(jingleFile) || 'Jingle';
    trackThumbnail = null;
    trackYoutubeId = 'jingle';
    trackDuration = await getAudioDuration(jingleFile);
    trackAddedBy = null;
    trackQueueId = null;
    isFallback = true;
    trackIsAutoFallback = false;
    trackCleanupAfterUse = false;
    selectionLabel = 'Jingle';
    selectionPlaylist = null;
    selectionTab = null;
    selectionKey = `jingle:${path.basename(jingleFile)}`;
    source = 'jingle';
    currentQueueItemId = null;
    lastJinglePath = jingleFile;
    return true;
  }

  const jinglePicked = await pickJingleBreak();
  if (!jinglePicked) {
  // ── FAST PATH: use pre-prepared track (instant, no DB call) ──
  // Guard against stale prepare races where "next" accidentally equals current.
  if (nextReady?.queueItemId && !nextReady.isFallback) {
    const freshQueue = await getQueue(sb);
    if (!freshQueue.some((q) => q.id === nextReady?.queueItemId)) {
      const stale = nextReady;
      nextReady = null;
      if (stale.cleanupAfterUse) cleanupFileIfSafe(stale.audioFile, 'playNext:staleNextReadyMissingQueueItem');
      console.warn(`[prepare] Dropped stale nextReady removed from queue: ${stale.title ?? stale.youtubeId}`);
      broadcastUpcomingTrack();
    }
  }

  if (nextReady && nextReady.queueItemId !== currentTrack?.id) {
    const ready = nextReady;
    nextReady = null;
    pendingQueueUpcoming = null;
    pendingAutoUpcoming = null;
    audioFile = ready.audioFile;
    trackTitle = ready.title;
    trackThumbnail = ready.thumbnail;
    trackYoutubeId = ready.youtubeId;
    trackDuration = ready.duration;
    trackAddedBy = ready.addedBy;
    trackQueueId = ready.queueItemId;
    isFallback = ready.isFallback;
    trackIsAutoFallback = ready.isAutoFallback;
    trackCleanupAfterUse = ready.cleanupAfterUse;
    trackForceDualMono = ready.forceDualMono;
    if (trackQueueId) {
      const meta = queueSelectionMetaByItemId.get(trackQueueId);
      selectionLabel = meta?.selectionLabel ?? 'Wachtrij';
      selectionPlaylist = meta?.selectionPlaylist ?? null;
      selectionTab = meta?.selectionTab ?? 'queue';
      selectionKey = meta?.selectionKey ?? null;
    } else {
      selectionLabel = ready.selectionLabel;
      selectionPlaylist = ready.selectionPlaylist;
      selectionTab = ready.selectionTab;
      selectionKey = ready.selectionKey;
    }
    source = isFallback ? 'ready/random' : 'ready/preloaded';
    currentQueueItemId = trackQueueId;
    broadcastUpcomingTrack();
  } else {
    if (nextReady && nextReady.queueItemId === currentTrack?.id) {
      const stale = nextReady;
      nextReady = null;
      if (stale.cleanupAfterUse) cleanupFileIfSafe(stale.audioFile, 'playNext:staleNextReadyEqualsCurrent');
      console.warn(`[prepare] Dropped stale nextReady equal to current track: ${stale.title ?? stale.youtubeId}`);
      broadcastUpcomingTrack();
    }

    // ── NORMAL PATH: fetch from queue or fallback ──
    const queue = await getQueue(sb);
    const item = pickNextQueueItem(queue, currentTrack?.id ?? null, currentQueueItemId);

    if (item) {
      const fails = failCounts.get(item.youtube_id) ?? 0;
      if (fails >= maxRetries) {
        console.warn(`[player] Skipping ${item.title ?? item.youtube_id} after ${fails} failed attempts`);
        io.emit('error:toast', { message: `Overgeslagen: ${item.title ?? item.youtube_id} (download mislukt)` });
        failCounts.delete(item.youtube_id);
        await clearQueueItem(sb, item.id);
        const q = await getQueue(sb);
        io.emit('queue:update', { items: q });
        return;
      }

      const buffered = takeFromBuffer(item.id);
      if (buffered) {
        audioFile = buffered.audioFile;
        trackDuration = buffered.duration;
        if (buffered.item.title) item.title = buffered.item.title;
        trackTitle = item.title;
        trackThumbnail = item.thumbnail;
        trackYoutubeId = item.youtube_id;
        trackQueueId = item.id;
        trackAddedBy = item.added_by ?? null;
        failCounts.delete(item.youtube_id);
        currentQueueItemId = trackQueueId;
        trackCleanupAfterUse = true;
        trackIsAutoFallback = false;
        trackForceDualMono = buffered.forceDualMono;
        const meta = queueSelectionMetaByItemId.get(item.id);
        selectionLabel = meta?.selectionLabel ?? 'Wachtrij';
        selectionPlaylist = meta?.selectionPlaylist ?? null;
        selectionTab = meta?.selectionTab ?? 'queue';
        selectionKey = meta?.selectionKey ?? null;
        source = 'preloaded';
      } else {
        // Gap guard: never block transition on download preparation.
        // If queue item isn't ready yet, play random fallback first.
        console.log(`[player] Gap guard: queue item not ready, playing random first (${item.title ?? item.youtube_id})`);
        void prepareNextTrack(sb, cacheDir, currentTrack?.id ?? null);
        const fallbackPicked = activeAutoSource
          ? (await pickImmediateAutoFallback()) || (await pickImmediateFallback(true, true))
          : (await pickImmediateFallback(true)) || (await pickImmediateAutoFallback());
        if (!fallbackPicked) {
          currentTrack = null;
          currentQueueItemId = null;
          io.emit('track:change', null);
          console.log('[player] No fallback available while queue is preparing');
          await sleep(500);
          return;
        }
      }
    } else {
      const fallbackPicked = activeAutoSource
        ? (await pickImmediateAutoFallback()) || (await pickImmediateFallback(queue.length > 0, true))
        : (await pickImmediateFallback(queue.length > 0)) || (await pickImmediateAutoFallback());
      if (!fallbackPicked) {
        currentTrack = null;
        currentQueueItemId = null;
        pendingQueueUpcoming = null;
        io.emit('track:change', null);
        if (activeAutoSource) {
          // In auto mode we should keep probing for strict candidates; never park forever waiting for queue:add.
          console.log('[player] Auto mode: no immediate fallback yet — retrying shortly');
          await sleep(700);
          return;
        }
        console.log('[player] Queue empty — waiting for tracks...');
        await waitForQueueAdd();
        return;
      }
    }
  }
  }

  if (!audioFile) return;

  const trackId = trackQueueId ?? `fallback_${Date.now()}`;

  try {
    // If we are starting a real queue item, an older fallback preview can linger in nextReady.
    // Drop only fallback nextReady entries to keep "next track" in sync with the active queue.
    if (trackQueueId && nextReady?.isFallback) {
      if (nextReady.cleanupAfterUse) cleanupFileIfSafe(nextReady.audioFile, 'playNext:dropFallbackNextReadyWhenQueueTrackStarts');
      nextReady = null;
      broadcastUpcomingTrack();
    }

    // Remove from queue in background
    if (trackQueueId) {
      clearQueueItem(sb, trackQueueId)
        .then(() => getQueue(sb))
        .then((q) => io.emit('queue:update', { items: q }))
        .catch(() => {});
    }

    const enc = ensureEncoder();

    // NOW show track + set timer — audio is about to stream
    currentTrack = {
      id: trackId,
      youtube_id: trackYoutubeId,
      title: trackTitle,
      thumbnail: trackThumbnail,
      added_by: trackAddedBy,
      duration: trackDuration,
      started_at: Date.now() + STREAM_DELAY_MS,
      selection_label: selectionLabel,
      selection_playlist: selectionPlaylist,
      selection_tab: selectionTab,
      selection_key: selectionKey,
    };
    if (trackYoutubeId === 'jingle') tracksSinceLastJingle = 0;
    else tracksSinceLastJingle += 1;
    if (trackQueueId) queueSelectionMetaByItemId.delete(trackQueueId);
    pendingQueueUpcoming = null;
    pendingAutoUpcoming = null;
    io.emit('track:change', currentTrack);
    lastTrackAnnouncedAt = Date.now();
    if (isFallback) {
      lastFallbackFile = audioFile;
    }
    void refreshPendingQueueUpcoming(sb, trackQueueId);
    // Always unlock on actual track start; cooldown logic in server.ts handles
    // the 5s post-skip guard and prevents accidental double skips.
    if (skipWhenReady) {
      console.log('[player] skipWhenReady cleared after natural transition');
      skipWhenReady = false;
    }
    setSkipLock(false);

    const durStr = trackDuration
      ? `${Math.floor(trackDuration / 60)}:${String(Math.round(trackDuration % 60)).padStart(2, '0')}`
      : '?';
    console.log(`[player] Streaming (${source}): ${trackTitle ?? trackYoutubeId} (${durStr})`);

    // Start preparing next track in background while this one plays
    prepareNextTrack(sb, cacheDir, trackQueueId);
    void ensureAutoReadyBuffer(sb, cacheDir);

    activePlaybackFile = audioFile;
    await decodeToEncoder(audioFile, enc, trackForceDualMono);

    // ── Handle seamless swap chain ──
    // After decodeToEncoder resolves (either track finished or swap happened),
    // check if there's a completed swap. If so, set up the new track and keep
    // piping. This loop supports chained skips (skip during a swapped track).
    while (completedSwap) {
      const swap = completedSwap;
      completedSwap = null;

      // Clean up old track
      if (audioFile && trackCleanupAfterUse && !keepFiles) cleanupFile(audioFile);
      persistPlayedHistory();

      // Set up new track metadata
      audioFile = swap.ready.audioFile;
      trackTitle = swap.ready.title;
      trackThumbnail = swap.ready.thumbnail;
      trackYoutubeId = swap.ready.youtubeId;
      trackDuration = swap.ready.duration;
      trackAddedBy = swap.ready.addedBy;
      trackQueueId = swap.ready.queueItemId;
      isFallback = swap.ready.isFallback;
      trackIsAutoFallback = swap.ready.isAutoFallback;
      trackCleanupAfterUse = swap.ready.cleanupAfterUse;
      trackForceDualMono = swap.ready.forceDualMono;
      if (trackQueueId) {
        const meta = queueSelectionMetaByItemId.get(trackQueueId);
        selectionLabel = meta?.selectionLabel ?? 'Wachtrij';
        selectionPlaylist = meta?.selectionPlaylist ?? null;
        selectionTab = meta?.selectionTab ?? 'queue';
        selectionKey = meta?.selectionKey ?? null;
      } else if (trackIsAutoFallback) {
        selectionLabel = swap.ready.selectionLabel;
        selectionPlaylist = swap.ready.selectionPlaylist;
        selectionTab = swap.ready.selectionTab;
        selectionKey = swap.ready.selectionKey;
      } else if (isFallback) {
        selectionLabel = 'Lokale random fallback';
        selectionPlaylist = null;
        selectionTab = 'local';
        selectionKey = activeFallbackGenre;
      }

      const swapTrackId = trackQueueId ?? `fallback_${Date.now()}`;
      const durStr = trackDuration
        ? `${Math.floor(trackDuration / 60)}:${String(Math.round(trackDuration % 60)).padStart(2, '0')}`
        : '?';

      currentTrack = {
        id: swapTrackId,
        youtube_id: trackYoutubeId,
        title: trackTitle,
        thumbnail: trackThumbnail,
        added_by: trackAddedBy,
        duration: trackDuration,
        started_at: Date.now() + STREAM_DELAY_MS,
        selection_label: selectionLabel,
        selection_playlist: selectionPlaylist,
        selection_tab: selectionTab,
        selection_key: selectionKey,
      };
      if (trackYoutubeId === 'jingle') tracksSinceLastJingle = 0;
      else tracksSinceLastJingle += 1;
      if (trackQueueId) queueSelectionMetaByItemId.delete(trackQueueId);
      io.emit('track:change', currentTrack);
      lastTrackAnnouncedAt = Date.now();
      if (isFallback) {
        lastFallbackFile = audioFile;
      }
      activePlaybackFile = audioFile;
      setSkipLock(false);
      console.log(`[player] Seamless skip → ${trackTitle ?? trackYoutubeId} (${durStr})`);
      currentQueueItemId = trackQueueId;
      void refreshPendingQueueUpcoming(sb, trackQueueId);

      if (trackQueueId) {
        clearQueueItem(sb, trackQueueId)
          .then(() => getQueue(sb))
          .then((q) => io.emit('queue:update', { items: q }))
          .catch(() => {});
      }

      prepareNextTrack(sb, cacheDir, trackQueueId);
      void ensureAutoReadyBuffer(sb, cacheDir);

      await pipeRunningDecoder(swap.decoder, ensureEncoder());
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    const encoderStdinUnavailable = !encoder?.stdin || encoder.stdin.destroyed || !encoder.stdin.writable;
    const isEncoderCrash = !encoder || encoder.killed || encoder.exitCode !== null || encoderStdinUnavailable || /encoder stdin not available/i.test(message);

    if (isEncoderCrash) {
      console.warn(`[player] Encoder crashed during ${trackTitle ?? trackYoutubeId} — restarting encoder (not counting as track failure)`);
      currentTrack = null;
      currentQueueItemId = null;
      pendingQueueUpcoming = null;
      pendingAutoUpcoming = null;
      io.emit('track:change', null);
      broadcastUpcomingTrack();
    } else {
      console.error(`[player] Error playing ${trackYoutubeId}: ${message}`);
      if (!isFallback) {
        const newFails = (failCounts.get(trackYoutubeId) ?? 0) + 1;
        failCounts.set(trackYoutubeId, newFails);
        console.warn(`[player] Fail ${newFails}/${maxRetries} for ${trackTitle ?? trackYoutubeId}`);
      }
      io.emit('error:toast', { message: `Fout bij afspelen: ${trackTitle ?? trackYoutubeId}` });
    }
  } finally {
    currentDecoder = null;
    currentQueueItemId = null;
    activePlaybackFile = null;

    if (audioFile && trackCleanupAfterUse && !keepFiles) {
      cleanupFile(audioFile);
    }

    persistPlayedHistory();
  }
}

/**
 * Decode an audio file to raw PCM and pipe into the encoder stdin.
 * Supports seamless hot-swap: while piping, if a pendingSwap becomes
 * ready (its firstChunk is set) we write the new chunk, kill the old
 * decoder, and resolve — the old track's audio plays right up to the
 * switch point with zero silence.
 */
function decodeToEncoder(audioFile: string, enc: ChildProcess, forceDualMono = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!enc.stdin || enc.stdin.destroyed) {
      reject(new Error('Encoder stdin not available'));
      return;
    }

    // Validate file exists and is readable before starting decoder
    if (!fs.existsSync(audioFile)) {
      reject(new Error(`Audio file not found: ${audioFile}`));
      return;
    }

    try {
      const stats = fs.statSync(audioFile);
      if (stats.size === 0) {
        reject(new Error(`Audio file is empty: ${audioFile}`));
        return;
      }
      if (stats.size < 1024) { // Less than 1KB is suspicious
        console.warn(`[player] Warning: Audio file is very small (${stats.size} bytes): ${audioFile}`);
      }
    } catch (err) {
      reject(new Error(`Cannot access audio file: ${audioFile} - ${(err as Error).message}`));
      return;
    }

    const decoder = spawn('ffmpeg', [
      '-hide_banner',
      '-re',
      '-i', audioFile,
      ...getDecoderFilterArgs(forceDualMono),
      '-vn',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-loglevel', 'error', // Reduce ffmpeg verbosity
      'pipe:1',
    ]);

    currentDecoder = decoder;
    let pipeError = false;
    let settled = false;

    function finish(err?: Error) {
      if (settled) return;
      settled = true;
      currentDecoder = null;
      enc.stdin?.removeListener('error', onStdinError);
      enc.removeListener('close', onEncClose);
      if (err) reject(err); else resolve();
    }

    function onStdinError(err: Error) {
      if (pipeError) return;
      pipeError = true;
      if (!isExpectedEncoderShutdownWindow() && !isWriteAfterEndError(err)) {
        console.warn(`[encoder] stdin error during decode: ${err.message}`);
      }
      killDecoderProcess(decoder);
      finish(new Error(`encoder write failed: ${err.message}`));
    }

    function onEncClose() {
      killDecoderProcess(decoder);
    }

    enc.stdin.on('error', onStdinError);
    enc.on('close', onEncClose);

    decoder.stdout?.on('data', (chunk: Buffer) => {
      if (settled || pipeError) return;
      markAudioProgress();

      // ── Check for seamless swap ──
      if (pendingSwap?.firstChunk) {
        const swap = pendingSwap;
        pendingSwap = null;

        // Write the NEW track's first audio chunk to the encoder
        if (enc.stdin && !enc.stdin.destroyed && enc.stdin.writable) {
          try {
            enc.stdin.write(swap.firstChunk);
            markAudioProgress();
          } catch (err) {
            pipeError = true;
            killDecoderProcess(decoder);
            finish(new Error(`encoder write failed during swap: ${(err as Error).message}`));
            return;
          }
        }

        // Kill old decoder — its last chunk was already written above (or skipped)
        killDecoderProcess(decoder);

        // Store completed swap for playNext to pick up
        completedSwap = { decoder: swap.newDecoder, ready: swap.ready };
        console.log('[player] Seamless swap complete — new audio flowing');
        finish();
        return;
      }

      // ── Normal: pipe old track's audio to encoder ──
      if (enc.stdin && !enc.stdin.destroyed && enc.stdin.writable) {
        try {
          const ok = enc.stdin.write(chunk);
          markAudioProgress();
          if (!ok) {
            decoder.stdout?.pause();
            enc.stdin.once('drain', () => decoder.stdout?.resume());
          }
        } catch (err) {
          pipeError = true;
          killDecoderProcess(decoder);
          if (isBrokenPipeError(err)) {
            finish(new Error('encoder write failed: EPIPE'));
          } else {
            finish(new Error(`encoder write failed: ${(err as Error).message}`));
          }
          return;
        }
      } else if (enc.exitCode !== null || !enc.stdin || enc.stdin.destroyed || !enc.stdin.writable) {
        pipeError = true;
        killDecoderProcess(decoder);
        finish(new Error('Encoder stdin not available'));
        return;
      }
    });

    let stderr = '';
    decoder.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    decoder.on('close', (code) => {
      if (settled) return;
      if (pipeError || code === 0 || code === 255 || code === null) {
        finish();
      } else {
        finish(new Error(`decoder exited ${code}: ${stderr.slice(-200)}`));
      }
    });

    decoder.on('error', (err) => {
      finish(new Error(`Failed to start decoder: ${err.message}`));
    });
  });
}

/**
 * Continue piping audio from an already-running decoder (post hot-swap).
 * Also supports chained skips — the same swap logic applies.
 */
function pipeRunningDecoder(decoder: ChildProcess, enc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    currentDecoder = decoder;
    let settled = false;
    let pipeError = false;

    function finish() {
      if (settled) return;
      settled = true;
      currentDecoder = null;
      enc.stdin?.removeListener('error', onStdinError);
      enc.removeListener('close', onEncClose);
      resolve();
    }

    function onStdinError(err: Error) {
      if (pipeError) return;
      pipeError = true;
      if (!isExpectedEncoderShutdownWindow() && !isWriteAfterEndError(err)) {
        console.warn(`[encoder] stdin error during chained decode: ${err.message}`);
      }
      killDecoderProcess(decoder);
      finish();
    }

    function onEncClose() {
      if (pipeError) return;
      pipeError = true;
      killDecoderProcess(decoder);
      finish();
    }

    enc.stdin?.on('error', onStdinError);
    enc.on('close', onEncClose);

    decoder.stdout?.on('data', (chunk: Buffer) => {
      if (settled || pipeError) return;
      markAudioProgress();

      // Support chained skips during the swapped track
      if (pendingSwap?.firstChunk) {
        const swap = pendingSwap;
        pendingSwap = null;

        if (enc.stdin && !enc.stdin.destroyed) {
          try {
            enc.stdin.write(swap.firstChunk);
            markAudioProgress();
          } catch {}
        }

        killDecoderProcess(decoder);
        completedSwap = { decoder: swap.newDecoder, ready: swap.ready };
        console.log('[player] Chained seamless swap complete');
        finish();
        return;
      }

      if (enc.stdin && !enc.stdin.destroyed) {
        try {
          const ok = enc.stdin.write(chunk);
          markAudioProgress();
          if (!ok) {
            decoder.stdout?.pause();
            enc.stdin.once('drain', () => decoder.stdout?.resume());
          }
        } catch {
          pipeError = true;
          killDecoderProcess(decoder);
          finish();
        }
      }
    });

    decoder.on('close', () => finish());
    decoder.on('error', () => finish());

    // Resume the paused stdout (it was paused after firstChunk capture)
    decoder.stdout?.resume();
  });
}

let downloadCounter = 0;
const queueDownloadInFlight = new Map<string, Promise<{ audioFile: string; info: { title: string | null; duration: number | null; thumbnail: string | null }; forceDualMono: boolean }>>();

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function downloadQueueItemShared(
  item: QueueItem,
  cacheDir: string,
): Promise<{ audioFile: string; info: { title: string | null; duration: number | null; thumbnail: string | null }; forceDualMono: boolean }> {
  const key = item.id;
  const existing = queueDownloadInFlight.get(key);
  if (existing) return existing;

  const run = (async () => {
    const localSource = isLocalUrl(item.youtube_url);
    const baseInfo = localSource
      ? { title: item.title ?? null, duration: null, thumbnail: item.thumbnail ?? null }
      : await fetchVideoInfo(item.youtube_url);
    if (baseInfo.title && !item.title) item.title = baseInfo.title;
    const audioFile = await downloadAudio(item, cacheDir);
    const measuredDuration = baseInfo.duration ?? (localSource ? await getAudioDuration(audioFile) : null);
    const forceDualMono = await shouldForceDualMono(audioFile);
    return {
      audioFile,
      info: {
        title: baseInfo.title,
        duration: measuredDuration,
        thumbnail: baseInfo.thumbnail,
      },
      forceDualMono,
    };
  })();

  queueDownloadInFlight.set(key, run);
  // Guard against unhandled-rejection process crashes when multiple
  // async callers race on the same in-flight download promise.
  run.catch(() => undefined).finally(() => {
    if (queueDownloadInFlight.get(key) === run) {
      queueDownloadInFlight.delete(key);
    }
  });
  return run;
}

function resolveAlternativeYoutubeUrl(item: QueueItem): Promise<string | null> {
  return new Promise((resolve) => {
    const query = (item.title ?? item.youtube_id ?? '').trim();
    if (!query) {
      resolve(null);
      return;
    }

    // Clean up the query for better search results
    const cleanQuery = query
      .replace(/\(.*?\)/g, '') // Remove parentheses content
      .replace(/\[.*?\]/g, '') // Remove bracket content
      .replace(/official|video|clip|out now|free release/gi, '') // Remove common video keywords
      .replace(/\s+/g, ' ')
      .trim();

    const searchQuery = cleanQuery || query;

    const proc = spawn('python', [
      '-m', 'yt_dlp',
      '--flat-playlist',
      '--print', '%(id)s',
      '--no-warnings',
      '--socket-timeout', '15',
      '--playlist-end', '3', // Reduced from 5 to 3 for faster results
      `ytsearch3:${searchQuery}`,
    ], { timeout: 10_000 }); // Reduced timeout from 15s to 10s

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const candidates = output
        .split('\n')
        .map((line) => line.trim())
        .filter((id) => /^[\w-]{11}$/.test(id))
        .filter((id) => id !== item.youtube_id);

      const id = candidates[0];
      resolve(id ? `https://www.youtube.com/watch?v=${id}` : null);
    });

    proc.on('error', () => resolve(null));
  });
}

function downloadAudio(item: QueueItem, cacheDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const localPath = decodeLocalFileUrl(item.youtube_url);
    if (localPath) {
      fs.access(localPath, fs.constants.R_OK, (err) => {
        if (err) {
          reject(new Error(`Lokale file niet gevonden: ${localPath}`));
          return;
        }
        resolve(localPath);
      });
      return;
    }

    const safeId = item.youtube_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const uniqueTag = `${safeId}_${Date.now()}_${downloadCounter++}`;
    const outputTemplate = path.join(cacheDir, `${uniqueTag}.%(ext)s`);

    function downloadFrom(url: string): Promise<string> {
      return new Promise((resolveDownload, rejectDownload) => {
        // Ensure cache directory exists
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
        } catch (err) {
          rejectDownload(new Error(`Failed to create cache directory: ${(err as Error).message}`));
          return;
        }

        const proc = spawn('python', [
          '-m', 'yt_dlp',
          '--format', 'bestaudio',
          '--no-playlist',
          '--no-warnings',
          '--socket-timeout', '20',
          '--retries', '1', // Fast failure for primary attempt
          '-o', outputTemplate,
          url,
        ], {
          timeout: 30000, // 30 second timeout for primary attempt
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            rejectDownload(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 200)}`));
            return;
          }

          // Add a small delay to ensure file system operations complete
          setTimeout(() => {
            try {
              if (!fs.existsSync(cacheDir)) {
                rejectDownload(new Error('Cache directory disappeared after download'));
                return;
              }

              const files = fs.readdirSync(cacheDir)
                .filter((f) => f.startsWith(uniqueTag))
                .map((f) => path.join(cacheDir, f))
                .filter((f) => {
                  try {
                    return fs.existsSync(f) && fs.statSync(f).size > 0;
                  } catch {
                    return false;
                  }
                });

              if (files.length === 0) {
                rejectDownload(new Error('yt-dlp completed but no valid file found'));
                return;
              }

              const selectedFile = files[0];
              
              // Verify file is readable before resolving
              fs.access(selectedFile, fs.constants.R_OK, (err) => {
                if (err) {
                  rejectDownload(new Error(`Downloaded file not readable: ${selectedFile}`));
                  return;
                }
                resolveDownload(selectedFile);
              });
            } catch (err) {
              rejectDownload(new Error(`Error checking downloaded files: ${(err as Error).message}`));
            }
          }, 100); // 100ms delay
        });

        proc.on('error', (err) => {
          rejectDownload(new Error(`Failed to start yt-dlp: ${err.message}`));
        });

        // Handle timeout
        proc.on('timeout', () => {
          proc.kill('SIGKILL');
          rejectDownload(new Error('Download timeout after 60 seconds'));
        });
      });
    }

    downloadFrom(item.youtube_url)
      .then(resolve)
      .catch(async (primaryErr) => {
        // For direct YouTube URLs that fail, try alternative search
        const altUrl = await resolveAlternativeYoutubeUrl(item);
        if (!altUrl) {
          reject(primaryErr);
          return;
        }
        // Silently try alternative source - this is normal fallback behavior
        try {
          const file = await downloadFrom(altUrl);
          resolve(file);
        } catch {
          reject(primaryErr);
        }
      });
  });
}

function waitForQueueAdd(): Promise<void> {
  return new Promise((resolve) => {
    playerEvents.once('queue:add', () => resolve());
  });
}

async function prepareNextTrack(
  sb: SupabaseClient,
  cacheDir: string,
  currentItemId: string | null,
): Promise<void> {
  if (preparingNext || nextReady) return;
  lastPrepareKickAt = Date.now();
  const activeAutoSource = getActiveAutoSource();
  preparingNext = true;

  try {
    let queue = await getQueue(sb);
    let item = pickNextQueueItem(queue, currentItemId, currentQueueItemId);

    while (item) {
      const buffered = takeFromBuffer(item.id);
      if (buffered) {
        const freshQueue = await getQueue(sb);
        if (!freshQueue.some((q) => q.id === item?.id)) {
          if (!keepFiles) cleanupFile(buffered.audioFile);
          console.log(`[prepare] Discarded preloaded removed from queue: ${item.title ?? item.youtube_id}`);
          queue = freshQueue;
          item = pickNextQueueItem(queue, currentItemId, currentQueueItemId);
          continue;
        }
        if (buffered.item.title) item.title = buffered.item.title;
        nextReady = {
          audioFile: buffered.audioFile,
          title: item.title,
          thumbnail: item.thumbnail,
          youtubeId: item.youtube_id,
          duration: buffered.duration,
          addedBy: item.added_by ?? null,
          queueItemId: item.id,
          isFallback: false,
          isAutoFallback: false,
          cleanupAfterUse: true,
          forceDualMono: buffered.forceDualMono,
          selectionLabel: null,
          selectionPlaylist: null,
          selectionTab: null,
          selectionKey: null,
        };
        pendingQueueUpcoming = null;
        console.log(`[prepare] Next ready (preloaded): ${item.title ?? item.youtube_id}`);
        clearPrepareFailure(item.id);
        broadcastUpcomingTrack();
        break;
      }

      try {
        if (!item) throw new Error('Queue item missing during prepare');
        const itemSafe = item;
        console.log(`[prepare] Downloading next: ${item.title ?? item.youtube_id}`);
        const { info, audioFile, forceDualMono } = await downloadQueueItemShared(itemSafe, cacheDir);
        const freshQueue = await getQueue(sb);
        if (!freshQueue.some((q) => q.id === itemSafe.id)) {
          if (!keepFiles) cleanupFile(audioFile);
          console.log(`[prepare] Discarded downloaded removed from queue: ${item.title ?? item.youtube_id}`);
          queue = freshQueue;
          item = pickNextQueueItem(queue, currentItemId, currentQueueItemId);
          continue;
        }
        nextReady = {
          audioFile,
          title: item.title,
          thumbnail: item.thumbnail,
          youtubeId: item.youtube_id,
          duration: info.duration,
          addedBy: item.added_by ?? null,
          queueItemId: item.id,
          isFallback: false,
          isAutoFallback: false,
          cleanupAfterUse: true,
          forceDualMono,
          selectionLabel: null,
          selectionPlaylist: null,
          selectionTab: null,
          selectionKey: null,
        };
        const duplicateBuffered = preloadBuffer.filter((p) => p.item.id === itemSafe.id);
        if (duplicateBuffered.length > 0) {
          for (const entry of duplicateBuffered) {
            if (!keepFiles && entry.audioFile !== audioFile) cleanupFile(entry.audioFile);
          }
          preloadBuffer = preloadBuffer.filter((p) => p.item.id !== itemSafe.id);
        }
        pendingQueueUpcoming = null;
        console.log(`[prepare] Next ready (downloaded): ${item.title ?? item.youtube_id}`);
        clearPrepareFailure(itemSafe.id);
        broadcastUpcomingTrack();
        break;
      } catch (err) {
        const msg = describeError(err);
        if (!item) throw err;
        const removed = await markUnplayableQueueItem(sb, item, 'prepare', msg);
        if (!removed) {
          // Keep server alive on transient/first download failure (e.g. age-restricted video).
          // The item stays in queue and will be retried in a later prepare cycle.
          pendingQueueUpcoming = null;
          broadcastUpcomingTrack();
          return;
        }
        queue = await getQueue(sb);
        item = pickNextQueueItem(queue, currentItemId, currentQueueItemId);
      }
    }

    if (!item && !nextReady) {
      // Never pick random while queue still has items (usually current-track DB lag).
      if (queue.length > 0) {
        pendingQueueUpcoming = null;
        console.log('[prepare] Queue still contains current track only — skip random fallback');
        return;
      }
      if (activeAutoSource) {
        const autoReady = takeAutoReadyFromBuffer() ?? (await prepareAutoSourceTrack(activeAutoSource));
        if (autoReady) {
          nextReady = autoReady;
          console.log(`[prepare] Next ready (auto source): ${autoReady.title ?? activeAutoSource.key}`);
          broadcastUpcomingTrack();
          void ensureAutoReadyBuffer(sb, cacheDir);
          return;
        }
      }

      const fallbackFile = activeAutoSource
        ? null
        : pickRandomFallbackForActiveSelections(lastFallbackFile);
      if (fallbackFile) {
        const title = titleFromFilename(fallbackFile);
        const duration = await getAudioDuration(fallbackFile);
        const thumbnail = await getFallbackArtworkDataUrl(fallbackFile);
        nextReady = {
          audioFile: fallbackFile,
          title,
          thumbnail,
          youtubeId: 'local',
          duration,
          addedBy: null,
          queueItemId: null,
          isFallback: true,
          isAutoFallback: false,
          cleanupAfterUse: false,
          forceDualMono: false,
          selectionLabel: 'Lokale random fallback',
          selectionPlaylist: null,
          selectionTab: 'local',
          selectionKey: activeFallbackGenre,
        };
        console.log(`[prepare] Next ready (random): ${title}`);
        broadcastUpcomingTrack();
      } else if (activeAutoSource) {
        const autoReady = takeAutoReadyFromBuffer() ?? (await prepareAutoSourceTrack(activeAutoSource));
        if (autoReady) {
          nextReady = autoReady;
          console.log(`[prepare] Next ready (auto source): ${autoReady.title ?? activeAutoSource.key}`);
          broadcastUpcomingTrack();
          void ensureAutoReadyBuffer(sb, cacheDir);
        } else {
          pendingQueueUpcoming = null;
          console.warn(`[prepare] Auto source "${activeAutoSource.key}" has no strict candidates yet`);
        }
      }
    }
  } catch (err) {
    console.warn(`[prepare] Failed: ${(err as Error).message}`);
    if (skipWhenReady) {
      skipWhenReady = false;
      setSkipLock(false);
      console.warn('[player] skipWhenReady aborted — prepare failed');
    }
  } finally {
    preparingNext = false;
  }

  // If a skip is waiting for this track, trigger swap now.
  if (skipWhenReady && nextReady) {
    if (encoder?.stdin && !encoder.stdin.destroyed) {
      skipWhenReady = false;
      const ready = nextReady;
      nextReady = null;
      broadcastUpcomingTrack();
      beginSeamlessSwap(ready);
      console.log('[player] skipWhenReady triggered — seamless swap started');
    } else {
      // Encoder is down: force a hard transition so playback loop can restart encoder.
      skipWhenReady = false;
      setSkipLock(false);
      killDecoderProcess(currentDecoder);
      console.warn('[player] skipWhenReady forced hard transition (encoder unavailable)');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
