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

function getAdminSecret(): string {
  return (
    process.env.ADMIN_PASSWORD ??
    process.env.NEXT_PUBLIC_ADMIN_PASSWORD ??
    process.env.ADMIN_TOKEN ??
    ""
  );
}

function isAuthorized(request: NextRequest, bodyToken?: string): boolean {
  const secret = getAdminSecret();
  if (!secret) return false;
  const headerToken = request.headers.get("x-admin-token") ?? "";
  return (bodyToken ?? headerToken).trim() === secret;
}

export async function GET() {
  try {
    const sb = getSupabaseServerClient();
    const { data: poll, error } = await sb
      .from("live_polls")
      .select("id,question,options,status,created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!poll) return NextResponse.json({ poll: null });

    const { data: votes, error: votesErr } = await sb
      .from("live_poll_votes")
      .select("option_index")
      .eq("poll_id", poll.id);
    if (votesErr) return NextResponse.json({ error: votesErr.message }, { status: 500 });

    const options = (poll.options as string[]) ?? [];
    const counts = new Array(options.length).fill(0);
    for (const row of votes ?? []) {
      const idx = Number(row.option_index);
      if (Number.isFinite(idx) && idx >= 0 && idx < counts.length) counts[idx] += 1;
    }

    return NextResponse.json({
      poll: {
        ...poll,
        options,
        counts,
        totalVotes: counts.reduce((a, b) => a + b, 0),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch live poll";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    question?: string;
    options?: string[];
    token?: string;
  };
  if (!isAuthorized(request, body.token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const question = (body.question ?? "").trim();
  const options = (body.options ?? []).map((opt) => String(opt).trim()).filter(Boolean);
  if (!question || options.length < 2) {
    return NextResponse.json({ error: "Question and at least 2 options are required" }, { status: 400 });
  }

  try {
    const sb = getSupabaseServerClient();
    await sb
      .from("live_polls")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("status", "active");

    const { data, error } = await sb
      .from("live_polls")
      .insert({
        question,
        options,
        status: "active",
        created_by: "dj",
      })
      .select("id,question,options,status,created_at")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ poll: data }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create live poll";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
