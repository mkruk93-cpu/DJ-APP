import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SupabaseClient } from '@supabase/supabase-js';

const POLL_INTERVAL = 5_000;

interface RequestRow {
  id: string;
  nickname: string;
  url: string;
  status: string;
}

function safeFilename(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '_');
}

function downloadRequest(row: RequestRow, downloadPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const nickname = safeFilename(row.nickname);
    const outtmpl = path.join(
      downloadPath,
      `%(artist,uploader,creator|Unknown)s - %(title)s [${nickname}].%(ext)s`,
    );

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

  async function poll(): Promise<void> {
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
        console.log(`[bridge] Downloading: ${row.url} voor ${row.nickname}`);
        try {
          await downloadRequest(row, downloadPath);
          await sb.from('requests').update({ status: 'downloaded' }).eq('id', row.id);
          console.log(`[bridge] Done: ${row.url}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[bridge] Download error: ${msg}`);
          try {
            await sb.from('requests').update({ status: 'rejected' }).eq('id', row.id);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      console.error('[bridge] Poll error:', err);
    }
  }

  setInterval(poll, POLL_INTERVAL);
  poll();
}
