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
    const nowIso = new Date().toISOString();
    const { data, error } = await sb
      .from("shoutouts")
      .select("id,nickname,message,created_at,expires_at")
      .eq("active", true)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ shoutout: data ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch shoutout";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    nickname?: string;
    message?: string;
    token?: string;
    durationSeconds?: number;
  };
  if (!isAuthorized(request, body.token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const nickname = (body.nickname ?? "").trim().slice(0, 40);
  const message = (body.message ?? "").trim().slice(0, 140);
  const durationSeconds = Math.max(8, Math.min(45, Number(body.durationSeconds ?? 18)));
  if (!nickname || !message) {
    return NextResponse.json({ error: "Nickname and message are required" }, { status: 400 });
  }

  try {
    const sb = getSupabaseServerClient();
    await sb
      .from("shoutouts")
      .update({ active: false })
      .eq("active", true);

    const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
    const { data, error } = await sb
      .from("shoutouts")
      .insert({ nickname, message, active: true, expires_at: expiresAt })
      .select("id,nickname,message,created_at,expires_at")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ shoutout: data }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create shoutout";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
