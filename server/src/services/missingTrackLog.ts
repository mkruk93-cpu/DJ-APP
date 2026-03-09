import fs from 'node:fs';
import { dirname, join } from 'node:path';

export interface MissingTrackLookupEvent {
  source: 'queue_add' | 'auto_shared' | 'auto_liked';
  query: string;
  strictMetadata?: boolean;
  expectedArtist?: string | null;
  expectedTitle?: string | null;
  providerCandidates?: number | null;
  diagnostics?: unknown;
}

interface PersistedMissingTrackLookupEvent extends MissingTrackLookupEvent {
  timestamp: string;
}

const STORE_FILE = process.env.MISSING_TRACK_LOG_FILE
  ? process.env.MISSING_TRACK_LOG_FILE
  : join(process.cwd(), 'data', 'missing_track_lookups.jsonl');

function ensureStoreDir(): void {
  const dir = dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function recordMissingTrackLookup(event: MissingTrackLookupEvent): void {
  try {
    ensureStoreDir();
    const payload: PersistedMissingTrackLookupEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(STORE_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (err) {
    console.warn('[missing-track-log] Failed to append event:', (err as Error).message);
  }
}
