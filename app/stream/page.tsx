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
import QueuePushVotePanel from "@/components/QueuePushVotePanel";
import LivePollCard from "@/components/LivePollCard";
import ShoutoutBanner from "@/components/ShoutoutBanner";
import FallbackGenreSelector from "@/components/FallbackGenreSelector";
import type { Track, QueueItem, Mode, ModeSettings, VoteState, DurationVote, UpcomingTrack } from "@/lib/types";
import { parseTrackDisplay } from "@/lib/trackDisplay";
import { useSyncedTrack } from "@/lib/useSyncedTrack";

type StreamMode = "twitch" | "audio" | "radio" | "offline";
type MobileTab = "chat" | "requests" | "radio" | "queue";
type DesktopAccordionTab = "radio" | "queue";
const TUNNEL_RECOVERY_WINDOW_MS = 150_000;

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
  const [twitchPlayerHidden, setTwitchPlayerHidden] = useState(false);
  const [icecastUrl, setIcecastUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");
  const [desktopAccordionTab, setDesktopAccordionTab] = useState<DesktopAccordionTab>("radio");
  const [chatBadge, setChatBadge] = useState(false);
  const [requestBadge, setRequestBadge] = useState(false);
  const [queueBadge, setQueueBadge] = useState(false);
  const activeTabRef = useRef<MobileTab>(activeTab);
  activeTabRef.current = activeTab;
  const previousQueueLengthRef = useRef<number>(0);
  const latestUpcomingRef = useRef<UpcomingTrack | null>(null);
  const latestQueueRef = useRef<QueueItem[]>([]);

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
  const [infoToastMessage, setInfoToastMessage] = useState<string | null>(null);
  const [skipVoteToastHidden, setSkipVoteToastHidden] = useState(false);
  const [skipVoteToastExpiresAt, setSkipVoteToastExpiresAt] = useState<number | null>(null);
  const [skipVoteToastSecondsLeft, setSkipVoteToastSecondsLeft] = useState(0);
  const [skipVoteToastVoted, setSkipVoteToastVoted] = useState(false);
  const [displayHeaderNextTrack, setDisplayHeaderNextTrack] = useState<{
    title: string | null;
    artist: string | null;
    requestedBy: string | null;
    isFallback: boolean;
  } | null>(null);
  const [tunnelRecoveryUntil, setTunnelRecoveryUntil] = useState<number | null>(null);
  const [tunnelRecoverySecondsLeft, setTunnelRecoverySecondsLeft] = useState(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipVoteCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tunnelRecoveryTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressNextQueueBadgeRef = useRef(false);
  const prevVisibleTrackKeyRef = useRef("");

  const isStreamUnavailable = radioMode === "dj" ? !twitchLive : !streamOnline;
  const tabsAllowed = !isStreamUnavailable;
  const showRequests = tabsAllowed && (twitchLive || (radioConnected && radioMode === "dj"));
  const showRadioPanel = tabsAllowed && radioMode !== "dj";
  const showQueuePanel = tabsAllowed && radioMode !== "dj";
  const voteState = useRadioStore((s) => s.voteState);
  const syncedCurrentTrack = useSyncedTrack(radioMode === "dj" ? null : radioTrack);

  function hydrateCurrentTrack(track: Track | null): Track | null {
    if (!track) return null;
    let hydrated = track;
    const upcoming = latestUpcomingRef.current;
    if (upcoming && upcoming.youtube_id === track.youtube_id) {
      hydrated = {
        ...hydrated,
        title: hydrated.title ?? upcoming.title ?? null,
        thumbnail: hydrated.thumbnail ?? upcoming.thumbnail ?? null,
        added_by: hydrated.added_by ?? upcoming.added_by ?? null,
        duration: hydrated.duration ?? upcoming.duration ?? null,
      };
    }

    if (!hydrated.title || !hydrated.added_by || !hydrated.thumbnail) {
      const fromQueue = latestQueueRef.current.find((item) => item.youtube_id === track.youtube_id);
      if (fromQueue) {
        hydrated = {
          ...hydrated,
          title: hydrated.title ?? fromQueue.title ?? null,
          thumbnail: hydrated.thumbnail ?? fromQueue.thumbnail ?? null,
          added_by: hydrated.added_by ?? fromQueue.added_by ?? null,
        };
      }
    }
    return hydrated;
  }

  function showToast(message: string, durationMs = 5000): void {
    setToastMessage(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, durationMs);
  }

  function showInfoToast(message: string): void {
    setInfoToastMessage(message);
    if (infoToastTimerRef.current) clearTimeout(infoToastTimerRef.current);
    infoToastTimerRef.current = setTimeout(() => {
      setInfoToastMessage(null);
      infoToastTimerRef.current = null;
    }, 5500);
  }

  function dismissInfoToast(): void {
    setInfoToastMessage(null);
    suppressNextQueueBadgeRef.current = true;
    if (infoToastTimerRef.current) {
      clearTimeout(infoToastTimerRef.current);
      infoToastTimerRef.current = null;
    }
  }

  function dismissSkipVoteToast(): void {
    setSkipVoteToastHidden(true);
  }

  function castSkipVoteFromToast(): void {
    if (!voteState) return;
    getSocket().emit("vote:skip", {});
    setSkipVoteToastVoted(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("skip-vote-cast"));
    }
  }

  useEffect(() => {
    if (!showRequests && activeTab === "requests") {
      setActiveTab(radioConnected ? "radio" : "chat");
    }
  }, [showRequests, activeTab, radioConnected]);

  useEffect(() => {
    if (!showRadioPanel && activeTab === "radio") {
      if (showQueuePanel) setActiveTab("queue");
      else setActiveTab(showRequests ? "requests" : "chat");
    }
  }, [showRadioPanel, showQueuePanel, activeTab, showRequests]);

  useEffect(() => {
    if (!showQueuePanel && activeTab === "queue") {
      if (showRadioPanel) setActiveTab("radio");
      else setActiveTab(showRequests ? "requests" : "chat");
    }
  }, [showQueuePanel, showRadioPanel, activeTab, showRequests]);

  useEffect(() => {
    if (desktopAccordionTab === "radio" && !showRadioPanel && showQueuePanel) {
      setDesktopAccordionTab("queue");
      return;
    }
    if (desktopAccordionTab === "queue" && !showQueuePanel && showRadioPanel) {
      setDesktopAccordionTab("radio");
    }
  }, [desktopAccordionTab, showQueuePanel, showRadioPanel]);


  useEffect(() => {
    if (!voteState || voteState.votes <= 0) {
      setSkipVoteToastExpiresAt(null);
      setSkipVoteToastSecondsLeft(0);
      setSkipVoteToastHidden(false);
      setSkipVoteToastVoted(false);
      if (skipVoteCountdownRef.current) {
        clearInterval(skipVoteCountdownRef.current);
        skipVoteCountdownRef.current = null;
      }
      return;
    }

    setSkipVoteToastHidden(false);
    if (!skipVoteToastExpiresAt) {
      const expiresAt = Date.now() + Math.max(1, voteState.timer ?? 15) * 1000;
      setSkipVoteToastExpiresAt(expiresAt);
      setSkipVoteToastSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }
  }, [voteState, skipVoteToastExpiresAt]);

  useEffect(() => {
    function onSkipVoteCast() {
      setSkipVoteToastVoted(true);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("skip-vote-cast", onSkipVoteCast);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("skip-vote-cast", onSkipVoteCast);
      }
    };
  }, []);

  useEffect(() => {
    if (!skipVoteToastExpiresAt) {
      if (skipVoteCountdownRef.current) {
        clearInterval(skipVoteCountdownRef.current);
        skipVoteCountdownRef.current = null;
      }
      return;
    }

    const tick = () => {
      const next = Math.max(0, Math.ceil((skipVoteToastExpiresAt - Date.now()) / 1000));
      setSkipVoteToastSecondsLeft(next);
      if (next <= 0 && skipVoteCountdownRef.current) {
        clearInterval(skipVoteCountdownRef.current);
        skipVoteCountdownRef.current = null;
      }
    };

    tick();
    if (skipVoteCountdownRef.current) clearInterval(skipVoteCountdownRef.current);
    skipVoteCountdownRef.current = setInterval(tick, 1000);

    return () => {
      if (skipVoteCountdownRef.current) {
        clearInterval(skipVoteCountdownRef.current);
        skipVoteCountdownRef.current = null;
      }
    };
  }, [skipVoteToastExpiresAt]);

  useEffect(() => {
    if (!tunnelRecoveryUntil) {
      setTunnelRecoverySecondsLeft(0);
      if (tunnelRecoveryTickRef.current) {
        clearInterval(tunnelRecoveryTickRef.current);
        tunnelRecoveryTickRef.current = null;
      }
      return;
    }

    const tick = () => {
      const next = Math.max(0, Math.ceil((tunnelRecoveryUntil - Date.now()) / 1000));
      setTunnelRecoverySecondsLeft(next);
      if (next <= 0) {
        setTunnelRecoveryUntil(null);
        if (tunnelRecoveryTickRef.current) {
          clearInterval(tunnelRecoveryTickRef.current);
          tunnelRecoveryTickRef.current = null;
        }
      }
    };

    tick();
    if (tunnelRecoveryTickRef.current) clearInterval(tunnelRecoveryTickRef.current);
    tunnelRecoveryTickRef.current = setInterval(tick, 1000);

    return () => {
      if (tunnelRecoveryTickRef.current) {
        clearInterval(tunnelRecoveryTickRef.current);
        tunnelRecoveryTickRef.current = null;
      }
    };
  }, [tunnelRecoveryUntil]);

  useEffect(() => {
    const nickname = localStorage.getItem("nickname");
    if (!nickname) router.replace("/");
  }, [router]);

  useEffect(() => {
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    const forceTop = () => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      const resetScrollContainers = () => {
        document
          .querySelectorAll<HTMLElement>(".overflow-y-auto, .chat-scroll")
          .forEach((el) => {
            el.scrollTop = 0;
          });
      };
      resetScrollContainers();
      setTimeout(resetScrollContainers, 0);
    };
    forceTop();
    window.addEventListener("pageshow", forceTop);
    return () => window.removeEventListener("pageshow", forceTop);
  }, []);

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
          latestQueueRef.current = state.queue ?? [];
          console.log("[radio] State loaded:", {
            track: state.currentTrack?.title ?? "none",
            duration: state.currentTrack?.duration,
            queue: state.queue?.length,
            mode: state.mode,
          });
          store.getState().initFromServer({
            currentTrack: hydrateCurrentTrack(state.currentTrack ?? null),
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
            queuePushVote: state.queuePushVote ?? null,
            queuePushLocked: state.queuePushLocked ?? false,
            skipLocked: state.skipLocked ?? false,
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
      setTunnelRecoveryUntil(null);
      fetchState();
    });

    socket.on("disconnect", () => {
      const hadActiveStream = !!(store.getState().streamOnline || store.getState().currentTrack);
      store.getState().setConnected(false);
      store.getState().setStreamOnline(false);
      store.getState().setCurrentTrack(null);
      latestUpcomingRef.current = null;
      latestQueueRef.current = [];
      previousQueueLengthRef.current = 0;
      store.getState().setQueuePushVote(null);
      store.getState().setQueuePushLocked(false);
      store.getState().setSkipLocked(false);
      setQueueBadge(false);
      setSuppressFallback(true);
      if (hadActiveStream) {
        setTunnelRecoveryUntil(Date.now() + TUNNEL_RECOVERY_WINDOW_MS);
      }
    });

    socket.on("track:change", (track: Track | null) => {
      store.getState().setCurrentTrack(hydrateCurrentTrack(track));
      store.getState().setStreamOnline(track !== null);
      store.getState().setVoteState(null);
    });

    socket.on("queue:update", (data: { items: QueueItem[] }) => {
      const nextQueueLength = data.items.length;
      const hadQueue = previousQueueLengthRef.current;
      store.getState().setQueue(data.items);
      latestQueueRef.current = data.items;
      if (nextQueueLength > hadQueue && activeTabRef.current !== "queue") {
        if (suppressNextQueueBadgeRef.current) {
          suppressNextQueueBadgeRef.current = false;
        } else {
          setQueueBadge(true);
        }
      }
      previousQueueLengthRef.current = nextQueueLength;
    });

    socket.on("queue:added", (data: { title?: string | null; added_by?: string | null }) => {
      const addedBy = (data.added_by ?? "").trim();
      if (!addedBy) return;
      const me = (localStorage.getItem("nickname") ?? "").trim().toLowerCase();
      if (me && addedBy.toLowerCase() === me) return;
      const title = (data.title ?? "").trim() || "een nummer";
      showInfoToast(`${addedBy} voegde toe: ${title}`);
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

    socket.on("info:toast", (data: { message: string }) => {
      if (!data?.message) return;
      showInfoToast(data.message);
    });

    socket.on("durationVote:update", (data: DurationVote & { voters: string[] }) => {
      const voted = data.voters?.includes(socket.id ?? "") ?? false;
      store.getState().setDurationVote({ ...data, voted });
    });

    socket.on("durationVote:end", () => {
      store.getState().setDurationVote(null);
    });

    socket.on("queuePushVote:update", (data: {
      id: string;
      item_id: string;
      title: string | null;
      thumbnail: string | null;
      added_by: string;
      proposed_by: string;
      required: number;
      yes: number;
      no: number;
      voters: string[];
      expires_at: number;
    }) => {
      const voted = data.voters?.includes(socket.id ?? "") ?? false;
      store.getState().setQueuePushVote({ ...data, voted });
    });

    socket.on("queuePushVote:end", () => {
      store.getState().setQueuePushVote(null);
    });

    socket.on("queuePush:lock", (data: { locked: boolean }) => {
      store.getState().setQueuePushLocked(!!data.locked);
    });

    socket.on("queuePushVote:result", (data: { accepted: boolean; title?: string | null; reason?: string }) => {
      if (data.accepted) showToast(`Push akkoord: ${data.title ?? "nummer"}`, 3200);
      else showToast(data.reason ?? `Push geweigerd voor ${data.title ?? "nummer"}`, 3200);
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
      if (infoToastTimerRef.current) {
        clearTimeout(infoToastTimerRef.current);
        infoToastTimerRef.current = null;
      }
      if (skipVoteCountdownRef.current) {
        clearInterval(skipVoteCountdownRef.current);
        skipVoteCountdownRef.current = null;
      }
      if (tunnelRecoveryTickRef.current) {
        clearInterval(tunnelRecoveryTickRef.current);
        tunnelRecoveryTickRef.current = null;
      }
      suppressNextQueueBadgeRef.current = false;
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

  useEffect(() => {
    if (!twitchLive) setTwitchPlayerHidden(false);
  }, [twitchLive]);

  // Derive the audio source for radio mode
  const radioStreamUrl = radioServerUrl
    ? `${radioServerUrl}/listen`
    : process.env.NEXT_PUBLIC_STREAM_URL ?? icecastUrl;
  const isDjModeConnected = radioMode === "dj" && radioConnected;
  const showTunnelRecoveryState =
    mode === "radio" &&
    !!radioStreamUrl &&
    !!radioServerUrl &&
    !radioConnected &&
    !!tunnelRecoveryUntil &&
    tunnelRecoverySecondsLeft > 0;
  const showRadioOfflineState =
    mode === "radio" &&
    (!radioStreamUrl || (!radioConnected && !showTunnelRecoveryState) || (!isDjModeConnected && radioConnected && !streamOnline));
  const shouldPollCommunityWidgets = radioMode === "dj" && radioConnected;
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
  const nextIsFallback = !nextQueueItem && !!upcomingTrack?.isFallback;
  const showHeaderNextOnly = mode === "radio" && !showRadioOfflineState && !showTunnelRecoveryState;

  useEffect(() => {
    const visibleTrackKey = syncedCurrentTrack
      ? `${syncedCurrentTrack.id}|${syncedCurrentTrack.started_at}`
      : "none";
    const visibleTrackChanged = prevVisibleTrackKeyRef.current !== visibleTrackKey;

    if (visibleTrackChanged || !syncedCurrentTrack) {
      if (nextTitle || nextArtist) {
        setDisplayHeaderNextTrack({
          title: nextTitle ?? null,
          artist: nextArtist ?? null,
          requestedBy: nextRequestedBy,
          isFallback: nextIsFallback,
        });
      } else {
        setDisplayHeaderNextTrack(null);
      }
    }

    prevVisibleTrackKeyRef.current = visibleTrackKey;
  }, [syncedCurrentTrack, nextTitle, nextArtist, nextRequestedBy, nextIsFallback]);

  return (
    <div className="relative flex min-h-[100svh] h-dvh max-h-dvh flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="player-ambient absolute -left-20 top-10 h-72 w-72 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="player-ambient absolute bottom-0 right-0 h-80 w-80 rounded-full bg-fuchsia-500/10 blur-3xl" />
      </div>
      {/* Header */}
      <header
        className="relative z-50 border-b border-gray-800 bg-gray-900/80 px-2 py-1.5 backdrop-blur-sm sm:px-6 sm:py-3"
        style={{ paddingTop: "max(env(safe-area-inset-top), 0px)" }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
          <h1 className="min-w-0 truncate text-sm font-bold tracking-tight text-white sm:text-lg">
            🎵 <span className="text-violet-400">{process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "Stream"}</span>
          </h1>
          <div className="flex min-w-0 shrink-0 items-center gap-1 sm:gap-3">
            <ModeIndicator />
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
          <div className="mt-2 rounded-lg border border-gray-700/60 bg-gray-800/60 px-2.5 py-1 sm:px-3 sm:py-1.5">
            <p className="truncate text-[11px] text-gray-300 sm:text-xs">
              <span className="mr-1 uppercase tracking-wider text-gray-500">Volgende:</span>
              {displayHeaderNextTrack?.artist && <span className="text-violet-400">{displayHeaderNextTrack.artist}</span>}
              {displayHeaderNextTrack?.artist && displayHeaderNextTrack?.title && <span className="text-gray-500"> — </span>}
              {displayHeaderNextTrack?.title && <span>{displayHeaderNextTrack.title}</span>}
              {!displayHeaderNextTrack?.title && <span className="text-gray-500">Nog geen track klaar...</span>}
              {displayHeaderNextTrack?.isFallback && (
                <span className="ml-1 text-gray-500">(random)</span>
              )}
              {displayHeaderNextTrack?.requestedBy && (
                <span className="ml-1 text-gray-500">
                  · door <span className="text-violet-300">{displayHeaderNextTrack.requestedBy}</span>
                </span>
              )}
            </p>
          </div>
        )}
        {mode !== "offline" && mode !== "radio" && !showRadioOfflineState && (
          <div className={mode === "twitch" ? "block" : "hidden landscape:block sm:block"}>
            <NowPlaying
              radioTrack={radioConnected && radioMode !== "dj" ? radioTrack : null}
              showFallback={!suppressFallback || radioMode === "dj"}
              preferSupabase={radioMode === "dj"}
            />
          </div>
        )}
        {showTunnelRecoveryState ? (
          <div className="mt-2 rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300/70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
              </span>
              <span className="font-semibold uppercase tracking-wide">Verbinding herstellen...</span>
            </div>
            <p className="mt-1 text-[11px] text-amber-100/85">
              Tunnel lijkt verbroken. We proberen automatisch opnieuw te verbinden ({tunnelRecoverySecondsLeft}s).
            </p>
          </div>
        ) : showRadioOfflineState && (
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
        <div className="min-h-0 shrink-0 max-h-[38dvh] overflow-hidden landscape:min-w-0 landscape:flex-1 landscape:max-h-none landscape:min-h-0 landscape:overflow-hidden lg:min-w-0 lg:flex-1 lg:max-h-none lg:min-h-0 lg:overflow-visible">
          {shouldPollCommunityWidgets && <ShoutoutBanner />}
          {mode === "twitch" && twitchLive && (
            <div className="space-y-2">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setTwitchPlayerHidden((prev) => !prev)}
                  className="rounded-md border border-gray-700 bg-gray-900/80 px-2.5 py-1 text-[11px] font-semibold text-violet-200 transition hover:border-violet-500/70 hover:text-white"
                >
                  {twitchPlayerHidden ? "Toon Twitch player" : "Verberg Twitch player"}
                </button>
              </div>
              {twitchPlayerHidden ? (
                <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-6 text-center text-sm text-gray-400">
                  Twitch player verborgen
                </div>
              ) : (
                <TwitchPlayer />
              )}
            </div>
          )}
          {mode === "audio" && icecastUrl && (
            <AudioPlayer src={icecastUrl} radioTrack={radioConnected ? radioTrack : undefined} showFallback={!suppressFallback} />
          )}
          {mode === "radio" && radioStreamUrl && !showRadioOfflineState && !showTunnelRecoveryState && (
            <AudioPlayer
              src={radioStreamUrl}
              radioTrack={radioMode === "dj" ? null : radioTrack}
              showFallback={radioMode === "dj" || !radioTrack}
              preferSupabase={radioMode === "dj" || !radioTrack}
            />
          )}
          {mode === "radio" && showTunnelRecoveryState && (
            <div className="relative overflow-hidden rounded-xl border border-amber-900/60 bg-gradient-to-br from-amber-950/30 via-gray-900 to-gray-900 px-4 py-6 shadow-lg shadow-amber-900/20 sm:py-12">
              <div className="pointer-events-none absolute -left-10 -top-10 h-32 w-32 rounded-full bg-amber-500/15 blur-2xl" />
              <div className="pointer-events-none absolute -bottom-12 right-0 h-36 w-36 rounded-full bg-violet-500/10 blur-3xl" />
              <div className="relative z-10 flex items-center justify-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-400" />
                </span>
                <p className="text-sm font-semibold text-amber-100 sm:text-base">
                  Verbinding herstellen...
                </p>
              </div>
              <p className="relative z-10 mt-2 text-center text-xs text-gray-200 sm:text-sm">
                Tunnel wordt opnieuw opgezet. Proberen in de achtergrond ({tunnelRecoverySecondsLeft}s).
              </p>
            </div>
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
          {radioConnected && radioMode !== "dj" && !showRadioOfflineState && (
            <div className="mt-1.5 space-y-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 pb-0.5">
                <div className="relative z-[130] min-w-0 flex-[1.2] overflow-visible">
                  <FallbackGenreSelector />
                </div>
                <div className="min-w-0 flex-1">
                  <SkipButton compact />
                </div>
              </div>
              <DurationVotePanel />
              <QueuePushVotePanel />
            </div>
          )}
          {shouldPollCommunityWidgets && (
            <div className="mt-2">
              <LivePollCard />
            </div>
          )}
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
              onClick={() => setActiveTab("radio")}
              className={`relative flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                activeTab === "radio"
                  ? "bg-violet-600 text-white shadow-sm"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Aanvragen
            </button>
          )}
          {showQueuePanel && (
            <button
              onClick={() => { setActiveTab("queue"); setQueueBadge(false); }}
              className={`relative flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                activeTab === "queue"
                  ? "bg-violet-600 text-white shadow-sm"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Wachtrij{queue.length > 0 ? ` (${queue.length})` : ""}
              {queueBadge && activeTab !== "queue" && (
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
            <div className={`min-h-0 min-w-0 flex-1 overflow-hidden flex-col gap-2 ${activeTab === "radio" ? "flex" : "hidden"} lg:hidden`}>
              <RadioPanelErrorBoundary>
                <QueueAdd />
              </RadioPanelErrorBoundary>
            </div>
          )}
          {showQueuePanel && (
            <div className={`min-h-0 min-w-0 flex-1 overflow-hidden flex-col gap-2 ${activeTab === "queue" ? "flex" : "hidden"} lg:hidden`}>
              <RadioPanelErrorBoundary>
                <Queue />
              </RadioPanelErrorBoundary>
            </div>
          )}
          {(showRadioPanel || showQueuePanel) && (
            <div className="hidden min-h-0 min-w-0 flex-1 flex-col gap-2 lg:flex">
              {showRadioPanel && (
                <div className={`relative flex min-h-0 min-w-0 flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5 ${
                  desktopAccordionTab === "radio" ? "z-40 overflow-visible" : "z-20 overflow-hidden"
                }`}>
                  <button
                    type="button"
                    onClick={() => setDesktopAccordionTab("radio")}
                    className={`flex w-full items-center justify-between border-b border-gray-800 px-3 py-2 text-left text-sm font-semibold transition ${
                      desktopAccordionTab === "radio" ? "text-white bg-gray-800/40" : "text-gray-200 hover:bg-gray-800/60"
                    }`}
                  >
                    <span>Nummer toevoegen</span>
                    <span className={`text-xs text-gray-400 transition ${desktopAccordionTab === "radio" ? "rotate-180" : ""}`}>▾</span>
                  </button>
                  {desktopAccordionTab === "radio" && (
                    <div className="overflow-visible p-2">
                      <RadioPanelErrorBoundary>
                        <QueueAdd />
                      </RadioPanelErrorBoundary>
                    </div>
                  )}
                </div>
              )}
              {showQueuePanel && (
                <div className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5 ${
                  desktopAccordionTab === "queue" ? "z-30" : "z-10"
                }`}>
                  <button
                    type="button"
                    onClick={() => setDesktopAccordionTab("queue")}
                    className={`flex w-full items-center justify-between border-b border-gray-800 px-3 py-2 text-left text-sm font-semibold transition ${
                      desktopAccordionTab === "queue" ? "text-white bg-gray-800/40" : "text-gray-200 hover:bg-gray-800/60"
                    }`}
                  >
                    <span>Wachtrij{queue.length > 0 ? ` (${queue.length})` : ""}</span>
                    <span className={`text-xs text-gray-400 transition ${desktopAccordionTab === "queue" ? "rotate-180" : ""}`}>▾</span>
                  </button>
                  {desktopAccordionTab === "queue" && (
                    <div className="max-h-[56dvh] overflow-y-auto p-2">
                      <RadioPanelErrorBoundary>
                        <Queue />
                      </RadioPanelErrorBoundary>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      {infoToastMessage && (
        <div className="pointer-events-none fixed left-1/2 top-3 z-[115] w-[92%] max-w-xl -translate-x-1/2 sm:top-4">
          <div className="pointer-events-auto flex items-start justify-between gap-2 rounded-lg border border-violet-800/70 bg-violet-950/80 px-4 py-2 text-sm text-violet-100 shadow-lg shadow-violet-900/30 backdrop-blur-sm">
            <span className="min-w-0 flex-1 break-words">{infoToastMessage}</span>
            <button
              type="button"
              onClick={dismissInfoToast}
              className="shrink-0 rounded px-1 text-violet-200/80 transition hover:bg-violet-800/40 hover:text-white"
              aria-label="Sluit melding"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {toastMessage && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-[120] w-[92%] max-w-xl -translate-x-1/2">
          <div className="rounded-lg border border-red-900/60 bg-red-950/85 px-4 py-2 text-center text-sm text-red-100 shadow-lg shadow-red-900/40 backdrop-blur-sm">
            {toastMessage}
          </div>
        </div>
      )}
      {voteState && voteState.votes > 0 && !skipVoteToastHidden && (
        <div className="pointer-events-none fixed bottom-20 left-1/2 z-[125] w-[94%] max-w-xl -translate-x-1/2 sm:bottom-6">
          <div className="pointer-events-auto rounded-lg border border-violet-700/60 bg-violet-950/90 px-3 py-2 text-violet-100 shadow-lg shadow-violet-900/40 backdrop-blur-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  Skip-stemming actief
                </p>
                <p className="mt-0.5 text-xs text-violet-200/90">
                  {voteState.votes}/{voteState.required} stemmen · nog {skipVoteToastSecondsLeft}s
                </p>
              </div>
              <button
                type="button"
                onClick={dismissSkipVoteToast}
                className="shrink-0 rounded px-1 text-violet-200/80 transition hover:bg-violet-800/40 hover:text-white"
                aria-label="Sluit skip-stemming melding"
              >
                ×
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={castSkipVoteFromToast}
                disabled={skipVoteToastVoted}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  skipVoteToastVoted
                    ? "cursor-default bg-violet-500/25 text-violet-200"
                    : "bg-violet-500 text-white hover:bg-violet-400"
                }`}
              >
                {skipVoteToastVoted ? "Gestemd" : "Skip"}
              </button>
              <button
                type="button"
                onClick={dismissSkipVoteToast}
                className="rounded-md border border-violet-700/70 px-3 py-1.5 text-xs font-semibold text-violet-200 transition hover:bg-violet-900/55"
              >
                Verbergen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
