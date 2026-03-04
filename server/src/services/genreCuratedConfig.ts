import fs from 'node:fs';
import path from 'node:path';

export interface CuratedGenreRule {
  id: string;
  label?: string;
  priorityArtists?: string[];
  blockedArtists?: string[];
  priorityTracks?: string[];
  blockedTracks?: string[];
  priorityLabels?: string[];
  requiredTokens?: string[];
  blockedTokens?: string[];
  minScore?: number;
}

interface CuratedGenreConfigFile {
  version?: number;
  genres?: CuratedGenreRule[];
  likedPlaylistTracks?: string[];
}

export interface PendingArtistClassification {
  artist: string;
  primaryGenre: string;
  secondaryGenres?: string[];
  confidence: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  source?: string;
}

interface PendingClassificationFile {
  generatedAt?: string;
  items?: PendingArtistClassification[];
}

let cachedConfigPath: string | null = null;
let cachedConfigMtime = 0;
let cachedConfigRules = new Map<string, CuratedGenreRule>();

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function dedupe(values: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function uniqueByNormalized(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function getGenreCurationConfigPath(): string {
  const raw = process.env.GENRE_CURATION_CONFIG?.trim();
  if (raw) {
    return path.isAbsolute(raw)
      ? raw
      : path.resolve(process.cwd(), raw);
  }
  return path.resolve(process.cwd(), 'config', 'genre-curation.json');
}

export function getGenreCurationPendingPath(): string {
  const raw = process.env.GENRE_CURATION_PENDING?.trim();
  if (raw) {
    return path.isAbsolute(raw)
      ? raw
      : path.resolve(process.cwd(), raw);
  }
  return path.resolve(process.cwd(), 'config', 'genre-curation.pending.json');
}

function normalizeRule(rule: CuratedGenreRule): CuratedGenreRule | null {
  const id = normalize(rule.id ?? '');
  if (!id) return null;
  return {
    id,
    label: rule.label?.trim() || undefined,
    priorityArtists: dedupe(rule.priorityArtists),
    blockedArtists: dedupe(rule.blockedArtists),
    priorityTracks: dedupe(rule.priorityTracks),
    blockedTracks: dedupe(rule.blockedTracks),
    priorityLabels: dedupe(rule.priorityLabels),
    requiredTokens: dedupe(rule.requiredTokens),
    blockedTokens: dedupe(rule.blockedTokens),
    minScore: typeof rule.minScore === 'number' && Number.isFinite(rule.minScore)
      ? Math.max(0, Math.round(rule.minScore))
      : undefined,
  };
}

function reloadRules(configPath: string): void {
  if (!fs.existsSync(configPath)) {
    cachedConfigPath = configPath;
    cachedConfigMtime = 0;
    cachedConfigRules = new Map();
    return;
  }
  const stat = fs.statSync(configPath);
  if (
    cachedConfigPath === configPath
    && stat.mtimeMs === cachedConfigMtime
    && cachedConfigRules.size > 0
  ) {
    return;
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as CuratedGenreConfigFile;
  const next = new Map<string, CuratedGenreRule>();
  for (const rule of parsed.genres ?? []) {
    const normalized = normalizeRule(rule);
    if (!normalized) continue;
    next.set(normalized.id, normalized);
  }
  cachedConfigPath = configPath;
  cachedConfigMtime = stat.mtimeMs;
  cachedConfigRules = next;
}

export function listCuratedGenreRules(): CuratedGenreRule[] {
  const configPath = getGenreCurationConfigPath();
  try {
    reloadRules(configPath);
  } catch {
    return [];
  }
  return [...cachedConfigRules.values()];
}

export function getCuratedGenreRule(genreId: string): CuratedGenreRule | null {
  const id = normalize(genreId);
  if (!id) return null;
  const configPath = getGenreCurationConfigPath();
  try {
    reloadRules(configPath);
  } catch {
    return null;
  }
  return cachedConfigRules.get(id) ?? null;
}

export function readPendingClassifications(): PendingArtistClassification[] {
  const pendingPath = getGenreCurationPendingPath();
  if (!fs.existsSync(pendingPath)) return [];
  try {
    const raw = fs.readFileSync(pendingPath, 'utf8');
    const parsed = JSON.parse(raw) as PendingClassificationFile;
    return (parsed.items ?? []).filter((item) => !!item?.artist && !!item?.primaryGenre);
  } catch {
    return [];
  }
}

export function addPriorityArtistForGenre(
  genreId: string,
  artistName: string,
  label?: string,
): CuratedGenreRule {
  const normalizedGenreId = normalize(genreId);
  const normalizedArtist = normalize(artistName);
  const trimmedLabel = label?.trim() || undefined;
  if (!normalizedGenreId) {
    throw new Error('Invalid genre');
  }
  if (!normalizedArtist) {
    throw new Error('Invalid artist');
  }

  const configPath = getGenreCurationConfigPath();
  const base: CuratedGenreConfigFile = { version: 1, genres: [] };
  let parsed: CuratedGenreConfigFile = base;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw) as CuratedGenreConfigFile;
    if (!Array.isArray(parsed.genres)) parsed.genres = [];
    if (typeof parsed.version !== 'number') parsed.version = 1;
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  const genres = parsed.genres ?? [];
  const existingIndex = genres.findIndex((rule) => normalize(rule.id ?? '') === normalizedGenreId);
  if (existingIndex === -1) {
    genres.push({
      id: normalizedGenreId,
      label: trimmedLabel,
      priorityArtists: [normalizedArtist],
    });
  } else {
    const current = genres[existingIndex] ?? { id: normalizedGenreId };
    const priorityArtists = uniqueByNormalized([...(current.priorityArtists ?? []), normalizedArtist]).map(normalize);
    const blockedArtists = dedupe((current.blockedArtists ?? []).filter((value) => normalize(value) !== normalizedArtist));
    genres[existingIndex] = {
      ...current,
      id: normalizedGenreId,
      label: current.label?.trim() || trimmedLabel,
      priorityArtists,
      blockedArtists,
      priorityTracks: dedupe(current.priorityTracks),
      blockedTracks: dedupe(current.blockedTracks),
      priorityLabels: dedupe(current.priorityLabels),
      requiredTokens: dedupe(current.requiredTokens),
      blockedTokens: dedupe(current.blockedTokens),
      minScore: typeof current.minScore === 'number' && Number.isFinite(current.minScore)
        ? Math.max(0, Math.round(current.minScore))
        : current.minScore,
    };
  }

  parsed.genres = genres;
  if (typeof parsed.version !== 'number') parsed.version = 1;
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  cachedConfigPath = null;
  cachedConfigMtime = 0;
  cachedConfigRules = new Map();
  const updated = getCuratedGenreRule(normalizedGenreId);
  if (!updated) {
    throw new Error('Failed to reload curated rule');
  }
  return updated;
}

export function addPriorityTrackForGenre(
  genreId: string,
  trackTitle: string,
  label?: string,
): CuratedGenreRule {
  const normalizedGenreId = normalize(genreId);
  const normalizedTrack = normalize(trackTitle);
  const trimmedLabel = label?.trim() || undefined;
  if (!normalizedGenreId) {
    throw new Error('Invalid genre');
  }
  if (!normalizedTrack) {
    throw new Error('Invalid track');
  }

  const configPath = getGenreCurationConfigPath();
  const base: CuratedGenreConfigFile = { version: 1, genres: [] };
  let parsed: CuratedGenreConfigFile = base;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw) as CuratedGenreConfigFile;
    if (!Array.isArray(parsed.genres)) parsed.genres = [];
    if (typeof parsed.version !== 'number') parsed.version = 1;
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  const genres = parsed.genres ?? [];
  const existingIndex = genres.findIndex((rule) => normalize(rule.id ?? '') === normalizedGenreId);
  if (existingIndex === -1) {
    genres.push({
      id: normalizedGenreId,
      label: trimmedLabel,
      priorityTracks: [normalizedTrack],
    });
  } else {
    const current = genres[existingIndex] ?? { id: normalizedGenreId };
    const priorityTracks = uniqueByNormalized([...(current.priorityTracks ?? []), normalizedTrack]).map(normalize);
    genres[existingIndex] = {
      ...current,
      id: normalizedGenreId,
      label: current.label?.trim() || trimmedLabel,
      priorityArtists: dedupe(current.priorityArtists),
      blockedArtists: dedupe(current.blockedArtists),
      priorityTracks,
      blockedTracks: dedupe(current.blockedTracks),
      priorityLabels: dedupe(current.priorityLabels),
      requiredTokens: dedupe(current.requiredTokens),
      blockedTokens: dedupe(current.blockedTokens),
      minScore: typeof current.minScore === 'number' && Number.isFinite(current.minScore)
        ? Math.max(0, Math.round(current.minScore))
        : current.minScore,
    };
  }

  parsed.genres = genres;
  if (typeof parsed.version !== 'number') parsed.version = 1;
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  cachedConfigPath = null;
  cachedConfigMtime = 0;
  cachedConfigRules = new Map();
  const updated = getCuratedGenreRule(normalizedGenreId);
  if (!updated) {
    throw new Error('Failed to reload curated rule');
  }
  return updated;
}

export function addBlockedTrackForGenre(
  genreId: string,
  trackTitle: string,
  label?: string,
): CuratedGenreRule {
  const normalizedGenreId = normalize(genreId);
  const normalizedTrack = normalize(trackTitle);
  const trimmedLabel = label?.trim() || undefined;
  if (!normalizedGenreId) {
    throw new Error('Invalid genre');
  }
  if (!normalizedTrack) {
    throw new Error('Invalid track');
  }

  const configPath = getGenreCurationConfigPath();
  const base: CuratedGenreConfigFile = { version: 1, genres: [] };
  let parsed: CuratedGenreConfigFile = base;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw) as CuratedGenreConfigFile;
    if (!Array.isArray(parsed.genres)) parsed.genres = [];
    if (typeof parsed.version !== 'number') parsed.version = 1;
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  const genres = parsed.genres ?? [];
  const existingIndex = genres.findIndex((rule) => normalize(rule.id ?? '') === normalizedGenreId);
  if (existingIndex === -1) {
    genres.push({
      id: normalizedGenreId,
      label: trimmedLabel,
      blockedTracks: [normalizedTrack],
    });
  } else {
    const current = genres[existingIndex] ?? { id: normalizedGenreId };
    const blockedTracks = uniqueByNormalized([...(current.blockedTracks ?? []), normalizedTrack]).map(normalize);
    const priorityTracks = dedupe((current.priorityTracks ?? []).filter((value) => normalize(value) !== normalizedTrack));
    genres[existingIndex] = {
      ...current,
      id: normalizedGenreId,
      label: current.label?.trim() || trimmedLabel,
      priorityArtists: dedupe(current.priorityArtists),
      blockedArtists: dedupe(current.blockedArtists),
      priorityTracks,
      blockedTracks,
      priorityLabels: dedupe(current.priorityLabels),
      requiredTokens: dedupe(current.requiredTokens),
      blockedTokens: dedupe(current.blockedTokens),
      minScore: typeof current.minScore === 'number' && Number.isFinite(current.minScore)
        ? Math.max(0, Math.round(current.minScore))
        : current.minScore,
    };
  }

  parsed.genres = genres;
  if (typeof parsed.version !== 'number') parsed.version = 1;
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  cachedConfigPath = null;
  cachedConfigMtime = 0;
  cachedConfigRules = new Map();
  const updated = getCuratedGenreRule(normalizedGenreId);
  if (!updated) {
    throw new Error('Failed to reload curated rule');
  }
  return updated;
}

