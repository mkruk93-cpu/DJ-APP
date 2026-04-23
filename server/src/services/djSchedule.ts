import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export interface DJSlot {
  id: string;
  nickname: string;
  start_time: string;
  end_time: string;
  created_at?: string | null;
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

export async function getCurrentDJSlot(): Promise<DJSlot | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('dj_schedule')
    .select('*')
    .lte('start_time', now)
    .gt('end_time', now)
    .order('start_time', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[dj-schedule] Error fetching current DJ slot:', error);
    return null;
  }

  return data ?? null;
}

export async function endCurrentDJSlot(): Promise<DJSlot | null> {
  const currentSlot = await getCurrentDJSlot();
  if (!currentSlot) return null;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('dj_schedule')
    .update({ end_time: now })
    .eq('id', currentSlot.id)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[dj-schedule] Error ending current DJ slot:', error);
    return null;
  }

  return data ?? currentSlot;
}

export async function getDJSlotById(id: string): Promise<DJSlot | null> {
  if (!id) return null;
  const { data, error } = await supabase
    .from('dj_schedule')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[dj-schedule] Error fetching DJ slot by id:', error);
    return null;
  }

  return data ?? null;
}

export async function updateDJSlot(id: string, nickname: string, startTime: string, endTime: string): Promise<boolean> {
  const { data: existing, error: existingError } = await supabase
    .from('dj_schedule')
    .select('id')
    .neq('id', id)
    .lt('start_time', endTime)
    .gt('end_time', startTime);

  if (existingError) {
    console.error('[dj-schedule] Error checking slot overlap on update:', existingError);
    return false;
  }

  if (existing && existing.length > 0) return false;

  const { error } = await supabase
    .from('dj_schedule')
    .update({
      nickname,
      start_time: startTime,
      end_time: endTime,
    })
    .eq('id', id);

  if (error) {
    console.error('[dj-schedule] Error updating DJ slot:', error);
    return false;
  }

  return true;
}

export async function deleteDJSlot(id: string): Promise<boolean> {
  if (!id) return false;
  const { error } = await supabase
    .from('dj_schedule')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('[dj-schedule] Error deleting DJ slot:', error);
    return false;
  }

  return true;
}

export async function claimDJSlot(nickname: string, startTime: string, endTime: string): Promise<boolean> {
  const { data: existing, error: existingError } = await supabase
    .from('dj_schedule')
    .select('id')
    .lt('start_time', endTime)
    .gt('end_time', startTime);

  if (existingError) {
    console.error('[dj-schedule] Error checking slot overlap:', existingError);
    return false;
  }

  if (existing && existing.length > 0) return false;

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
