import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Zoek naar de data/samples map op verschillende plekken
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

  // Fallback
  const fallback = path.join(process.cwd(), 'server', 'data', 'samples');
  console.log(`[soundboard] No sample directory found, using fallback: ${fallback}`);
  return fallback;
}

export const SAMPLE_DIR = resolveSampleDir();

interface Sample {
  id: string;
  name: string;
  file: string;
}

class SoundboardManager extends EventEmitter {
  private samples: Sample[] = [];

  private sampleCache: Map<string, Buffer> = new Map();

  constructor() {
    super();
    this.ensureSampleDir();
    this.loadSamples();
    this.preloadSamples();
  }

  private ensureSampleDir() {
    if (!fs.existsSync(SAMPLE_DIR)) {
      fs.mkdirSync(SAMPLE_DIR, { recursive: true });
    }
  }

  private loadSamples() {
    if (!fs.existsSync(SAMPLE_DIR)) {
      console.log(`[soundboard] Sample directory does not exist: ${SAMPLE_DIR}`);
      this.samples = [];
      return;
    }
    const files = fs.readdirSync(SAMPLE_DIR);
    const allowedExts = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.webm', '.aac', '.flac'];
    
    this.samples = files
      .filter(f => allowedExts.includes(path.extname(f).toLowerCase()))
      .map(f => ({
        id: path.basename(f, path.extname(f)),
        name: path.basename(f, path.extname(f)).replace(/_/g, ' ').replace(/-/g, ' '),
        file: path.join(SAMPLE_DIR, f)
      }));
    
    console.log(`[soundboard] Loaded ${this.samples.length} samples from ${SAMPLE_DIR}`);
  }

  private preloadSamples() {
    console.log('[soundboard] Pre-loading samples into memory...');
    for (const sample of this.samples) {
      const ffmpeg = spawn('ffmpeg', [
        '-i', sample.file,
        '-f', 's16le',
        '-ar', '44100',
        '-ac', '2',
        'pipe:1'
      ]);
      const chunks: Buffer[] = [];
      ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
      ffmpeg.on('close', () => {
        this.sampleCache.set(sample.id, Buffer.concat(chunks));
        console.log(`[soundboard] Pre-loaded: ${sample.name} (${Math.round(Buffer.concat(chunks).length / 1024)} KB)`);
      });
    }
  }

  public reloadSamples() {
    this.loadSamples();
  }

  public async preloadSingleSample(sampleId: string) {
    const sample = this.samples.find(s => s.id === sampleId);
    if (!sample) return;

    const ffmpeg = spawn('ffmpeg', [
      '-i', sample.file,
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      'pipe:1'
    ]);
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.on('close', () => {
      this.sampleCache.set(sample.id, Buffer.concat(chunks));
      console.log(`[soundboard] Hot-loaded new sample: ${sample.name}`);
    });
  }

  public getSamples() {
    return this.samples;
  }

  public startServer() {
    // No longer needed, mixing happens in Node.js
    console.log('[soundboard] Ready for Node.js mixing');
  }

  public async playSample(sampleId: string): Promise<void> {
    const cached = this.sampleCache.get(sampleId);
    if (cached) {
      console.log(`[soundboard] Playing sample from cache: ${sampleId}`);
      this.emit('pcm', cached);
      return;
    }

    const sample = this.samples.find(s => s.id === sampleId);
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
        'pipe:1'
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
}

export const soundboardManager = new SoundboardManager();
