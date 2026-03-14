import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase env for chat messages API");
  }
  return createClient(url, key);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { nickname?: string };
  const nickname = String(body.nickname ?? "").trim();
  if (!id || !nickname) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  try {
    const sb = getSupabaseServerClient();
    const { data: row, error: fetchError } = await sb
      .from("chat_messages")
      .select("id,nickname")
      .eq("id", id)
      .maybeSingle();
    if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "Bericht niet gevonden" }, { status: 404 });

    if (normalizeName(row.nickname ?? "") !== normalizeName(nickname)) {
      return NextResponse.json({ error: "Je kunt alleen je eigen bericht verwijderen" }, { status: 403 });
    }

    const { error: deleteError } = await sb
      .from("chat_messages")
      .delete()
      .eq("id", id)
      .eq("nickname", row.nickname);
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete chat message";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

