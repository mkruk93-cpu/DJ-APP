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

    const { data: profiles, error } = await sb
      .from("user_profiles")
      .select(`
        user_id,
        points,
        total_listen_seconds,
        total_requests,
        achievements,
        name_color,
        user_accounts:user_id (username)
      `)
      .order(orderColumn, { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const leaderboard = profiles?.map((p: any, index: number) => ({
      rank: index + 1,
      user_id: p.user_id,
      username: p.user_accounts?.username || "Unknown",
      points: p.points || 0,
      listen_seconds: p.total_listen_seconds || 0,
      total_requests: p.total_requests || 0,
      name_color: p.name_color || "#ffffff",
      achievements: p.achievements || [],
    })) || [];

    return NextResponse.json({ leaderboard, type });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch leaderboard";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
