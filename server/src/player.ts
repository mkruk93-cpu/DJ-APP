import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SupabaseClient } from '@supabase/supabase-js';
import type { Server as IOServer } from 'socket.io';
import type { QueueItem, Track } from './types.js';
import { getNextTrack, clearQueueItem, getQueue, fetchVideoInfo } from './queue.js';
import { cleanupFile } from './cleanup.js';

export const playerEvents = new EventEmitter();

let currentTrack: Track | null = null;
let currentDecoder: ChildProcess | null = null;
let encoder: ChildProcess | null = null;
let isRunning = false;
let keepFiles = false;

const STREAM_DELAY_MS = parseInt(process.env.STREAM_DELAY_MS ?? '8000', 10);
const FALLBACK_MUSIC_DIR = process.env.FALLBACK_MUSIC_DIR ?? '';

let fallbackFiles: string[] = [];

function loadFallbackLibrary(): void {
  if (!FALLBACK_MUSIC_DIR) return;
  try {
    const exts = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.wma']);
    function scan(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (exts.has(path.extname(entry.name).toLowerCase())) fallbackFiles.push(full);
      }
    }
    scan(FALLBACK_MUSIC_DIR);
    console.log(`[player] Fallback library: ${fallbackFiles.length} tracks from ${FALLBACK_MUSIC_DIR}`);
  } catch (err) {
    console.warn(`[player] Could not scan fallback dir: ${(err as Error).message}`);
  }
}

function pickRandomFallback(): string | null {
  if (fallbackFiles.length === 0) return null;
  const idx = Math.floor(Math.random() * fallbackFiles.length);
  return fallbackFiles[idx];
}

function titleFromFilename(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
    .replace(/^\d{2,4}\s*[-.]?\s*/, '')
    .trim();
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

const MAX_PRELOAD = 5;

interface PreloadedTrack {
  item: QueueItem;
  audioFile: string;
  duration: number | null;
}

let preloadBuffer: PreloadedTrack[] = [];
let preloading = false;

let _sb: SupabaseClient | null = null;
let _cacheDir = '';

interface ReadyTrack {
  audioFile: string;
  title: string | null;
  thumbnail: string | null;
  youtubeId: string;
  duration: number | null;
  queueItemId: string | null;
  isFallback: boolean;
}

let nextReady: ReadyTrack | null = null;
let preparingNext = false;

export function getCurrentTrack(): Track | null {
  return currentTrack;
}

export function skipCurrentTrack(): void {
  if (currentDecoder && currentDecoder.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(currentDecoder.pid), '/f', '/t']);
      } else {
        process.kill(currentDecoder.pid, 'SIGTERM');
      }
    } catch {
      console.warn('[player] Could not kill decoder process');
    }
  }
}

export function setKeepFiles(keep: boolean): void {
  keepFiles = keep;
}

export function invalidatePreload(): void {
  if (preloadBuffer.length === 0) return;
  for (const p of preloadBuffer) {
    if (!keepFiles) cleanupFile(p.audioFile);
  }
  preloadBuffer = [];
  console.log('[preload] Buffer invalidated');
}

function takeFromBuffer(itemId: string): PreloadedTrack | null {
  const idx = preloadBuffer.findIndex((p) => p.item.id === itemId);
  if (idx === -1) return null;
  const [found] = preloadBuffer.splice(idx, 1);
  return found;
}

function isInBuffer(itemId: string): boolean {
  return preloadBuffer.some((p) => p.item.id === itemId);
}

// Persistent encoder: stays connected to Icecast across tracks
function ensureEncoder(
  icecast: { host: string; port: number; password: string; mount: string },
): ChildProcess {
  if (encoder && !encoder.killed && encoder.exitCode === null) return encoder;

  const icecastUrl = `icecast://source:${icecast.password}@${icecast.host}:${icecast.port}${icecast.mount}`;

  console.log('[encoder] Starting persistent encoder → Icecast');

  encoder = spawn('ffmpeg', [
    '-hide_banner',
    '-f', 's16le',
    '-ar', '44100',
    '-ac', '2',
    '-i', 'pipe:0',
    '-acodec', 'libmp3lame',
    '-b:a', '128k',
    '-f', 'mp3',
    '-content_type', 'audio/mpeg',
    icecastUrl,
  ]);

  encoder.stderr?.on('data', () => {});

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
  icecast: { host: string; port: number; password: string; mount: string },
): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  _sb = sb;
  _cacheDir = cacheDir;

  loadFallbackLibrary();

  playerEvents.on('queue:add', () => {
    // Invalidate fallback nextReady so queued track gets priority
    if (nextReady?.isFallback) {
      console.log('[prepare] Invalidated fallback — queue item added');
      nextReady = null;
    }
    if (currentTrack && !preloading && preloadBuffer.length < MAX_PRELOAD && _sb) {
      fillPreloadBuffer(_sb, _cacheDir, currentTrack.id);
    }
    // Re-prepare next with the new queue item
    if (_sb && currentTrack) {
      prepareNextTrack(_sb, _cacheDir, currentTrack.id);
    }
  });

  console.log('[player] Play cycle started');
  const failCounts = new Map<string, number>();
  const MAX_RETRIES = 2;

  while (isRunning) {
    try {
      await playNext(sb, io, cacheDir, icecast, failCounts, MAX_RETRIES);
    } catch (err) {
      console.error('[player] Cycle error:', err);
      io.emit('error:toast', { message: 'Afspeelfout — volgende nummer wordt geladen' });
      await sleep(2000);
    }
  }
}

