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

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    pollId?: string;
    optionIndex?: number;
    nickname?: string;
  };

  const pollId = (body.pollId ?? "").trim();
  const optionIndex = Number(body.optionIndex);
  const nickname = (body.nickname ?? "").trim().slice(0, 40);
  if (!pollId || !Number.isInteger(optionIndex) || optionIndex < 0 || !nickname) {
    return NextResponse.json({ error: "Invalid vote payload" }, { status: 400 });
  }

  try {
    const sb = getSupabaseServerClient();
    const { data: poll, error: pollErr } = await sb
      .from("live_polls")
      .select("id,options,status")
      .eq("id", pollId)
      .maybeSingle();
    if (pollErr) return NextResponse.json({ error: pollErr.message }, { status: 500 });
    if (!poll || poll.status !== "active") {
      return NextResponse.json({ error: "Poll is not active" }, { status: 400 });
    }

    const options = (poll.options as string[]) ?? [];
    if (optionIndex >= options.length) {
      return NextResponse.json({ error: "Invalid option index" }, { status: 400 });
    }

    const { error } = await sb.from("live_poll_votes").upsert(
      {
        poll_id: pollId,
        nickname,
        option_index: optionIndex,
      },
      { onConflict: "poll_id,nickname" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit vote";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
