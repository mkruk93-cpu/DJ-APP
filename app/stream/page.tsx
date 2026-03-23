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
import { useAuth } from "@/lib/authContext";

type StreamMode = "twitch" | "audio" | "radio" | "offline";
type MobileTab = "chat" | "requests" | "radio" | "queue" | "requested";
type StreamRequestItem = {
  id: string;
  nickname: string;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  duration: number | null;
  genre: string | null;
  genre_confidence: "explicit" | "artist_based" | "unknown" | null;
  status: string;
  created_at: string;
};
type DesktopAccordionTab = "radio" | "queue";
const TUNNEL_RECOVERY_WINDOW_MS = 150_000;
const PWA_INSTALL_DISMISS_KEY = "djapp:pwa-install-dismissed-at";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface PublicStatsSummary {
  generatedAt: number;
  periodDays: number;
  totals: {
    requests: number;
    uniqueRequesters: number;
    uniqueTracks: number;
  };
  topRequesters: Array<{ name: string; count: number }>;
  topGenres: Array<{ name: string; count: number }>;
  topSources: Array<{ name: string; count: number }>;
  topArtists: Array<{ name: string; count: number }>;
  topTracks: Array<{ name: string; count: number }>;
  topPlaylists: Array<{ name: string; count: number }>;
  dataQuality: {
    knownGenres: number;
    inferredGenres: number;
    missingGenres: number;
    knownSources: number;
    inferredSources: number;
    missingSources: number;
  };
  recentRequests: Array<{
    ts: number;
    added_by: string;
    title: string | null;
    artist: string | null;
    source_type: string | null;
    source_genre: string | null;
    source_playlist: string | null;
  }>;
}

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
  const { user, userAccount, loading: authLoading, signOut } = useAuth();
  const [mode, setMode] = useState<StreamMode>("offline");
  const [twitchPlayerHidden, setTwitchPlayerHidden] = useState(false);
  const [icecastUrl, setIcecastUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MobileTab>("chat");
  const [desktopAccordionTab, setDesktopAccordionTab] = useState<DesktopAccordionTab>("radio");
  const [chatBadge, setChatBadge] = useState(false);
  const [requestBadge, setRequestBadge] = useState(false);
  const [queueBadge, setQueueBadge] = useState(false);
  const [requestedItems, setRequestedItems] = useState<StreamRequestItem[]>([]);
  const [requestedLoading, setRequestedLoading] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [appInfoOpen, setAppInfoOpen] = useState(false);
  const [mobileHeaderMenuOpen, setMobileHeaderMenuOpen] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsSummary, setStatsSummary] = useState<PublicStatsSummary | null>(null);
  const [statsDays, setStatsDays] = useState<7 | 30 | 90 | 180>(30);
  const [statsFilter, setStatsFilter] = useState<{
    kind: "requester" | "genre" | "source" | "artist" | "playlist" | null;
    value: string | null;
  }>({ kind: null, value: null });
  const [isHydrated, setIsHydrated] = useState(false);
  const [showLoadingStates, setShowLoadingStates] = useState(true);
  const [radioStateReady, setRadioStateReady] = useState(false);
  const [offlineUiArmed, setOfflineUiArmed] = useState(false);
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
  const pausedForIdle = useRadioStore((s) => s.pausedForIdle);
  const skipLocked = useRadioStore((s) => s.skipLocked);
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
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [isStandalonePwa, setIsStandalonePwa] = useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installBannerDismissed, setInstallBannerDismissed] = useState(false);
  const [displayHeaderNextTrack, setDisplayHeaderNextTrack] = useState<{
    title: string | null;
    artist: string | null;
    requestedBy: string | null;
    isFallback: boolean;
  } | null>(() => {
    // Try to restore from localStorage for PWA persistence
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('lastHeaderTrack');
        return saved ? JSON.parse(saved) : null;
      } catch {
        return null;
      }
    }
    return null;
  });
  const [tunnelRecoveryUntil, setTunnelRecoveryUntil] = useState<number | null>(null);
  const [tunnelRecoverySecondsLeft, setTunnelRecoverySecondsLeft] = useState(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipVoteCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tunnelRecoveryTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressNextQueueBadgeRef = useRef(false);
  const prevVisibleTrackKeyRef = useRef("");
  const mobileHeaderMenuRef = useRef<HTMLDivElement>(null);
  const skipWaitToastShownRef = useRef(false);
  const hadSkipVoteActiveRef = useRef(false);
  const lastQueuePushVoteIdRef = useRef<string | null>(null);

  const hasExternalDjSignal = twitchLive || (radioConnected && !streamOnline && !pausedForIdle);
  const isDjSessionLive = (radioMode === "dj" && (twitchLive || radioConnected)) || hasExternalDjSignal;
  const communityUiActive = mode !== "offline" && (radioConnected || twitchLive || !!radioServerUrl || radioMode === "dj");
  const forceDjCommunityUi = radioMode === "dj" || hasExternalDjSignal || mode === "twitch";
  // Fail-safe: once stream context is active, keep request/queue UI available.
  const isStreamUnavailable = communityUiActive ? false : (!streamOnline && !pausedForIdle);
  const tabsAllowed = communityUiActive ? true : !isStreamUnavailable;
  const showRequests = radioMode === "dj";
  const showRadioPanel = communityUiActive && radioMode !== "dj";
  const showQueuePanel = communityUiActive && radioMode !== "dj";
  const showRequestedPanel = communityUiActive && radioMode === "dj";
  const voteState = useRadioStore((s) => s.voteState);
  const syncedCurrentTrack = useSyncedTrack(radioMode === "dj" ? null : radioTrack);
  const statsServerUrl = (radioServerUrl ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL ?? "").replace(/\/+$/, "");
  const shouldShowInstallBanner = isHydrated && !isStandalonePwa && !installBannerDismissed;

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

  async function fetchPublicStats(days: number): Promise<void> {
    if (!statsServerUrl) {
      setStatsError("Geen server URL beschikbaar voor statistieken.");
      return;
    }
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await fetch(`${statsServerUrl}/api/stats/summary?days=${Math.max(1, days)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatsSummary(data as PublicStatsSummary);
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : "Kon statistieken niet laden.");
    } finally {
      setStatsLoading(false);
    }
  }

  function castSkipVoteFromToast(): void {
    if (!voteState) return;
    getSocket().emit("vote:skip", {});
    setSkipVoteToastVoted(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("skip-vote-cast"));
    }
  }

  function requestCastFromHeader(): void {
    if (typeof window === "undefined") return;
    const hasPlayerCastUi = Boolean((window as Window & { __radioCastUiAvailable?: boolean }).__radioCastUiAvailable);
    if (!hasPlayerCastUi) {
      showInfoToast("Open eerst de radio player om cast te starten.");
      return;
    }
    window.dispatchEvent(new CustomEvent("radio-cast-toggle-request"));
  }

  useEffect(() => {
    if (skipLocked) {
      if (!skipWaitToastShownRef.current) {
        skipWaitToastShownRef.current = true;
        const waitingTitle = latestUpcomingRef.current?.title ?? null;
        showInfoToast(waitingTitle
          ? `Skip aangevraagd. Wachten op: ${waitingTitle}`
          : "Skip aangevraagd. Volgende nummer wordt voorbereid...");
      }
      return;
    }
    skipWaitToastShownRef.current = false;
  }, [skipLocked]);

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
      else if (showRequestedPanel) setActiveTab("requested");
      else setActiveTab(showRequests ? "requests" : "chat");
    }
  }, [showQueuePanel, showRadioPanel, showRequestedPanel, activeTab, showRequests]);

  useEffect(() => {
    if (!showRequestedPanel && activeTab === "requested") {
      if (showQueuePanel) setActiveTab("queue");
      else if (showRadioPanel) setActiveTab("radio");
      else setActiveTab(showRequests ? "requests" : "chat");
    }
  }, [showRequestedPanel, showQueuePanel, showRadioPanel, activeTab, showRequests]);

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
    if (!mobileHeaderMenuOpen) return;
    function onClickOutside(event: MouseEvent) {
      if (mobileHeaderMenuRef.current && !mobileHeaderMenuRef.current.contains(event.target as Node)) {
        setMobileHeaderMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [mobileHeaderMenuOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const win = window as Window & { __radioPlayerFullscreenState?: boolean };
    setPlayerFullscreen(!!win.__radioPlayerFullscreenState);
    function onPlayerFullscreen(event: Event) {
      const custom = event as CustomEvent<{ fullscreen?: boolean }>;
      setPlayerFullscreen(!!custom.detail?.fullscreen);
    }
    window.addEventListener("radio-player-fullscreen-state", onPlayerFullscreen as EventListener);
    return () => window.removeEventListener("radio-player-fullscreen-state", onPlayerFullscreen as EventListener);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissedAt = Number.parseInt(localStorage.getItem(PWA_INSTALL_DISMISS_KEY) ?? "", 10);
    if (Number.isFinite(dismissedAt) && Date.now() - dismissedAt < 12 * 60 * 60 * 1000) {
      setInstallBannerDismissed(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setDeferredInstallPrompt(promptEvent);
    };

    const onAppInstalled = () => {
      setDeferredInstallPrompt(null);
      setInstallBannerDismissed(true);
      localStorage.removeItem(PWA_INSTALL_DISMISS_KEY);
      showInfoToast("App geinstalleerd. Veel luisterplezier!");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const dismissInstallBanner = () => {
    setInstallBannerDismissed(true);
    if (typeof window !== "undefined") {
      localStorage.setItem(PWA_INSTALL_DISMISS_KEY, String(Date.now()));
    }
  };

  const promptInstallApp = async () => {
    if (!deferredInstallPrompt) {
      showInfoToast("Open browsermenu en kies 'Installeer app' of 'Toevoegen aan beginscherm'.");
      return;
    }
    try {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstallBannerDismissed(true);
        localStorage.removeItem(PWA_INSTALL_DISMISS_KEY);
      }
    } catch {
      showInfoToast("Installatieprompt kon niet worden geopend.");
    } finally {
      setDeferredInstallPrompt(null);
    }
  };

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
    setIsHydrated(true);
    // Give components time to initialize before hiding loading states
    const timer = setTimeout(() => setShowLoadingStates(false), 2000);
    return () => clearTimeout(timer);
  }, []);

  // PWA lifecycle event handlers for installed app
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        console.log('[PWA] App became visible, forcing re-render');
        // Force re-render when PWA becomes visible
        setIsHydrated(false);
        setTimeout(() => {
          setIsHydrated(true);
          setShowLoadingStates(true);
          setTimeout(() => setShowLoadingStates(false), 2000);
        }, 100);
      }
    }

    function handleAppStateChange() {
      console.log('[PWA] App state change detected');
      // Force components to re-initialize
      setShowLoadingStates(true);
      setTimeout(() => setShowLoadingStates(false), 2000);
    }

    // Listen for PWA visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Listen for PWA app state changes
    window.addEventListener('focus', handleAppStateChange);
    window.addEventListener('pageshow', handleAppStateChange);
    
    // Listen for PWA-specific events
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleAppStateChange);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleAppStateChange);
      window.removeEventListener('pageshow', handleAppStateChange);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleAppStateChange);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const navStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    const displayModeMedia = window.matchMedia("(display-mode: standalone)");

    const syncViewportHeight = () => {
      const nextHeight = Math.max(320, Math.round(window.visualViewport?.height ?? window.innerHeight));
      document.documentElement.style.setProperty("--app-dvh", `${nextHeight}px`);
    };

    const syncDisplayMode = () => {
      const standalone = navStandalone || displayModeMedia.matches;
      setIsStandalonePwa(standalone);
      document.documentElement.dataset.displayMode = standalone ? "standalone" : "browser";
      document.body.dataset.displayMode = standalone ? "standalone" : "browser";
    };

    const syncViewport = () => {
      syncViewportHeight();
      syncDisplayMode();
    };

    syncViewport();
    const timers = [0, 80, 220, 500, 1000].map((delay) => window.setTimeout(syncViewport, delay));
    window.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    window.addEventListener("pageshow", syncViewport);
    window.addEventListener("focus", syncViewport);
    document.addEventListener("visibilitychange", syncViewport);
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    if (typeof displayModeMedia.addEventListener === "function") {
      displayModeMedia.addEventListener("change", syncViewport);
    } else {
      displayModeMedia.addListener(syncViewport);
    }

    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      window.removeEventListener("pageshow", syncViewport);
      window.removeEventListener("focus", syncViewport);
      document.removeEventListener("visibilitychange", syncViewport);
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.visualViewport?.removeEventListener("scroll", syncViewport);
      if (typeof displayModeMedia.removeEventListener === "function") {
        displayModeMedia.removeEventListener("change", syncViewport);
      } else {
        displayModeMedia.removeListener(syncViewport);
      }
      delete document.documentElement.dataset.displayMode;
      delete document.body.dataset.displayMode;
    };
  }, []);

  useEffect(() => {
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverscroll = document.documentElement.style.overscrollBehaviorY;
    const prevBodyOverscroll = document.body.style.overscrollBehaviorY;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehaviorY = "none";
    document.body.style.overscrollBehaviorY = "none";
    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overscrollBehaviorY = prevHtmlOverscroll;
      document.body.style.overscrollBehaviorY = prevBodyOverscroll;
    };
  }, []);

  useEffect(() => {
    if (!isStandalonePwa) return;
    const prevBodyPosition = document.body.style.position;
    const prevBodyInset = document.body.style.inset;
    const prevBodyWidth = document.body.style.width;
    const prevBodyHeight = document.body.style.height;
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.position = "fixed";
    document.body.style.inset = "0";
    document.body.style.width = "100%";
    document.body.style.height = "var(--app-dvh, 100dvh)";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.position = prevBodyPosition;
      document.body.style.inset = prevBodyInset;
      document.body.style.width = prevBodyWidth;
      document.body.style.height = prevBodyHeight;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, [isStandalonePwa]);

  useEffect(() => {
    if (!isStandalonePwa) return;

    let touchStartY = 0;
    const findScrollableParent = (node: EventTarget | null): HTMLElement | null => {
      let el = node instanceof HTMLElement ? node : null;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const canScrollY = (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
        if (canScrollY) return el;
        el = el.parentElement;
      }
      return null;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      touchStartY = event.touches[0]?.clientY ?? 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const currentY = event.touches[0]?.clientY ?? touchStartY;
      const pullingDown = currentY - touchStartY > 8;
      if (!pullingDown) return;
      const scrollable = findScrollableParent(event.target);
      if (!scrollable || scrollable.scrollTop <= 0) {
        event.preventDefault();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isRefresh =
        key === "f5" ||
        ((event.ctrlKey || event.metaKey) && key === "r") ||
        ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "r");
      if (!isRefresh) return;
      event.preventDefault();
      showInfoToast("Refresh is uitgeschakeld in app-modus.");
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isStandalonePwa]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    const forceTop = () => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
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
    const timers = [0, 60, 180, 420, 900, 1500, 2200].map((delay) => window.setTimeout(forceTop, delay));
    const guard = window.setInterval(() => {
      if (window.scrollY > 0 || document.documentElement.scrollTop > 0 || document.body.scrollTop > 0) {
        forceTop();
      }
    }, 300);
    window.setTimeout(() => window.clearInterval(guard), 3200);
    const onVisibility = () => {
      if (document.visibilityState === "visible") forceTop();
    };
    forceTop();
    window.addEventListener("pageshow", forceTop);
    window.addEventListener("focus", forceTop);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      window.clearInterval(guard);
      window.removeEventListener("pageshow", forceTop);
      window.removeEventListener("focus", forceTop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
          setRadioStateReady(true);
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
            activeFallbackGenres: state.activeFallbackGenres ?? [],
            activeFallbackGenreBy: state.activeFallbackGenreBy ?? null,
            activeFallbackSharedMode: state.activeFallbackSharedMode ?? "random",
            mode: state.mode ?? "radio",
            modeSettings: state.modeSettings ?? store.getState().modeSettings,
            listenerCount: state.listenerCount ?? 0,
            streamOnline: state.streamOnline ?? false,
            pausedForIdle: state.pausedForIdle ?? false,
            durationVote: state.durationVote ?? null,
            queuePushVote: state.queuePushVote ?? null,
            queuePushLocked: state.queuePushLocked ?? false,
            skipLocked: state.skipLocked ?? false,
            lockAutoplayFallback: state.lockAutoplayFallback ?? false,
            hideLocalDiscovery: state.hideLocalDiscovery ?? false,
          });
        })
        .catch((err) => {
          console.warn("[radio] Failed to fetch state:", err.message);
          setTimeout(fetchState, 3000);
        });
    }

    socket.on("connect", () => {
      store.getState().setConnected(true);
      setRadioStateReady(false);
      setPreferRadioUi(true);
      setSuppressFallback(false);
      setTunnelRecoveryUntil(null);
      fetchState();
    });

    socket.on("disconnect", () => {
      const hadActiveStream = !!(store.getState().streamOnline || store.getState().currentTrack);
      store.getState().setConnected(false);
      store.getState().setStreamOnline(false);
      store.getState().setPausedForIdle(false);
      store.getState().setCurrentTrack(null);
      latestUpcomingRef.current = null;
      latestQueueRef.current = [];
      previousQueueLengthRef.current = 0;
      store.getState().setQueuePushVote(null);
      store.getState().setQueuePushLocked(false);
      store.getState().setSkipLocked(false);
      setQueueBadge(false);
      setSuppressFallback(true);
      setRadioStateReady(false);
      if (hadActiveStream) {
        setTunnelRecoveryUntil(Date.now() + TUNNEL_RECOVERY_WINDOW_MS);
      }
    });

    socket.on("track:change", (track: Track | null) => {
      store.getState().setCurrentTrack(hydrateCurrentTrack(track));
      store.getState().setStreamOnline(track !== null);
      if (track) store.getState().setPausedForIdle(false);
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
      const me = (userAccount?.username ?? "").trim().toLowerCase();
      const title = (data.title ?? "").trim() || "een nummer";
      if (me && addedBy.toLowerCase() === me) showInfoToast(`Toegevoegd aan wachtrij: ${title}`);
      else showInfoToast(`${addedBy} voegde toe: ${title}`);
    });

    socket.on("upcoming:update", (upcoming: UpcomingTrack | null) => {
      latestUpcomingRef.current = upcoming;
      store.getState().setUpcomingTrack(upcoming);
    });

    socket.on("fallback:genre:update", (data: {
      activeGenreId: string | null;
      activeGenreIds?: string[];
      selectedBy?: string | null;
      sharedPlaybackMode?: "random" | "ordered";
      genres: Array<{ id: string; label: string; trackCount: number }>;
      lockAutoplayFallback?: boolean;
      hideLocalDiscovery?: boolean;
    }) => {
      store.getState().setFallbackGenres(data.genres ?? []);
      store.getState().setActiveFallbackGenre(data.activeGenreId ?? null);
      store.getState().setActiveFallbackGenres(Array.isArray(data.activeGenreIds) ? data.activeGenreIds : []);
      store.getState().setActiveFallbackGenreBy(data.selectedBy ?? null);
      store.getState().setActiveFallbackSharedMode(data.sharedPlaybackMode ?? "random");
      if (typeof data.lockAutoplayFallback === "boolean") {
        store.getState().setLockAutoplayFallback(data.lockAutoplayFallback);
      }
      if (typeof data.hideLocalDiscovery === "boolean") {
        store.getState().setHideLocalDiscovery(data.hideLocalDiscovery);
      }
    });

    socket.on("mode:change", (data: { mode: Mode; settings: ModeSettings }) => {
      store.getState().setMode(data.mode, data.settings);
    });

    socket.on("vote:update", (data: VoteState | null) => {
      store.getState().setVoteState(data);
      const active = !!(data && data.votes > 0);
      if (active && !hadSkipVoteActiveRef.current) {
        showInfoToast("Skip voorgesteld. Stem nu mee als je wilt skippen.");
      }
      hadSkipVoteActiveRef.current = active;
    });

    socket.on("stream:status", (data: { online: boolean; listeners: number; pausedForIdle?: boolean }) => {
      store.getState().setStreamOnline(data.online);
      store.getState().setListenerCount(data.listeners);
      if (typeof data.pausedForIdle === "boolean") {
        store.getState().setPausedForIdle(data.pausedForIdle);
      }
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
      if (lastQueuePushVoteIdRef.current !== data.id) {
        lastQueuePushVoteIdRef.current = data.id;
        showInfoToast(`Push voorgesteld: ${data.title ?? "nummer"} · door ${data.proposed_by}`);
      }
    });

    socket.on("queuePushVote:end", () => {
      store.getState().setQueuePushVote(null);
      lastQueuePushVoteIdRef.current = null;
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
    }, 15000);

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
  const isDjModeConnected = isDjSessionLive || forceDjCommunityUi;
  const showTunnelRecoveryState =
    mode === "radio" &&
    !!radioStreamUrl &&
    !!radioServerUrl &&
    !radioConnected &&
    !!tunnelRecoveryUntil &&
    tunnelRecoverySecondsLeft > 0;
  const rawRadioOfflineCandidate =
    mode === "radio" &&
    (!radioStreamUrl || (!radioConnected && !showTunnelRecoveryState) || (!isDjModeConnected && radioConnected && !streamOnline && !pausedForIdle));
  const showRadioOfflineState = rawRadioOfflineCandidate && offlineUiArmed;
  const showRadioOfflinePendingState = rawRadioOfflineCandidate && !offlineUiArmed && !showTunnelRecoveryState;
  const shouldPollCommunityWidgets = radioMode === "dj" && radioConnected;
  const nextQueueItem = (queue.find((item) => {
    const key = (item.selection_key ?? "").toLowerCase();
    return item.youtube_id !== "jingle" && !key.startsWith("jingle:");
  }) ?? null);
  const visibleUpcomingTrack = (upcomingTrack && upcomingTrack.youtube_id !== "jingle" && !((upcomingTrack.selection_key ?? "").toLowerCase().startsWith("jingle:")))
    ? upcomingTrack
    : null;
  const nextSourceTitle = firstNonEmpty(
    nextQueueItem?.title,
    visibleUpcomingTrack?.title,
    nextQueueItem?.youtube_id,
    visibleUpcomingTrack?.youtube_id,
  );
  const parsedNext = parseTrackDisplay(nextSourceTitle);
  const nextTitle = parsedNext.title ?? nextSourceTitle;
  const nextArtist = parsedNext.artist;
  const nextRequestedBy = nextQueueItem?.added_by ?? visibleUpcomingTrack?.added_by ?? null;
  const nextIsFallback = !nextQueueItem && !!visibleUpcomingTrack?.isFallback;
  const showHeaderNextOnly = mode === "radio" && !showRadioOfflineState && !showTunnelRecoveryState;

  useEffect(() => {
    if (!rawRadioOfflineCandidate) {
      setOfflineUiArmed(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setOfflineUiArmed(true);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [rawRadioOfflineCandidate]);

  useEffect(() => {
    const visibleTrackKey = syncedCurrentTrack
      ? `${syncedCurrentTrack.id}|${syncedCurrentTrack.started_at}`
      : "none";
    const visibleTrackChanged = prevVisibleTrackKeyRef.current !== visibleTrackKey;

    if (visibleTrackChanged || !syncedCurrentTrack) {
      if (nextTitle || nextArtist) {
        const trackInfo = {
          title: nextTitle ?? null,
          artist: nextArtist ?? null,
          requestedBy: nextRequestedBy,
          isFallback: nextIsFallback,
        };
        setDisplayHeaderNextTrack(trackInfo);
        
        // Save to localStorage for PWA persistence
        if (typeof window !== 'undefined') {
          try {
            localStorage.setItem('lastHeaderTrack', JSON.stringify(trackInfo));
          } catch (e) {
            console.warn('Failed to save header track to localStorage:', e);
          }
        }
      } else {
        setDisplayHeaderNextTrack(null);
        if (typeof window !== 'undefined') {
          localStorage.removeItem('lastHeaderTrack');
        }
      }
    }

    prevVisibleTrackKeyRef.current = visibleTrackKey;
  }, [syncedCurrentTrack, nextTitle, nextArtist, nextRequestedBy, nextIsFallback]);

  useEffect(() => {
    if (!statsOpen) return;
    void fetchPublicStats(statsDays);
    const interval = setInterval(() => {
      void fetchPublicStats(statsDays);
    }, 20_000);
    return () => clearInterval(interval);
  }, [statsOpen, statsServerUrl, statsDays]);

  useEffect(() => {
    if (!showRequestedPanel) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const loadRequested = async () => {
      if (!cancelled) setRequestedLoading((prev) => prev || requestedItems.length === 0);
      try {
        const res = await fetch("/api/requests", { cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json().catch(() => ({}))) as { items?: StreamRequestItem[] };
        if (cancelled) return;
        const rows = Array.isArray(payload.items) ? payload.items : [];
        setRequestedItems(
          rows.filter((item) => item.status !== "rejected" && item.status !== "error"),
        );
      } catch {
        // keep previous list on fetch hiccup
      } finally {
        if (!cancelled) setRequestedLoading(false);
      }
    };

    void loadRequested();
    timer = setInterval(() => void loadRequested(), 5000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [showRequestedPanel, requestedItems.length]);

  const filteredRecentStats = (statsSummary?.recentRequests ?? []).filter((row) => {
    if (!statsFilter.kind || !statsFilter.value) return true;
    if (statsFilter.kind === "requester") return row.added_by === statsFilter.value;
    if (statsFilter.kind === "genre") return (row.source_genre?.trim() || "Onbekend") === statsFilter.value;
    if (statsFilter.kind === "source") return (row.source_type?.trim() || "unknown") === statsFilter.value;
    if (statsFilter.kind === "artist") return (row.artist?.trim() || "Unknown artist") === statsFilter.value;
    if (statsFilter.kind === "playlist") return (row.source_playlist?.trim() || "Onbekende playlist") === statsFilter.value;
    return true;
  });

  function applyStatsFilter(
    kind: "requester" | "genre" | "source" | "artist" | "playlist",
    value: string,
  ): void {
    setStatsFilter((prev) => {
      if (prev.kind === kind && prev.value === value) return { kind: null, value: null };
      return { kind, value };
    });
  }

  useEffect(() => {
    // Redirect to login if auth is done and there's no user.
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [authLoading, user, router]);

  // Auth check: show loading screen while loading or if user is not yet determined.
  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-white">Laden...</div>
      </div>
    );
  }

  if (!userAccount?.approved) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 shadow-lg shadow-violet-500/5 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-600/20 text-3xl">
            ⏳
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-4">
            Account in Behandeling
          </h1>
          <p className="text-gray-400 mb-6">
            Je account is aangemaakt maar nog niet goedgekeurd door de admin.
            Je ontvangt een notificatie zodra je toegang krijgt.
          </p>
          <button
            onClick={() => router.push('/login')}
            className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500"
          >
            Terug naar Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden"
      style={{ height: "var(--app-dvh, 100dvh)", maxHeight: "var(--app-dvh, 100dvh)" }}
    >
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="player-ambient absolute -left-20 top-10 h-72 w-72 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="player-ambient absolute bottom-0 right-0 h-80 w-80 rounded-full bg-fuchsia-500/10 blur-3xl" />
      </div>
      {/* Header */}
      <header
        className="relative z-50 border-b border-gray-800 bg-gray-900/80 px-2 py-1.5 backdrop-blur-sm sm:px-6 sm:py-3"
        style={{ 
          paddingTop: "max(env(safe-area-inset-top), 0px)",
          minHeight: "60px"
        }}
      >
        <div className="flex w-full items-center gap-1.5">
          <h1 className="min-w-0 flex-1 truncate text-sm font-bold tracking-tight text-white sm:text-lg">
            🎵 <span className="text-violet-400">{process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "Stream"}</span>
          </h1>
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1 sm:gap-3">
            {/* Always show header components, with fallback during loading */}
            <ModeIndicator />
            <OnlineUsers username={userAccount?.username} />
            <button
              onClick={() => setStatsOpen((prev) => !prev)}
              className={`hidden whitespace-nowrap rounded-lg border px-2 py-1 text-xs transition sm:inline-flex sm:px-3 sm:text-sm ${
                statsOpen
                  ? "border-violet-500/80 bg-violet-500/15 text-violet-200"
                  : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-white"
              }`}
            >
              Stats
            </button>
            <button
              onClick={async () => {
                await signOut();
                router.push("/login");
              }}
              className="hidden whitespace-nowrap rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 transition hover:border-gray-600 hover:text-white sm:inline-flex sm:px-3 sm:text-sm"
            >
              Uitloggen
            </button>
            <button
              onClick={() => setAppInfoOpen((prev) => !prev)}
              className={`hidden whitespace-nowrap rounded-lg border px-2 py-1 text-xs transition sm:inline-flex sm:px-3 sm:text-sm ${
                appInfoOpen
                  ? "border-violet-500/80 bg-violet-500/15 text-violet-200"
                  : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-white"
              }`}
            >
              Info
            </button>
            <div ref={mobileHeaderMenuRef} className="relative sm:hidden">
              <button
                type="button"
                onClick={() => setMobileHeaderMenuOpen((prev) => !prev)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-gray-700 text-gray-300 transition hover:border-gray-600 hover:text-white"
                aria-label="Header menu"
              >
                ⋯
              </button>
              {mobileHeaderMenuOpen && (
                <div className="absolute right-0 top-full z-50 mt-1.5 w-36 rounded-lg border border-gray-700 bg-gray-900 p-1.5 shadow-xl shadow-black/40">
                  <button
                    type="button"
                    onClick={() => {
                      setStatsOpen((prev) => !prev);
                      setMobileHeaderMenuOpen(false);
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left text-xs text-gray-200 transition hover:bg-gray-800"
                  >
                    {statsOpen ? "Sluit stats" : "Open stats"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAppInfoOpen((prev) => !prev);
                      setMobileHeaderMenuOpen(false);
                    }}
                    className="mt-1 block w-full rounded px-2 py-1.5 text-left text-xs text-gray-200 transition hover:bg-gray-800"
                  >
                    {appInfoOpen ? "Sluit info" : "Open info"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setMobileHeaderMenuOpen(false);
                      await signOut();
                      router.push("/login");
                    }}
                    className="mt-1 block w-full rounded px-2 py-1.5 text-left text-xs text-red-200 transition hover:bg-red-900/30"
                  >
                    Uitloggen
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {shouldShowInstallBanner && (
          <div className="mt-2 rounded-lg border border-violet-500/40 bg-violet-950/35 px-3 py-2 text-xs text-violet-100">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 leading-relaxed">
                Installeer de app voor snellere start en stabielere playback. Wil je nu installeren?
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { void promptInstallApp(); }}
                  className="rounded-md border border-violet-300/60 bg-violet-500/30 px-2 py-1 text-[11px] font-semibold text-violet-100 transition hover:bg-violet-500/45"
                >
                  Installeer
                </button>
                <button
                  type="button"
                  onClick={dismissInstallBanner}
                  className="rounded-md border border-violet-300/30 px-2 py-1 text-[11px] text-violet-200 transition hover:bg-violet-500/20"
                >
                  Later
                </button>
              </div>
            </div>
          </div>
        )}
        {!(forceDjCommunityUi || (communityUiActive && !showRadioPanel)) && (
          <div className="mt-2 rounded-lg border border-gray-700/60 bg-gray-800/60 px-2.5 py-1 sm:px-3 sm:py-1.5">
            <p className="truncate text-[11px] text-gray-300 sm:text-xs">
              <span className="mr-1 uppercase tracking-wider text-gray-500">Volgende:</span>
              {!isHydrated || showLoadingStates ? (
                <span className="text-gray-500">Laden...</span>
              ) : !radioConnected ? (
                <span className="text-gray-500">Verbinden...</span>
              ) : displayHeaderNextTrack?.artist || (nextTitle || nextArtist) ? (
                <>
                  <span className="text-violet-400">{displayHeaderNextTrack?.artist || nextArtist}</span>
                  {(displayHeaderNextTrack?.title || nextTitle) && <span className="text-gray-500"> — </span>}
                  {(displayHeaderNextTrack?.title || nextTitle) && <span>{displayHeaderNextTrack?.title || nextTitle}</span>}
                  {(displayHeaderNextTrack?.isFallback || nextIsFallback) && (
                    <span className="ml-1 text-gray-500">(random)</span>
                  )}
                  {(displayHeaderNextTrack?.requestedBy || nextRequestedBy) && (
                    <span className="ml-1 text-gray-500">
                      · door <span className="text-violet-300">{displayHeaderNextTrack?.requestedBy || nextRequestedBy}</span>
                    </span>
                  )}
                </>
              ) : (
                <span className="text-gray-500">Nog geen track klaar...</span>
              )}
            </p>
          </div>
        )}
        {(mode !== "offline" && mode !== "radio" && !showRadioOfflineState) && (
          <div className={mode === "twitch" ? "block" : "hidden sm:block"}>
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

      <main className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5 sm:gap-4 sm:p-4 lg:flex-row">
        {/* Player */}
        <div className="min-h-0 shrink-0 max-h-[38dvh] overflow-hidden lg:min-w-0 lg:flex-1 lg:max-h-none lg:min-h-0 lg:overflow-visible">
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
          {mode === "radio" && radioStreamUrl && !rawRadioOfflineCandidate && !showTunnelRecoveryState && (
            <AudioPlayer
              src={radioStreamUrl}
              radioTrack={radioMode === "dj" ? null : radioTrack}
              showFallback={radioMode === "dj" || !radioTrack}
              preferSupabase={radioMode === "dj" || !radioTrack}
            />
          )}
          {mode === "radio" && showRadioOfflinePendingState && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-gray-800 bg-gray-900 px-4 py-4 shadow-lg shadow-violet-500/5 sm:py-16">
              <div className="hidden h-10 w-10 items-center justify-center rounded-full bg-gray-800 sm:flex">
                <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728M9.172 14.828a4 4 0 010-5.656m5.656 0a4 4 0 010 5.656M12 12h.01" />
                </svg>
              </div>
              <p className="text-sm text-gray-500">Control server verbinden...</p>
            </div>
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
        <div className="flex shrink-0 gap-1 rounded-lg bg-gray-800/60 p-1 lg:hidden">
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
          {showRequestedPanel && (
            <button
              onClick={() => setActiveTab("requested")}
              className={`relative flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                activeTab === "requested"
                  ? "bg-violet-600 text-white shadow-sm"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Aangevraagd{requestedItems.length > 0 ? ` (${requestedItems.length})` : ""}
            </button>
          )}
        </div>

        {/* Content panels */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 lg:min-w-0 lg:flex-[2] lg:flex-row lg:gap-4">
          <div className={`min-h-0 min-w-0 flex-1 ${activeTab === "chat" ? "" : "hidden"} lg:block`}>
            <ChatBox username={userAccount?.username} onNewMessage={() => { if (activeTabRef.current !== "chat") setChatBadge(true); }} />
          </div>
          {showRequests && (
            <div className={`min-h-0 min-w-0 flex-1 ${activeTab === "requests" ? "" : "hidden"} lg:block`}>
              <RequestForm
                username={userAccount?.username}
                onNewRequest={() => { if (activeTabRef.current !== "requests") setRequestBadge(true); }}
                onOwnRequestStatusUpdate={(update) => {
                  const trackLabel = [update.artist, update.title].filter(Boolean).join(" - ") || "je verzoekje";
                  if (update.status === "approved") {
                    showToast(`Verzoek geaccepteerd: ${trackLabel}`);
                  } else if (update.status === "rejected") {
                    showToast(`Verzoek afgewezen: ${trackLabel}`);
                  }
                }}
              />
            </div>
          )}
          {showRadioPanel && (
            <div className={`min-h-0 min-w-0 flex-1 overflow-hidden flex-col gap-2 ${activeTab === "radio" ? "flex" : "hidden"} lg:hidden`}>
              <RadioPanelErrorBoundary>
                <QueueAdd username={userAccount?.username} />
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
          {showRequestedPanel && (
            <div className={`min-h-0 min-w-0 flex-1 overflow-hidden flex-col gap-2 ${activeTab === "requested" ? "flex" : "hidden"} lg:hidden`}>
              <div className="chat-scroll min-h-0 flex-1 overflow-y-auto rounded-xl border border-gray-800 bg-gray-900 p-2">
                {requestedLoading && requestedItems.length === 0 ? (
                  <p className="text-xs text-gray-400">Verzoekjes laden...</p>
                ) : requestedItems.length === 0 ? (
                  <p className="text-xs text-gray-500">Nog geen verzoekjes in DJ modus.</p>
                ) : (
                  <div className="space-y-1.5">
                    {requestedItems.map((item) => (
                      <div
                        key={item.id}
                        className={`overflow-hidden rounded-lg border ${
                          item.status === "approved"
                            ? "border-green-500/20 bg-green-500/5"
                            : item.status === "downloaded"
                              ? "border-violet-500/20 bg-violet-500/5"
                              : "border-gray-800 bg-gray-800/50"
                        }`}
                      >
                        <div className="flex gap-2.5 p-2.5">
                          {item.thumbnail ? (
                            <img
                              src={item.thumbnail}
                              alt=""
                              className="h-12 w-12 shrink-0 rounded-md object-cover"
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-semibold text-violet-400">{item.nickname}</span>
                              <span className="shrink-0 rounded-full bg-gray-700/70 px-2 py-0.5 text-xs font-medium text-gray-200">
                                {item.status === "approved"
                                  ? "Goedgekeurd"
                                  : item.status === "downloaded"
                                    ? "Gedownload"
                                    : "Wachtrij"}
                              </span>
                            </div>
                            <p className="truncate text-sm font-medium text-white">{item.title || "Onbekende titel"}</p>
                            <p className="truncate text-xs text-gray-400">{item.artist || "Onbekende artiest"}</p>
                            {typeof item.duration === "number" && item.duration > 0 && (
                              <p className="truncate text-xs text-gray-500">
                                Lengte: {Math.floor(item.duration / 60)}:{String(item.duration % 60).padStart(2, "0")}
                              </p>
                            )}
                            {item.genre && (
                              <p className="truncate text-xs text-fuchsia-300">
                                Genre: {item.genre}
                                {item.genre_confidence === "artist_based" ? " (op artiest)" : ""}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
                        <QueueAdd username={userAccount?.username} />
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
        <div className={`pointer-events-none fixed left-1/2 top-3 -translate-x-1/2 sm:top-4 ${playerFullscreen ? "z-[220] w-[96%] max-w-2xl" : "z-[115] w-[92%] max-w-xl"}`}>
          <div className={`pointer-events-auto flex items-start justify-between gap-2 text-violet-100 ${
            playerFullscreen
              ? "rounded-xl border border-violet-700/80 bg-violet-950/88 px-4 py-3 text-sm shadow-2xl shadow-violet-900/35 backdrop-blur-md sm:px-5 sm:py-3.5 sm:text-base"
              : "rounded-lg border border-violet-800/70 bg-violet-950/80 px-4 py-2 text-sm shadow-lg shadow-violet-900/30 backdrop-blur-sm"
          }`}>
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
      {statsOpen && (
        <div className="fixed inset-0 z-[140] flex items-end justify-center bg-black/45 p-2 sm:items-center sm:p-4">
          <div className="flex h-[78dvh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl shadow-black/50 sm:h-[80vh]">
            <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
              <div>
                <p className="text-sm font-semibold text-white">Publieke statistieken</p>
                <p className="text-[11px] text-gray-400">Klik op rijen om te filteren</p>
              </div>
              <button
                type="button"
                onClick={() => setStatsOpen(false)}
                className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 transition hover:text-white"
              >
                Sluit
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 pb-8">
              {statsLoading && !statsSummary && (
                <p className="text-sm text-gray-400">Statistieken laden...</p>
              )}
              {statsError && (
                <p className="mb-2 text-xs text-red-300">{statsError}</p>
              )}
              {statsSummary && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[7, 30, 90, 180].map((days) => (
                      <button
                        key={days}
                        type="button"
                        onClick={() => setStatsDays(days as 7 | 30 | 90 | 180)}
                        className={`rounded border px-2 py-1 text-[11px] transition ${
                          statsDays === days
                            ? "border-violet-500/70 bg-violet-500/20 text-violet-100"
                            : "border-gray-700 text-gray-300 hover:border-gray-600 hover:text-white"
                        }`}
                      >
                        {days}d
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setStatsFilter({ kind: null, value: null });
                        void fetchPublicStats(statsDays);
                      }}
                      className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 transition hover:border-gray-600 hover:text-white"
                    >
                      Ververs
                    </button>
                    {statsFilter.kind && statsFilter.value && (
                      <button
                        type="button"
                        onClick={() => setStatsFilter({ kind: null, value: null })}
                        className="rounded border border-blue-700/70 bg-blue-900/25 px-2 py-1 text-[11px] text-blue-200 transition hover:bg-blue-900/40"
                      >
                        Filter: {statsFilter.kind} = {statsFilter.value} ×
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">Aanvragen</p>
                      <p className="text-lg font-semibold text-violet-200">{statsSummary.totals.requests}</p>
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">Unieke aanvragers</p>
                      <p className="text-lg font-semibold text-violet-200">{statsSummary.totals.uniqueRequesters}</p>
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">Unieke tracks</p>
                      <p className="text-lg font-semibold text-violet-200">{statsSummary.totals.uniqueTracks}</p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
                    <p className="mb-1 text-xs font-semibold text-gray-200">Datakwaliteit</p>
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-300 sm:grid-cols-3">
                      <p>Genres bekend: <span className="text-violet-200">{statsSummary.dataQuality.knownGenres}</span></p>
                      <p>Genres afgeleid: <span className="text-emerald-300">{statsSummary.dataQuality.inferredGenres}</span></p>
                      <p>Genres missen: <span className="text-amber-300">{statsSummary.dataQuality.missingGenres}</span></p>
                      <p>Bron bekend: <span className="text-violet-200">{statsSummary.dataQuality.knownSources}</span></p>
                      <p>Bron afgeleid: <span className="text-emerald-300">{statsSummary.dataQuality.inferredSources}</span></p>
                      <p>Bron mist: <span className="text-amber-300">{statsSummary.dataQuality.missingSources}</span></p>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
                      <p className="mb-1 text-xs font-semibold text-gray-200">Top aanvragers</p>
                      {statsSummary.topRequesters.slice(0, 8).map((row) => (
                        <button
                          key={`req-${row.name}`}
                          type="button"
                          onClick={() => applyStatsFilter("requester", row.name)}
                          className="block w-full rounded px-1 py-0.5 text-left text-[11px] text-gray-300 transition hover:bg-gray-800 hover:text-white"
                        >
                          {row.name}: {row.count}
                        </button>
                      ))}
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
                      <p className="mb-1 text-xs font-semibold text-gray-200">Top genres</p>
                      {statsSummary.topGenres.slice(0, 8).map((row) => (
                        <button
                          key={`genre-${row.name}`}
                          type="button"
                          onClick={() => applyStatsFilter("genre", row.name)}
                          className="block w-full rounded px-1 py-0.5 text-left text-[11px] text-gray-300 transition hover:bg-gray-800 hover:text-white"
                        >
                          {row.name}: {row.count}
                        </button>
                      ))}
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
                      <p className="mb-1 text-xs font-semibold text-gray-200">Top bronnen</p>
                      {statsSummary.topSources.slice(0, 8).map((row) => (
                        <button
                          key={`src-${row.name}`}
                          type="button"
                          onClick={() => applyStatsFilter("source", row.name)}
                          className="block w-full rounded px-1 py-0.5 text-left text-[11px] text-gray-300 transition hover:bg-gray-800 hover:text-white"
                        >
                          {row.name}: {row.count}
                        </button>
                      ))}
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
                      <p className="mb-1 text-xs font-semibold text-gray-200">Top artiesten</p>
                      {statsSummary.topArtists.slice(0, 8).map((row) => (
                        <button
                          key={`artist-${row.name}`}
                          type="button"
                          onClick={() => applyStatsFilter("artist", row.name)}
                          className="block w-full rounded px-1 py-0.5 text-left text-[11px] text-gray-300 transition hover:bg-gray-800 hover:text-white"
                        >
                          {row.name}: {row.count}
                        </button>
                      ))}
                    </div>
                    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2 sm:col-span-2 lg:col-span-1">
                      <p className="mb-1 text-xs font-semibold text-gray-200">Top playlists</p>
                      {statsSummary.topPlaylists.slice(0, 8).map((row) => (
                        <button
                          key={`playlist-${row.name}`}
                          type="button"
                          onClick={() => applyStatsFilter("playlist", row.name)}
                          className="block w-full rounded px-1 py-0.5 text-left text-[11px] text-gray-300 transition hover:bg-gray-800 hover:text-white"
                        >
                          {row.name}: {row.count}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-2">
                    <p className="mb-1 text-xs font-semibold text-gray-200">
                      Recente aanvragen {statsFilter.kind ? `(gefilterd: ${filteredRecentStats.length})` : ""}
                    </p>
                    {filteredRecentStats.length === 0 && (
                      <p className="text-[11px] text-gray-500">Geen resultaten voor deze filter.</p>
                    )}
                    {filteredRecentStats.map((row, idx) => (
                      <div key={`${row.ts}-${idx}`} className="rounded px-1 py-1 text-[11px] text-gray-300 hover:bg-gray-800/60">
                        <p>
                          {new Date(row.ts).toLocaleTimeString()} · {row.added_by} · {(row.artist ? `${row.artist} - ` : "")}{row.title ?? "Onbekend"}
                        </p>
                        <p className="mt-0.5 text-[10px] text-gray-500">
                          bron: {row.source_type ?? "unknown"} · genre: {row.source_genre ?? "Onbekend"} · playlist: {row.source_playlist ?? "n.v.t."}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {toastMessage && (
        <div className={`pointer-events-none fixed bottom-4 left-1/2 w-[92%] max-w-xl -translate-x-1/2 ${playerFullscreen ? "z-[220]" : "z-[120]"}`}>
          <div className={`border border-red-900/60 bg-red-950/85 text-center text-red-100 backdrop-blur-sm ${
            playerFullscreen
              ? "rounded-xl px-5 py-3 text-base shadow-2xl shadow-red-900/45"
              : "rounded-lg px-4 py-2 text-sm shadow-lg shadow-red-900/40"
          }`}>
            {toastMessage}
          </div>
        </div>
      )}
      {voteState && voteState.votes > 0 && !skipVoteToastHidden && (
        <div className={`pointer-events-none fixed bottom-20 left-1/2 w-[94%] max-w-xl -translate-x-1/2 sm:bottom-6 ${playerFullscreen ? "z-[220]" : "z-[125]"}`}>
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
      {appInfoOpen && (
        <div className="fixed inset-0 z-[160] flex items-end justify-center bg-black/70 px-2 py-2 sm:items-center sm:p-6">
          <div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-950 p-4 shadow-2xl shadow-black/50 sm:max-h-[min(85dvh,42rem)] sm:p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Hoe deze app werkt</h2>
                <p className="mt-1 text-xs text-gray-400">Korte uitleg van de radio, wachtrij en autoplay fallback.</p>
              </div>
              <button
                type="button"
                onClick={() => setAppInfoOpen(false)}
                className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 transition hover:border-gray-600 hover:text-white"
              >
                Sluiten
              </button>
            </div>
            <div className="min-h-0 space-y-2 overflow-y-auto pr-1 text-sm text-gray-200">
              <p><span className="font-semibold text-violet-300">1. Aanvragen:</span> in de add-track tabs kun je tracks zoeken of uit playlists toevoegen aan de wachtrij.</p>
              <p><span className="font-semibold text-violet-300">2. Wachtrij:</span> als de wachtrij niet leeg is, speelt de server die tracks af in volgorde.</p>
              <p><span className="font-semibold text-violet-300">3. Autoplay fallback:</span> als de wachtrij leeg is, gebruikt de app het gekozen fallback genre of de geselecteerde autoplay playlists.</p>
              <p><span className="font-semibold text-violet-300">4. Skip en stemmen:</span> afhankelijk van de modus kan admin skippen of kunnen luisteraars stemmen om te skippen.</p>
              <p><span className="font-semibold text-violet-300">5. Statistieken:</span> via Stats zie je top-aanvragers, genres, bronnen en recente verzoeken.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
