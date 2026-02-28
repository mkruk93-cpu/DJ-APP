import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SupabaseClient } from '@supabase/supabase-js';

const POLL_INTERVAL = 5_000;

interface RequestRow {
  id: string;
  nickname: string;
  url: string;
  title?: string | null;
  artist?: string | null;
  status: string;
}

function safeFilename(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '_');
}

function cleanPart(text: string | null | undefined, fallback: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return fallback;
  return safeFilename(trimmed).replace(/\s+/g, ' ');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripArtistPrefixFromTitle(artistRaw: string, titleRaw: string): string {
  const artist = artistRaw.trim();
  const title = titleRaw.trim();
  if (!artist || !title) return titleRaw;

  // Remove leading "Artist - " / "Artist: " / "Artist | " patterns.
  const prefixRe = new RegExp(`^${escapeRegExp(artist)}\\s*[-–:|]\\s*`, 'i');
  const stripped = title.replace(prefixRe, '').trim();
  return stripped || titleRaw;
}

function downloadRequest(row: RequestRow, downloadPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const artistRaw = (row.artist ?? '').trim() || 'Unknown Artist';
    const titleRaw = stripArtistPrefixFromTitle(artistRaw, (row.title ?? '').trim() || 'Unknown Title');
    const artist = cleanPart(artistRaw, 'Unknown Artist');
    const title = cleanPart(titleRaw, 'Unknown Title');
    const outtmpl = path.join(downloadPath, `${artist} - ${title}.%(ext)s`);

    const proc = spawn('python', [
      '-m', 'yt_dlp',
      '--format', 'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '-o', outtmpl,
      row.url,
    ]);

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 300)}`));
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

export function startBridge(sb: SupabaseClient, downloadPath: string): void {
  if (!downloadPath) {
    console.log('[bridge] DOWNLOAD_PATH not set — bridge disabled');
    return;
  }

  fs.mkdirSync(downloadPath, { recursive: true });
  console.log(`[bridge] Started — download folder: ${downloadPath}`);
  const inFlight = new Set<string>();
  const lockDir = path.join(downloadPath, '.bridge-locks');
  fs.mkdirSync(lockDir, { recursive: true });
  let pollRunning = false;

  function acquireLock(id: string): string | null {
    const lockPath = path.join(lockDir, `${id}.lock`);
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      return lockPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') return null;
      throw err;
    }
  }

  function releaseLock(lockPath: string | null): void {
    if (!lockPath) return;
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }

  async function poll(): Promise<void> {
    if (pollRunning) return;
    pollRunning = true;
    try {
      const { data, error } = await sb
        .from('requests')
        .select('*')
        .eq('status', 'approved');

      if (error) {
        console.error('[bridge] Poll error:', error.message);
        return;
      }

      for (const row of (data ?? []) as RequestRow[]) {
        if (inFlight.has(row.id)) continue;
        const lockPath = acquireLock(row.id);
        if (!lockPath) continue;
        inFlight.add(row.id);
        console.log(`[bridge] Downloading: ${row.url} voor ${row.nickname}`);
        try {
          const { data: stillApproved, error: checkErr } = await sb
            .from('requests')
            .select('id,status')
            .eq('id', row.id)
            .eq('status', 'approved')
            .maybeSingle();
          if (checkErr) {
            console.error(`[bridge] Check error for ${row.id}: ${checkErr.message}`);
            continue;
          }
          if (!stillApproved) {
            continue;
          }

          await downloadRequest(row, downloadPath);
          const { error: updateErr } = await sb
            .from('requests')
            .update({ status: 'downloaded' })
            .eq('id', row.id);
          if (updateErr) {
            console.error(`[bridge] Failed to mark downloaded for ${row.id}: ${updateErr.message}`);
            continue;
          }
          console.log(`[bridge] Done: ${row.url}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[bridge] Download error: ${msg}`);
          try {
            const { error: rejectErr } = await sb
              .from('requests')
              .update({ status: 'rejected' })
              .eq('id', row.id);
            if (rejectErr) {
              console.error(`[bridge] Failed to mark rejected for ${row.id}: ${rejectErr.message}`);
            }
          } catch {
            /* ignore */
          }
        } finally {
          inFlight.delete(row.id);
          releaseLock(lockPath);
        }
      }
    } catch (err) {
      console.error('[bridge] Poll error:', err);
    } finally {
      pollRunning = false;
    }
  }

  setInterval(poll, POLL_INTERVAL);
  poll();
}
