import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type ClassificationStatus = 'pending' | 'approved' | 'rejected';

interface PendingItem {
  artist: string;
  primaryGenre: string;
  secondaryGenres?: string[];
  confidence: number;
  reason: string;
  status: ClassificationStatus;
  source?: string;
}

interface PendingFile {
  generatedAt: string | null;
  items: PendingItem[];
}

interface CuratedRule {
  id: string;
  label?: string;
  priorityArtists?: string[];
}

interface CuratedFile {
  version?: number;
  genres?: CuratedRule[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '..');

function normalize(value: string): string {
  return value.trim().toLowerCase();
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

function parseArtistsInput(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && typeof (entry as { artist?: unknown }).artist === 'string') {
            return String((entry as { artist: string }).artist);
          }
          if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
            return String((entry as { name: string }).name);
          }
          return '';
        })
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { artists?: unknown }).artists)) {
      return ((parsed as { artists: unknown[] }).artists)
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean);
    }
    return [];
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const artists: string[] = [];
  for (const line of lines) {
    // Supports simple CSV lines as well as single-value txt.
    const first = line.split(',')[0]?.trim() ?? '';
    if (!first) continue;
    artists.push(first);
  }
  return artists;
}

function readCurated(curatedPath: string): CuratedFile {
  if (!fs.existsSync(curatedPath)) return { version: 1, genres: [] };
  const raw = fs.readFileSync(curatedPath, 'utf8');
  return JSON.parse(raw) as CuratedFile;
}

function readPending(pendingPath: string): PendingFile {
  if (!fs.existsSync(pendingPath)) return { generatedAt: null, items: [] };
  try {
    const raw = fs.readFileSync(pendingPath, 'utf8');
    const parsed = JSON.parse(raw) as PendingFile;
    return {
      generatedAt: parsed.generatedAt ?? null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return { generatedAt: null, items: [] };
  }
}

async function classifyWithLlm(
  artists: string[],
  availableGenres: string[],
  model: string,
): Promise<PendingItem[]> {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? '';
  const apiUrl = process.env.LLM_API_URL?.trim() || 'https://api.openai.com/v1/chat/completions';
  if (!apiKey) {
    return artists.map((artist) => ({
      artist,
      primaryGenre: 'unknown',
      secondaryGenres: [],
      confidence: 0.2,
      reason: 'Geen LLM key ingesteld (LLM_API_KEY). Handmatige review nodig.',
      status: 'pending',
      source: 'heuristic-fallback',
    }));
  }

  const payload = {
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Classify artists into subgenres. Return strict JSON only. Keep confidence 0..1 and concise reasons.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          instruction:
            'Classify each artist with one primaryGenre from availableGenres, optional secondaryGenres, confidence, and reason.',
          availableGenres,
          artists,
          outputSchema: {
            items: [
              {
                artist: 'string',
                primaryGenre: 'string',
                secondaryGenres: ['string'],
                confidence: 0.0,
                reason: 'string',
              },
            ],
          },
        }),
      },
    ],
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`LLM request failed: HTTP ${response.status}`);
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(content) as {
    items?: Array<{
      artist?: string;
      primaryGenre?: string;
      secondaryGenres?: string[];
      confidence?: number;
      reason?: string;
    }>;
  };

  return (parsed.items ?? [])
    .map((item) => ({
      artist: String(item.artist ?? '').trim(),
      primaryGenre: normalize(String(item.primaryGenre ?? 'unknown')),
      secondaryGenres: Array.isArray(item.secondaryGenres)
        ? item.secondaryGenres.map((value) => normalize(String(value))).filter(Boolean)
        : [],
      confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0.5,
      reason: String(item.reason ?? '').trim() || 'Geen reden meegegeven.',
      status: 'pending' as const,
      source: 'llm',
    }))
    .filter((item) => item.artist.length > 0);
}

function mergePending(existing: PendingItem[], incoming: PendingItem[]): PendingItem[] {
  const byArtist = new Map<string, PendingItem>();
  for (const item of existing) {
    byArtist.set(normalize(item.artist), item);
  }
  for (const item of incoming) {
    byArtist.set(normalize(item.artist), item);
  }
  return [...byArtist.values()].sort((a, b) => a.artist.localeCompare(b.artist, 'nl', { sensitivity: 'base' }));
}

async function main(): Promise<void> {
  const inputArg = resolveArg('input', 'config/artist-ingest.txt');
  const pendingArg = resolveArg('pending', process.env.GENRE_CURATION_PENDING?.trim() || 'config/genre-curation.pending.json');
  const curatedArg = resolveArg('curated', process.env.GENRE_CURATION_CONFIG?.trim() || 'config/genre-curation.json');
  const model = resolveArg('model', process.env.LLM_MODEL?.trim() || 'gpt-4o-mini');
  const batchSizeRaw = parseInt(resolveArg('batch', '40'), 10);
  const batchSize = Number.isFinite(batchSizeRaw) ? Math.max(1, Math.min(batchSizeRaw, 120)) : 40;

  const inputPath = resolvePathWithFallback(inputArg, path.resolve(serverRoot, 'config', 'artist-ingest.txt'));
  const pendingPath = resolvePathWithFallback(pendingArg, path.resolve(serverRoot, 'config', 'genre-curation.pending.json'));
  const curatedPath = resolvePathWithFallback(curatedArg, path.resolve(serverRoot, 'config', 'genre-curation.json'));

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const artists = parseArtistsInput(inputPath);
  if (artists.length === 0) {
    throw new Error(`No artists found in input: ${inputPath}`);
  }

  const curated = readCurated(curatedPath);
  const availableGenres = (curated.genres ?? []).map((genre) => normalize(genre.id)).filter(Boolean);
  if (availableGenres.length === 0) {
    throw new Error(`No curated genres found in: ${curatedPath}`);
  }

  const result: PendingItem[] = [];
  for (let index = 0; index < artists.length; index += batchSize) {
    const chunk = artists.slice(index, index + batchSize);
    const classified = await classifyWithLlm(chunk, availableGenres, model);
    result.push(...classified);
    console.log(`[classify-artists] Processed ${Math.min(index + batchSize, artists.length)}/${artists.length}`);
  }

  const existingPending = readPending(pendingPath);
  const mergedItems = mergePending(existingPending.items, result);
  const nextPending: PendingFile = {
    generatedAt: new Date().toISOString(),
    items: mergedItems,
  };
  fs.writeFileSync(pendingPath, `${JSON.stringify(nextPending, null, 2)}\n`);
  console.log(`[classify-artists] Updated pending classifications: ${pendingPath}`);
  console.log(`[classify-artists] Total pending items: ${nextPending.items.length}`);
}

main().catch((err) => {
  console.error(`[classify-artists] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
