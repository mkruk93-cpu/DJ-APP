import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { username } = await request.json()

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable.')
    return NextResponse.json({ error: 'Internal server configuration error.' }, { status: 500 })
  }

  // Use the service role client to bypass RLS
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  if (!username) {
    return NextResponse.json({ error: 'Username is required.' }, { status: 400 })
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('user_accounts')
      .select('email')
      .eq('username', username)
      .single()

    if (error) {
      if (error.code === 'PGRST116') { // PostgREST code for "no rows found"
        return NextResponse.json({ error: 'User not found.' }, { status: 404 })
      }
      throw error
    }

    if (!data) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 })
    }

    return NextResponse.json({ email: data.email })
  } catch (error: any) {
    console.error('API Error getting email by username:', error)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }
}
