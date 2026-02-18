"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabaseClient";
import TwitchPlayer from "@/components/TwitchPlayer";
import AudioPlayer from "@/components/AudioPlayer";
import ChatBox from "@/components/ChatBox";
import RequestForm from "@/components/RequestForm";
import OnlineUsers from "@/components/OnlineUsers";
import NowPlaying from "@/components/NowPlaying";

type StreamMode = "twitch" | "audio" | "offline";
type MobileTab = "chat" | "requests";

export default function StreamPage() {
  const router = useRouter();
  const [mode, setMode] = useState<StreamMode>("offline");
  const [icecastUrl, setIcecastUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");
  const [chatBadge, setChatBadge] = useState(false);
  const [requestBadge, setRequestBadge] = useState(false);
  const activeTabRef = useRef<MobileTab>(activeTab);
  activeTabRef.current = activeTab;

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
    <div className="flex h-dvh flex-col overflow-hidden">
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
        <div className={mode === "audio" ? "hidden sm:block" : ""}>
          <NowPlaying />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2 sm:gap-4 sm:p-4 lg:flex-row">
        {/* Player */}
        <div className="shrink-0 lg:flex-[2]">
          {mode === "twitch" && <TwitchPlayer />}
          {mode === "audio" && icecastUrl && <AudioPlayer src={icecastUrl} />}
          {mode === "offline" && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-gray-800 bg-gray-900 px-4 py-4 shadow-lg shadow-violet-500/5 sm:py-16">
              <div className="hidden h-10 w-10 items-center justify-center rounded-full bg-gray-800 sm:flex">
                <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728M9.172 14.828a4 4 0 010-5.656m5.656 0a4 4 0 010 5.656M12 12h.01" />
                </svg>
              </div>
              <p className="text-sm text-gray-500">Momenteel offline</p>
            </div>
          )}
        </div>

        {/* Mobile: tab bar (hidden on desktop) */}
        <div className="flex shrink-0 gap-1 rounded-lg bg-gray-800/60 p-1 lg:hidden">
          <button
            onClick={() => { setActiveTab("chat"); setChatBadge(false); }}
            className={`relative flex-1 rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wider transition ${
              activeTab === "chat"
                ? "bg-violet-600 text-white shadow-sm"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Chat
            {chatBadge && activeTab !== "chat" && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
            )}
          </button>
          <button
            onClick={() => { setActiveTab("requests"); setRequestBadge(false); }}
            className={`relative flex-1 rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wider transition ${
              activeTab === "requests"
                ? "bg-violet-600 text-white shadow-sm"
                : "text-gray-400 hover:text-white"
            }`}
          >
            Verzoekjes
            {requestBadge && activeTab !== "requests" && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
            )}
          </button>
        </div>

        {/* Chat + Requests: tabbed on mobile, side by side on desktop */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-4">
          <div className={`min-h-0 flex-1 ${activeTab === "chat" ? "" : "hidden"} lg:block`}>
            <ChatBox onNewMessage={() => { if (activeTabRef.current !== "chat") setChatBadge(true); }} />
          </div>
          <div className={`min-h-0 flex-1 ${activeTab === "requests" ? "" : "hidden"} lg:block`}>
            <RequestForm onNewRequest={() => { if (activeTabRef.current !== "requests") setRequestBadge(true); }} />
          </div>
        </div>
      </main>
    </div>
  );
}