export function stopPlayCycle(): void {
  isRunning = false;
  skipCurrentTrack();
  if (encoder && encoder.stdin) {
    encoder.stdin.end();
  }
}

async function fillPreloadBuffer(sb: SupabaseClient, cacheDir: string, currentId: string): Promise<void> {
  if (preloading) return;
  preloading = true;

  try {
    const queue = await getQueue(sb);
    const upcoming = queue.filter((q) => q.id !== currentId && !isInBuffer(q.id));

    const slotsAvailable = MAX_PRELOAD - preloadBuffer.length;
    const toPreload = upcoming.slice(0, slotsAvailable);

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[preload] Failed: ${next.title ?? next.youtube_id} — ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[preload] Buffer fill error: ${msg}`);
  } finally {
    preloading = false;
  }
}

async function playNext(
  sb: SupabaseClient,
  io: IOServer,
  cacheDir: string,
  icecast: { host: string; port: number; password: string; mount: string },
  failCounts: Map<string, number>,
  maxRetries: number,
): Promise<void> {
  let audioFile: string | null = null;
  let trackTitle: string | null = null;
  let trackThumbnail: string | null = null;
  let trackYoutubeId = '';
  let trackDuration: number | null = null;
  let trackQueueId: string | null = null;
  let isFallback = false;
  let source = '';

  // ── FAST PATH: use pre-prepared track (instant, no DB call) ──
  if (nextReady) {
    const ready = nextReady;
    nextReady = null;
    audioFile = ready.audioFile;
    trackTitle = ready.title;
    trackThumbnail = ready.thumbnail;
    trackYoutubeId = ready.youtubeId;
    trackDuration = ready.duration;
    trackQueueId = ready.queueItemId;
    isFallback = ready.isFallback;
    source = isFallback ? 'ready/random' : 'ready/preloaded';
  } else {
    // ── NORMAL PATH: fetch from queue or fallback ──
    const item = await getNextTrack(sb);

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
        source = 'preloaded';
      } else {
        const info = await fetchVideoInfo(item.youtube_url);
        trackDuration = info.duration;
        if (info.title && !item.title) item.title = info.title;

        // Show "loading" state while downloading
        currentTrack = {
          id: item.id, youtube_id: item.youtube_id,
          title: item.title, thumbnail: item.thumbnail,
          duration: trackDuration, started_at: 0,
        };
        io.emit('track:change', currentTrack);

        console.log(`[player] Downloading: ${item.title ?? item.youtube_id}`);
        audioFile = await downloadAudio(item, cacheDir);
        source = 'downloaded';
      }

      trackTitle = item.title;
      trackThumbnail = item.thumbnail;
      trackYoutubeId = item.youtube_id;
      trackQueueId = item.id;
      failCounts.delete(item.youtube_id);
    } else {
      const fallbackFile = pickRandomFallback();
      if (fallbackFile) {
        audioFile = fallbackFile;
        trackTitle = titleFromFilename(fallbackFile);
        trackYoutubeId = 'local';
        trackDuration = await getAudioDuration(fallbackFile);
        isFallback = true;
        source = 'random';
      } else {
        currentTrack = null;
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

    // Ensure encoder is ready
    const enc = ensureEncoder(icecast);

    // NOW show track + set timer — audio is about to stream
    currentTrack = {
      id: trackId,
      youtube_id: trackYoutubeId,
      title: trackTitle,
      thumbnail: trackThumbnail,
      duration: trackDuration,
      started_at: Date.now() + STREAM_DELAY_MS,
    };
    io.emit('track:change', currentTrack);

    const durStr = trackDuration
      ? `${Math.floor(trackDuration / 60)}:${String(Math.round(trackDuration % 60)).padStart(2, '0')}`
      : '?';
    console.log(`[player] Streaming (${source}): ${trackTitle ?? trackYoutubeId} (${durStr})`);

    // Start preparing next track in background while this one plays
    prepareNextTrack(sb, cacheDir, trackQueueId);

    await decodeToEncoder(audioFile, enc);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    console.error(`[player] Error playing ${trackYoutubeId}: ${message}`);
    if (!isFallback) {
      const newFails = (failCounts.get(trackYoutubeId) ?? 0) + 1;
      failCounts.set(trackYoutubeId, newFails);
      console.warn(`[player] Fail ${newFails}/${maxRetries} for ${trackTitle ?? trackYoutubeId}`);
    }
    io.emit('error:toast', { message: `Fout bij afspelen: ${trackTitle ?? trackYoutubeId}` });
  } finally {
    currentDecoder = null;

    if (audioFile && !isFallback && !keepFiles) {
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

/** Decode an audio file to raw PCM and pipe it into the encoder's stdin. */
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

    decoder.stdout?.on('data', (chunk: Buffer) => {
      if (enc.stdin && !enc.stdin.destroyed) {
        const ok = enc.stdin.write(chunk);
        if (!ok) {
          decoder.stdout?.pause();
          enc.stdin.once('drain', () => decoder.stdout?.resume());
        }
      }
    });

    let stderr = '';
    decoder.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    decoder.on('close', (code) => {
      currentDecoder = null;
      if (code === 0 || code === 255 || code === null) {
        resolve();
      } else {
        reject(new Error(`decoder exited ${code}: ${stderr.slice(-200)}`));
      }
    });

    decoder.on('error', (err) => {
      currentDecoder = null;
      reject(new Error(`Failed to start decoder: ${err.message}`));
    });

    // If the encoder dies, kill the decoder
    enc.on('close', () => {
      if (decoder.pid && decoder.exitCode === null) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(decoder.pid), '/f', '/t']);
          } else {
            process.kill(decoder.pid, 'SIGTERM');
          }
        } catch {}
      }
    });
  });
}

function downloadAudio(item: QueueItem, cacheDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(
      cacheDir,
      `%(artist,uploader,creator|Unknown)s - %(title)s [${item.youtube_id}].%(ext)s`,
    );

    const proc = spawn('python', [
      '-m', 'yt_dlp',
      '--format', 'bestaudio',
      '--no-playlist',
      '--no-warnings',
      '-o', outputTemplate,
      item.youtube_url,
    ]);

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }

      const files = fs.readdirSync(cacheDir)
        .filter((f) => f.includes(item.youtube_id))
        .map((f) => path.join(cacheDir, f));

      if (files.length === 0) {
        reject(new Error('yt-dlp completed but no file found'));
        return;
      }

      resolve(files[0]);
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
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
  preparingNext = true;

  try {
    const item = await getNextTrack(sb);

    if (item && item.id !== currentItemId) {
      const buffered = takeFromBuffer(item.id);
      if (buffered) {
        if (buffered.item.title) item.title = buffered.item.title;
        nextReady = {
          audioFile: buffered.audioFile,
          title: item.title,
          thumbnail: item.thumbnail,
          youtubeId: item.youtube_id,
          duration: buffered.duration,
          queueItemId: item.id,
          isFallback: false,
        };
        console.log(`[prepare] Next ready (preloaded): ${item.title ?? item.youtube_id}`);
      } else {
        const info = await fetchVideoInfo(item.youtube_url);
        if (info.title && !item.title) item.title = info.title;
        console.log(`[prepare] Downloading next: ${item.title ?? item.youtube_id}`);
        const audioFile = await downloadAudio(item, cacheDir);
        nextReady = {
          audioFile,
          title: item.title,
          thumbnail: item.thumbnail,
          youtubeId: item.youtube_id,
          duration: info.duration,
          queueItemId: item.id,
          isFallback: false,
        };
        console.log(`[prepare] Next ready (downloaded): ${item.title ?? item.youtube_id}`);
      }
    } else {
      const fallbackFile = pickRandomFallback();
      if (fallbackFile) {
        const title = titleFromFilename(fallbackFile);
        const duration = await getAudioDuration(fallbackFile);
        nextReady = {
          audioFile: fallbackFile,
          title,
          thumbnail: null,
          youtubeId: 'local',
          duration,
          queueItemId: null,
          isFallback: true,
        };
        console.log(`[prepare] Next ready (random): ${title}`);
      }
    }
  } catch (err) {
    console.warn(`[prepare] Failed: ${(err as Error).message}`);
  } finally {
    preparingNext = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
