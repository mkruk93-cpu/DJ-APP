"use client";

import { useEffect, useState, useRef, Component, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabaseClient";
import { connectSocket, disconnectSocket, getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { handleSpotifyCallback } from "@/lib/spotify";
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
import LivePollCard from "@/components/LivePollCard";
import ShoutoutBanner from "@/components/ShoutoutBanner";
import FallbackGenreSelector from "@/components/FallbackGenreSelector";
import type { Track, QueueItem, Mode, ModeSettings, VoteState, DurationVote, UpcomingTrack } from "@/lib/types";
import { parseTrackDisplay } from "@/lib/trackDisplay";

type StreamMode = "twitch" | "audio" | "radio" | "offline";
type MobileTab = "chat" | "requests" | "radio";

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

class RadioPanelErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.warn("[radio-panel] Render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
          Er ging iets mis in het radio-paneel.
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="ml-2 text-xs text-violet-300 transition hover:text-violet-200"
          >
            Opnieuw proberen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  const previousQueueLengthRef = useRef<number>(0);
  const latestUpcomingRef = useRef<UpcomingTrack | null>(null);

  const radioConnected = useRadioStore((s) => s.connected);
  const radioTrack = useRadioStore((s) => s.currentTrack);
  const queue = useRadioStore((s) => s.queue);
  const upcomingTrack = useRadioStore((s) => s.upcomingTrack);
  const radioMode = useRadioStore((s) => s.mode);
  const streamOnline = useRadioStore((s) => s.streamOnline);
  const store = useRadioStore;

  const [suppressFallback, setSuppressFallback] = useState(false);
  const [twitchLive, setTwitchLive] = useState(false);
  const [radioServerUrl, setRadioServerUrl] = useState<string | null>(null);
  const [preferRadioUi, setPreferRadioUi] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRequests = twitchLive || (radioConnected && radioMode === "dj");
  const showRadioPanel = radioMode !== "dj";

  function hydrateTrackRequester(track: Track | null): Track | null {
    if (!track) return null;
    if (track.added_by) return track;
    const upcoming = latestUpcomingRef.current;
    if (upcoming && upcoming.youtube_id === track.youtube_id && upcoming.added_by) {
      return { ...track, added_by: upcoming.added_by };
    }
    return track;
  }

  function showToast(message: string): void {
    setToastMessage(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 5000);
  }

  useEffect(() => {
    if (!showRequests && activeTab === "requests") {
      setActiveTab(radioConnected ? "radio" : "chat");
    }
  }, [showRequests, activeTab, radioConnected]);

  useEffect(() => {
    if (!showRadioPanel && activeTab === "radio") {
      setActiveTab(showRequests ? "requests" : "chat");
    }
  }, [showRadioPanel, activeTab, showRequests]);

  useEffect(() => {
    const nickname = localStorage.getItem("nickname");
    if (!nickname) router.replace("/");
  }, [router]);

  // Handle Spotify OAuth callback (code in URL after redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("code")) {
      void handleSpotifyCallback();
    }
  }, []);

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
          const nextQueueLength = state.queue?.length ?? 0;
          previousQueueLengthRef.current = nextQueueLength;
          latestUpcomingRef.current = state.upcomingTrack ?? null;
          console.log("[radio] State loaded:", {
            track: state.currentTrack?.title ?? "none",
            duration: state.currentTrack?.duration,
            queue: state.queue?.length,
            mode: state.mode,
          });
          store.getState().initFromServer({
            currentTrack: hydrateTrackRequester(state.currentTrack ?? null),
            upcomingTrack: state.upcomingTrack ?? null,
            queue: state.queue ?? [],
            fallbackGenres: state.fallbackGenres ?? [],
            activeFallbackGenre: state.activeFallbackGenre ?? null,
            activeFallbackGenreBy: state.activeFallbackGenreBy ?? null,
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
      setPreferRadioUi(true);
      setSuppressFallback(false);
      fetchState();
    });

    socket.on("disconnect", () => {
      store.getState().setConnected(false);
      store.getState().setStreamOnline(false);
      store.getState().setCurrentTrack(null);
      latestUpcomingRef.current = null;
      previousQueueLengthRef.current = 0;
      setSuppressFallback(true);
    });

    socket.on("track:change", (track: Track | null) => {
      store.getState().setCurrentTrack(hydrateTrackRequester(track));
      store.getState().setStreamOnline(track !== null);
      store.getState().setVoteState(null);
    });

    socket.on("queue:update", (data: { items: QueueItem[] }) => {
      const nextQueueLength = data.items.length;
      const hadQueue = previousQueueLengthRef.current;
      store.getState().setQueue(data.items);
      if (nextQueueLength > hadQueue && activeTabRef.current !== "radio") {
        setRadioBadge(true);
      }
      previousQueueLengthRef.current = nextQueueLength;
    });

    socket.on("upcoming:update", (upcoming: UpcomingTrack | null) => {
      latestUpcomingRef.current = upcoming;
      store.getState().setUpcomingTrack(upcoming);
    });

    socket.on("fallback:genre:update", (data: { activeGenreId: string | null; selectedBy?: string | null; genres: Array<{ id: string; label: string; trackCount: number }> }) => {
      store.getState().setFallbackGenres(data.genres ?? []);
      store.getState().setActiveFallbackGenre(data.activeGenreId ?? null);
      store.getState().setActiveFallbackGenreBy(data.selectedBy ?? null);
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
      showToast(data.message);
    });

    socket.on("durationVote:update", (data: DurationVote & { voters: string[] }) => {
      const voted = data.voters?.includes(socket.id ?? "") ?? false;
      store.getState().setDurationVote({ ...data, voted });
    });

    socket.on("durationVote:end", () => {
      store.getState().setDurationVote(null);
    });

    socket.on("skip:lock", (data: { locked: boolean }) => {
      store.getState().setSkipLocked(data.locked);
    });

    // Safety net: keep upcoming/current state in sync in case a socket event is missed.
    const stateSyncInterval = setInterval(() => {
      if (store.getState().connected) fetchState();
    }, 8000);

    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      clearInterval(stateSyncInterval);
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
    } else if (preferRadioUi || radioConnected || !!radioServerUrl) {
      setMode("radio");
    } else if (icecastUrl) {
      setMode("audio");
    } else {
      setMode("offline");
    }
  }, [twitchLive, radioConnected, icecastUrl, preferRadioUi, radioServerUrl]);

  // Derive the audio source for radio mode
  const radioStreamUrl = radioServerUrl
    ? `${radioServerUrl}/listen`
    : process.env.NEXT_PUBLIC_STREAM_URL ?? icecastUrl;
  const showRadioOfflineState =
    mode === "radio" &&
    (!radioStreamUrl || !radioConnected || !streamOnline);
  const nextQueueItem = queue[0] ?? null;
  const nextSourceTitle = firstNonEmpty(
    nextQueueItem?.title,
    upcomingTrack?.title,
    nextQueueItem?.youtube_id,
    upcomingTrack?.youtube_id,
  );
  const parsedNext = parseTrackDisplay(nextSourceTitle);
  const nextTitle = parsedNext.title ?? nextSourceTitle;
  const nextArtist = parsedNext.artist;
  const nextRequestedBy = nextQueueItem?.added_by ?? upcomingTrack?.added_by ?? null;
  const showHeaderNextOnly = mode === "radio" && !showRadioOfflineState;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="player-ambient absolute -left-20 top-10 h-72 w-72 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="player-ambient absolute bottom-0 right-0 h-80 w-80 rounded-full bg-fuchsia-500/10 blur-3xl" />
      </div>
      {/* Header */}
      <header className="relative z-50 border-b border-gray-800 bg-gray-900/80 px-2 py-1.5 backdrop-blur-sm sm:px-6 sm:py-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
          <h1 className="min-w-0 truncate text-sm font-bold tracking-tight text-white sm:text-lg">
            🎵 <span className="text-violet-400">{process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "Stream"}</span>
          </h1>
          <div className="flex min-w-0 shrink-0 items-center gap-1 sm:gap-3">
            {radioConnected && <ModeIndicator />}
            <OnlineUsers />
            <button
              onClick={() => {
                localStorage.removeItem("nickname");
                router.push("/");
              }}
              className="whitespace-nowrap rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 transition hover:border-gray-600 hover:text-white sm:px-3 sm:text-sm"
            >
              Uitloggen
            </button>
          </div>
        </div>
        {showHeaderNextOnly && (
          <div className="mt-2 rounded-lg border border-gray-700/60 bg-gray-800/60 px-2.5 py-1 landscape:hidden sm:hidden">
            <p className="truncate text-[11px] text-gray-300">
              <span className="mr-1 uppercase tracking-wider text-gray-500">Volgende:</span>
              {nextArtist && <span className="text-violet-400">{nextArtist}</span>}
              {nextArtist && nextTitle && <span className="text-gray-500"> — </span>}
              {nextTitle && <span>{nextTitle}</span>}
              {!nextTitle && <span className="text-gray-500">Nog geen track klaar...</span>}
              {!nextQueueItem && upcomingTrack?.isFallback && (
                <span className="ml-1 text-gray-500">(random)</span>
              )}
              {nextRequestedBy && (
                <span className="ml-1 text-gray-500">
                  · door <span className="text-violet-300">{nextRequestedBy}</span>
                </span>
              )}
            </p>
          </div>
        )}
        {mode !== "offline" && !showRadioOfflineState && (
          <div className="hidden landscape:block sm:block">
            <NowPlaying
              radioTrack={radioConnected && radioMode !== "dj" ? radioTrack : null}
              showFallback={((mode === "twitch" || mode === "audio") && !suppressFallback) || radioMode === "dj" || (mode === "radio" && !radioTrack)}
              preferSupabase={radioMode === "dj" || (mode === "radio" && !radioTrack)}
            />
          </div>
        )}
        {showRadioOfflineState && (
          <div className="mt-2 rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-200">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400/70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              </span>
              <span className="font-semibold uppercase tracking-wide">Stream offline</span>
            </div>
            <p className="mt-1 text-[11px] text-red-200/85">
              Geen live DJ/radio signaal. Metadata is verborgen tot de stream weer online is.
            </p>
          </div>
        )}
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5 sm:gap-4 sm:p-4 landscape:flex-row lg:flex-row">
        {/* Player */}
        <div className="min-h-0 shrink-0 max-h-[38dvh] overflow-y-auto landscape:min-w-0 landscape:flex-1 landscape:max-h-none landscape:min-h-0 landscape:overflow-visible lg:min-w-0 lg:flex-1 lg:max-h-none lg:min-h-0 lg:overflow-visible">
          <ShoutoutBanner />
          {mode === "twitch" && <TwitchPlayer />}
          {mode === "audio" && icecastUrl && (
            <AudioPlayer src={icecastUrl} radioTrack={radioConnected ? radioTrack : undefined} showFallback={!suppressFallback} />
          )}
          {mode === "radio" && radioStreamUrl && !showRadioOfflineState && (
            <AudioPlayer
              src={radioStreamUrl}
              radioTrack={radioMode === "dj" ? null : radioTrack}
              showFallback={radioMode === "dj" || !radioTrack}
              preferSupabase={radioMode === "dj" || !radioTrack}
            />
          )}
          {mode === "radio" && showRadioOfflineState && (
            <div className="relative overflow-hidden rounded-xl border border-red-900/60 bg-gradient-to-br from-red-950/30 via-gray-900 to-gray-900 px-4 py-6 shadow-lg shadow-red-900/20 sm:py-12">
              <div className="pointer-events-none absolute -left-10 -top-10 h-32 w-32 rounded-full bg-red-500/15 blur-2xl" />
              <div className="pointer-events-none absolute -bottom-12 right-0 h-36 w-36 rounded-full bg-violet-500/10 blur-3xl" />
              <div className="relative z-10 flex items-center justify-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
                </span>
                <p className="text-sm font-semibold text-red-200 sm:text-base">
                  Stream is offline
                </p>
              </div>
              <p className="relative z-10 mt-2 text-center text-xs text-gray-300 sm:text-sm">
                Wachten op DJ/radio verbinding...
              </p>
            </div>
          )}
          {mode === "radio" && !radioStreamUrl && !showRadioOfflineState && (
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
              <FallbackGenreSelector />
              <SkipButton />
              <DurationVotePanel />
            </div>
          )}
          <div className="mt-2">
            <LivePollCard />
          </div>
        </div>

        {/* Mobile: tab bar */}
        <div className="flex shrink-0 gap-1 rounded-lg bg-gray-800/60 p-1 landscape:hidden lg:hidden">
          <button
            onClick={() => { setActiveTab("chat"); setChatBadge(false); }}
            className={`relative flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
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
              className={`relative flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
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
          {showRadioPanel && (
            <button
              onClick={() => { setActiveTab("radio"); setRadioBadge(false); }}
              className={`relative flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 landscape:min-w-0 landscape:flex-[2] landscape:flex-row landscape:gap-4 lg:min-w-0 lg:flex-[2] lg:flex-row lg:gap-4">
          <div className={`min-h-0 min-w-0 flex-1 ${activeTab === "chat" ? "" : "hidden"} landscape:block lg:block`}>
            <ChatBox onNewMessage={() => { if (activeTabRef.current !== "chat") setChatBadge(true); }} />
          </div>
          {showRequests && (
            <div className={`min-h-0 min-w-0 flex-1 ${activeTab === "requests" ? "" : "hidden"} landscape:block lg:block`}>
              <RequestForm onNewRequest={() => { if (activeTabRef.current !== "requests") setRequestBadge(true); }} />
            </div>
          )}
          {showRadioPanel && (
            <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto flex-col gap-2 ${activeTab === "radio" ? "flex" : "hidden"} landscape:flex lg:flex`}>
              <RadioPanelErrorBoundary>
                <QueueAdd />
                <Queue />
              </RadioPanelErrorBoundary>
            </div>
          )}
        </div>
      </main>
      {toastMessage && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-[120] w-[92%] max-w-xl -translate-x-1/2">
          <div className="rounded-lg border border-red-900/60 bg-red-950/85 px-4 py-2 text-center text-sm text-red-100 shadow-lg shadow-red-900/40 backdrop-blur-sm">
            {toastMessage}
          </div>
        </div>
      )}
    </div>
  );
}
