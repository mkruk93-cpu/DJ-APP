import { NextRequest, NextResponse } from "next/server";

type GiphyImages = {
  original?: { url?: string };
  fixed_width?: { url?: string };
  fixed_width_downsampled?: { url?: string };
  fixed_height?: { url?: string };
  preview_gif?: { url?: string };
};

type GiphyResult = {
  id?: string;
  title?: string;
  images?: GiphyImages;
};

function pickPreviewUrl(images: GiphyImages | undefined): string | null {
  if (!images) return null;
  const keys: Array<keyof GiphyImages> = [
    "fixed_width_downsampled",
    "fixed_width",
    "fixed_height",
    "preview_gif",
    "original",
  ];
  for (const key of keys) {
    const url = images[key]?.url;
    if (url) return url;
  }
  return null;
}

function pickMediaUrl(images: GiphyImages | undefined): string | null {
  if (!images) return null;
  return (
    images.original?.url
    ?? images.fixed_width?.url
    ?? images.fixed_height?.url
    ?? images.preview_gif?.url
    ?? images.fixed_width_downsampled?.url
    ?? null
  );
}

function toInt(value: string | null, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export async function GET(request: NextRequest) {
  const apiKey = (process.env.GIPHY_API_KEY ?? "").trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "GIPHY_API_KEY ontbreekt op de server." },
      { status: 500 },
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const rawType = (searchParams.get("type") ?? "gif").trim().toLowerCase();
  const type = rawType === "sticker" ? "sticker" : "gif";
  const q = (searchParams.get("q") ?? "").trim();
  const offset = Math.max(0, toInt(searchParams.get("pos"), 0));
  const limit = Math.min(50, Math.max(1, toInt(searchParams.get("limit"), 24)));
  const locale = (request.headers.get("accept-language") ?? "en-US").split(",")[0]?.trim() || "en";
  const lang = locale.split("-")[0]?.trim().toLowerCase() || "en";

  const giphyParams = new URLSearchParams({
    api_key: apiKey,
    limit: String(limit),
    offset: String(offset),
    rating: "r",
    lang,
    bundle: "messaging_non_clips",
  });
  if (q) giphyParams.set("q", q);

  const endpointBase = type === "sticker"
    ? (q ? "https://api.giphy.com/v1/stickers/search" : "https://api.giphy.com/v1/stickers/trending")
    : (q ? "https://api.giphy.com/v1/gifs/search" : "https://api.giphy.com/v1/gifs/trending");
  const endpoint = `${endpointBase}?${giphyParams.toString()}`;

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `GIPHY request failed (${res.status})` },
        { status: 502 },
      );
    }

    const payload = (await res.json().catch(() => ({}))) as {
      data?: GiphyResult[];
      pagination?: {
        total_count?: number;
        count?: number;
        offset?: number;
      };
    };

    const items = (payload.data ?? [])
      .map((item) => {
        const mediaUrl = pickMediaUrl(item.images);
        const previewUrl = pickPreviewUrl(item.images);
        if (!mediaUrl || !previewUrl) return null;
        return {
          id: String(item.id ?? `${type}-${Math.random().toString(36).slice(2)}`),
          title: String(item.title ?? "").trim() || null,
          previewUrl,
          mediaUrl,
        };
      })
      .filter((item): item is { id: string; title: string | null; previewUrl: string; mediaUrl: string } => !!item);

    const pageCount = Number(payload.pagination?.count ?? items.length);
    const currentOffset = Number(payload.pagination?.offset ?? offset);
    const totalCount = Number(payload.pagination?.total_count ?? 0);
    const computedNextOffset = currentOffset + pageCount;
    const hasMore = Number.isFinite(totalCount) ? computedNextOffset < totalCount : pageCount >= limit;

    return NextResponse.json(
      {
        type,
        query: q,
        items,
        nextPos: hasMore ? String(computedNextOffset) : null,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Onbekende fout";
    return NextResponse.json({ error: `Media zoeken mislukt: ${message}` }, { status: 500 });
  }
}

