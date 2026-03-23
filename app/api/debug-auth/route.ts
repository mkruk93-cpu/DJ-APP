import { getSupabase } from '@/lib/supabaseClient';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const supabase = getSupabase();

    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ 
        authenticated: false, 
        message: 'Niet ingelogd' 
      });
    }

    // Check if user_accounts exists
    const { data: account, error: accountError } = await supabase
      .from('user_accounts')
      .select('*')
      .eq('id', user.id)
      .single();

    return NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
      },
      userAccount: account,
      accountError: accountError ? {
        code: accountError.code,
        message: accountError.message,
        status: accountError.status,
      } : null,
      suggestion: !account 
        ? `INSERT INTO user_accounts (id, email, username, approved, approved_at, approved_by, created_at, last_login) VALUES ('${user.id}', '${user.email}', '${user.email?.split('@')[0] || 'user'}', true, now(), 'system', now());`
        : null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
