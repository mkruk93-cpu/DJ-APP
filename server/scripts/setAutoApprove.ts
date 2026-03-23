import { getSupabase } from '../../lib/supabaseClient';

async function setAutoApprove() {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('settings')
    .update({ auto_approve: true })
    .eq('id', 1);

  if (error) {
    console.error('Error setting auto_approve:', error);
  } else {
    console.log('Auto approve set to true');
  }

  process.exit(0);
}

setAutoApprove();