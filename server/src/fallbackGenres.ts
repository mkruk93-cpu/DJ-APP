import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { isKnownDiscoveryGenre } from './services/discovery.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac', '.wma']);

interface FallbackGenreConfigItem {
  id: string;
  label?: string;
  folders: string[];
}

interface FallbackGenreConfigFile {
  defaultGenreId?: string;
  genres?: FallbackGenreConfigItem[];
}

export interface FallbackGenreInfo {
  id: string;
  label: string;
  trackCount: number;
}

interface FallbackGenreRuntimeItem {
  id: string;
  label: string;
  files: string[];
}

let runtimeGenres: FallbackGenreRuntimeItem[] = [];
let defaultGenreId: string | null = null;
const AUTO_GENRE_PREFIX = 'auto:';
export const LIKED_AUTO_GENRE_ID = 'liked';

function normalizeGenreId(value: string): string {
  return value.trim().toLowerCase();
}

export function toAutoFallbackGenreId(discoveryGenreId: string): string {
  return `${AUTO_GENRE_PREFIX}${normalizeGenreId(discoveryGenreId)}`;
}

export function parseAutoFallbackGenreId(genreId: string | null | undefined): string | null {
  if (!genreId) return null;
  const normalized = normalizeGenreId(genreId);
  if (!normalized.startsWith(AUTO_GENRE_PREFIX)) return null;
  const inner = normalized.slice(AUTO_GENRE_PREFIX.length).trim();
  return inner || null;
}

function toAbsPath(input: string, configDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const expanded = trimmed.startsWith('~/')
    ? path.join(homedir(), trimmed.slice(2))
    : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

function scanAudioFiles(dirPath: string, out: string[]): void {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanAudioFiles(fullPath, out);
      continue;
    }
    if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(fullPath);
    }
  }
}

function validateGenreItem(raw: FallbackGenreConfigItem): FallbackGenreConfigItem | null {
  const id = (raw.id ?? '').trim();
  if (!id) return null;
  if (!Array.isArray(raw.folders) || raw.folders.length === 0) return null;
  const folders = raw.folders
    .map((folder) => (folder ?? '').trim())
    .filter((folder) => folder.length > 0);
  if (folders.length === 0) return null;
  return { id, label: raw.label, folders };
}

function buildLegacyGenreFromEnv(): FallbackGenreRuntimeItem[] {
  const legacyRaw = process.env.FALLBACK_MUSIC_DIR ?? '';
  if (!legacyRaw.trim()) return [];
  const folderPath = toAbsPath(legacyRaw, process.cwd());
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.warn(`[fallback-genres] Legacy fallback folder not found: ${folderPath}`);
    return [];
  }
  const files: string[] = [];
  scanAudioFiles(folderPath, files);
  return [{
    id: 'all',
    label: 'Alles',
    files,
  }];
}

function getConfigPath(): string {
  const configured = process.env.FALLBACK_GENRES_CONFIG;
  if (configured && configured.trim()) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), 'config', 'fallback-genres.json');
}

export function reloadFallbackGenres(): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configPath)) {
    const legacy = buildLegacyGenreFromEnv();
    runtimeGenres = legacy;
    defaultGenreId = legacy[0]?.id ?? null;
    if (legacy.length > 0) {
      console.log(`[fallback-genres] Loaded legacy fallback genre (${legacy[0].files.length} tracks)`);
    } else {
      console.warn(`[fallback-genres] Config file not found: ${configPath}`);
    }
    return;
  }

  let parsed: FallbackGenreConfigFile;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as FallbackGenreConfigFile;
  } catch (err) {
    console.warn(`[fallback-genres] Invalid JSON config (${configPath}): ${(err as Error).message}`);
    runtimeGenres = [];
    defaultGenreId = null;
    return;
  }

  const rawGenres = Array.isArray(parsed.genres) ? parsed.genres : [];
  const valid = rawGenres
    .map(validateGenreItem)
    .filter((item): item is FallbackGenreConfigItem => item !== null);

  const nextGenres: FallbackGenreRuntimeItem[] = [];
  for (const genre of valid) {
    const files: string[] = [];
    for (const folder of genre.folders) {
      const absFolder = toAbsPath(folder, configDir);
      if (!absFolder || !fs.existsSync(absFolder)) {
        console.warn(`[fallback-genres] Missing folder for ${genre.id}: ${absFolder || folder}`);
        continue;
      }
      if (!fs.statSync(absFolder).isDirectory()) {
        console.warn(`[fallback-genres] Not a folder for ${genre.id}: ${absFolder}`);
        continue;
      }
      scanAudioFiles(absFolder, files);
    }
    nextGenres.push({
      id: genre.id,
      label: (genre.label ?? genre.id).trim() || genre.id,
      files,
    });
  }

  runtimeGenres = nextGenres;
  if (parsed.defaultGenreId && runtimeGenres.some((g) => g.id === parsed.defaultGenreId)) {
    defaultGenreId = parsed.defaultGenreId;
  } else {
    defaultGenreId = runtimeGenres[0]?.id ?? null;
  }

  const summary = runtimeGenres.map((g) => `${g.id}:${g.files.length}`).join(', ');
  console.log(`[fallback-genres] Loaded ${runtimeGenres.length} genre(s)${summary ? ` [${summary}]` : ''}`);
}

export function listFallbackGenres(): FallbackGenreInfo[] {
  return runtimeGenres.map((genre) => ({
    id: genre.id,
    label: genre.label,
    trackCount: genre.files.length,
  }));
}

export function getDefaultFallbackGenreId(): string | null {
  return defaultGenreId;
}

/** True for genres backed by on-disk folders in fallback-genres config (not auto:/shared:). */
export function isLocalDiskFallbackGenre(genreId: string | null | undefined): boolean {
  if (!genreId) return false;
  return runtimeGenres.some((genre) => genre.id === genreId);
}

export function isKnownFallbackGenre(genreId: string | null | undefined): boolean {
  if (!genreId) return false;
  const localKnown = runtimeGenres.some((genre) => genre.id === genreId);
  if (localKnown) return true;
  const autoGenre = parseAutoFallbackGenreId(genreId);
  if (!autoGenre) return false;
  if (autoGenre === LIKED_AUTO_GENRE_ID) return true;
  return isKnownDiscoveryGenre(autoGenre);
}

export function pickRandomFallbackForGenre(
  activeGenreId: string | null | undefined,
  excludeFile: string | null = null,
): string | null {
  const active = activeGenreId && isKnownFallbackGenre(activeGenreId)
    ? runtimeGenres.find((genre) => genre.id === activeGenreId) ?? null
    : null;

  const fallback = defaultGenreId
    ? runtimeGenres.find((genre) => genre.id === defaultGenreId) ?? null
    : null;

  const candidates = active?.files?.length
    ? active.files
    : fallback?.files?.length
      ? fallback.files
      : runtimeGenres.find((genre) => genre.files.length > 0)?.files ?? [];

  if (candidates.length === 0) return null;
  if (excludeFile && candidates.length > 1) {
    const filtered = candidates.filter((file) => file !== excludeFile);
    if (filtered.length > 0) {
      const idx = Math.floor(Math.random() * filtered.length);
      return filtered[idx];
    }
  }
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
}
