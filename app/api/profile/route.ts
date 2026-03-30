import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing Supabase env");
  return createClient(url, key);
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const username = searchParams.get("username");

  if (!username) {
    return NextResponse.json({ error: "Username required" }, { status: 400 });
  }

  try {
    const sb = getSupabaseServerClient();
    
    // Get user account
    const { data: account, error: accountError } = await sb
      .from("user_accounts")
      .select("id, username, email, created_at, approved")
      .eq("username", username)
      .single();

    if (accountError || !account) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Get profile (create if doesn't exist)
    let { data: profile, error: profileError } = await sb
      .from("user_profiles")
      .select("*")
      .eq("user_id", account.id)
      .single();

    // Create profile if it doesn't exist
    if (!profile) {
      const { data: newProfile, error: createError } = await sb
        .from("user_profiles")
        .insert({
          user_id: account.id,
          avatar_url: null,
          name_color: "#ffffff",
          points: 0,
          total_listen_seconds: 0,
          total_requests: 0,
        })
        .select()
        .single();

      if (createError) {
        console.error("Error creating profile:", createError);
        profile = null;
      } else {
        profile = newProfile;
      }
    }

    // Get stats
    const { data: stats } = await sb
      .from("user_stats")
      .select("*")
      .eq("user_id", account.id)
      .single();

    return NextResponse.json({
      account: {
        id: account.id,
        username: account.username,
        created_at: account.created_at,
      },
      profile: profile ? {
        avatar_url: profile.avatar_url,
        name_color: profile.name_color,
        points: profile.points,
        total_listen_seconds: profile.total_listen_seconds,
        total_requests: profile.total_requests,
        achievements: profile.achievements,
      } : null,
      stats,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, avatar_url, name_color } = body;

    if (!user_id) {
      return NextResponse.json({ error: "User ID required" }, { status: 400 });
    }

    const sb = getSupabaseServerClient();

    // Update or insert profile
    const { data: profile, error } = await sb
      .from("user_profiles")
      .upsert({
        user_id,
        avatar_url: avatar_url ?? null,
        name_color: name_color ?? "#ffffff",
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ profile });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
