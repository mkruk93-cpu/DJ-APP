import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface CuratedGenreRule {
  id: string;
  label?: string;
  priorityArtists?: string[];
  priorityLabels?: string[];
  requiredTokens?: string[];
  blockedTokens?: string[];
  minScore?: number;
}

interface CuratedGenreFile {
  version?: number;
  genres?: CuratedGenreRule[];
}

type PendingStatus = 'pending' | 'approved' | 'rejected';

interface PendingItem {
  artist: string;
  primaryGenre: string;
  secondaryGenres?: string[];
  confidence: number;
  reason: string;
  status: PendingStatus;
  source?: string;
}

interface PendingFile {
  generatedAt?: string | null;
  items?: PendingItem[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '..');

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

function resolveArg(name: string, fallback: string): string {
  const key = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(key));
  if (!match) return fallback;
  return match.slice(key.length).trim() || fallback;
}

function resolvePathWithFallback(input: string, fallbackAbs: string): string {
  const fromArg = input.trim();
  if (!fromArg) return fallbackAbs;
  return path.isAbsolute(fromArg)
    ? fromArg
    : path.resolve(serverRoot, fromArg);
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function ensureRule(genres: CuratedGenreRule[], genreId: string): CuratedGenreRule {
  const normalized = normalize(genreId);
  let found = genres.find((genre) => normalize(genre.id) === normalized);
  if (found) return found;
  found = {
    id: normalized,
    label: normalized,
    priorityArtists: [],
    priorityLabels: [],
    requiredTokens: [],
    blockedTokens: [],
    minScore: 2,
  };
  genres.push(found);
  return found;
}

async function main(): Promise<void> {
  const pendingArg = resolveArg('pending', process.env.GENRE_CURATION_PENDING?.trim() || 'config/genre-curation.pending.json');
  const curatedArg = resolveArg('curated', process.env.GENRE_CURATION_CONFIG?.trim() || 'config/genre-curation.json');

  const pendingPath = resolvePathWithFallback(pendingArg, path.resolve(serverRoot, 'config', 'genre-curation.pending.json'));
  const curatedPath = resolvePathWithFallback(curatedArg, path.resolve(serverRoot, 'config', 'genre-curation.json'));

  const pending = readJson<PendingFile>(pendingPath, { generatedAt: null, items: [] });
  const curated = readJson<CuratedGenreFile>(curatedPath, { version: 1, genres: [] });
  const pendingItems = Array.isArray(pending.items) ? pending.items : [];
  const genres = Array.isArray(curated.genres) ? curated.genres : [];

  let applied = 0;
  const remaining: PendingItem[] = [];
  for (const item of pendingItems) {
    if (item.status !== 'approved') {
      remaining.push(item);
      continue;
    }
    const artist = item.artist.trim();
    const primaryGenre = normalize(item.primaryGenre);
    if (!artist || !primaryGenre) {
      remaining.push(item);
      continue;
    }
    const rule = ensureRule(genres, primaryGenre);
    rule.priorityArtists = dedupe([...(rule.priorityArtists ?? []), artist]);
    applied += 1;
  }

  curated.version = curated.version ?? 1;
  curated.genres = genres
    .map((genre) => ({
      ...genre,
      id: normalize(genre.id),
      label: genre.label?.trim() || genre.id,
      priorityArtists: dedupe(genre.priorityArtists),
      priorityLabels: dedupe(genre.priorityLabels),
      requiredTokens: dedupe(genre.requiredTokens),
      blockedTokens: dedupe(genre.blockedTokens),
      minScore: typeof genre.minScore === 'number' && Number.isFinite(genre.minScore)
        ? Math.max(0, Math.round(genre.minScore))
        : 2,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, 'nl', { sensitivity: 'base' }));

  const nextPending: PendingFile = {
    generatedAt: new Date().toISOString(),
    items: remaining,
  };

  fs.writeFileSync(curatedPath, `${JSON.stringify(curated, null, 2)}\n`);
  fs.writeFileSync(pendingPath, `${JSON.stringify(nextPending, null, 2)}\n`);

  console.log(`[apply-approved] Applied ${applied} approved artist mappings.`);
  console.log(`[apply-approved] Updated curated config: ${curatedPath}`);
  console.log(`[apply-approved] Remaining pending items: ${remaining.length}`);
}

main().catch((err) => {
  console.error(`[apply-approved] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
