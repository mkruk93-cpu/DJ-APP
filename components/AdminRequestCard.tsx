"use client";

import { getSupabase } from "@/lib/supabaseClient";

interface Request {
  id: string;
  nickname: string;
  url: string;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  status: string;
  created_at: string;
}

const statusConfig: Record<string, { label: string; color: string }> = {
  pending: { label: "Wachtrij", color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  approved: { label: "Goedgekeurd", color: "bg-green-500/20 text-green-400 border-green-500/30" },
  downloaded: { label: "Gedownload", color: "bg-violet-500/20 text-violet-400 border-violet-500/30" },
  rejected: { label: "Afgekeurd", color: "bg-red-500/20 text-red-400 border-red-500/30" },
};

export default function AdminRequestCard({
  request,
  onUpdate,
}: {
  request: Request;
  onUpdate: () => void;
}) {
  async function approve() {
    await getSupabase().from("requests").update({ status: "approved" }).eq("id", request.id);
    onUpdate();
  }

  async function reject() {
    await getSupabase().from("requests").update({ status: "rejected" }).eq("id", request.id);
    onUpdate();
  }

  async function remove() {
    await getSupabase().from("requests").delete().eq("id", request.id);
    onUpdate();
  }

  const cfg = statusConfig[request.status] ?? { label: request.status, color: "" };

  return (
    <div className={`overflow-hidden rounded-xl border bg-gray-900 transition hover:border-gray-700 ${
      request.status === "rejected" ? "border-red-500/20 opacity-60" : "border-gray-800"
    }`}>
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        {request.thumbnail && (
          <img
            src={request.thumbnail}
            alt=""
            className="h-18 w-28 shrink-0 rounded-lg object-cover"
          />
        )}

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-semibold text-violet-400">{request.nickname}</span>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.color}`}>
              {cfg.label}
            </span>
            <span className="text-xs text-gray-500">
              {new Date(request.created_at).toLocaleTimeString("nl-NL", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>

          {request.title ? (
            <div className="mb-1">
              <p className="truncate text-sm font-medium text-white">{request.title}</p>
              {request.artist && (
                <p className="truncate text-xs text-gray-400">{request.artist}</p>
              )}
            </div>
          ) : (
            <a
              href={request.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-1 block truncate text-sm text-gray-300 underline decoration-gray-600 hover:decoration-gray-300"
            >
              {request.url}
            </a>
          )}

          {/* Source link */}
          {request.title && (
            <a
              href={request.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              {request.url.includes("youtube") || request.url.includes("youtu.be") ? "YouTube" : "SoundCloud"} ↗
            </a>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-start gap-2">
          {request.status === "pending" && (
            <>
              <button
                onClick={approve}
                className="rounded-lg bg-green-600/20 px-3 py-1.5 text-sm font-medium text-green-400 transition hover:bg-green-600/30"
              >
                Goedkeuren
              </button>
              <button
                onClick={reject}
                className="rounded-lg bg-red-600/20 px-3 py-1.5 text-sm font-medium text-red-400 transition hover:bg-red-600/30"
              >
                Afkeuren
              </button>
            </>
          )}
          {(request.status === "rejected" || request.status === "downloaded") && (
            <button
              onClick={remove}
              className="rounded-lg bg-gray-600/20 px-3 py-1.5 text-sm font-medium text-gray-400 transition hover:bg-gray-600/30"
            >
              Verwijderen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
