"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabaseClient";
import TwitchPlayer from "@/components/TwitchPlayer";
import AudioPlayer from "@/components/AudioPlayer";
import ChatBox from "@/components/ChatBox";
import RequestForm from "@/components/RequestForm";
import OnlineUsers from "@/components/OnlineUsers";
import NowPlaying from "@/components/NowPlaying";

type StreamMode = "twitch" | "audio" | "offline";

export default function StreamPage() {
  const router = useRouter();
  const [mode, setMode] = useState<StreamMode>("offline");
  const [icecastUrl, setIcecastUrl] = useState<string | null>(null);

  useEffect(() => {
    const nickname = localStorage.getItem("nickname");
    if (!nickname) router.replace("/");
  }, [router]);

  const checkStatus = useCallback(async () => {
    const [twitchRes, settingsRes] = await Promise.all([
      fetch("/api/twitch-live").then((r) => r.json()).catch(() => ({ live: false })),
      getSupabase().from("settings").select("icecast_url").eq("id", 1).single(),
    ]);

    const url = settingsRes.data?.icecast_url || null;
    setIcecastUrl(url);

    if (twitchRes.live) {
      setMode("twitch");
    } else if (url) {
      setMode("audio");
    } else {
      setMode("offline");
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 60_000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      {/* Header */}
      <header className="relative z-50 border-b border-gray-800 bg-gray-900/80 px-3 py-2 backdrop-blur-sm sm:px-6 sm:py-3">
        <div className="flex items-center justify-between">
          <h1 className="shrink-0 text-base font-bold tracking-tight text-white sm:text-lg">
            🎵 <span className="text-violet-400">{process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "Stream"}</span>
          </h1>
          <div className="flex items-center gap-2 sm:gap-3">
            <OnlineUsers />
            <button
              onClick={() => {
                localStorage.removeItem("nickname");
                router.push("/");
              }}
              className="rounded-lg border border-gray-700 px-2.5 py-1.5 text-sm text-gray-400 transition hover:border-gray-600 hover:text-white sm:px-3"
            >
              Uitloggen
            </button>
          </div>
        </div>
        <NowPlaying />
      </header>

      <main className="flex flex-1 flex-col gap-2 p-2 sm:gap-4 sm:p-4 lg:flex-row">
        {/* Player */}
        <div className="shrink-0 lg:flex-[2]">
          {mode === "twitch" && <TwitchPlayer />}
          {mode === "audio" && icecastUrl && <AudioPlayer src={icecastUrl} />}
          {mode === "offline" && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-gray-800 bg-gray-900 px-4 py-4 shadow-lg shadow-violet-500/5 sm:py-16" style={{ minHeight: 0 }}>
              <div className="hidden h-10 w-10 items-center justify-center rounded-full bg-gray-800 sm:flex">
                <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728M9.172 14.828a4 4 0 010-5.656m5.656 0a4 4 0 010 5.656M12 12h.01" />
                </svg>
              </div>
              <p className="text-sm text-gray-500">Momenteel offline</p>
            </div>
          )}
        </div>

        {/* Chat + Requests: side by side on mobile, stacked in desktop column */}
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-4 lg:grid-cols-1 lg:grid-rows-2 lg:gap-4">
          <div className="h-[280px] sm:h-[400px] lg:h-auto">
            <ChatBox />
          </div>
          <div className="h-[280px] sm:h-[400px] lg:h-auto">
            <RequestForm />
          </div>
        </div>
      </main>
    </div>
  );
}
