import { NextRequest, NextResponse } from "next/server";
import { getRequestMetadata } from "@/app/api/_lib/metadata";

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  const result = await getRequestMetadata(url);
  return NextResponse.json(result);
}
