import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export interface DJSlot {
  id: string;
  user_id: string;
  nickname: string;
  start_time: string;
  end_time: string;
}

export async function isCurrentDJ(nickname: string): Promise<boolean> {
  if (!nickname) return false;
  
  const now = new Date().toISOString();
  
  const { data, error } = await supabase
    .from('dj_schedule')
    .select('*')
    .eq('nickname', nickname)
    .lte('start_time', now)
    .gte('end_time', now)
    .maybeSingle();

  if (error) {
    console.error('[dj-schedule] Error checking DJ status:', error);
    return false;
  }

  return !!data;
}

export async function getDJSchedule(): Promise<DJSlot[]> {
  const { data, error } = await supabase
    .from('dj_schedule')
    .select('*')
    .order('start_time', { ascending: true });

  if (error) {
    console.error('[dj-schedule] Error fetching schedule:', error);
    return [];
  }

  return data || [];
}

export async function claimDJSlot(nickname: string, startTime: string, endTime: string): Promise<boolean> {
  // Check if slot is already taken
  const { data: existing } = await supabase
    .from('dj_schedule')
    .select('*')
    .or(`start_time.lte.${startTime},end_time.gte.${endTime}`);

  if (existing && existing.length > 0) {
    return false;
  }

  const { error } = await supabase
    .from('dj_schedule')
    .insert({
      nickname,
      start_time: startTime,
      end_time: endTime
    });

  if (error) {
    console.error('[dj-schedule] Error claiming slot:', error);
    return false;
  }

  return true;
}
