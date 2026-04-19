import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Zoek naar de data/samples map relatief aan dit bestand, of in de root van de server
export const SAMPLE_DIR = fs.existsSync(path.join(process.cwd(), 'data', 'samples'))
  ? path.join(process.cwd(), 'data', 'samples')
  : fs.existsSync(path.join(process.cwd(), 'server', 'data', 'samples'))
    ? path.join(process.cwd(), 'server', 'data', 'samples')
    : path.join(process.cwd(), 'data', 'samples'); // Fallback naar root/data/samples

console.log(`[soundboard] Sample directory set to: ${SAMPLE_DIR}`);

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
    if (!fs.existsSync(SAMPLE_DIR)) return;
    const files = fs.readdirSync(SAMPLE_DIR);
    const allowedExts = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.webm', '.aac', '.flac'];
    
    this.samples = files
      .filter(f => allowedExts.includes(path.extname(f).toLowerCase()))
      .map(f => ({
        id: path.basename(f, path.extname(f)),
        name: path.basename(f, path.extname(f)).replace(/_/g, ' ').replace(/-/g, ' '),
        file: path.join(SAMPLE_DIR, f)
      }));
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

  public playSample(sampleId: string) {
    const cached = this.sampleCache.get(sampleId);
    if (cached) {
      console.log(`[soundboard] Playing sample from cache: ${sampleId}`);
      this.emit('pcm', cached);
      return;
    }

    const sample = this.samples.find(s => s.id === sampleId);
    if (!sample) return;

    console.log(`[soundboard] Playing sample (not cached): ${sample.name}`);

    this.playSampleFromFile(sample.file);
  }

  public async playSampleFromFile(filePath: string) {
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

    ffmpeg.on('error', (err) => {
      console.error(`[soundboard] Error decoding file ${filePath}:`, err);
    });
  }
}

export const soundboardManager = new SoundboardManager();
