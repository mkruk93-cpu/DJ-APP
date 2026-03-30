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
  const usernames = searchParams.get("usernames")?.split(",").map(s => s.trim()).filter(Boolean) || [];

  if (usernames.length === 0) {
    return NextResponse.json({ colors: {} });
  }

  try {
    const sb = getSupabaseServerClient();
    
    // Get user accounts for the usernames
    const { data: accounts, error } = await sb
      .from("user_accounts")
      .select("id, username")
      .or(usernames.map(u => `username.ilike.${u}`).join(","));

    if (error || !accounts) {
      return NextResponse.json({ colors: {} });
    }

    const userIds = accounts.map(a => a.id);
    const usernameMap = new Map(accounts.map(a => [a.username.toLowerCase(), a.id]));

    // Get profiles for these users
    const { data: profiles } = await sb
      .from("user_profiles")
      .select("user_id, name_color")
      .in("user_id", userIds);

    const colors: Record<string, string> = {};
    for (const profile of profiles || []) {
      const username = Array.from(usernameMap.entries())
        .find(([, id]) => id === profile.user_id)?.[0];
      if (username && profile.name_color) {
        colors[username] = profile.name_color;
      }
    }

    return NextResponse.json({ colors });
  } catch (err) {
    return NextResponse.json({ colors: {} });
  }
}
