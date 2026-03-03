import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SupabaseClient } from '@supabase/supabase-js';
import type { Server as IOServer } from 'socket.io';
import type { QueueItem, Track, UpcomingTrack } from './types.js';
import { clearQueueItem, getQueue, fetchVideoInfo } from './queue.js';
import { cleanupFile } from './cleanup.js';
import type { StreamHub } from './streamHub.js';
import { pickRandomFallbackForGenre, parseAutoFallbackGenreId, LIKED_AUTO_GENRE_ID } from './fallbackGenres.js';
import { fetchArtworkCandidate } from './artwork.js';
import { getTopTracksByGenre } from './services/discovery.js';
import { listLikedPlaylistTracks } from './services/genreCuratedConfig.js';

export const playerEvents = new EventEmitter();

let currentTrack: Track | null = null;
let currentDecoder: ChildProcess | null = null;
let encoder: ChildProcess | null = null;
let isRunning = false;
let keepFiles = false;

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
let _io: IOServer | null = null;

export function isSkipLocked(): boolean {
  return skipLocked;
}

function setSkipLock(locked: boolean): void {
  if (skipLocked === locked) return;
  skipLocked = locked;
  _io?.emit('skip:lock', { locked });
}

const STREAM_DELAY_MS = parseInt(process.env.STREAM_DELAY_MS ?? '8000', 10);
const STREAM_BITRATE_RAW = (process.env.STREAM_BITRATE ?? '256k').trim().toLowerCase();
const STREAM_USE_SOURCE_MODE = STREAM_BITRATE_RAW === 'source' || STREAM_BITRATE_RAW === 'true';
const STREAM_BITRATE = STREAM_USE_SOURCE_MODE ? '256k' : STREAM_BITRATE_RAW;
let activeFallbackGenre: string | null = null;

function getEncoderRateArgs(): string[] {
  // "source"/"true": use high-quality VBR instead of fixed CBR cap.
  if (STREAM_USE_SOURCE_MODE) return ['-q:a', '0'];
  return ['-b:a', STREAM_BITRATE];
}

