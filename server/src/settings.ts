import { SupabaseClient } from '@supabase/supabase-js';
import type { Mode, ModeSettings } from './types.js';

const TABLE = 'radio_settings';

const DEFAULTS: Record<string, unknown> = {
  active_mode: 'radio',
  fallback_active_genre: null,
  fallback_active_genre_by: null,
  democracy_threshold: 51,
  democracy_timer: 15,
  jukebox_max_per_user: 5,
  party_skip_cooldown: 10,
  stream_url: '',
  dj_queue_base_per_user: 3,
  dj_queue_min_per_user: 1,
  dj_queue_listener_step: 3,
  radio_queue_base_per_user: 3,
  radio_queue_min_per_user: 1,
  radio_queue_listener_step: 3,
  democracy_queue_base_per_user: 2,
  democracy_queue_min_per_user: 1,
  democracy_queue_listener_step: 3,
  jukebox_queue_base_per_user: 5,
  jukebox_queue_min_per_user: 1,
  jukebox_queue_listener_step: 2,
  party_queue_base_per_user: 6,
  party_queue_min_per_user: 1,
  party_queue_listener_step: 2,
};

export async function seedSettings(sb: SupabaseClient): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const { data } = await sb
      .from(TABLE)
      .select('key')
      .eq('key', key)
      .maybeSingle();

    if (!data) {
      await sb.from(TABLE).insert({ key, value });
    }
  }
}

export async function getSetting<T = unknown>(sb: SupabaseClient, key: string): Promise<T | null> {
  const { data } = await sb
    .from(TABLE)
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (!data) return null;
  return data.value as T;
}

export async function setSetting(sb: SupabaseClient, key: string, value: unknown): Promise<void> {
  await sb
    .from(TABLE)
    .upsert({ key, value });
}

export async function getActiveMode(sb: SupabaseClient): Promise<Mode> {
  const mode = await getSetting<Mode>(sb, 'active_mode');
  return mode ?? 'radio';
}

export async function getModeSettings(sb: SupabaseClient): Promise<ModeSettings> {
  const [
    threshold,
    timer,
    maxPerUser,
    skipCooldown,
    djBase,
    djMin,
    djStep,
    radioBase,
    radioMin,
    radioStep,
    democracyBase,
    democracyMin,
    democracyStep,
    jukeboxBase,
    jukeboxMin,
    jukeboxStep,
    partyBase,
    partyMin,
    partyStep,
  ] = await Promise.all([
    getSetting<number>(sb, 'democracy_threshold'),
    getSetting<number>(sb, 'democracy_timer'),
    getSetting<number>(sb, 'jukebox_max_per_user'),
    getSetting<number>(sb, 'party_skip_cooldown'),
    getSetting<number>(sb, 'dj_queue_base_per_user'),
    getSetting<number>(sb, 'dj_queue_min_per_user'),
    getSetting<number>(sb, 'dj_queue_listener_step'),
    getSetting<number>(sb, 'radio_queue_base_per_user'),
    getSetting<number>(sb, 'radio_queue_min_per_user'),
    getSetting<number>(sb, 'radio_queue_listener_step'),
    getSetting<number>(sb, 'democracy_queue_base_per_user'),
    getSetting<number>(sb, 'democracy_queue_min_per_user'),
    getSetting<number>(sb, 'democracy_queue_listener_step'),
    getSetting<number>(sb, 'jukebox_queue_base_per_user'),
    getSetting<number>(sb, 'jukebox_queue_min_per_user'),
    getSetting<number>(sb, 'jukebox_queue_listener_step'),
    getSetting<number>(sb, 'party_queue_base_per_user'),
    getSetting<number>(sb, 'party_queue_min_per_user'),
    getSetting<number>(sb, 'party_queue_listener_step'),
  ]);

  return {
    democracy_threshold: threshold ?? 51,
    democracy_timer: timer ?? 15,
    jukebox_max_per_user: maxPerUser ?? 5,
    party_skip_cooldown: skipCooldown ?? 10,
    dj_queue_base_per_user: djBase ?? 3,
    dj_queue_min_per_user: djMin ?? 1,
    dj_queue_listener_step: djStep ?? 3,
    radio_queue_base_per_user: radioBase ?? 3,
    radio_queue_min_per_user: radioMin ?? 1,
    radio_queue_listener_step: radioStep ?? 3,
    democracy_queue_base_per_user: democracyBase ?? 2,
    democracy_queue_min_per_user: democracyMin ?? 1,
    democracy_queue_listener_step: democracyStep ?? 3,
    jukebox_queue_base_per_user: jukeboxBase ?? 5,
    jukebox_queue_min_per_user: jukeboxMin ?? 1,
    jukebox_queue_listener_step: jukeboxStep ?? 2,
    party_queue_base_per_user: partyBase ?? 6,
    party_queue_min_per_user: partyMin ?? 1,
    party_queue_listener_step: partyStep ?? 2,
  };
}

export async function getActiveFallbackGenre(sb: SupabaseClient): Promise<string | null> {
  const genreId = await getSetting<string | null>(sb, 'fallback_active_genre');
  if (!genreId || typeof genreId !== 'string') return null;
  const trimmed = genreId.trim();
  return trimmed.length > 0 ? trimmed : null;
}