export function addBlockedArtistForGenre(
  genreId: string,
  artistName: string,
  label?: string,
): CuratedGenreRule {
  const normalizedGenreId = normalize(genreId);
  const normalizedArtist = normalize(artistName);
  const trimmedLabel = label?.trim() || undefined;
  if (!normalizedGenreId) {
    throw new Error('Invalid genre');
  }
  if (!normalizedArtist) {
    throw new Error('Invalid artist');
  }

  const configPath = getGenreCurationConfigPath();
  const base: CuratedGenreConfigFile = { version: 1, genres: [] };
  let parsed: CuratedGenreConfigFile = base;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw) as CuratedGenreConfigFile;
    if (!Array.isArray(parsed.genres)) parsed.genres = [];
    if (typeof parsed.version !== 'number') parsed.version = 1;
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  const genres = parsed.genres ?? [];
  const existingIndex = genres.findIndex((rule) => normalize(rule.id ?? '') === normalizedGenreId);
  if (existingIndex === -1) {
    genres.push({
      id: normalizedGenreId,
      label: trimmedLabel,
      blockedArtists: [normalizedArtist],
    });
  } else {
    const current = genres[existingIndex] ?? { id: normalizedGenreId };
    const blockedArtists = uniqueByNormalized([...(current.blockedArtists ?? []), normalizedArtist]).map(normalize);
    const priorityArtists = dedupe((current.priorityArtists ?? []).filter((value) => normalize(value) !== normalizedArtist));
    genres[existingIndex] = {
      ...current,
      id: normalizedGenreId,
      label: current.label?.trim() || trimmedLabel,
      priorityArtists,
      blockedArtists,
      priorityTracks: dedupe(current.priorityTracks),
      blockedTracks: dedupe(current.blockedTracks),
      priorityLabels: dedupe(current.priorityLabels),
      requiredTokens: dedupe(current.requiredTokens),
      blockedTokens: dedupe(current.blockedTokens),
      minScore: typeof current.minScore === 'number' && Number.isFinite(current.minScore)
        ? Math.max(0, Math.round(current.minScore))
        : current.minScore,
    };
  }

  parsed.genres = genres;
  if (typeof parsed.version !== 'number') parsed.version = 1;
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  cachedConfigPath = null;
  cachedConfigMtime = 0;
  cachedConfigRules = new Map();
  const updated = getCuratedGenreRule(normalizedGenreId);
  if (!updated) {
    throw new Error('Failed to reload curated rule');
  }
  return updated;
}

export function listLikedPlaylistTracks(): string[] {
  const configPath = getGenreCurationConfigPath();
  if (!fs.existsSync(configPath)) return [];
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as CuratedGenreConfigFile;
    return dedupe(parsed.likedPlaylistTracks);
  } catch {
    return [];
  }
}

export function addLikedPlaylistTrack(trackTitle: string): string[] {
  const normalizedTrack = normalize(trackTitle);
  if (!normalizedTrack) {
    throw new Error('Invalid track');
  }
  const configPath = getGenreCurationConfigPath();
  const base: CuratedGenreConfigFile = { version: 1, genres: [], likedPlaylistTracks: [] };
  let parsed: CuratedGenreConfigFile = base;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw) as CuratedGenreConfigFile;
    if (!Array.isArray(parsed.genres)) parsed.genres = [];
    if (typeof parsed.version !== 'number') parsed.version = 1;
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  parsed.likedPlaylistTracks = uniqueByNormalized([...(parsed.likedPlaylistTracks ?? []), normalizedTrack]).map(normalize);
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return parsed.likedPlaylistTracks;
}
