import fs from 'node:fs';
import path from 'node:path';
import type { GenreHitItem } from './services/discovery.js';

export interface GenreHitsCacheEntry {
  results: GenreHitItem[];
  ts: number;
}

interface PersistedGenreHitsCacheFile {
  version: 1;
  entries: Array<{
    key: string;
    results: GenreHitItem[];
    ts: number;
  }>;
}

const STORE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 5_000;
const HYDRATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const dataDir = path.resolve(process.cwd(), 'data');
const cacheStoreFile = path.join(dataDir, 'genre_cache_store.json');
const cacheStoreTempFile = `${cacheStoreFile}.tmp`;

const genreHitsCache = new Map<string, GenreHitsCacheEntry>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function makeGenreHitsCacheKey(
  genre: string,
  limit: number,
  offset: number,
  includeLocal: boolean,
): string {
  return `${genre.toLowerCase()}::${limit}::${offset}::local=${includeLocal ? '1' : '0'}`;
}

export function getGenreHitsCacheEntry(key: string): GenreHitsCacheEntry | undefined {
  return genreHitsCache.get(key);
}

export function hasGenreHitsCacheEntry(key: string): boolean {
  return genreHitsCache.has(key);
}

export function setGenreHitsCacheEntry(key: string, results: GenreHitItem[]): void {
  genreHitsCache.set(key, { results, ts: Date.now() });
  scheduleCachePersist();
}

export function clearGenreHitsCache(): void {
  genreHitsCache.clear();
  scheduleCachePersist();
}

export function getCachedGenreHits(
  genre: string,
  limit: number,
  offset: number,
  includeLocal = true,
): GenreHitItem[] {
  const key = makeGenreHitsCacheKey(genre, limit, offset, includeLocal);
  return genreHitsCache.get(key)?.results ?? [];
}

function scheduleCachePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistGenreHitsCacheToDisk();
  }, PERSIST_DEBOUNCE_MS);
}

export function persistGenreHitsCacheToDisk(): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const payload: PersistedGenreHitsCacheFile = {
      version: STORE_VERSION,
      entries: Array.from(genreHitsCache.entries()).map(([key, entry]) => ({
        key,
        results: entry.results,
        ts: entry.ts,
      })),
    };
    fs.writeFileSync(cacheStoreTempFile, JSON.stringify(payload), 'utf8');
    fs.renameSync(cacheStoreTempFile, cacheStoreFile);
  } catch (err) {
    console.warn('[cache] Failed to persist genre cache:', (err as Error).message);
  }
}

export function hydrateGenreHitsCacheFromDisk(): void {
  try {
    if (!fs.existsSync(cacheStoreFile)) return;
    const raw = fs.readFileSync(cacheStoreFile, 'utf8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as PersistedGenreHitsCacheFile;
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.entries)) return;
    const now = Date.now();
    for (const entry of parsed.entries) {
      if (!entry || typeof entry.key !== 'string') continue;
      if (!Array.isArray(entry.results)) continue;
      if (typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) continue;
      if (now - entry.ts > HYDRATE_MAX_AGE_MS) continue;
      genreHitsCache.set(entry.key, {
        results: entry.results,
        ts: entry.ts,
      });
    }
  } catch (err) {
    console.warn('[cache] Failed to hydrate genre cache:', (err as Error).message);
  }
}
