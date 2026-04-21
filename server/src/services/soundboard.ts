import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveSampleDir() {
  const possiblePaths = [
    path.join(process.cwd(), 'data', 'samples'),
    path.join(process.cwd(), 'server', 'data', 'samples'),
    path.join(__dirname, '..', '..', 'data', 'samples'),
    path.join(__dirname, '..', '..', '..', 'data', 'samples'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log(`[soundboard] Found sample directory at: ${p}`);
      return p;
    }
  }

  const fallback = path.join(process.cwd(), 'server', 'data', 'samples');
  console.log(`[soundboard] No sample directory found, using fallback: ${fallback}`);
  return fallback;
}

function resolveSoundboardDataDir() {
  const possiblePaths = [
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), 'server', 'data'),
    path.join(__dirname, '..', '..', 'data'),
    path.join(__dirname, '..', '..', '..', 'data'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }

  return path.join(process.cwd(), 'server', 'data');
}

export const SAMPLE_DIR = resolveSampleDir();
const DATA_DIR = resolveSoundboardDataDir();
const METADATA_FILE = path.join(DATA_DIR, 'soundboard_samples.json');
const allowedExts = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.webm', '.aac', '.flac'];

export const SOUNDBOARD_CATEGORIES = [
  'meme',
  'reaction',
  'laugh',
  'quote',
  'hype',
  'effect',
  'music',
  'horn',
  'voice',
  'other',
] as const;

export type SoundboardCategory = typeof SOUNDBOARD_CATEGORIES[number];

export interface Sample {
  id: string;
  name: string;
  category: SoundboardCategory;
  uploadedBy: string;
  uploadedAt: string;
  originalFileName: string | null;
  file: string;
}

interface PersistedSampleRecord {
  id: string;
  name: string;
  category: string | null;
  uploadedBy: string | null;
  uploadedAt: string | null;
  originalFileName?: string | null;
  fileName: string;
}

interface PersistedSoundboardStore {
  samples: PersistedSampleRecord[];
}

function normalizeCategory(value: string | null | undefined): SoundboardCategory {
  const normalized = (value ?? '').trim().toLowerCase();
  return (SOUNDBOARD_CATEGORIES as readonly string[]).includes(normalized)
    ? normalized as SoundboardCategory
    : 'other';
}

