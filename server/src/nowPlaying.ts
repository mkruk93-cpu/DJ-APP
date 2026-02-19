import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { SupabaseClient } from '@supabase/supabase-js';

const POLL_INTERVAL = 2_000;

function readFileText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function fetchArtwork(artist: string, title: string): Promise<string | null> {
  const query = `${artist} ${title}`.trim();
  if (!query) return Promise.resolve(null);

  const url = `https://itunes.apple.com/search?${new URLSearchParams({
    term: query,
    media: 'music',
    limit: '1',
  })}`;

  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5_000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const results = data?.results ?? [];
          if (results.length === 0) { resolve(null); return; }
          const artUrl: string = results[0]?.artworkUrl100 ?? '';
          resolve(artUrl ? artUrl.replace('100x100bb', '600x600bb') : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
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