export function setActiveFallbackGenre(genreId: string | null): void {
  activeFallbackGenre = genreId;
  const activeAuto = parseAutoFallbackGenreId(genreId);
  if (!activeAuto) {
    pendingAutoUpcoming = null;
    if (autoReadyBuffer.length > 0) {
      for (const entry of autoReadyBuffer) {
        if (entry.cleanupAfterUse && !keepFiles) cleanupFile(entry.audioFile);
      }
      autoReadyBuffer = [];
    }
    if (nextReady?.isAutoFallback) {
      if (nextReady.cleanupAfterUse && !keepFiles) cleanupFile(nextReady.audioFile);
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
  return `${artist} - ${title}`.trim();
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

function buildAutoFallbackSource(genreId: string, artist: string, title: string): QueueItem {
  const search = autoTrackTitle(artist, title);
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

const AUTO_RECENT_WINDOW = 60;
const recentAutoTrackKeys: string[] = [];

function isRecentAutoTrack(artist: string, title: string): boolean {
  const key = normalizeAutoKey(`${artist} ${title}`);
  return recentAutoTrackKeys.includes(key);
}

function rememberAutoTrack(artist: string, title: string): void {
  const key = normalizeAutoKey(`${artist} ${title}`);
  rememberAutoTrackKey(key);
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

async function prepareAutoFallbackByGenre(genreId: string): Promise<ReadyTrack | null> {
  try {
    const baseOffsets = [0, 20, 40, 60, 80, 120, 160, 200, 260, 320];
    const randomOffsets = shuffleInPlace([...baseOffsets]).slice(0, 2);
    const offsets = [0, ...randomOffsets];
    const mergedHits: Array<{ title: string; artist: string; thumbnail: string | null }> = [];
    const seen = new Set<string>();

    const pages = await Promise.allSettled(
      offsets.map((offset) => getTopTracksByGenre(genreId, 16, offset)),
    );
    for (const page of pages) {
      const hits = page.status === 'fulfilled' ? page.value : [];
      for (const hit of hits) {
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

    if (mergedHits.length === 0) return null;
    const freshCandidates = mergedHits.filter((hit) => !isRecentAutoTrack(hit.artist, hit.title));
    const candidates = freshCandidates.length > 0 ? freshCandidates : mergedHits;
    if (candidates.length === 0) return null;
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    pendingAutoUpcoming = {
      youtube_id: 'auto',
      title: autoTrackTitle(choice.artist, choice.title),
      thumbnail: choice.thumbnail ?? null,
      duration: null,
      added_by: null,
      isFallback: true,
    };
    broadcastUpcomingTrack();
    const pseudo = buildAutoFallbackSource(genreId, choice.artist, choice.title);
    const audioFile = await downloadAudio(pseudo, _cacheDir);
    const resolvedTitle = autoTrackTitle(choice.artist, choice.title);
    rememberAutoTrack(choice.artist, choice.title);
    pendingAutoUpcoming = null;
    return {
      audioFile,
      title: resolvedTitle,
      thumbnail: choice.thumbnail ?? null,
      youtubeId: 'local',
      duration: null,
      addedBy: null,
      queueItemId: null,
      isFallback: true,
      isAutoFallback: true,
      cleanupAfterUse: true,
    };
  } catch (err) {
    pendingAutoUpcoming = null;
    broadcastUpcomingTrack();
    console.warn(`[player] Auto fallback prepare failed (${genreId}): ${(err as Error).message}`);
    return null;
  }
}

async function prepareLikedAutoFallbackTrack(): Promise<ReadyTrack | null> {
  try {
    const likedTracks = listLikedPlaylistTracks();
    if (likedTracks.length === 0) return null;

    const fresh = likedTracks.filter((track) => !recentAutoTrackKeys.includes(normalizeAutoKey(track)));
    const pool = fresh.length > 0 ? fresh : likedTracks;
    const choice = pool[Math.floor(Math.random() * pool.length)];
    if (!choice) return null;

    pendingAutoUpcoming = {
      youtube_id: 'auto',
      title: choice,
      thumbnail: null,
      duration: null,
      added_by: null,
      isFallback: true,
    };
    broadcastUpcomingTrack();
    const pseudo = buildAutoFallbackSourceForQuery(LIKED_AUTO_GENRE_ID, choice);
    const audioFile = await downloadAudio(pseudo, _cacheDir);
    rememberAutoTrackKey(choice);
    pendingAutoUpcoming = null;
    return {
      audioFile,
      title: choice,
      thumbnail: null,
      youtubeId: 'local',
      duration: null,
      addedBy: null,
      queueItemId: null,
      isFallback: true,
      isAutoFallback: true,
      cleanupAfterUse: true,
    };
  } catch (err) {
    pendingAutoUpcoming = null;
    broadcastUpcomingTrack();
    console.warn(`[player] Liked auto fallback prepare failed: ${(err as Error).message}`);
    return null;
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
const PRELOAD_REFRESH_MS = 3000;
const AUTO_READY_MIN = 2;
const AUTO_READY_MAX = 3;

interface PreloadedTrack {
  item: QueueItem;
  audioFile: string;
  duration: number | null;
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
}

let nextReady: ReadyTrack | null = null;
let preparingNext = false;
let autoBufferFilling = false;
let currentQueueItemId: string | null = null;
let lastUpcomingKey: string | null = null;
let lastFallbackFile: string | null = null;
let pendingQueueUpcoming: UpcomingTrack | null = null;
let pendingAutoUpcoming: UpcomingTrack | null = null;
let autoReadyBuffer: ReadyTrack[] = [];
const prepareFailCounts = new Map<string, number>();
const PREPARE_FAIL_MAX = 3;

export function getCurrentTrack(): Track | null {
  return currentTrack;
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

function beginSeamlessSwap(ready: ReadyTrack): void {
  const newDecoder = spawn('ffmpeg', [
    '-hide_banner', '-re',
    '-i', ready.audioFile,
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
  if (nextReady && nextReady.cleanupAfterUse && !keepFiles) {
    cleanupFile(nextReady.audioFile);
  }
  nextReady = null;
  broadcastUpcomingTrack();
  if (preloadBuffer.length === 0) return;
  for (const p of preloadBuffer) {
    if (!keepFiles) cleanupFile(p.audioFile);
  }
  preloadBuffer = [];
  for (const entry of autoReadyBuffer) {
    if (entry.cleanupAfterUse && !keepFiles) cleanupFile(entry.audioFile);
  }
  autoReadyBuffer = [];
  console.log('[preload] Buffer invalidated');
  broadcastUpcomingTrack();
}

export function invalidateNextReady(): void {
  if (!nextReady) return;
  if (nextReady.cleanupAfterUse && !keepFiles) {
    cleanupFile(nextReady.audioFile);
  }
  nextReady = null;
  broadcastUpcomingTrack();
}

export function removeQueueItemFromPreload(itemId: string): void {
  if (!itemId) return;

  if (nextReady?.queueItemId === itemId) {
    if (nextReady.cleanupAfterUse && !keepFiles) cleanupFile(nextReady.audioFile);
    nextReady = null;
  }

  const removed = preloadBuffer.filter((p) => p.item.id === itemId);
  if (removed.length > 0) {
    for (const entry of removed) {
      if (!keepFiles) cleanupFile(entry.audioFile);
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

function takeAutoReadyFromBuffer(): ReadyTrack | null {
  if (autoReadyBuffer.length === 0) return null;
  const next = autoReadyBuffer.shift() ?? null;
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
    if (nextReady.cleanupAfterUse && !keepFiles) cleanupFile(nextReady.audioFile);
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
  if (encoder && !encoder.killed && encoder.exitCode === null) return encoder;

  if (_icecast) {
    const icecastUrl = `icecast://source:${_icecast.password}@${_icecast.host}:${_icecast.port}${_icecast.mount}`;
    console.log('[encoder] Starting persistent encoder → Icecast');

    encoder = spawn('ffmpeg', [
      '-hide_banner',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-i', 'pipe:0',
      '-acodec', 'libmp3lame',
      ...getEncoderRateArgs(),
      '-f', 'mp3',
      '-content_type', 'audio/mpeg',
      icecastUrl,
    ]);
  } else {
    console.log('[encoder] Starting persistent encoder → StreamHub (stdout)');

    encoder = spawn('ffmpeg', [
      '-hide_banner',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-i', 'pipe:0',
      '-acodec', 'libmp3lame',
      ...getEncoderRateArgs(),
      '-f', 'mp3',
      'pipe:1',
    ]);

    encoder.stdout?.on('data', (chunk: Buffer) => {
      _streamHub?.broadcast(chunk);
    });
  }

  encoder.stderr?.on('data', () => {});
  encoder.stdin?.on('error', () => {});

  encoder.on('close', (code) => {
    console.log(`[encoder] Exited with code ${code}`);
    encoder = null;
  });

  encoder.on('error', (err) => {
    console.error(`[encoder] Error: ${err.message}`);
    encoder = null;
  });

  return encoder;
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

  playerEvents.on('queue:add', () => {
    // Invalidate fallback nextReady so queued track gets priority
    if (nextReady?.isFallback) {
      if (nextReady.cleanupAfterUse && !keepFiles) cleanupFile(nextReady.audioFile);
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

export function stopPlayCycle(): void {
  isRunning = false;
  skipWhenReady = false;
  setSkipLock(false);
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
  if (autoReadyBuffer.length > 0) {
    for (const entry of autoReadyBuffer) {
      if (entry.cleanupAfterUse && !keepFiles) cleanupFile(entry.audioFile);
    }
    autoReadyBuffer = [];
  }
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
      .filter((q) => !isInBuffer(q.id) && q.id !== nextReady?.queueItemId)
      .slice(0, slotsAvailable);

    for (const next of toPreload) {
      if (!isRunning) break;

      try {
        console.log(`[preload] Downloading (${preloadBuffer.length + 1}/${MAX_PRELOAD}): ${next.title ?? next.youtube_id}`);

        const info = await fetchVideoInfo(next.youtube_url);
        if (info.title && !next.title) next.title = info.title;

        const audioFile = await downloadAudio(next, cacheDir);

        const freshQueue = await getQueue(sb);
        if (!freshQueue.some((q) => q.id === next.id)) {
          if (!keepFiles) cleanupFile(audioFile);
          console.log(`[preload] Discarded (removed from queue): ${next.title ?? next.youtube_id}`);
          continue;
        }

        preloadBuffer.push({ item: next, audioFile, duration: info.duration });
        console.log(`[preload] Ready (${preloadBuffer.length}/${MAX_PRELOAD}): ${next.title ?? next.youtube_id}`);
        broadcastUpcomingTrack();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[preload] Failed: ${next.title ?? next.youtube_id} — ${msg}`);
        await markUnplayableQueueItem(sb, next, 'preload', msg);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[preload] Buffer fill error: ${msg}`);
  } finally {
    preloading = false;
  }
}

async function ensureAutoReadyBuffer(sb: SupabaseClient, cacheDir: string): Promise<void> {
  void sb;
  void cacheDir;
  const activeAutoGenre = parseAutoFallbackGenreId(activeFallbackGenre);
  if (!activeAutoGenre) return;
  if (autoBufferFilling) return;
  autoBufferFilling = true;

  try {
    while (isRunning && getAutoReadyCount() < AUTO_READY_MIN && autoReadyBuffer.length < AUTO_READY_MAX) {
      const ready = activeAutoGenre === LIKED_AUTO_GENRE_ID
        ? await prepareLikedAutoFallbackTrack()
        : await prepareAutoFallbackByGenre(activeAutoGenre);
      if (!ready) break;
      const stillActiveAuto = parseAutoFallbackGenreId(activeFallbackGenre);
      if (stillActiveAuto !== activeAutoGenre) {
        if (ready.cleanupAfterUse && !keepFiles) cleanupFile(ready.audioFile);
        break;
      }
      autoReadyBuffer.push(ready);
      console.log(`[auto-preload] Buffered auto track (${getAutoReadyCount()}/${AUTO_READY_MIN}): ${ready.title ?? activeAutoGenre}`);
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
  let trackCleanupAfterUse = false;
  let source = '';
  const activeAutoGenre = parseAutoFallbackGenreId(activeFallbackGenre);

  async function pickImmediateFallback(quickMeta = true): Promise<boolean> {
    if (activeAutoGenre) return false;
    const fallbackFile = pickRandomFallbackForGenre(activeFallbackGenre, lastFallbackFile);
    if (!fallbackFile) return false;
    audioFile = fallbackFile;
    trackTitle = titleFromFilename(fallbackFile);
    trackYoutubeId = 'local';
    trackDuration = quickMeta ? null : await getAudioDuration(fallbackFile);
    trackThumbnail = quickMeta ? null : await getFallbackArtworkDataUrl(fallbackFile);
    trackAddedBy = null;
    isFallback = true;
    trackCleanupAfterUse = false;
    source = quickMeta ? 'random/gap-guard' : 'random';
    currentQueueItemId = null;
    return true;
  }

  async function pickImmediateAutoFallback(): Promise<boolean> {
    if (!activeAutoGenre) return false;
    let ready = takeAutoReadyFromBuffer();
    if (!ready) {
      await ensureAutoReadyBuffer(sb, cacheDir);
      ready = takeAutoReadyFromBuffer();
    }
    if (!ready) {
      ready = activeAutoGenre === LIKED_AUTO_GENRE_ID
        ? await prepareLikedAutoFallbackTrack()
        : await prepareAutoFallbackByGenre(activeAutoGenre);
    }
    if (!ready) return false;
    audioFile = ready.audioFile;
    trackTitle = ready.title;
    trackThumbnail = ready.thumbnail;
    trackYoutubeId = ready.youtubeId;
    trackDuration = ready.duration;
    trackAddedBy = null;
    isFallback = true;
    trackCleanupAfterUse = ready.cleanupAfterUse;
    source = 'auto/random';
    currentQueueItemId = null;
    return true;
  }

  // ── FAST PATH: use pre-prepared track (instant, no DB call) ──
  // Guard against stale prepare races where "next" accidentally equals current.
  if (nextReady?.queueItemId && !nextReady.isFallback) {
    const freshQueue = await getQueue(sb);
    if (!freshQueue.some((q) => q.id === nextReady?.queueItemId)) {
      const stale = nextReady;
      nextReady = null;
      if (stale.cleanupAfterUse && !keepFiles) cleanupFile(stale.audioFile);
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
    trackCleanupAfterUse = ready.cleanupAfterUse;
    source = isFallback ? 'ready/random' : 'ready/preloaded';
    currentQueueItemId = trackQueueId;
    broadcastUpcomingTrack();
  } else {
    if (nextReady && nextReady.queueItemId === currentTrack?.id) {
      const stale = nextReady;
      nextReady = null;
      if (stale.cleanupAfterUse && !keepFiles) cleanupFile(stale.audioFile);
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
        source = 'preloaded';
      } else {
        // Gap guard: never block transition on download preparation.
        // If queue item isn't ready yet, play random fallback first.
        console.log(`[player] Gap guard: queue item not ready, playing random first (${item.title ?? item.youtube_id})`);
        void prepareNextTrack(sb, cacheDir, currentTrack?.id ?? null);
        const fallbackPicked = activeAutoGenre
          ? (await pickImmediateAutoFallback()) || (await pickImmediateFallback(true))
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
      const fallbackPicked = activeAutoGenre
        ? (await pickImmediateAutoFallback()) || (await pickImmediateFallback(queue.length > 0))
        : (await pickImmediateFallback(queue.length > 0)) || (await pickImmediateAutoFallback());
      if (!fallbackPicked) {
        currentTrack = null;
        currentQueueItemId = null;
        pendingQueueUpcoming = null;
        io.emit('track:change', null);
        console.log('[player] Queue empty — waiting for tracks...');
        await waitForQueueAdd();
        return;
      }
    }
  }

  if (!audioFile) return;

  const trackId = trackQueueId ?? `fallback_${Date.now()}`;

  try {
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
    };
    pendingQueueUpcoming = null;
    pendingAutoUpcoming = null;
    io.emit('track:change', currentTrack);
    if (isFallback) {
      lastFallbackFile = audioFile;
    }
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

    await decodeToEncoder(audioFile, enc);

    // ── Handle seamless swap chain ──
    // After decodeToEncoder resolves (either track finished or swap happened),
    // check if there's a completed swap. If so, set up the new track and keep
    // piping. This loop supports chained skips (skip during a swapped track).
    while (completedSwap) {
      const swap = completedSwap;
      completedSwap = null;

      // Clean up old track
      if (audioFile && trackCleanupAfterUse && !keepFiles) cleanupFile(audioFile);
      if (audioFile && !isFallback) {
        sb.from('played_history').insert({
          youtube_id: trackYoutubeId, title: trackTitle,
          thumbnail: trackThumbnail, duration_s: trackDuration,
        }).then(() => {}, () => {});
      }

      // Set up new track metadata
      audioFile = swap.ready.audioFile;
      trackTitle = swap.ready.title;
      trackThumbnail = swap.ready.thumbnail;
      trackYoutubeId = swap.ready.youtubeId;
      trackDuration = swap.ready.duration;
      trackAddedBy = swap.ready.addedBy;
      trackQueueId = swap.ready.queueItemId;
      isFallback = swap.ready.isFallback;
      trackCleanupAfterUse = swap.ready.cleanupAfterUse;

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
      };
      io.emit('track:change', currentTrack);
      if (isFallback) {
        lastFallbackFile = audioFile;
      }
      setSkipLock(false);
      console.log(`[player] Seamless skip → ${trackTitle ?? trackYoutubeId} (${durStr})`);
      currentQueueItemId = trackQueueId;

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
    const isEncoderCrash = !encoder || encoder.killed || encoder.exitCode !== null;

    if (isEncoderCrash) {
      console.warn(`[player] Encoder crashed during ${trackTitle ?? trackYoutubeId} — restarting encoder (not counting as track failure)`);
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

    if (audioFile && trackCleanupAfterUse && !keepFiles) {
      cleanupFile(audioFile);
    }

    if (audioFile && !isFallback) {
      sb.from('played_history').insert({
        youtube_id: trackYoutubeId,
        title: trackTitle,
        thumbnail: trackThumbnail,
        duration_s: trackDuration,
      }).then(() => {}, () => {});
    }
  }
}

/**
 * Decode an audio file to raw PCM and pipe into the encoder stdin.
 * Supports seamless hot-swap: while piping, if a pendingSwap becomes
 * ready (its firstChunk is set) we write the new chunk, kill the old
 * decoder, and resolve — the old track's audio plays right up to the
 * switch point with zero silence.
 */
function decodeToEncoder(audioFile: string, enc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!enc.stdin || enc.stdin.destroyed) {
      reject(new Error('Encoder stdin not available'));
      return;
    }

    const decoder = spawn('ffmpeg', [
      '-hide_banner',
      '-re',
      '-i', audioFile,
      '-vn',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
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
      console.warn(`[encoder] stdin error during decode: ${err.message}`);
      killDecoderProcess(decoder);
    }

    function onEncClose() {
      killDecoderProcess(decoder);
    }

    enc.stdin.on('error', onStdinError);
    enc.on('close', onEncClose);

    decoder.stdout?.on('data', (chunk: Buffer) => {
      if (settled || pipeError) return;

      // ── Check for seamless swap ──
      if (pendingSwap?.firstChunk) {
        const swap = pendingSwap;
        pendingSwap = null;

        // Write the NEW track's first audio chunk to the encoder
        if (enc.stdin && !enc.stdin.destroyed) {
          try { enc.stdin.write(swap.firstChunk); } catch {}
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
      if (enc.stdin && !enc.stdin.destroyed) {
        try {
          const ok = enc.stdin.write(chunk);
          if (!ok) {
            decoder.stdout?.pause();
            enc.stdin.once('drain', () => decoder.stdout?.resume());
          }
        } catch {
          pipeError = true;
        }
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

    function finish() {
      if (settled) return;
      settled = true;
      currentDecoder = null;
      resolve();
    }

    decoder.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;

      // Support chained skips during the swapped track
      if (pendingSwap?.firstChunk) {
        const swap = pendingSwap;
        pendingSwap = null;

        if (enc.stdin && !enc.stdin.destroyed) {
          try { enc.stdin.write(swap.firstChunk); } catch {}
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
          if (!ok) {
            decoder.stdout?.pause();
            enc.stdin.once('drain', () => decoder.stdout?.resume());
          }
        } catch {}
      }
    });

    decoder.on('close', () => finish());
    decoder.on('error', () => finish());

    // Resume the paused stdout (it was paused after firstChunk capture)
    decoder.stdout?.resume();
  });
}

let downloadCounter = 0;

function resolveAlternativeYoutubeUrl(item: QueueItem): Promise<string | null> {
  return new Promise((resolve) => {
    const query = (item.title ?? item.youtube_id ?? '').trim();
    if (!query) {
      resolve(null);
      return;
    }

    const proc = spawn('python', [
      '-m', 'yt_dlp',
      '--flat-playlist',
      '--print', '%(id)s',
      '--no-warnings',
      '--playlist-end', '5',
      `ytsearch5:${query}`,
    ], { timeout: 15_000 });

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
    const safeId = item.youtube_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const uniqueTag = `${safeId}_${Date.now()}_${downloadCounter++}`;
    const outputTemplate = path.join(cacheDir, `${uniqueTag}.%(ext)s`);

    function downloadFrom(url: string): Promise<string> {
      return new Promise((resolveDownload, rejectDownload) => {
        const proc = spawn('python', [
          '-m', 'yt_dlp',
          '--format', 'bestaudio',
          '--no-playlist',
          '--no-warnings',
          '-o', outputTemplate,
          url,
        ]);

        let stderr = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            rejectDownload(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 200)}`));
            return;
          }

          const files = fs.readdirSync(cacheDir)
            .filter((f) => f.startsWith(uniqueTag))
            .map((f) => path.join(cacheDir, f));

          if (files.length === 0) {
            rejectDownload(new Error('yt-dlp completed but no file found'));
            return;
          }

          resolveDownload(files[0]);
        });

        proc.on('error', (err) => {
          rejectDownload(new Error(`Failed to start yt-dlp: ${err.message}`));
        });
      });
    }

    downloadFrom(item.youtube_url)
      .then(resolve)
      .catch(async (primaryErr) => {
        const altUrl = await resolveAlternativeYoutubeUrl(item);
        if (!altUrl) {
          reject(primaryErr);
          return;
        }
        console.warn(`[download] Primary source failed for ${item.title ?? item.youtube_id}; trying alternative source`);
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
  const activeAutoGenre = parseAutoFallbackGenreId(activeFallbackGenre);
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
        };
        pendingQueueUpcoming = null;
        console.log(`[prepare] Next ready (preloaded): ${item.title ?? item.youtube_id}`);
        clearPrepareFailure(item.id);
        broadcastUpcomingTrack();
        break;
      }

      try {
        const info = await fetchVideoInfo(item.youtube_url);
        if (info.title && !item.title) item.title = info.title;
        console.log(`[prepare] Downloading next: ${item.title ?? item.youtube_id}`);
        const audioFile = await downloadAudio(item, cacheDir);
        const freshQueue = await getQueue(sb);
        if (!freshQueue.some((q) => q.id === item?.id)) {
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
        };
        pendingQueueUpcoming = null;
        console.log(`[prepare] Next ready (downloaded): ${item.title ?? item.youtube_id}`);
        clearPrepareFailure(item.id);
        broadcastUpcomingTrack();
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!item) throw err;
        const removed = await markUnplayableQueueItem(sb, item, 'prepare', msg);
        if (!removed) {
          throw err;
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
      if (activeAutoGenre) {
        await ensureAutoReadyBuffer(sb, cacheDir);
        const autoReady = takeAutoReadyFromBuffer() ?? (
          activeAutoGenre === LIKED_AUTO_GENRE_ID
            ? await prepareLikedAutoFallbackTrack()
            : await prepareAutoFallbackByGenre(activeAutoGenre)
        );
        if (autoReady) {
          nextReady = autoReady;
          console.log(`[prepare] Next ready (auto genre): ${autoReady.title ?? activeAutoGenre}`);
          broadcastUpcomingTrack();
          void ensureAutoReadyBuffer(sb, cacheDir);
          return;
        }
      }

      const fallbackFile = pickRandomFallbackForGenre(activeFallbackGenre, lastFallbackFile);
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
        };
        console.log(`[prepare] Next ready (random): ${title}`);
        broadcastUpcomingTrack();
      } else if (activeAutoGenre) {
        await ensureAutoReadyBuffer(sb, cacheDir);
        const autoReady = takeAutoReadyFromBuffer() ?? (
          activeAutoGenre === LIKED_AUTO_GENRE_ID
            ? await prepareLikedAutoFallbackTrack()
            : await prepareAutoFallbackByGenre(activeAutoGenre)
        );
        if (autoReady) {
          nextReady = autoReady;
          console.log(`[prepare] Next ready (auto genre): ${autoReady.title ?? activeAutoGenre}`);
          broadcastUpcomingTrack();
          void ensureAutoReadyBuffer(sb, cacheDir);
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

  // If a skip is waiting for this track, trigger the seamless swap now
  if (skipWhenReady && nextReady && encoder?.stdin && !encoder.stdin.destroyed) {
    skipWhenReady = false;
    const ready = nextReady;
    nextReady = null;
    broadcastUpcomingTrack();
    beginSeamlessSwap(ready);
    console.log('[player] skipWhenReady triggered — seamless swap started');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
