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
import { getTopTracksByGenre, getMergedGenreTags, getPriorityArtistsForGenre, resolveMergedGenreId, type GenreHitItem } from './services/discovery.js';
import { getCachedGenreHits, makeGenreHitsCacheKey, setGenreHitsCacheEntry } from './genreHitsStore.js';

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
let skipLockWatchdog: ReturnType<typeof setTimeout> | null = null;
let selfHealTimer: ReturnType<typeof setInterval> | null = null;
let lastAudioProgressAt = 0;
let lastTrackAnnouncedAt = 0;
let lastPrepareKickAt = 0;
let lastSelfHealAt = 0;
let _io: IOServer | null = null;

const SELF_HEAL_CHECK_MS = 5_000;
const SELF_HEAL_COOLDOWN_MS = 6_000;
const SELF_HEAL_STALL_MS = 35_000;
const SELF_HEAL_DURATION_GRACE_SECONDS = 45;

function toWindowsSystemErrorCode(exitCode: number | null): number | null {
  if (exitCode === null) return null;
  // Node can report Windows process exit codes as unsigned 32-bit numbers.
  return exitCode > 0x7fffffff ? (0x1_0000_0000 - exitCode) : null;
}

function isBrokenPipeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /\bEPIPE\b/i.test(msg) || /\bbroken pipe\b/i.test(msg);
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
let activeFallbackGenre: string | null = null;

function isAutoGenreStillActive(expectedGenreId: string): boolean {
  const active = parseAutoFallbackGenreId(activeFallbackGenre);
  if (!active) return false;
  return resolveMergedGenreId(active) === resolveMergedGenreId(expectedGenreId);
}

function getEncoderRateArgs(): string[] {
  // "source"/"true": use high-quality VBR instead of fixed CBR cap.
  if (STREAM_USE_SOURCE_MODE) return ['-q:a', '0'];
  return ['-b:a', STREAM_BITRATE];
}

