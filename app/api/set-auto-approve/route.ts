import { getSupabase } from '@/lib/supabaseClient';
import { NextResponse } from 'next/server';

export async function GET() {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('settings')
    .update({ auto_approve: true })
    .eq('id', 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}