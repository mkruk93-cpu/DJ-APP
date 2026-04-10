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
  const type = searchParams.get("type") || "points"; // points, listen_time, requests
  const limit = Math.min(50, parseInt(searchParams.get("limit") || "10"));

  try {
    const sb = getSupabaseServerClient();

    let orderColumn: string;
    switch (type) {
      case "listen_time":
        orderColumn = "total_listen_seconds";
        break;
      case "requests":
        orderColumn = "total_requests";
        break;
      default:
        orderColumn = "points";
    }

    // First get profiles
    const { data: profiles, error } = await sb
      .from("user_profiles")
      .select("user_id, points, total_listen_seconds, total_requests, name_color, avatar_url")
      .order(orderColumn, { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[leaderboard] Error fetching profiles:", error);
      return NextResponse.json({ leaderboard: [], type, error: error.message });
    }

    if (!profiles || profiles.length === 0) {
      return NextResponse.json({ leaderboard: [], type });
    }

    // Get usernames from user_accounts
    const userIds = profiles.map(p => p.user_id);
    const { data: accounts } = await sb
      .from("user_accounts")
      .select("id, username")
      .in("id", userIds);

    const usernameMap = new Map(accounts?.map(a => [a.id, a.username]) || []);

    const leaderboard = profiles.map((p: any, index: number) => ({
      rank: index + 1,
      user_id: p.user_id,
      username: usernameMap.get(p.user_id) || "Unknown",
      points: p.points || 0,
      listen_seconds: p.total_listen_seconds || 0,
      total_requests: p.total_requests || 0,
      name_color: p.name_color || "#a78bfa",
      avatar_url: p.avatar_url || "🎵",
    }));

    return NextResponse.json({ leaderboard, type });
  } catch (err) {
    console.error("[leaderboard] Error:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch leaderboard";
    return NextResponse.json({ leaderboard: [], type, error: message });
  }
}
