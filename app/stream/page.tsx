"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabaseClient";
import { connectSocket, disconnectSocket, getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import TwitchPlayer from "@/components/TwitchPlayer";
import AudioPlayer from "@/components/AudioPlayer";
import ChatBox from "@/components/ChatBox";
import RequestForm from "@/components/RequestForm";
import OnlineUsers from "@/components/OnlineUsers";
import NowPlaying from "@/components/NowPlaying";
import Queue from "@/components/Queue";
import QueueAdd from "@/components/QueueAdd";
import SkipButton from "@/components/SkipButton";
import ModeIndicator from "@/components/ModeIndicator";
import DurationVotePanel from "@/components/DurationVote";
import type { Track, QueueItem, Mode, ModeSettings, VoteState, DurationVote } from "@/lib/types";

type StreamMode = "twitch" | "audio" | "radio" | "offline";
type MobileTab = "chat" | "requests" | "radio";

export default function StreamPage() {
  const router = useRouter();
  const [mode, setMode] = useState<StreamMode>("offline");
  const [icecastUrl, setIcecastUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");
  const [chatBadge, setChatBadge] = useState(false);
  const [requestBadge, setRequestBadge] = useState(false);
  const [radioBadge, setRadioBadge] = useState(false);
  const activeTabRef = useRef<MobileTab>(activeTab);
  activeTabRef.current = activeTab;

  const radioConnected = useRadioStore((s) => s.connected);
  const radioTrack = useRadioStore((s) => s.currentTrack);
  const radioMode = useRadioStore((s) => s.mode);
  const store = useRadioStore;

  const [suppressFallback, setSuppressFallback] = useState(false);
  const [twitchLive, setTwitchLive] = useState(false);
  const [radioServerUrl, setRadioServerUrl] = useState<string | null>(null);

  const showRequests = twitchLive || (radioConnected && radioMode === "dj");

  useEffect(() => {
    if (!showRequests && activeTab === "requests") {
      setActiveTab(radioConnected ? "radio" : "chat");
    }
  }, [showRequests, activeTab, radioConnected]);

  useEffect(() => {
    const nickname = localStorage.getItem("nickname");
    if (!nickname) router.replace("/");
  }, [router]);

  // Initialize Socket.io connection to radio control server
  useEffect(() => {
    const serverUrl = radioServerUrl ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;
    if (!serverUrl) return;

    let socket: ReturnType<typeof connectSocket>;
    try {
      socket = connectSocket(serverUrl);
    } catch { return; }

    function fetchState() {
      fetch(`${serverUrl}/state`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((state) => {
          console.log("[radio] State loaded:", {
            track: state.currentTrack?.title ?? "none",
            duration: state.currentTrack?.duration,
            queue: state.queue?.length,
            mode: state.mode,
          });
          store.getState().initFromServer({
            currentTrack: state.currentTrack ?? null,
            queue: state.queue ?? [],
            mode: state.mode ?? "radio",
            modeSettings: state.modeSettings ?? store.getState().modeSettings,
            listenerCount: state.listenerCount ?? 0,
            streamOnline: state.streamOnline ?? false,
            durationVote: state.durationVote ?? null,
          });
        })
        .catch((err) => {
          console.warn("[radio] Failed to fetch state:", err.message);
          setTimeout(fetchState, 3000);
        });
    }

    socket.on("connect", () => {
      store.getState().setConnected(true);
      setSuppressFallback(false);
      fetchState();
    });

    socket.on("disconnect", () => {
      store.getState().resetAll();
      setSuppressFallback(true);
    });

    socket.on("track:change", (track: Track | null) => {
      store.getState().setCurrentTrack(track);
      store.getState().setStreamOnline(track !== null);
      store.getState().setVoteState(null);
    });

    socket.on("queue:update", (data: { items: QueueItem[] }) => {
      store.getState().setQueue(data.items);
      if (activeTabRef.current !== "radio") setRadioBadge(true);
    });

    socket.on("mode:change", (data: { mode: Mode; settings: ModeSettings }) => {
      store.getState().setMode(data.mode, data.settings);
    });

    socket.on("vote:update", (data: VoteState | null) => {
      store.getState().setVoteState(data);
    });

    socket.on("stream:status", (data: { online: boolean; listeners: number }) => {
      store.getState().setStreamOnline(data.online);
      store.getState().setListenerCount(data.listeners);
    });

    socket.on("error:toast", (data: { message: string }) => {
      console.warn("[radio]", data.message);
    });

    socket.on("durationVote:update", (data: DurationVote & { voters: string[] }) => {
      const voted = data.voters?.includes(socket.id ?? "") ?? false;
      store.getState().setDurationVote({ ...data, voted });
    });

    socket.on("durationVote:end", () => {
      store.getState().setDurationVote(null);
    });

    return () => {
      disconnectSocket();
    };
  }, [radioServerUrl, store]);

  useEffect(() => {
    async function pollExternal() {
      const [twitchRes, settingsRes] = await Promise.all([
        fetch("/api/twitch-live").then((r) => r.json()).catch(() => ({ live: false })),
        getSupabase().from("settings").select("*").eq("id", 1).single(),
      ]);
      setTwitchLive(twitchRes.live ?? false);
      setIcecastUrl(settingsRes.data?.icecast_url || null);
      const rUrl = settingsRes.data?.radio_server_url || null;
      setRadioServerUrl(rUrl);
      store.getState().setServerUrl(rUrl);
    }

    pollExternal();
    const interval = setInterval(pollExternal, 15_000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (twitchLive) {
      setSuppressFallback(false);
      setMode("twitch");
    } else if (radioConnected) {
      setMode("radio");
    } else if (icecastUrl) {
      setMode("audio");
    } else {
      setMode("offline");
    }
  }, [twitchLive, radioConnected, icecastUrl]);

  // Derive the audio source for radio mode
  const radioStreamUrl = radioServerUrl
    ? `${radioServerUrl}/listen`
    : process.env.NEXT_PUBLIC_STREAM_URL ?? icecastUrl;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Header */}
      <header className="relative z-50 border-b border-gray-800 bg-gray-900/80 px-3 py-2 backdrop-blur-sm sm:px-6 sm:py-3">
        <div className="flex items-center justify-between">
          <h1 className="shrink-0 text-base font-bold tracking-tight text-white sm:text-lg">
            🎵 <span className="text-violet-400">{process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "Stream"}</span>
          </h1>
          <div className="flex items-center gap-2 sm:gap-3">
            {radioConnected && <ModeIndicator />}
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
        {mode !== "offline" && (
          <div className={mode === "audio" || mode === "radio" ? "hidden sm:block" : ""}>
            <NowPlaying radioTrack={radioConnected ? radioTrack : null} showFallback={(mode === "twitch" || mode === "audio") && !suppressFallback} />
          </div>
        )}
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2 sm:gap-4 sm:p-4 lg:flex-row">
        {/* Player */}
        <div className="shrink-0 lg:flex-1">
          {mode === "twitch" && <TwitchPlayer />}
          {mode === "audio" && icecastUrl && (
            <AudioPlayer src={icecastUrl} radioTrack={radioConnected ? radioTrack : undefined} showFallback={!suppressFallback} />
          )}
          {mode === "radio" && radioStreamUrl && (
            <AudioPlayer src={radioStreamUrl} radioTrack={radioTrack} />
          )}
          {mode === "radio" && !radioStreamUrl && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-gray-800 bg-gray-900 px-4 py-4 shadow-lg shadow-violet-500/5 sm:py-16">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-violet-500" />
              </span>
              <p className="text-sm text-gray-400">Radio verbonden — wacht op stream URL</p>
            </div>
          )}
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

          {/* Skip / vote button below player */}
          {radioConnected && (
            <div className="mt-2 space-y-2">
              <SkipButton />
              <DurationVotePanel />
            </div>
          )}
        </div>

        {/* Mobile: tab bar */}
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
          {showRequests && (
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
          )}
          {radioConnected && (
            <button
              onClick={() => { setActiveTab("radio"); setRadioBadge(false); }}
              className={`relative flex-1 rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wider transition ${
                activeTab === "radio"
                  ? "bg-violet-600 text-white shadow-sm"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Radio
              {radioBadge && activeTab !== "radio" && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
              )}
            </button>
          )}
        </div>

        {/* Content panels */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-[2] lg:flex-row lg:gap-4">
          <div className={`min-h-0 flex-1 ${activeTab === "chat" ? "" : "hidden"} lg:block`}>
            <ChatBox onNewMessage={() => { if (activeTabRef.current !== "chat") setChatBadge(true); }} />
          </div>
          {showRequests && (
            <div className={`min-h-0 flex-1 ${activeTab === "requests" ? "" : "hidden"} lg:block`}>
              <RequestForm onNewRequest={() => { if (activeTabRef.current !== "requests") setRequestBadge(true); }} />
            </div>
          )}
          {radioConnected && (
            <div className={`min-h-0 flex-1 flex flex-col gap-2 ${activeTab === "radio" ? "" : "hidden"} lg:block`}>
              <QueueAdd />
              <div className="min-h-0 flex-1">
                <Queue />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
