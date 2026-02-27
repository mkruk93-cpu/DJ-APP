import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type RequestStatus = "pending" | "approved" | "downloaded" | "rejected" | "error";

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
  const token = (bodyToken ?? headerToken).trim();
  return token === secret;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    status?: RequestStatus;
    token?: string;
  };

  if (!isAuthorized(request, body.token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const status = body.status;
  if (!status || !["pending", "approved", "rejected", "downloaded", "error"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  try {
    const sb = getSupabaseServerClient();
    const { data, error } = await sb
      .from("requests")
      .update({ status })
      .eq("id", id)
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ item: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update request";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  if (!isAuthorized(request, body.token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    const sb = getSupabaseServerClient();
    const { error } = await sb.from("requests").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete request";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
