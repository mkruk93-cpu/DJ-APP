import { SupabaseClient } from '@supabase/supabase-js';
import type { Mode, ModeSettings } from './types.js';

const TABLE = 'radio_settings';

const DEFAULTS: Record<string, unknown> = {
  active_mode: 'radio',
  democracy_threshold: 51,
  democracy_timer: 15,
  jukebox_max_per_user: 5,
  party_skip_cooldown: 10,
  stream_url: '',
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
  const [threshold, timer, maxPerUser, skipCooldown] = await Promise.all([
    getSetting<number>(sb, 'democracy_threshold'),
    getSetting<number>(sb, 'democracy_timer'),
    getSetting<number>(sb, 'jukebox_max_per_user'),
    getSetting<number>(sb, 'party_skip_cooldown'),
  ]);

  return {
    democracy_threshold: threshold ?? 51,
    democracy_timer: timer ?? 15,
    jukebox_max_per_user: maxPerUser ?? 5,
    party_skip_cooldown: skipCooldown ?? 10,
  };
}
