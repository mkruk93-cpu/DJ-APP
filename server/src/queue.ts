import { spawn } from 'node:child_process';
import { SupabaseClient } from '@supabase/supabase-js';
import type { QueueItem } from './types.js';

const TABLE = 'queue';

const YT_URL_PATTERNS = [
  /(?:youtube\.com\/watch\?.*v=)([\w-]{11})/,
  /(?:youtu\.be\/)([\w-]{11})/,
  /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  /(?:youtube\.com\/embed\/)([\w-]{11})/,
];

export function extractYoutubeId(url: string): string | null {
  for (const pattern of YT_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function isValidYoutubeUrl(url: string): boolean {
  return extractYoutubeId(url) !== null;
}

export function getThumbnailUrl(youtubeId: string): string {
  return `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`;
}

export async function getQueue(sb: SupabaseClient): Promise<QueueItem[]> {
  const { data, error } = await sb
    .from(TABLE)
    .select('*')
    .order('position', { ascending: true });

  if (error) throw error;
  return (data ?? []) as QueueItem[];
}

export async function getNextTrack(sb: SupabaseClient): Promise<QueueItem | null> {
  const { data, error } = await sb
    .from(TABLE)
    .select('*')
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as QueueItem | null;
}

export async function addToQueue(
  sb: SupabaseClient,
  youtubeUrl: string,
  addedBy: string,
  title?: string | null,
): Promise<QueueItem> {
  const youtubeId = extractYoutubeId(youtubeUrl);
  if (!youtubeId) throw new Error('Invalid YouTube URL');

  const thumbnail = getThumbnailUrl(youtubeId);

  const { data: last } = await sb
    .from(TABLE)
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextPosition = (last?.position ?? 0) + 1;

  const { data, error } = await sb
    .from(TABLE)
    .insert({
      youtube_url: youtubeUrl,
      youtube_id: youtubeId,
      title: title ?? null,
      thumbnail,
      added_by: addedBy,
      position: nextPosition,
    })
    .select()
    .single();

  if (error) throw error;
  const item = data as QueueItem;

  if (!title) {
    fetchVideoInfo(youtubeUrl).then(async ({ title: fetchedTitle }) => {
      if (fetchedTitle) {
        await sb.from(TABLE).update({ title: fetchedTitle }).eq('id', item.id);
      }
    }).catch(() => {});
  }

  return item;
}

export async function removeFromQueue(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from(TABLE).delete().eq('id', id);
  if (error) throw error;
  await recompactPositions(sb);
}

export async function reorderQueue(
  sb: SupabaseClient,
  id: string,
  newPosition: number,
): Promise<void> {
  const queue = await getQueue(sb);
  const itemIndex = queue.findIndex((q) => q.id === id);
  if (itemIndex === -1) throw new Error('Item not found in queue');

  const [item] = queue.splice(itemIndex, 1);
  const insertAt = Math.max(0, Math.min(newPosition - 1, queue.length));
  queue.splice(insertAt, 0, item);

  for (let i = 0; i < queue.length; i++) {
    await sb.from(TABLE).update({ position: i + 1 }).eq('id', queue[i].id);
  }
}

export async function clearQueueItem(sb: SupabaseClient, id: string): Promise<void> {
  await sb.from(TABLE).delete().eq('id', id);
}

async function recompactPositions(sb: SupabaseClient): Promise<void> {
  const queue = await getQueue(sb);
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].position !== i + 1) {
      await sb.from(TABLE).update({ position: i + 1 }).eq('id', queue[i].id);
    }
  }
}

export interface VideoInfo {
  title: string | null;
  duration: number | null;
}

export function fetchVideoInfo(url: string): Promise<VideoInfo> {
  return new Promise((resolve) => {
    const proc = spawn('python', [
      '-m', 'yt_dlp',
      '--print', '%(title)s\n%(duration)s',
      '--no-warnings',
      '--no-playlist',
      url,
    ], { timeout: 20_000 });

    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ title: null, duration: null });
        return;
      }
      const lines = output.trim().split('\n');
      const title = lines[0]?.trim() || null;
      const rawDur = lines[1]?.trim();
      const duration = rawDur ? Math.round(parseFloat(rawDur)) : null;
      resolve({ title, duration: Number.isFinite(duration) ? duration : null });
    });

    proc.on('error', () => resolve({ title: null, duration: null }));
  });
}