export function setActiveFallbackGenre(genreId: string | null): void {
  const previousGenre = activeFallbackGenre;
  activeFallbackGenre = genreId;
  const changed = (previousGenre ?? '').trim().toLowerCase() !== (genreId ?? '').trim().toLowerCase();
  const activeAuto = parseAutoFallbackGenreId(genreId);
  if (changed) {
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
  // For generic genre names as title, just use the artist
  const genericTitles = ['melodic techno', 'hard techno', 'euphoric hardstyle', 'hardstyle', 'trance', 'house', 'techno'];
  if (!title || title === artist || genericTitles.some(g => title.toLowerCase().includes(g))) {
    return artist;
  }
  return `${artist} - ${title}`.trim();
}

const DISPLAY_TITLE_SEPARATORS = [' - ', ' – ', ' — ', ' | ', ': '];

function hasDisplayArtistSeparator(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return DISPLAY_TITLE_SEPARATORS.some((sep) => {
    const idx = text.indexOf(sep);
    return idx > 0 && idx < text.length - sep.length;
  });
}

function parseDisplayArtistTitle(value: string): { artist: string | null; title: string } {
  const text = value.trim();
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
  const cleanTitle = title.trim();
  const cleanArtist = artist.trim();
  if (!cleanTitle || !cleanArtist) return cleanTitle;
  for (const sep of DISPLAY_TITLE_SEPARATORS) {
    const prefix = `${cleanArtist}${sep}`.toLowerCase();
    if (cleanTitle.toLowerCase().startsWith(prefix)) {
      return cleanTitle.slice(prefix.length).trim();
    }
  }
  return cleanTitle;
}

function buildAutoDisplayTitle(
  detectedTitle: string | null | undefined,
  fallbackArtist: string | null | undefined,
  fallbackTitle: string | null | undefined,
): string {
  const detected = (detectedTitle ?? '').trim();
  if (detected && hasDisplayArtistSeparator(detected)) return detected;
  const artist = (fallbackArtist ?? '').trim();
  const baseTitle = (fallbackTitle ?? '').trim();
  if (!artist) return detected || baseTitle || 'Unknown title';
  const candidate = stripLeadingArtistFromTitle(detected || baseTitle, artist) || baseTitle || detected;
  return autoTrackTitle(artist, candidate || 'Unknown title');
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

async function resolveShortAutoCandidate(query: string, genreId?: string): Promise<AutoSearchCandidate | null> {
  // Use the same fast API-based search as genre hits instead of yt-dlp processes
  try {
    // Import search functions from the search service
    const { youtubeSearch, soundcloudSearch } = await import('./services/search.js');
    
    // Get genre-specific filtering rules if genreId is provided
    let genreHints: any = null;
    if (genreId) {
      try {
        const { getGenreHints } = await import('./services/discovery.js');
        genreHints = getGenreHints(genreId);
      } catch (err) {
        console.warn(`[auto-filter] Failed to get genre hints for ${genreId}:`, (err as Error).message);
      }
    }

    // Keep the original query for better artist matching
    const searchQuery = query;

    // Try YouTube first with aggressive timeout
    const ytResults = await Promise.race([
      youtubeSearch(searchQuery, 8), // Increased limit for better selection
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)) // Slightly longer timeout
    ]).catch(() => []);

    // Find first suitable YouTube result - prefer shorter tracks
    const sortedResults = ytResults
      .filter(result => {
        if (!result.title || isSetLikeAutoTitle(result.title)) return false;
        if (!result.duration || result.duration < 120 || result.duration > AUTO_MAX_DURATION_SECONDS) return false;
        
        // Filter out obvious non-music content
        const title = result.title.toLowerCase();
        const channel = (result.channel || '').toLowerCase();
        const artistTitle = `${channel} - ${result.title}`.toLowerCase();

        // Apply genre-specific blocked tracks filtering
        if (genreHints?.blockedTracks) {
          const blockedTracks = genreHints.blockedTracks.map((track: string) => track.toLowerCase());
          for (const blockedTrack of blockedTracks) {
            if (blockedTrack && (title.includes(blockedTrack) || artistTitle.includes(blockedTrack))) {
              console.log(`[auto-filter] Blocked by genre rule (${genreId}): ${result.title} (blocked: ${blockedTrack})`);
              return false;
            }
          }
        }

        // Apply genre-specific blocked tokens filtering
        if (genreHints?.blockedTokens) {
          const blockedTokens = genreHints.blockedTokens.map((token: string) => token.toLowerCase());
          for (const token of blockedTokens) {
            if (token && (title.includes(token) || channel.includes(token) || artistTitle.includes(token))) {
              console.log(`[auto-filter] Blocked by genre token (${genreId}): ${result.title} (token: ${token})`);
              return false;
            }
          }
        }

        // Apply genre-specific blocked artists filtering
        if (genreHints?.blockedArtists) {
          const blockedArtists = genreHints.blockedArtists.map((artist: string) => artist.toLowerCase());
          for (const blockedArtist of blockedArtists) {
            if (blockedArtist && channel.includes(blockedArtist)) {
              console.log(`[auto-filter] Blocked by genre artist rule (${genreId}): ${result.title} (artist: ${blockedArtist})`);
              return false;
            }
          }
        }

        // Strict bad keywords filtering
        const badKeywords = [
          'tutorial', 'how to', 'review', 'interview', 'documentary', 'news', 'podcast',
          'lesson', 'course', 'expert', 'spreekt over', 'cyberaanval', 'cybersecurity',
          'iran', 'politics', 'nieuws', 'talk', 'discussion', 'analysis', 'explained',
          'features you might not know', 'cool features', 'tips', 'tricks', 'guide',
          'acoustic live', 'cover', 'live at', 'southampton', 'concert', 'performance'
        ];
        if (badKeywords.some(keyword => title.includes(keyword))) return false;

        // Filter out software/plugin content
        const softwareKeywords = ['sylenth1', 'vst', 'plugin', 'ableton', 'fl studio', 'logic pro'];
        if (softwareKeywords.some(keyword => title.includes(keyword))) return false;
        
        // Must have hardstyle/electronic music indicators
        const requiredGenreKeywords = ['hardstyle', 'euphoric', 'trance', 'techno', 'electronic', 'edm'];
        const hasGenre = requiredGenreKeywords.some(keyword => title.includes(keyword));
        
        // Must have music production indicators
        const musicIndicators = [
          'official', 'video', 'videoclip', 'audio', 'remix', 'edit', 'mix', 
          'rip', 'hq', '4k', 'visualizer', 'music', 'track', 'anthem'
        ];
        const hasIndicator = musicIndicators.some(keyword => title.includes(keyword));
        
        // Must have either genre keyword OR music indicator
        if (!hasGenre && !hasIndicator) return false;
        
        // Extract artist name from query and ensure it's in title or channel
        const queryWords = searchQuery.toLowerCase().split(/[\s\-]+/).filter(word => word.length > 2);
        const hasArtistMatch = queryWords.some(word => 
          title.includes(word) || channel.includes(word)
        );
        
        // For euphoric hardstyle, be extra strict about artist matching
        if (searchQuery.toLowerCase().includes('euphoric') && !hasArtistMatch) return false;
        
        return true;
      })
      .sort((a, b) => (a.duration || 0) - (b.duration || 0)); // Prefer shorter tracks

    if (sortedResults.length > 0) {
      const result = sortedResults[0];
      return {
        url: result.url,
        title: result.title,
        duration: result.duration,
        thumbnail: result.thumbnail,
        source: 'youtube' as const,
      };
    }

    // Try SoundCloud as fallback with aggressive timeout
    const scResults = await Promise.race([
      soundcloudSearch(searchQuery, 5),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
    ]).catch(() => []);
    
    // Find first suitable SoundCloud result
    for (const result of scResults) {
      if (!result.title || isSetLikeAutoTitle(result.title)) continue;
      if (!result.duration || result.duration < 120 || result.duration > AUTO_MAX_DURATION_SECONDS) continue;
      
      return {
        url: result.url,
        title: result.title,
        duration: result.duration,
        thumbnail: result.thumbnail,
        source: 'soundcloud' as const,
      };
    }
    
    return null;
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

async function prepareAutoFallbackByGenre(genreId: string): Promise<ReadyTrack | null> {
  try {
    if (!isAutoGenreStillActive(genreId)) return null;
    const canonicalGenreId = resolveMergedGenreId(genreId);
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
      if (!isAutoGenreStillActive(canonicalGenreId)) return [];
      
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
                console.log(`[auto-playlist] Filtered out non-matching short artist: "${result.title}" by "${result.channel}" (expected: ${artist})`);
                return false;
              }
            } else if (!artistInTitle && !artistInChannel && !simpleMatch) {
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
        if (!isAutoGenreStillActive(canonicalGenreId)) return null;
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
        if (!isAutoGenreStillActive(canonicalGenreId)) return null;
        
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
      if (!isAutoGenreStillActive(canonicalGenreId)) return null;
      const choiceKey = normalizeAutoKey(`${choice.artist} ${choice.title}`);
      if (!choiceKey || inFlightAutoTrackKeys.has(choiceKey)) {
        continue;
      }
      inFlightAutoTrackKeys.add(choiceKey);
      try {
        for (const withGenreTags of [false, true]) {
          if (!isAutoGenreStillActive(canonicalGenreId)) return null;
          const pseudo = buildAutoFallbackSource(canonicalGenreId, choice.artist, choice.title, mergedGenreTags, withGenreTags);
          const query = pseudo.youtube_url.replace(/^ytsearch1:/, '').trim();
          const selected = await resolveShortAutoCandidate(query, genreId);
          if (!isAutoGenreStillActive(canonicalGenreId)) return null;
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
          if (!isAutoGenreStillActive(canonicalGenreId)) return null;
          pendingAutoUpcoming = {
            youtube_id: 'auto',
            title: resolvedTitle,
            thumbnail: choice.thumbnail ?? selected.thumbnail ?? null,
            duration: hintedDuration,
            added_by: null,
            isFallback: true,
          };
          broadcastUpcomingTrack();
          try {
            const audioFile = await downloadAudio(selectedPseudo, _cacheDir);
            if (!isAutoGenreStillActive(canonicalGenreId)) {
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

async function prepareLikedAutoFallbackTrack(): Promise<ReadyTrack | null> {
  try {
    if (parseAutoFallbackGenreId(activeFallbackGenre) !== LIKED_AUTO_GENRE_ID) return null;
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
    if (parseAutoFallbackGenreId(activeFallbackGenre) !== LIKED_AUTO_GENRE_ID) return null;
    if (!selected) {
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
    };
    broadcastUpcomingTrack();
    const audioFile = await downloadAudio(selectedPseudo, _cacheDir);
    if (parseAutoFallbackGenreId(activeFallbackGenre) !== LIKED_AUTO_GENRE_ID) {
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
    };
  } catch (err) {
    pendingAutoUpcoming = null;
    broadcastUpcomingTrack();
    console.warn(`[player] Liked auto fallback prepare failed: ${(err as Error).message}`);
    return null;
  }
}

async function waitForAutoReadyMinimum(sb: SupabaseClient, cacheDir: string, minCount: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isRunning && Date.now() < deadline && getAutoReadyCount() < minCount) {
    await ensureAutoReadyBuffer(sb, cacheDir);
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

  if (skipWhenReady && nextReady && (!encoder?.stdin || encoder.stdin.destroyed)) {
    triggerSelfHeal('skip pending while encoder unavailable');
    return;
  }

  if (currentTrack?.duration && Number.isFinite(currentTrack.duration) && currentTrack.duration > 0) {
    const startedAt = currentTrack.started_at - STREAM_DELAY_MS;
    const elapsedMs = now - startedAt;
    const maxExpectedMs = (currentTrack.duration + SELF_HEAL_DURATION_GRACE_SECONDS) * 1000;
    if (elapsedMs > maxExpectedMs) {
      triggerSelfHeal(`track runtime exceeded (${Math.round(elapsedMs / 1000)}s)`);
      return;
    }
  }

  if (currentTrack) {
    const idleMs = now - Math.max(lastAudioProgressAt, lastTrackAnnouncedAt);
    if (idleMs > SELF_HEAL_STALL_MS) {
      triggerSelfHeal(`audio stalled for ${Math.round(idleMs / 1000)}s`);
      return;
    }
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
    if (winSystemCode === 10053) {
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
  lastAudioProgressAt = Date.now();
  lastTrackAnnouncedAt = Date.now();
  lastPrepareKickAt = Date.now();
  lastSelfHealAt = 0;

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

export function stopPlayCycle(): void {
  isRunning = false;
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
        const { info, audioFile } = await downloadQueueItemShared(next, cacheDir);

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

        preloadBuffer.push({ item: next, audioFile, duration: info.duration });
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

async function ensureAutoReadyBuffer(sb: SupabaseClient, cacheDir: string): Promise<void> {
  void sb;
  void cacheDir;
  const activeAutoGenre = parseAutoFallbackGenreId(activeFallbackGenre);
  if (!activeAutoGenre) return;
  if (autoBufferFilling) return;
  const now = Date.now();
  if (now - lastAutoPreloadAttemptAt < AUTO_PRELOAD_COOLDOWN_MS) return;
  lastAutoPreloadAttemptAt = now;
  autoBufferFilling = true;

  try {
    while (isRunning && getAutoReadyCount() < AUTO_READY_MIN && autoReadyBuffer.length < AUTO_READY_MAX) {
      const ready = activeAutoGenre === LIKED_AUTO_GENRE_ID
        ? await prepareLikedAutoFallbackTrack()
        : await prepareAutoFallbackByGenre(activeAutoGenre);
      if (!ready) break;
      const stillActiveAuto = parseAutoFallbackGenreId(activeFallbackGenre);
      if (stillActiveAuto !== activeAutoGenre) {
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
      console.log(`[auto-preload] Buffered auto track (${getAutoReadyCount()}/${AUTO_READY_MAX}): ${ready.title ?? activeAutoGenre}`);
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
  let source = '';
  const activeAutoGenre = parseAutoFallbackGenreId(activeFallbackGenre);

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
    if (activeAutoGenre && !allowWhenAuto) return false;
    let selectedFile: string | null = null;
    let exclude = lastFallbackFile;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = pickRandomFallbackForGenre(activeFallbackGenre, exclude);
      if (!candidate) break;
      const candidateTitle = titleFromFilename(candidate);
      if (isSetLikeAutoTitle(candidateTitle)) {
        exclude = candidate;
        continue;
      }
      selectedFile = candidate;
      break;
    }
    const fallbackFile = selectedFile ?? pickRandomFallbackForGenre(activeFallbackGenre, lastFallbackFile);
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
    source = quickMeta ? 'random/gap-guard' : 'random';
    if (activeAutoGenre && allowWhenAuto) {
      console.warn(`[player] Emergency local fallback while auto "${activeAutoGenre}" is buffering`);
    }
    currentQueueItemId = null;
    return true;
  }

  async function pickImmediateAutoFallback(timeoutMs = AUTO_IMMEDIATE_PREPARE_TIMEOUT_MS): Promise<boolean> {
    if (!activeAutoGenre) return false;
    if (getAutoReadyCount() < AUTO_READY_START_MIN) {
      await waitForAutoReadyMinimum(sb, cacheDir, AUTO_READY_START_MIN, AUTO_READY_WAIT_TIMEOUT_MS);
    }
    let ready = takeAutoReadyFromBuffer();
    if (!ready) {
      const preparePromise = activeAutoGenre === LIKED_AUTO_GENRE_ID
        ? prepareLikedAutoFallbackTrack()
        : prepareAutoFallbackByGenre(activeAutoGenre);
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
    }
    if (!isAutoGenreStillActive(activeAutoGenre)) return false;
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
    source = 'auto/random';
    currentQueueItemId = null;
    // Refill asynchronously; do not block current playback on buffer refill.
    void ensureAutoReadyBuffer(sb, cacheDir);
    return true;
  }

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
        source = 'preloaded';
      } else {
        // Gap guard: never block transition on download preparation.
        // If queue item isn't ready yet, play random fallback first.
        console.log(`[player] Gap guard: queue item not ready, playing random first (${item.title ?? item.youtube_id})`);
        void prepareNextTrack(sb, cacheDir, currentTrack?.id ?? null);
        const fallbackPicked = activeAutoGenre
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
      const fallbackPicked = activeAutoGenre
        ? (await pickImmediateAutoFallback()) || (await pickImmediateFallback(queue.length > 0, true))
        : (await pickImmediateFallback(queue.length > 0)) || (await pickImmediateAutoFallback());
      if (!fallbackPicked) {
        currentTrack = null;
        currentQueueItemId = null;
        pendingQueueUpcoming = null;
        io.emit('track:change', null);
        if (activeAutoGenre) {
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
    };
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
function decodeToEncoder(audioFile: string, enc: ChildProcess): Promise<void> {
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
      console.warn(`[encoder] stdin error during decode: ${err.message}`);
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
      console.warn(`[encoder] stdin error during chained decode: ${err.message}`);
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
const queueDownloadInFlight = new Map<string, Promise<{ audioFile: string; info: { title: string | null; duration: number | null; thumbnail: string | null } }>>();

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
): Promise<{ audioFile: string; info: { title: string | null; duration: number | null; thumbnail: string | null } }> {
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
    return {
      audioFile,
      info: {
        title: baseInfo.title,
        duration: measuredDuration,
        thumbnail: baseInfo.thumbnail,
      },
    };
  })();

  queueDownloadInFlight.set(key, run);
  run.finally(() => {
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
        if (!item) throw new Error('Queue item missing during prepare');
        const itemSafe = item;
        console.log(`[prepare] Downloading next: ${item.title ?? item.youtube_id}`);
        const { info, audioFile } = await downloadQueueItemShared(itemSafe, cacheDir);
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

      const fallbackFile = activeAutoGenre
        ? null
        : pickRandomFallbackForGenre(activeFallbackGenre, lastFallbackFile);
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
        } else {
          pendingQueueUpcoming = null;
          console.warn(`[prepare] Auto genre "${activeAutoGenre}" has no strict candidates yet`);
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
