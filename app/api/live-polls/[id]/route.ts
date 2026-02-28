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

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    status?: "active" | "closed";
    token?: string;
  };
  if (!isAuthorized(request, body.token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const status = body.status;
  if (!status || !["active", "closed"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  try {
    const sb = getSupabaseServerClient();
    const updatePayload: Record<string, unknown> = { status };
    if (status === "closed") updatePayload.closed_at = new Date().toISOString();
    const { data, error } = await sb
      .from("live_polls")
      .update(updatePayload)
      .eq("id", id)
      .select("id,question,options,status,created_at")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ poll: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update poll";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
