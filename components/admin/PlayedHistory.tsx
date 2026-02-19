"use client";

import { useEffect, useState, useCallback } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { getSocket } from "@/lib/socket";
import { getRadioToken } from "@/lib/auth";

interface HistoryItem {
  id: string;
  youtube_id: string;
  title: string | null;
  thumbnail: string | null;
  played_at: string;
  duration_s: number | null;
}

export default function PlayedHistory() {
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const load = useCallback(async () => {
    const { data } = await getSupabase()
      .from("played_history")
      .select("*")
      .order("played_at", { ascending: false })
      .limit(50);
    if (data) setHistory(data as HistoryItem[]);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  function handleReAdd(item: HistoryItem) {
    const token = getRadioToken();
    const nickname =
      typeof window !== "undefined"
        ? localStorage.getItem("nickname") ?? "admin"
        : "admin";

    if (token) {
      const url = `https://www.youtube.com/watch?v=${item.youtube_id}`;
      getSocket().emit("queue:add", { youtube_url: url, added_by: nickname });
    }
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
        Geschiedenis
      </h3>

      {history.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
          Nog geen nummers gespeeld
        </div>
      ) : (
        <div className="space-y-1">
          {history.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2.5 rounded-lg border border-gray-800 bg-gray-800/50 p-2 transition hover:border-gray-700"
            >
              {item.thumbnail && (
                <img
                  src={item.thumbnail}
                  alt=""
                  className="h-10 w-14 shrink-0 rounded object-cover"
                />
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">
                  {item.title ?? item.youtube_id}
                </p>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span>{formatTime(item.played_at)}</span>
                  {item.duration_s && (
                    <span>{formatDuration(item.duration_s)}</span>
                  )}
                </div>
              </div>

              <button
                onClick={() => handleReAdd(item)}
                className="shrink-0 rounded-md bg-violet-600/20 p-1.5 text-violet-400 transition hover:bg-violet-600/30"
                title="Opnieuw toevoegen"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
