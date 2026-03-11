import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SharedFallbackPlayMode } from './sharedPlaylistStore.js';

interface FallbackPresetEntry {
  id: string;
  name: string;
  genre_ids: string[];
  shared_playback_mode: SharedFallbackPlayMode;
  created_by: string | null;
  created_at: string;
}

interface FallbackPresetStore {
  presets: FallbackPresetEntry[];
}

export interface FallbackPresetSummary {
  id: string;
  name: string;
  genreIds: string[];
  sharedPlaybackMode: SharedFallbackPlayMode;
  createdBy: string | null;
  createdAt: string;
}

const STORE_FILE = process.env.FALLBACK_PRESET_STORE_FILE
  ? process.env.FALLBACK_PRESET_STORE_FILE
  : join(process.cwd(), 'data', 'fallback_presets_store.json');

function ensureDir(): void {
  const dir = dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readStore(): FallbackPresetStore {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return { presets: [] };
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) return { presets: [] };
    const parsed = JSON.parse(raw) as Partial<FallbackPresetStore>;
    return { presets: Array.isArray(parsed.presets) ? parsed.presets : [] };
  } catch {
    return { presets: [] };
  }
}

function writeStore(store: FallbackPresetStore): void {
  ensureDir();
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

function toSummary(entry: FallbackPresetEntry): FallbackPresetSummary {
  return {
    id: entry.id,
    name: entry.name,
    genreIds: entry.genre_ids,
    sharedPlaybackMode: entry.shared_playback_mode,
    createdBy: entry.created_by,
    createdAt: entry.created_at,
  };
}

export function listFallbackPresets(): FallbackPresetSummary[] {
  const store = readStore();
  return store.presets
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
    .map(toSummary);
}

export function saveFallbackPreset(input: {
  name: string;
  genreIds: string[];
  sharedPlaybackMode: SharedFallbackPlayMode;
  createdBy: string | null;
}): FallbackPresetSummary | null {
  const name = input.name.trim().slice(0, 80);
  const genreIds = Array.from(new Set(input.genreIds.map((id) => id.trim()).filter(Boolean))).slice(0, 200);
  if (!name || genreIds.length === 0) return null;
  const store = readStore();
  const lowered = name.toLowerCase();
  const existing = store.presets.find((entry) => entry.name.toLowerCase() === lowered);
  if (existing) {
    existing.genre_ids = genreIds;
    existing.shared_playback_mode = input.sharedPlaybackMode;
    existing.created_by = input.createdBy;
    existing.created_at = new Date().toISOString();
    writeStore(store);
    return toSummary(existing);
  }
  const created: FallbackPresetEntry = {
    id: randomUUID(),
    name,
    genre_ids: genreIds,
    shared_playback_mode: input.sharedPlaybackMode,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  store.presets.push(created);
  writeStore(store);
  return toSummary(created);
}

export function getFallbackPreset(id: string): FallbackPresetSummary | null {
  const store = readStore();
  const found = store.presets.find((entry) => entry.id === id.trim());
  return found ? toSummary(found) : null;
}