function sanitizeLabel(input: string | null | undefined, fallback: string): string {
  const normalized = (input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return normalized || fallback;
}

function humanizeId(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyFileStem(value: string): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
    .slice(0, 48) || 'sample';
}

function readMetadataStore(): PersistedSoundboardStore {
  if (!fs.existsSync(METADATA_FILE)) return { samples: [] };

  try {
    const raw = fs.readFileSync(METADATA_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedSoundboardStore>;
    return { samples: Array.isArray(parsed.samples) ? parsed.samples : [] };
  } catch (err) {
    console.warn(`[soundboard] Failed to read metadata store: ${(err as Error).message}`);
    return { samples: [] };
  }
}

function writeMetadataStore(store: PersistedSoundboardStore): void {
  fs.mkdirSync(path.dirname(METADATA_FILE), { recursive: true });
  const tempFile = `${METADATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tempFile, METADATA_FILE);
}

class SoundboardManager extends EventEmitter {
  private samples: Sample[] = [];
  private sampleCache: Map<string, Buffer> = new Map();

  constructor() {
    super();
    this.ensureDirectories();
    this.loadSamples();
    this.preloadSamples();
  }

  private ensureDirectories() {
    if (!fs.existsSync(SAMPLE_DIR)) {
      fs.mkdirSync(SAMPLE_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private loadSamples() {
    if (!fs.existsSync(SAMPLE_DIR)) {
      console.log(`[soundboard] Sample directory does not exist: ${SAMPLE_DIR}`);
      this.samples = [];
      return;
    }

    const files = fs.readdirSync(SAMPLE_DIR)
      .filter((fileName) => allowedExts.includes(path.extname(fileName).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));

    const stored = readMetadataStore();
    const metadataById = new Map(stored.samples.map((sample) => [sample.id, sample]));
    const nextStore: PersistedSampleRecord[] = [];
    const nextSamples: Sample[] = [];

    for (const fileName of files) {
      const id = path.basename(fileName, path.extname(fileName));
      const fallbackName = humanizeId(id) || 'Sample';
      const metadata = metadataById.get(id);

      const normalizedRecord: PersistedSampleRecord = {
        id,
        fileName,
        name: sanitizeLabel(metadata?.name, fallbackName),
        category: normalizeCategory(metadata?.category),
        uploadedBy: sanitizeLabel(metadata?.uploadedBy, 'Onbekend'),
        uploadedAt: metadata?.uploadedAt && !Number.isNaN(Date.parse(metadata.uploadedAt))
          ? metadata.uploadedAt
          : new Date(fs.statSync(path.join(SAMPLE_DIR, fileName)).mtimeMs).toISOString(),
        originalFileName: metadata?.originalFileName ?? null,
      };

      nextStore.push(normalizedRecord);
      nextSamples.push({
        id: normalizedRecord.id,
        name: normalizedRecord.name,
        category: normalizeCategory(normalizedRecord.category),
        uploadedBy: normalizedRecord.uploadedBy ?? 'Onbekend',
        uploadedAt: normalizedRecord.uploadedAt ?? new Date().toISOString(),
        originalFileName: normalizedRecord.originalFileName ?? null,
        file: path.join(SAMPLE_DIR, fileName),
      });
    }

    writeMetadataStore({ samples: nextStore });
    this.samples = nextSamples.sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }));
    this.sampleCache = new Map([...this.sampleCache.entries()].filter(([id]) => nextSamples.some((sample) => sample.id === id)));
    console.log(`[soundboard] Loaded ${this.samples.length} samples from ${SAMPLE_DIR}`);
  }

  private preloadSamples() {
    console.log('[soundboard] Pre-loading samples into memory...');
    for (const sample of this.samples) {
      void this.preloadSingleSample(sample.id);
    }
  }

  public reloadSamples() {
    this.loadSamples();
  }

  public registerUploadedSample(input: {
    sampleId: string;
    fileName: string;
    name: string;
    category: string;
    uploadedBy: string;
    originalFileName?: string | null;
  }): void {
    const store = readMetadataStore();
    const existing = store.samples.filter((sample) => sample.id !== input.sampleId);
    existing.push({
      id: input.sampleId,
      fileName: input.fileName,
      name: sanitizeLabel(input.name, humanizeId(input.sampleId) || 'Sample'),
      category: normalizeCategory(input.category),
      uploadedBy: sanitizeLabel(input.uploadedBy, 'Onbekend'),
      uploadedAt: new Date().toISOString(),
      originalFileName: input.originalFileName ?? null,
    });
    writeMetadataStore({ samples: existing });
    this.loadSamples();
  }

  public async preloadSingleSample(sampleId: string) {
    const sample = this.samples.find((s) => s.id === sampleId);
    if (!sample) return;

    const ffmpeg = spawn('ffmpeg', [
      '-i', sample.file,
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.on('close', () => {
      this.sampleCache.set(sample.id, Buffer.concat(chunks));
      console.log(`[soundboard] Hot-loaded sample: ${sample.name}`);
    });
  }

  public getSamples() {
    return this.samples.map((sample) => ({ ...sample }));
  }

  public startServer() {
    console.log('[soundboard] Ready for Node.js mixing');
  }

  public async playSample(sampleId: string): Promise<void> {
    const cached = this.sampleCache.get(sampleId);
    if (cached) {
      console.log(`[soundboard] Playing sample from cache: ${sampleId}`);
      this.emit('pcm', cached);
      return;
    }

    const sample = this.samples.find((s) => s.id === sampleId);
    if (!sample) return;

    console.log(`[soundboard] Playing sample (not cached): ${sample.name}`);
    await this.playSampleFromFile(sample.file);
  }

  public playSampleFromFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-probesize', '32',
        '-analyzeduration', '0',
        '-i', filePath,
        '-f', 's16le',
        '-ar', '44100',
        '-ac', '2',
        'pipe:1',
      ]);

      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        this.emit('pcm', chunk);
      });

      ffmpeg.on('close', () => resolve());

      ffmpeg.on('error', (err) => {
        console.error(`[soundboard] Error decoding file ${filePath}:`, err);
        reject(err);
      });
    });
  }

  public createSampleIdentity(preferredName: string, originalFileName?: string | null): {
    sampleId: string;
    fileName: string;
  } {
    const sourceName = sanitizeLabel(preferredName, path.basename(originalFileName ?? '', path.extname(originalFileName ?? '')) || 'sample');
    const base = slugifyFileStem(sourceName);
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const sampleId = `${base}_${timestamp}`;
    return {
      sampleId,
      fileName: `${sampleId}.wav`,
    };
  }
}

export const soundboardManager = new SoundboardManager();
