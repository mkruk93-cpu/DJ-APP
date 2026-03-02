"use client";

import { useEffect, useState } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";
import { getRadioToken } from "@/lib/auth";

function deriveTitleFromId(sourceId: string): string {
  if (!sourceId) return "Nummer wordt geladen...";
  if (sourceId.startsWith("sc-")) {
    const slug = sourceId.slice(3);
    const parts = slug.split("-");
    if (parts.length >= 2) {
      const artist = parts[0].replace(/[-_]+/g, " ").trim();
      const title = parts.slice(1).join(" ").replace(/[-_]+/g, " ").trim();
      if (artist && title) return `${artist} - ${title}`;
    }
  }
  return "Nummer wordt geladen...";
}

export default function Queue() {
  const queue = useRadioStore((s) => s.queue);
  const mode = useRadioStore((s) => s.mode);
  const queuePushVote = useRadioStore((s) => s.queuePushVote);
  const [nickname, setNickname] = useState<string>("");
  const canRequestPush = mode !== "dj";

  useEffect(() => {
    if (typeof window === "undefined") return;
    setNickname((localStorage.getItem("nickname") ?? "").trim());
  }, []);

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-400 sm:text-sm">
            Wachtrij
          </h2>
          <span className="text-xs text-gray-500">
            {queue.length} {queue.length === 1 ? "nummer" : "nummers"}
          </span>
        </div>
      </div>

      <div className="chat-scroll min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 sm:px-4 sm:py-3">
        {queue.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-500">
            Wachtrij is leeg
          </p>
        )}
        {queue.map((item, index) => (
          <div
            key={item.id}
            className="flex items-center gap-2.5 rounded-lg border border-gray-800 bg-gray-800/50 p-2 transition hover:border-gray-700 sm:gap-3 sm:p-2.5"
          >
            <span className="w-5 shrink-0 text-center text-xs font-medium text-gray-500">
              {index + 1}
            </span>

            {item.thumbnail && (
              <img
                src={item.thumbnail}
                alt=""
                className="h-8 w-12 shrink-0 rounded object-cover sm:h-9 sm:w-14"
              />
            )}

            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold leading-tight text-white">
                {item.title ?? deriveTitleFromId(item.youtube_id)}
              </p>
              <p className="truncate text-[11px] text-gray-400">
                door {item.added_by}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {canRequestPush && (
                <button
                  onClick={() => {
                    getSocket().emit("queuePushVote:start", { id: item.id, added_by: nickname || "onbekend" });
                  }}
                  disabled={!!queuePushVote || index === 0}
                  className="rounded p-1 text-violet-300 transition hover:bg-violet-500/10 hover:text-violet-200 disabled:opacity-40"
                  title="Stem om als volgende te zetten"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </button>
              )}

              {mode !== "dj" && (item.added_by === nickname || !!getRadioToken()) && (
                <button
                  onClick={() =>
                    getSocket().emit("queue:remove", {
                      id: item.id,
                      token: getRadioToken(),
                      added_by: nickname || "onbekend",
                    })
                  }
                  className="rounded p-1 text-gray-500 transition hover:bg-red-500/10 hover:text-red-400"
                  title="Verwijderen"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
