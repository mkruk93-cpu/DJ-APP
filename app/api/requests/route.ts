import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRequestMetadata } from "@/app/api/_lib/metadata";
import { resolveGenre, type GenreConfidence } from "@/app/api/_lib/genre";

const MAX_QUEUE = 3;
const COOLDOWN_SEC = 20;
const MAX_DURATION_SEC = 10 * 60;

type RequestStatus = "pending" | "approved" | "downloaded" | "rejected" | "error";

interface RequestRow {
  id: string;
  nickname: string;
  url: string;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  duration: number | null;
  source: string | null;
  genre: string | null;
  genre_confidence: GenreConfidence | null;
  status: RequestStatus;
  created_at: string;
}

function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase env for requests API");
  }
  return createClient(url, key);
}

function isSupportedUrl(input: string): boolean {
  if (/^local:\/\/.+/i.test(input)) return true;
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|soundcloud\.com)\/.+$/i.test(
    input,
  );
}

export async function GET(request: NextRequest) {
  try {
    const sb = getSupabaseServerClient();
    const status = request.nextUrl.searchParams.get("status");

    let query = sb
      .from("requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ items: (data ?? []) as RequestRow[] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch requests";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      nickname?: string;
      url?: string;
      title?: string | null;
      artist?: string | null;
      thumbnail?: string | null;
      duration?: number | null;
      source?: string | null;
      genre?: string | null;
    };
    const source = (body.source ?? "").trim() || "direct";

    const nickname = (body.nickname ?? "").trim() || "anon";
    const inputUrl = (body.url ?? "").trim();
    if (!isSupportedUrl(inputUrl)) {
      return NextResponse.json(
        { error: "Ongeldige URL — gebruik een YouTube of SoundCloud link." },
        { status: 400 },
      );
    }

    const sb = getSupabaseServerClient();

    const { data: recentRows, error: recentErr } = await sb
      .from("requests")
      .select("id,status,created_at")
      .eq("nickname", nickname)
      .order("created_at", { ascending: false })
      .limit(25);
    if (recentErr) return NextResponse.json({ error: recentErr.message }, { status: 500 });

    const recent = (recentRows ?? []) as Pick<RequestRow, "id" | "status" | "created_at">[];
    const latest = recent[0];
    if (latest) {
      const latestMs = new Date(latest.created_at).getTime();
      const deltaSec = (Date.now() - latestMs) / 1000;
      if (deltaSec < COOLDOWN_SEC) {
        return NextResponse.json(
          { error: `Even geduld — wacht nog ${Math.ceil(COOLDOWN_SEC - deltaSec)}s.` },
          { status: 429 },
        );
      }
    }

    const isLocalUrl = /^local:\/\/.+/i.test(inputUrl);
    const metadata = isLocalUrl
      ? { title: body.title ?? null, artist: body.artist ?? null, thumbnail: body.thumbnail ?? null, duration_seconds: body.duration ?? null }
      : await getRequestMetadata(inputUrl);
    if (!isLocalUrl && metadata.duration_seconds && metadata.duration_seconds > MAX_DURATION_SEC) {
      const mins = Math.ceil(metadata.duration_seconds / 60);
      return NextResponse.json(
        { error: `Dit nummer is ${mins} minuten — maximaal 10 minuten toegestaan.` },
        { status: 400 },
      );
    }

    const resolvedArtist = (body.artist ?? metadata.artist ?? "").trim() || null;
    const resolvedTitle = (body.title ?? metadata.title ?? "").trim() || null;
    const resolvedDuration =
      typeof body.duration === "number" && Number.isFinite(body.duration)
        ? Math.max(0, Math.floor(body.duration))
        : (metadata.duration_seconds ?? null);
    const genreInfo = resolveGenre({
      explicitGenre: body.genre,
      artist: resolvedArtist,
    });

    const active = recent.filter(
      (row) => row.status === "pending" || row.status === "approved",
    );
    if (active.length >= MAX_QUEUE) {
      const oldest = [...active].sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )[0];
      if (oldest) {
        await sb.from("requests").delete().eq("id", oldest.id);
      }
    }

    const { data: settings } = await sb
      .from("settings")
      .select("auto_approve")
      .eq("id", 1)
      .single();

    const status: RequestStatus = settings?.auto_approve ? "approved" : "pending";
    const insertBase = {
      nickname,
      url: inputUrl,
      title: resolvedTitle,
      artist: resolvedArtist,
      thumbnail: body.thumbnail ?? metadata.thumbnail,
      source,
      genre: genreInfo.genre,
      genre_confidence: genreInfo.confidence,
      status,
    };

    // Some deployments may not have the duration column yet.
    let insertResult = await sb
      .from("requests")
      .insert({
        ...insertBase,
        duration: resolvedDuration,
      })
      .select("*")
      .single();

    if (insertResult.error && /duration/i.test(insertResult.error.message)) {
      insertResult = await sb
        .from("requests")
        .insert(insertBase)
        .select("*")
        .single();
    }

    const { data, error } = insertResult;

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ item: data as RequestRow }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create request";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
