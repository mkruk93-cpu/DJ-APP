import fs from 'node:fs';
import path from 'node:path';
import { SupabaseClient } from '@supabase/supabase-js';
import { fetchArtwork } from './artwork.js';

const POLL_INTERVAL = 2_000;

function readFileText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function startNowPlayingWatcher(sb: SupabaseClient, rekordboxPath: string): void {
  if (!rekordboxPath || !fs.existsSync(rekordboxPath)) {
    console.log('[now-playing] REKORDBOX_OUTPUT_PATH not set or missing — watcher disabled');
    return;
  }

  const titlePath = path.join(rekordboxPath, 'TrackTitle.txt');
  const artistPath = path.join(rekordboxPath, 'TrackArtist.txt');
  let lastTitle = '';
  let lastArtist = '';

  console.log(`[now-playing] Watcher started — folder: ${rekordboxPath}`);

  async function poll(): Promise<void> {
    const title = readFileText(titlePath);
    const artist = readFileText(artistPath);

    if (title === lastTitle && artist === lastArtist) return;
    lastTitle = title;
    lastArtist = artist;

    const artworkUrl = await fetchArtwork(artist, title);
    if (artworkUrl) {
      console.log(`[now-playing] Artwork: ${artworkUrl.slice(0, 60)}...`);
    }

    try {
      await sb.from('now_playing').upsert({
        id: 1,
        title: title || null,
        artist: artist || null,
        artwork_url: artworkUrl ?? null,
        updated_at: new Date().toISOString(),
      });
      console.log(`[now-playing] ${artist} — ${title}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[now-playing] Update error: ${msg}`);
    }
  }

  setInterval(poll, POLL_INTERVAL);
  poll();
}
