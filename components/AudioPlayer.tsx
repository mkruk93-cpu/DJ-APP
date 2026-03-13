"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";
import AudioVisualizer from "@/components/AudioVisualizer";
import SkipButton from "@/components/SkipButton";
import { parseTrackDisplay } from "@/lib/trackDisplay";
import { useSyncedTrack } from "@/lib/useSyncedTrack";
import { dislikeCurrentAutoTrack, likeCurrentAutoTrack } from "@/lib/radioApi";
import { getSocket } from "@/lib/socket";
import type { Track } from "@/lib/types";

declare global {
  interface Window {
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
    cast?: {
      framework?: {
        CastContext: {
          getInstance: () => {
            setOptions: (options: { receiverApplicationId: string; autoJoinPolicy: string }) => void;
            requestSession: () => Promise<void>;
            endCurrentSession: (stopCasting: boolean) => void;
            getCurrentSession: () => {
              loadMedia: (request: unknown) => Promise<void>;
            } | null;
            getCastState: () => string;
            addEventListener: (eventType: string, listener: (event: unknown) => void) => void;
            removeEventListener: (eventType: string, listener: (event: unknown) => void) => void;
          };
        };
        CastContextEventType: {
          CAST_STATE_CHANGED: string;
          SESSION_STATE_CHANGED: string;
        };
        CastState: {
          CONNECTED: string;
        };
      };
    };
    chrome?: {
      cast?: {
        isAvailable?: boolean;
        AutoJoinPolicy?: { ORIGIN_SCOPED: string };
        media?: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: string;
          MediaInfo: new (contentId: string, contentType: string) => {
            metadata?: unknown;
            streamType?: string;
          };
          MusicTrackMediaMetadata: new () => {
            title?: string;
            artist?: string;
            albumName?: string;
            images?: Array<{ url: string }>;
          };
          Image: new (url: string) => { url: string };
          LoadRequest: new (mediaInfo: unknown) => {
            autoplay?: boolean;
          };
          StreamType?: { LIVE: string };
        };
      };
    };
  }
}

interface NowPlayingData {
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
}

interface ChatPreviewMessage {
  id: string;
  nickname: string;
  content: string;
  created_at: string;
}

interface AudioPlayerProps {
  src: string;
  radioTrack?: Track | null;
  showFallback?: boolean;
  preferSupabase?: boolean;
}

const VOLUME_STORAGE_KEY_BASE = "djapp:player-volume";

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hueToRgb = (p: number, q: number, t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, h + 1 / 3);
  const g = hueToRgb(p, q, h);
  const b = hueToRgb(p, q, h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getYouTubeVideoId(url: string): string | null {
  const idMatch = url.match(/\/vi\/([^/?]+)/i);
  return idMatch?.[1] ?? null;
}

function getFullscreenArtworkUrl(url: string | null): string | null {
  if (!url) return null;
  // Prefer higher resolution YouTube thumbnails for fullscreen artwork.
  if (url.includes("img.youtube.com/vi/") || url.includes("i.ytimg.com/vi/")) {
    const videoId = getYouTubeVideoId(url);
    if (videoId) {
      return `https://i.ytimg.com/vi_webp/${videoId}/maxresdefault.webp`;
    }
    return url
      .replace(/\/mqdefault\.jpg(\?.*)?$/i, "/maxresdefault.jpg")
      .replace(/\/hqdefault\.jpg(\?.*)?$/i, "/maxresdefault.jpg")
      .replace(/\/sddefault\.jpg(\?.*)?$/i, "/maxresdefault.jpg");
  }
  return url;
}

function getFullscreenArtworkFallbackUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.includes("img.youtube.com/vi/") || url.includes("i.ytimg.com/vi/")) {
    const videoId = getYouTubeVideoId(url);
    if (videoId) {
      // hqdefault exists much more often than maxres and avoids YouTube placeholder logo.
      return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  }
  return url;
}

export default function AudioPlayer({ src, radioTrack, showFallback = false, preferSupabase = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const artSwapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const artSwapRafRef = useRef<number | null>(null);
  const tintAnimRafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [track, setTrack] = useState<NowPlayingData>({ title: null, artist: null, artwork_url: null });
  const [elapsed, setElapsed] = useState(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [currentArtwork, setCurrentArtwork] = useState<string | null>(null);
  const [incomingArtwork, setIncomingArtwork] = useState<string | null>(null);
  const [incomingArtworkVisible, setIncomingArtworkVisible] = useState(false);
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [likedTrackKey, setLikedTrackKey] = useState<string | null>(null);
  const [dislikedTrackKey, setDislikedTrackKey] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [manualFullscreen, setManualFullscreen] = useState(false);
  const [showFullscreenChat, setShowFullscreenChat] = useState(false);
  const [chatPreviewMessages, setChatPreviewMessages] = useState<ChatPreviewMessage[]>([]);
  const [castSupported, setCastSupported] = useState(false);
  const [castConnected, setCastConnected] = useState(false);
  const [castBusy, setCastBusy] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  const [remoteCastSupported, setRemoteCastSupported] = useState(false);
  const [remoteCastConnected, setRemoteCastConnected] = useState(false);
  const [mobileCastFallbackVisible, setMobileCastFallbackVisible] = useState(false);
  const userPaused = useRef(false);
  const playingRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingSinceRef = useRef(0);
  const lastReconnectAtRef = useRef(0);
  const nicknameRef = useRef<string>("anonymous");
  const connected = useRadioStore((s) => s.connected);
  const isFullscreen = nativeFullscreen || manualFullscreen;
  const buildFreshStreamUrl = useCallback((baseUrl: string): string => {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}live=${Date.now()}`;
  }, []);

  const loadToCastSession = useCallback(async () => {
    const castFramework = window.cast?.framework;
    const castMedia = window.chrome?.cast?.media;
    if (!castFramework || !castMedia || !src) return;
    const context = castFramework.CastContext.getInstance();
    const session = context.getCurrentSession();
    if (!session) return;
    const mediaInfo = new castMedia.MediaInfo(buildFreshStreamUrl(src), "audio/mpeg");
    if (castMedia.StreamType?.LIVE) mediaInfo.streamType = castMedia.StreamType.LIVE;
    const metadata = new castMedia.MusicTrackMediaMetadata();
    const castTitle = track.title ?? "KrukkeX Live";
    const castArtist = track.artist ?? "Live radio";
    const castArtwork = currentArtwork ?? track.artwork_url ?? null;
    metadata.title = castTitle;
    metadata.artist = castArtist;
    metadata.albumName = "KrukkeX Radio";
    if (castArtwork) {
      metadata.images = [new castMedia.Image(castArtwork)];
    }
    mediaInfo.metadata = metadata;
    const request = new castMedia.LoadRequest(mediaInfo);
    request.autoplay = true;
    await session.loadMedia(request);
  }, [buildFreshStreamUrl, currentArtwork, src, track.artist, track.artwork_url, track.title]);

  function getVolumeStorageKey(): string {
    if (typeof window === "undefined") return VOLUME_STORAGE_KEY_BASE;
    const nicknameRaw = localStorage.getItem("nickname") ?? "";
    const nickname = nicknameRaw.trim().toLowerCase();
    if (!nickname) return VOLUME_STORAGE_KEY_BASE;
    return `${VOLUME_STORAGE_KEY_BASE}:${nickname}`;
  }

  function loadStoredVolume(): number | null {
    if (typeof window === "undefined") return null;
    const primary = localStorage.getItem(getVolumeStorageKey());
    const fallback = localStorage.getItem(VOLUME_STORAGE_KEY_BASE);
    const raw = primary ?? fallback;
    if (raw === null) return null;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(1, parsed));
  }
  useEffect(() => {
    if (typeof window === "undefined") return;
    nicknameRef.current = (localStorage.getItem("nickname") ?? "anonymous").trim() || "anonymous";
    const storedVolume = loadStoredVolume();
    if (storedVolume !== null) {
      setVolume(storedVolume);
    }
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const remote = (audio as HTMLAudioElement & { remote?: RemotePlayback }).remote;
    if (!remote || typeof remote.prompt !== "function") return;
    setRemoteCastSupported(true);
    const onRemoteConnect = () => setRemoteCastConnected(true);
    const onRemoteDisconnect = () => setRemoteCastConnected(false);
    remote.addEventListener("connect", onRemoteConnect);
    remote.addEventListener("disconnect", onRemoteDisconnect);
    return () => {
      remote.removeEventListener("connect", onRemoteConnect);
      remote.removeEventListener("disconnect", onRemoteDisconnect);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    const ua = navigator.userAgent.toLowerCase();
    const mobileUa = /android|iphone|ipad|ipod/.test(ua);
    if (coarse || mobileUa) {
      setMobileCastFallbackVisible(true);
    }
  }, []);

  useEffect(() => {
    playingRef.current = playing;
    if (typeof window !== "undefined") {
      (window as Window & { __radioListeningState?: boolean }).__radioListeningState = playing;
      window.dispatchEvent(new CustomEvent("radio-listening-state", { detail: { listening: playing } }));
    }
    const socket = getSocket();
    if (socket && socket.connected) {
      socket.emit("listener:state", {
        nickname: nicknameRef.current,
        listening: playing,
      });
    }
  }, [playing, connected]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const win = window as Window & { __radioPlayerFullscreenState?: boolean };
    win.__radioPlayerFullscreenState = isFullscreen;
    window.dispatchEvent(new CustomEvent("radio-player-fullscreen-state", { detail: { fullscreen: isFullscreen } }));
    return () => {
      if (!isFullscreen) return;
      win.__radioPlayerFullscreenState = false;
      window.dispatchEvent(new CustomEvent("radio-player-fullscreen-state", { detail: { fullscreen: false } }));
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyOverscroll = body.style.overscrollBehavior;
    if (isFullscreen) {
      html.style.overflow = "hidden";
      body.style.overflow = "hidden";
      body.style.overscrollBehavior = "none";
    }
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      body.style.overscrollBehavior = prevBodyOverscroll;
    };
  }, [isFullscreen]);

  useEffect(() => {
    const socket = getSocket();
    function onSocketConnect() {
      socket.emit("listener:state", {
        nickname: nicknameRef.current,
        listening: playing,
      });
    }
    socket.on("connect", onSocketConnect);
    return () => {
      socket.off("connect", onSocketConnect);
      socket.emit("listener:state", {
        nickname: nicknameRef.current,
        listening: false,
      });
    };
  }, [playing]);

  const syncedRadioTrack = useSyncedTrack(radioTrack);
  const isJingleTrack = !!syncedRadioTrack && (
    syncedRadioTrack.youtube_id === "jingle"
    || (syncedRadioTrack.selection_key ?? "").toLowerCase().startsWith("jingle:")
  );
  const activeFallbackGenre = useRadioStore((s) => s.activeFallbackGenre);
  const fallbackGenres = useRadioStore((s) => s.fallbackGenres);
  const queue = useRadioStore((s) => s.queue);
  const upcomingTrack = useRadioStore((s) => s.upcomingTrack);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const value = String(Math.max(0, Math.min(1, volume)));
    localStorage.setItem(getVolumeStorageKey(), value);
    // Keep a generic fallback key for first-time nickname-less loads.
    localStorage.setItem(VOLUME_STORAGE_KEY_BASE, value);
  }, [volume]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  const clearWaitingTimer = useCallback(() => {
    if (waitingTimerRef.current) {
      clearTimeout(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }
  }, []);

  const attemptRecover = useCallback((baseDelayMs: number, options?: { forceReload?: boolean; minIntervalMs?: number }) => {
    if (!src || userPaused.current) return;
    const minIntervalMs = options?.minIntervalMs ?? 6500;
    const now = Date.now();
    if (now - lastReconnectAtRef.current < minIntervalMs) return;

    clearReconnectTimer();
    const forceReload = !!options?.forceReload;
    const delay = baseDelayMs + reconnectAttemptRef.current * 300;
    reconnectTimer.current = setTimeout(() => {
      const audio = audioRef.current;
      if (!audio || userPaused.current || !src) return;

      lastReconnectAtRef.current = Date.now();
      reconnectAttemptRef.current = Math.min(reconnectAttemptRef.current + 1, 8);
      if (forceReload) {
        audio.src = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now()}`;
      } else if (!audio.src) {
        audio.src = src;
      }

      audio.play()
        .then(() => {
          reconnectAttemptRef.current = 0;
          waitingSinceRef.current = 0;
          setAutoplayBlocked(false);
          setPlaying(true);
        })
        .catch(() => {
          setAutoplayBlocked(true);
        });
    }, delay);
  }, [clearReconnectTimer, src]);

  // Autoplay when stream source becomes available
  useEffect(() => {
    if (!src || userPaused.current || playing) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.src !== src) {
      audio.src = src;
    }
    audio.play()
      .then(() => {
        reconnectAttemptRef.current = 0;
        setPlaying(true);
        setAutoplayBlocked(false);
      })
      .catch(() => {
        setAutoplayBlocked(true);
      });
  }, [src, playing]);

  // After autoplay block: start on first user interaction anywhere
  useEffect(() => {
    if (!autoplayBlocked) return;

    function onInteraction() {
      if (userPaused.current) return;
      const audio = audioRef.current;
      if (!audio || !src) return;
      if (audio.src !== src) {
        audio.src = src;
      }
      audio.play()
        .then(() => {
          reconnectAttemptRef.current = 0;
          setPlaying(true);
          setAutoplayBlocked(false);
        })
        .catch(() => {});
    }

    document.addEventListener("click", onInteraction, { once: true });
    document.addEventListener("touchstart", onInteraction, { once: true });
    return () => {
      document.removeEventListener("click", onInteraction);
      document.removeEventListener("touchstart", onInteraction);
    };
  }, [autoplayBlocked, src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function markHealthyPlayback() {
      waitingSinceRef.current = 0;
      clearWaitingTimer();
      reconnectAttemptRef.current = 0;
      setAutoplayBlocked(false);
    }

    function onWaiting() {
      if (!playingRef.current || userPaused.current || !src) return;
      if (!waitingSinceRef.current) waitingSinceRef.current = Date.now();
      clearWaitingTimer();
      waitingTimerRef.current = setTimeout(() => {
        const current = audioRef.current;
        if (!current || !playingRef.current || userPaused.current || !src) return;
        const waitingForMs = Date.now() - waitingSinceRef.current;
        const stillNoData = current.readyState < 3 || current.networkState === HTMLMediaElement.NETWORK_LOADING;
        if (waitingForMs >= 4000 && stillNoData) {
          attemptRecover(1100, { forceReload: true, minIntervalMs: 7000 });
        }
      }, 4200);
    }

    function onCanPlay() {
      markHealthyPlayback();
    }

    function onPlaying() {
      markHealthyPlayback();
      setPlaying(true);
    }

    function onTimeUpdate() {
      markHealthyPlayback();
    }

    function onEnded() {
      if (!playingRef.current || userPaused.current) return;
      attemptRecover(500, { forceReload: true, minIntervalMs: 7000 });
    }

    function onVisibilityOrFocus() {
      if (document.visibilityState === "hidden") return;
      if (!src || userPaused.current || !playingRef.current) return;
      const current = audioRef.current;
      if (!current) return;
      if (current.paused) {
        current.play()
          .then(() => {
            reconnectAttemptRef.current = 0;
            setAutoplayBlocked(false);
            setPlaying(true);
          })
          .catch(() => setAutoplayBlocked(true));
      }
    }

    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    window.addEventListener("focus", onVisibilityOrFocus);
    window.addEventListener("pageshow", onVisibilityOrFocus);

    return () => {
      clearWaitingTimer();
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
      window.removeEventListener("focus", onVisibilityOrFocus);
      window.removeEventListener("pageshow", onVisibilityOrFocus);
    };
  }, [attemptRecover, clearWaitingTimer, src]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("pause", () => {
      const audio = audioRef.current;
      if (!audio) return;
      userPaused.current = true;
      clearReconnectTimer();
      clearWaitingTimer();
      audio.pause();
      setPlaying(false);
    });

    navigator.mediaSession.setActionHandler("play", () => {
      const audio = audioRef.current;
      if (!audio || !src) return;
      userPaused.current = false;
      audio.src = buildFreshStreamUrl(src);
      audio.play()
        .then(() => {
          reconnectAttemptRef.current = 0;
          waitingSinceRef.current = 0;
          setPlaying(true);
          setAutoplayBlocked(false);
        })
        .catch(() => setAutoplayBlocked(true));
    });

    return () => {
      try {
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("play", null);
      } catch {
        // Ignore Media Session cleanup failures on unsupported browsers.
      }
    };
  }, [buildFreshStreamUrl, clearReconnectTimer, clearWaitingTimer, src]);

  useEffect(() => {
    return () => {
      clearReconnectTimer();
      clearWaitingTimer();
    };
  }, [clearReconnectTimer, clearWaitingTimer]);

  useEffect(() => {
    function onFullscreenChange() {
      const host = playerRef.current;
      const active = !!host && document.fullscreenElement === host;
      setNativeFullscreen(active);
      if (active) setManualFullscreen(false);
    }

    function onManualEscape(event: KeyboardEvent) {
      if (!manualFullscreen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setManualFullscreen(false);
        unlockLandscapeOrientation();
      }
    }

    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("keydown", onManualEscape);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("keydown", onManualEscape);
    };
  }, [manualFullscreen]);

  useEffect(() => {
    return () => {
      unlockLandscapeOrientation();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const castFramework = window.cast?.framework;
    const castApi = window.chrome?.cast;
    const initCast = () => {
      const framework = window.cast?.framework;
      const chromeCast = window.chrome?.cast;
      if (!framework || !chromeCast?.media || !chromeCast?.AutoJoinPolicy) return;
      const context = framework.CastContext.getInstance();
      context.setOptions({
        receiverApplicationId: chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      setCastSupported(true);
      setCastConnected(context.getCastState() === framework.CastState.CONNECTED);
      const onCastStateChanged = () => {
        setCastConnected(context.getCastState() === framework.CastState.CONNECTED);
      };
      context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, onCastStateChanged);
      context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, onCastStateChanged);
      return () => {
        context.removeEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, onCastStateChanged);
        context.removeEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, onCastStateChanged);
      };
    };

    let cleanup: (() => void) | undefined;
    if (castFramework && castApi?.isAvailable) {
      cleanup = initCast();
      return () => {
        cleanup?.();
      };
    }

    window.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (!isAvailable) return;
      cleanup = initCast();
    };
    const existing = document.querySelector('script[src*="cast_sender.js?loadCastFramework=1"]');
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      script.async = true;
      document.head.appendChild(script);
    }

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen || !showFullscreenChat) return;
    const sb = getSupabase();
    let disposed = false;

    sb.from("chat_messages")
      .select("id, nickname, content, created_at")
      .order("created_at", { ascending: false })
      .limit(12)
      .then(({ data }) => {
        if (disposed || !data) return;
        setChatPreviewMessages((data as ChatPreviewMessage[]).reverse());
      });

    const channel = sb
      .channel("audio-player-chat-preview")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          const row = payload.new as ChatPreviewMessage;
          setChatPreviewMessages((prev) => {
            const next = [...prev, row];
            return next.length > 18 ? next.slice(next.length - 18) : next;
          });
        }
      )
      .subscribe();

    return () => {
      disposed = true;
      sb.removeChannel(channel);
    };
  }, [isFullscreen, showFullscreenChat]);

  useEffect(() => {
    const sb = getSupabase();

    sb.from("now_playing")
      .select("title, artist, artwork_url")
      .eq("id", 1)
      .single()
      .then(({ data }) => { if (data) setTrack(data); });

    const channel = sb
      .channel("audio-now-playing")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "now_playing", filter: "id=eq.1" },
        (payload) => {
          const { title, artist, artwork_url } = payload.new as NowPlayingData;
          setTrack({ title, artist, artwork_url });
        }
      )
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, []);

  useEffect(() => {
    if (!syncedRadioTrack?.started_at) { setElapsed(0); return; }

    function tick() {
      if (!syncedRadioTrack?.started_at) return;
      setElapsed(Math.max(0, Math.floor((Date.now() - syncedRadioTrack.started_at) / 1000)));
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [syncedRadioTrack]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      clearReconnectTimer();
      clearWaitingTimer();
      reconnectAttemptRef.current = 0;
      userPaused.current = true;
      audio.pause();
      setPlaying(false);
      setAutoplayBlocked(false);
    } else {
      if (!src) return;
      userPaused.current = false;
      audio.src = buildFreshStreamUrl(src);
      audio.play()
        .then(() => {
          reconnectAttemptRef.current = 0;
          waitingSinceRef.current = 0;
          setPlaying(true);
          setAutoplayBlocked(false);
        })
        .catch(() => {
          setPlaying(false);
          setAutoplayBlocked(true);
        });
    }
  }

  async function lockLandscapeOrientation(): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      const orientationApi = window.screen?.orientation as (ScreenOrientation & {
        lock?: (orientation: "portrait" | "landscape") => Promise<void>;
      }) | undefined;
      if (orientationApi?.lock) await orientationApi.lock("landscape");
    } catch {
      // Ignore lock failures on unsupported browsers.
    }
  }

  function unlockLandscapeOrientation(): void {
    if (typeof window === "undefined") return;
    try {
      const orientationApi = window.screen?.orientation as (ScreenOrientation & {
        unlock?: () => void;
      }) | undefined;
      orientationApi?.unlock?.();
    } catch {
      // Ignore unlock failures on unsupported browsers.
    }
  }

  async function enterFullscreen(): Promise<void> {
    const host = playerRef.current;
    if (!host) return;
    let enteredNative = false;
    if (typeof host.requestFullscreen === "function") {
      try {
        await host.requestFullscreen();
        enteredNative = true;
      } catch {
        enteredNative = false;
      }
    }
    if (!enteredNative) setManualFullscreen(true);
    await lockLandscapeOrientation();
  }

  async function exitFullscreen(): Promise<void> {
    setManualFullscreen(false);
    if (typeof document !== "undefined" && document.fullscreenElement && typeof document.exitFullscreen === "function") {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore.
      }
    }
    unlockLandscapeOrientation();
  }

  function toggleFullscreen() {
    if (isFullscreen) {
      void exitFullscreen();
      return;
    }
    void enterFullscreen();
  }

  const toggleCast = useCallback(async () => {
    if (typeof window === "undefined" || castBusy) return;
    if (!castSupported) {
      const audio = audioRef.current as (HTMLAudioElement & { remote?: RemotePlayback }) | null;
      if (!audio?.remote || typeof audio.remote.prompt !== "function") {
        setCastError("Gebruik op Android: Chrome menu (⋮) > Casten");
        return;
      }
      setCastBusy(true);
      setCastError(null);
      try {
        await audio.remote.prompt();
      } catch {
        setCastError("Open browser cast picker en kies je TV");
      } finally {
        setCastBusy(false);
      }
      return;
    }
    const castFramework = window.cast?.framework;
    if (!castFramework) return;
    setCastBusy(true);
    setCastError(null);
    try {
      const context = castFramework.CastContext.getInstance();
      if (castConnected) {
        context.endCurrentSession(true);
        setCastConnected(false);
      } else {
        await context.requestSession();
        await loadToCastSession();
        setCastConnected(true);
      }
    } catch {
      setCastError("Cast koppelen mislukt");
    } finally {
      setCastBusy(false);
    }
  }, [castBusy, castConnected, castSupported, loadToCastSession]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const available = castSupported || remoteCastSupported || mobileCastFallbackVisible;
    (window as Window & { __radioCastUiAvailable?: boolean }).__radioCastUiAvailable = available;
    return () => {
      (window as Window & { __radioCastUiAvailable?: boolean }).__radioCastUiAvailable = false;
    };
  }, [castSupported, mobileCastFallbackVisible, remoteCastSupported]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRequest = () => {
      void toggleCast();
    };
    window.addEventListener("radio-cast-toggle-request", onRequest);
    return () => {
      window.removeEventListener("radio-cast-toggle-request", onRequest);
    };
  }, [toggleCast]);

  const isRadioMode = !!syncedRadioTrack;
  const hasLiveRadioTrack = !!radioTrack;
  const isLoading = isRadioMode && syncedRadioTrack.started_at === 0;
  const radioHasMetadata = !!(syncedRadioTrack?.title || syncedRadioTrack?.thumbnail);
  const showSupabaseData = (((showFallback && (!connected || preferSupabase)) || !radioHasMetadata) && !hasLiveRadioTrack);
  const parsedRadio = parseTrackDisplay(syncedRadioTrack?.title);
  const radioTitle = isJingleTrack ? null : (parsedRadio.title ?? syncedRadioTrack?.title ?? null);
  const radioArtist = isJingleTrack ? null : parsedRadio.artist;
  const radioRequestedBy = isJingleTrack ? null : (syncedRadioTrack?.added_by ?? null);
  const radioIsRandom = syncedRadioTrack?.youtube_id === "local";
  const autoGenreIsLikedPlaylist = (activeFallbackGenre ?? "").toLowerCase() === "auto:liked";
  const selectionLabel = isJingleTrack ? null : (syncedRadioTrack?.selection_label ?? null);
  const selectionTab = isJingleTrack ? null : (syncedRadioTrack?.selection_tab ?? null);
  const selectionKey = isJingleTrack ? null : (syncedRadioTrack?.selection_key ?? null);
  const sharedSelectionLabel = selectionKey?.startsWith("shared:")
    ? (fallbackGenres.find((genre) => genre.id === selectionKey)?.label ?? null)
    : null;
  const selectionPlaylistLabel = syncedRadioTrack?.selection_playlist ?? sharedSelectionLabel ?? null;
  const displayTitle = syncedRadioTrack ? radioTitle : (showSupabaseData ? track.title : null);
  const displayArtist = syncedRadioTrack ? radioArtist : (showSupabaseData ? track.artist : null);
  const immediateRadioArtwork = radioTrack?.thumbnail ?? null;
  const displayArtwork = isJingleTrack ? null : (immediateRadioArtwork ?? syncedRadioTrack?.thumbnail ?? (showSupabaseData ? track.artwork_url : null));
  const artworkVersion = syncedRadioTrack
    ? `${syncedRadioTrack.id}|${syncedRadioTrack.started_at}|${immediateRadioArtwork ?? ""}|${syncedRadioTrack.thumbnail ?? ""}`
    : `${displayTitle ?? ""}|${displayArtist ?? ""}|${displayArtwork ?? ""}`;
  const displayArtworkSrc = useMemo(() => {
    if (!displayArtwork) return null;
    const separator = displayArtwork.includes("?") ? "&" : "?";
    return `${displayArtwork}${separator}v=${encodeURIComponent(artworkVersion)}`;
  }, [displayArtwork, artworkVersion]);
  const hasTrack = displayTitle || displayArtist;
  const currentLikeKey = `${syncedRadioTrack?.id ?? ""}|${displayTitle ?? ""}|${displayArtist ?? ""}`;
  const canLikeTrack = !!(isRadioMode && !isJingleTrack && (displayTitle || displayArtist));
  const canDislikeAutoTrack = !!(
    syncedRadioTrack
    && radioIsRandom
    && selectionTab === "online"
    && !autoGenreIsLikedPlaylist
    && (displayTitle || displayArtist)
  );
  const backgroundArtBaseOpacity = 0.15;
  const nextQueueItem = queue.find((item) => {
    const key = (item.selection_key ?? "").toLowerCase();
    return item.youtube_id !== "jingle" && !key.startsWith("jingle:");
  }) ?? null;
  const nextCandidateTitle = nextQueueItem?.title ?? upcomingTrack?.title ?? null;
  const parsedNext = parseTrackDisplay(nextCandidateTitle);
  const nextTitle = parsedNext.title ?? nextCandidateTitle;
  const nextArtist = parsedNext.artist;
  const fullscreenCurrentArtwork = useMemo(() => getFullscreenArtworkUrl(currentArtwork), [currentArtwork]);
  const fullscreenIncomingArtwork = useMemo(() => getFullscreenArtworkUrl(incomingArtwork), [incomingArtwork]);
  const fullscreenCurrentArtworkFallback = useMemo(
    () => getFullscreenArtworkFallbackUrl(currentArtwork),
    [currentArtwork],
  );
  const fullscreenIncomingArtworkFallback = useMemo(
    () => getFullscreenArtworkFallbackUrl(incomingArtwork),
    [incomingArtwork],
  );

  useEffect(() => {
    if (!feedbackMessage) return;
    const timer = setTimeout(() => setFeedbackMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [feedbackMessage]);

  useEffect(() => {
    if (!castError) return;
    const timer = setTimeout(() => setCastError(null), 2500);
    return () => clearTimeout(timer);
  }, [castError]);

  async function likeTrack() {
    if (!canLikeTrack || feedbackSaving) return;
    const artist = displayArtist ?? null;
    const title = displayTitle ?? null;
    if (!artist && !title) return;
    setFeedbackSaving(true);
    try {
      await likeCurrentAutoTrack(artist, title);
      setLikedTrackKey(currentLikeKey);
      setDislikedTrackKey(null);
      setFeedbackMessage("Nummer geliked");
    } catch {
      setFeedbackMessage("Like opslaan mislukt");
    } finally {
      setFeedbackSaving(false);
    }
  }

  async function dislikeTrack() {
    if (!canDislikeAutoTrack || feedbackSaving) return;
    const artist = displayArtist ?? null;
    const title = displayTitle ?? null;
    if (!artist && !title) return;
    setFeedbackSaving(true);
    try {
      await dislikeCurrentAutoTrack(artist, title);
      setDislikedTrackKey(currentLikeKey);
      setLikedTrackKey(null);
      setFeedbackMessage("Dislike opgeslagen voor dit genre");
    } catch {
      setFeedbackMessage("Dislike opslaan mislukt");
    } finally {
      setFeedbackSaving(false);
    }
  }

  useEffect(() => {
    const host = playerRef.current;
    if (!host) return;
    const hostEl: HTMLDivElement = host;

    function readVar(name: string, fallback: number): number {
      const v = Number(getComputedStyle(hostEl).getPropertyValue(name).trim());
      return Number.isFinite(v) ? v : fallback;
    }

    function setTint(r: number, g: number, b: number, vr: number, vg: number, vb: number) {
      hostEl.style.setProperty("--player-art-r", String(Math.round(r)));
      hostEl.style.setProperty("--player-art-g", String(Math.round(g)));
      hostEl.style.setProperty("--player-art-b", String(Math.round(b)));
      hostEl.style.setProperty("--player-art-vibrant-r", String(Math.round(vr)));
      hostEl.style.setProperty("--player-art-vibrant-g", String(Math.round(vg)));
      hostEl.style.setProperty("--player-art-vibrant-b", String(Math.round(vb)));
    }

    function animateTintTo(target: { r: number; g: number; b: number; vr: number; vg: number; vb: number }) {
      if (tintAnimRafRef.current) cancelAnimationFrame(tintAnimRafRef.current);
      const from = {
        r: readVar("--player-art-r", 139),
        g: readVar("--player-art-g", 92),
        b: readVar("--player-art-b", 246),
        vr: readVar("--player-art-vibrant-r", 196),
        vg: readVar("--player-art-vibrant-g", 181),
        vb: readVar("--player-art-vibrant-b", 253),
      };
      const start = performance.now();
      const duration = 700;
      const ease = (t: number) => 1 - Math.pow(1 - t, 3);
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const e = ease(t);
        setTint(
          from.r + (target.r - from.r) * e,
          from.g + (target.g - from.g) * e,
          from.b + (target.b - from.b) * e,
          from.vr + (target.vr - from.vr) * e,
          from.vg + (target.vg - from.vg) * e,
          from.vb + (target.vb - from.vb) * e,
        );
        if (t < 1) tintAnimRafRef.current = requestAnimationFrame(step);
      };
      tintAnimRafRef.current = requestAnimationFrame(step);
    }

    function setDefaultTint() {
      animateTintTo({ r: 139, g: 92, b: 246, vr: 196, vg: 181, vb: 253 });
    }

    if (!displayArtworkSrc) {
      setDefaultTint();
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        const size = 18;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setDefaultTint();
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const lum = (r + g + b) / 3;
          // Ignore grayscale + extreme dark/bright pixels to keep tint meaningful.
          if (sat < 0.18 || lum < 28 || lum > 230) continue;
          rSum += r;
          gSum += g;
          bSum += b;
          count += 1;
        }
        if (count === 0) {
          setDefaultTint();
          return;
        }
        const rr = Math.round(rSum / count);
        const gg = Math.round(gSum / count);
        const bb = Math.round(bSum / count);
        const [h, s, l] = rgbToHsl(rr, gg, bb);
        const vividS = Math.min(1, s * 1.35 + 0.08);
        const vividL = Math.max(0.44, Math.min(0.67, l * 1.07));
        const [vr, vg, vb] = hslToRgb(h, vividS, vividL);
        animateTintTo({ r: rr, g: gg, b: bb, vr, vg, vb });
      } catch {
        setDefaultTint();
      }
    };
    img.onerror = setDefaultTint;
    img.src = displayArtworkSrc;

    return () => {
      cancelled = true;
      if (tintAnimRafRef.current) {
        cancelAnimationFrame(tintAnimRafRef.current);
        tintAnimRafRef.current = null;
      }
    };
  }, [displayArtworkSrc]);

  useEffect(() => {
    if (artSwapTimerRef.current) {
      clearTimeout(artSwapTimerRef.current);
      artSwapTimerRef.current = null;
    }
    if (artSwapRafRef.current) {
      cancelAnimationFrame(artSwapRafRef.current);
      artSwapRafRef.current = null;
    }

    if (!displayArtworkSrc) {
      setCurrentArtwork(null);
      setIncomingArtwork(null);
      setIncomingArtworkVisible(false);
      return;
    }

    if (!currentArtwork) {
      setCurrentArtwork(displayArtworkSrc);
      setIncomingArtwork(null);
      setIncomingArtworkVisible(false);
      return;
    }

    if (displayArtworkSrc === currentArtwork || displayArtworkSrc === incomingArtwork) {
      return;
    }

    setIncomingArtwork(displayArtworkSrc);
    setIncomingArtworkVisible(false);
    artSwapRafRef.current = requestAnimationFrame(() => setIncomingArtworkVisible(true));
    artSwapTimerRef.current = setTimeout(() => {
      setCurrentArtwork(displayArtworkSrc);
      setIncomingArtwork(null);
      setIncomingArtworkVisible(false);
      artSwapTimerRef.current = null;
    }, 700);
  }, [displayArtworkSrc, currentArtwork, incomingArtwork]);

  useEffect(() => {
    return () => {
      if (artSwapTimerRef.current) clearTimeout(artSwapTimerRef.current);
      if (artSwapRafRef.current) cancelAnimationFrame(artSwapRafRef.current);
      if (tintAnimRafRef.current) cancelAnimationFrame(tintAnimRafRef.current);
    };
  }, []);

  const duration = isJingleTrack ? null : (syncedRadioTrack?.duration ?? null);
  const progress = duration && duration > 0 ? Math.min(elapsed / duration, 1) : 0;
  const durationLabel = duration && duration > 0 ? formatTime(duration) : "--:--";
  const showCastButton = true;

  const artworkFallback = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.55}
      className="h-5 w-5 text-violet-100 sm:h-9 sm:w-9"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10-4.5M9 9v10.5a3 3 0 1 1-3-3h3Zm10-4.5v10a3 3 0 1 1-3-3h3V4.5Z" />
    </svg>
  );

  return (
    <div
      ref={playerRef}
      className={`audio-player-shell w-full overflow-hidden bg-gray-900 shadow-lg shadow-violet-500/5 ${
        isFullscreen
          ? "fixed inset-0 z-[180] h-[100dvh] max-w-none rounded-none border-0"
          : "relative max-w-full rounded-xl border border-gray-800"
      }`}
    >
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-xl">
        <div className="player-kick-sweep absolute inset-0" />
        {playing && (
          <AudioVisualizer
            audioRef={audioRef}
            playing={playing}
            mode="waveBackdrop"
            barCount={33}
            className="absolute inset-0 h-full opacity-55"
          />
        )}
        <div className="player-bass-wash absolute inset-0" />
      </div>
      {(currentArtwork || incomingArtwork) && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 z-0 w-[62%] max-w-[260px] overflow-hidden sm:w-[48%] sm:max-w-[320px]">
            {currentArtwork && (
              <img
                src={currentArtwork}
                alt=""
                className={`absolute inset-0 h-full w-full scale-105 object-cover blur-2xl transition-opacity duration-700 ${incomingArtwork ? "opacity-0" : "opacity-100"}`}
                style={{
                  opacity: (incomingArtwork ? (incomingArtworkVisible ? 0 : 1) : 1) * backgroundArtBaseOpacity,
                  filter: "saturate(1.2)",
                  WebkitMaskImage:
                    "linear-gradient(to right, rgba(0,0,0,0.95), rgba(0,0,0,0.5) 72%, rgba(0,0,0,0))",
                  maskImage:
                    "linear-gradient(to right, rgba(0,0,0,0.95), rgba(0,0,0,0.5) 72%, rgba(0,0,0,0))",
                }}
              />
            )}
            {incomingArtwork && (
              <img
                src={incomingArtwork}
                alt=""
                className="absolute inset-0 h-full w-full scale-105 object-cover blur-2xl transition-opacity duration-700"
                style={{
                  opacity: (incomingArtworkVisible ? 1 : 0) * backgroundArtBaseOpacity,
                  filter: "saturate(1.2)",
                  WebkitMaskImage:
                    "linear-gradient(to right, rgba(0,0,0,0.95), rgba(0,0,0,0.5) 72%, rgba(0,0,0,0))",
                  maskImage:
                    "linear-gradient(to right, rgba(0,0,0,0.95), rgba(0,0,0,0.5) 72%, rgba(0,0,0,0))",
                }}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-gray-900/45 via-gray-900/28 to-transparent" />
          </div>
          <div
            className={`player-ambient pointer-events-none absolute inset-0 rounded-xl blur-2xl ${playing ? "opacity-100" : "opacity-60"}`}
            style={{
              background:
                "radial-gradient(70% 62% at 20% 60%, rgba(var(--player-art-r), var(--player-art-g), var(--player-art-b), 0.24), transparent 72%), radial-gradient(68% 58% at 80% 40%, rgba(168, 85, 247, 0.18), transparent 74%)",
            }}
          />
        </>
      )}
      {!isFullscreen && (
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute right-1.5 top-1.5 z-[12] hidden h-6 w-6 items-center justify-center rounded-full border border-gray-600/70 bg-black/45 text-[11px] text-white transition hover:border-violet-400/80 hover:bg-black/65 sm:right-2 sm:top-2 sm:flex sm:h-8 sm:w-8 sm:text-sm"
          aria-label="Fullscreen player"
        >
          ⛶
        </button>
      )}
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          if (playingRef.current && !userPaused.current && src) {
            attemptRecover(1300, { forceReload: true, minIntervalMs: 7000 });
          } else {
            setPlaying(false);
          }
        }}
        onStalled={() => {
          if (playingRef.current && !userPaused.current && src) {
            attemptRecover(1500, { forceReload: true, minIntervalMs: 7000 });
          }
        }}
      />

      {autoplayBlocked && !playing && (
        <button
          onClick={toggle}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm transition hover:bg-black/50"
        >
          <div className="flex items-center gap-2 rounded-full bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/30">
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Tik om te luisteren
          </div>
        </button>
      )}
      {castError && (
        <div className="absolute left-2 top-2 z-20 rounded-md border border-red-500/40 bg-red-900/40 px-2 py-1 text-[10px] text-red-100">
          {castError}
        </div>
      )}

      {isFullscreen && (
        <div className="relative z-[2] flex h-full w-full flex-col overflow-hidden p-2 pb-3 pt-[max(env(safe-area-inset-top),0.35rem)] sm:p-4">
          <div className="z-20 mb-2 flex items-center justify-between">
            <span className="rounded-full border border-violet-400/40 bg-black/30 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-violet-100">
              Live player
            </span>
            <div className="flex items-center gap-2">
              {showCastButton && (
                <button
                  type="button"
                  onClick={toggleCast}
                  disabled={castBusy}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    (castConnected || remoteCastConnected)
                      ? "border-emerald-400/70 bg-emerald-500/20 text-emerald-100"
                      : "border-gray-500/60 bg-black/35 text-white hover:border-emerald-400/70 hover:bg-black/50"
                  } disabled:opacity-60`}
                >
                  {(castConnected || remoteCastConnected) ? "TV verbonden" : castBusy ? "Cast..." : "Cast naar TV"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowFullscreenChat((prev) => !prev)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  showFullscreenChat
                    ? "border-violet-400/70 bg-violet-500/20 text-violet-100"
                    : "border-gray-500/60 bg-black/35 text-white hover:border-violet-400/70 hover:bg-black/50"
                }`}
              >
                {showFullscreenChat ? "Hide chat" : "Show chat"}
              </button>
              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-full border border-gray-500/60 bg-black/35 px-3 py-1.5 text-xs font-semibold text-white transition hover:border-violet-400/70 hover:bg-black/50"
              >
                Sluit fullscreen
              </button>
            </div>
          </div>

          <div className={`flex flex-1 items-center justify-center py-0.5 sm:py-2 ${showFullscreenChat ? "pb-44" : ""}`}>
            <div className="grid h-full w-full max-w-6xl grid-cols-1 items-center gap-2 landscape:grid-cols-[minmax(0,1fr)_minmax(220px,1fr)] landscape:gap-3 md:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)] md:gap-6">
              <div className="relative flex items-center justify-center">
                {(fullscreenCurrentArtwork || fullscreenIncomingArtwork) ? (
                  <div className={`player-cover-fullscreen player-cover-idle-drift relative overflow-hidden rounded-3xl ${
                    showFullscreenChat
                      ? "h-[54vw] w-[54vw] max-h-[52dvh] max-w-[52dvh] min-h-[170px] min-w-[170px] landscape:max-h-[45dvh] landscape:max-w-[45dvh]"
                      : "h-[60vw] w-[60vw] max-h-[58dvh] max-w-[58dvh] min-h-[190px] min-w-[190px] landscape:max-h-[52dvh] landscape:max-w-[52dvh]"
                  } md:h-[56vh] md:w-[56vh] md:max-h-[64vh] md:max-w-[64vh]`}>
                    <div className="absolute inset-0 rounded-3xl bg-black/20 shadow-2xl shadow-black/60" />
                    {fullscreenCurrentArtwork && (
                      <img
                        key={`fullscreen-current-${fullscreenCurrentArtwork}`}
                        src={fullscreenCurrentArtwork}
                        alt=""
                        className="absolute inset-0 z-10 h-full w-full rounded-3xl object-cover transition-opacity duration-700"
                        style={{ opacity: fullscreenIncomingArtwork ? (incomingArtworkVisible ? 0 : 1) : 1 }}
                        data-fallback-src={fullscreenCurrentArtworkFallback ?? ""}
                        onError={(event) => {
                          const fallbackSrc = event.currentTarget.dataset.fallbackSrc;
                          if (!fallbackSrc || event.currentTarget.dataset.fallbackApplied === "1") return;
                          event.currentTarget.dataset.fallbackApplied = "1";
                          event.currentTarget.src = fallbackSrc;
                        }}
                      />
                    )}
                    {fullscreenIncomingArtwork && (
                      <img
                        key={`fullscreen-incoming-${fullscreenIncomingArtwork}`}
                        src={fullscreenIncomingArtwork}
                        alt=""
                        className="absolute inset-0 z-20 h-full w-full rounded-3xl object-cover transition-opacity duration-700"
                        style={{ opacity: incomingArtworkVisible ? 1 : 0 }}
                        data-fallback-src={fullscreenIncomingArtworkFallback ?? ""}
                        onError={(event) => {
                          const fallbackSrc = event.currentTarget.dataset.fallbackSrc;
                          if (!fallbackSrc || event.currentTarget.dataset.fallbackApplied === "1") return;
                          event.currentTarget.dataset.fallbackApplied = "1";
                          event.currentTarget.src = fallbackSrc;
                        }}
                      />
                    )}
                  </div>
                ) : (
                  <div className={`player-fallback-note player-fallback-cover flex items-center justify-center rounded-3xl border border-violet-300/30 ${
                    showFullscreenChat
                      ? "h-[54vw] w-[54vw] max-h-[52dvh] max-w-[52dvh] min-h-[170px] min-w-[170px] landscape:max-h-[45dvh] landscape:max-w-[45dvh]"
                      : "h-[60vw] w-[60vw] max-h-[58dvh] max-w-[58dvh] min-h-[190px] min-w-[190px] landscape:max-h-[52dvh] landscape:max-w-[52dvh]"
                  } md:h-[56vh] md:w-[56vh] md:max-h-[64vh] md:max-w-[64vh]`}>
                    {artworkFallback}
                  </div>
                )}
              </div>

              <div className="w-full space-y-2">
                <div className="rounded-2xl border border-gray-700/70 bg-black/35 p-3 backdrop-blur-md md:p-5">
                  <p className="text-[10px] uppercase tracking-[0.24em] text-gray-300">Nu live</p>
                  <h2 className="mt-1.5 line-clamp-2 text-base font-bold leading-tight text-white landscape:text-sm md:text-3xl">
                    {displayTitle || "Wacht op nummer..."}
                  </h2>
                  <p className="mt-1.5 line-clamp-1 text-xs text-violet-200 landscape:text-xs md:text-lg">
                    {displayArtist || "Radio stream"}
                  </p>
                  {isRadioMode && (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] text-gray-300 md:text-sm">
                        <span>Voortgang</span>
                        <span>{formatTime(elapsed)} / {durationLabel}</span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700/80">
                        <div className="h-full rounded-full bg-violet-500 transition-all duration-1000 ease-linear" style={{ width: `${progress * 100}%` }} />
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      onClick={toggle}
                      className={`flex h-14 w-14 items-center justify-center rounded-full text-white transition ${
                        playing ? "bg-violet-600 hover:bg-violet-500" : "bg-gray-700 hover:bg-gray-600"
                      }`}
                    >
                      {playing ? "❚❚" : "▶"}
                    </button>
                    <div className="shrink-0">
                      <SkipButton compact />
                    </div>
                    <div className="hidden min-w-0 flex-1 items-center gap-2 sm:flex">
                      <span className="text-[11px] text-gray-400">Volume</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={volume}
                        onChange={(e) => setVolume(Number(e.target.value))}
                        className="violet-slider h-1 w-full max-w-32 cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
                      />
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-gray-700/70 bg-black/25 p-3 backdrop-blur-md md:p-4">
                  <p className="text-[10px] uppercase tracking-[0.24em] text-gray-300">Volgend nummer</p>
                  <p className="mt-1.5 line-clamp-1 text-sm font-semibold text-violet-100 md:text-base">
                    {nextTitle || "Nog niet bekend"}
                  </p>
                  <p className="mt-1 line-clamp-1 text-xs text-gray-300 md:text-sm">
                    {nextArtist || "Artiest onbekend"}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {showFullscreenChat && (
            <div className="absolute inset-x-2 bottom-[max(env(safe-area-inset-bottom),0.5rem)] z-30 mx-auto w-auto max-w-3xl rounded-2xl border border-violet-500/25 bg-black/55 p-3 backdrop-blur-md md:inset-x-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-violet-200/90">Live chat</p>
              <div className="chat-scroll max-h-36 space-y-1 overflow-y-auto pr-1 sm:max-h-44">
                {chatPreviewMessages.length === 0 ? (
                  <p className="text-xs text-gray-400">Nog geen chatberichten.</p>
                ) : (
                  chatPreviewMessages.map((m) => (
                    <p key={m.id} className="text-xs leading-relaxed text-gray-200 sm:text-sm">
                      <span className="font-semibold text-violet-300">{m.nickname}</span>
                      <span className="mx-1 text-gray-500">·</span>
                      <span>{m.content}</span>
                    </p>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Mobile: compact horizontal layout */}
      {!isFullscreen && <div className="relative z-[1] flex flex-col landscape:hidden sm:hidden">
        <div className="flex items-center gap-2 p-2">
          <div className="relative shrink-0" style={{ perspective: "900px" }}>
            {playing && <div className="player-cover-glow absolute -inset-1 rounded-xl bg-violet-500/30 blur-md" />}
            {(currentArtwork || incomingArtwork) ? (
              <div className={`player-cover-3d-shell player-cover-3d-shell--sm relative h-12 w-12 ${playing ? "player-cover-art" : "player-cover-idle-drift"}`}>
                <div className={`player-cover-3d-card absolute inset-0 rounded-lg ${playing ? "player-cover-spin-cycle" : ""}`}>
                  {currentArtwork && (
                    <img
                      src={currentArtwork}
                      alt=""
                      className="player-cover-face absolute inset-0 z-10 h-12 w-12 rounded-lg object-cover transition-opacity duration-700"
                      style={{ opacity: incomingArtwork ? (incomingArtworkVisible ? 0 : 1) : 1 }}
                    />
                  )}
                  {currentArtwork && (
                    <img
                      src={currentArtwork}
                      alt=""
                      className="player-cover-face player-cover-face--back absolute inset-0 z-[5] h-12 w-12 rounded-lg object-cover transition-opacity duration-700"
                      style={{ opacity: incomingArtwork ? (incomingArtworkVisible ? 0 : 1) : 1 }}
                    />
                  )}
                  {incomingArtwork && (
                    <img
                      src={incomingArtwork}
                      alt=""
                      className="player-cover-face absolute inset-0 z-10 h-12 w-12 rounded-lg object-cover transition-opacity duration-700"
                      style={{ opacity: incomingArtworkVisible ? 1 : 0 }}
                    />
                  )}
                  {incomingArtwork && (
                    <img
                      src={incomingArtwork}
                      alt=""
                      className="player-cover-face player-cover-face--back absolute inset-0 z-[5] h-12 w-12 rounded-lg object-cover transition-opacity duration-700"
                      style={{ opacity: incomingArtworkVisible ? 1 : 0 }}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="player-fallback-note player-fallback-cover relative z-10 flex h-12 w-12 items-center justify-center rounded-lg border border-violet-300/25">
                <span className="player-fallback-shine absolute inset-0 rounded-lg" />
                <span className="player-fallback-grid absolute inset-0 rounded-lg" />
                <span className="player-fallback-orb player-fallback-orb--a absolute rounded-full" />
                <span className="player-fallback-orb player-fallback-orb--b absolute rounded-full" />
                <span className="relative z-10">{artworkFallback}</span>
              </div>
            )}
            {playing && (
              <div
                className="player-cover-ring player-cover-ring--inner absolute -inset-1 rounded-xl border"
                style={{
                  borderColor: "rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.52)",
                  boxShadow:
                    "0 0 0 1px rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.22) inset, 0 0 10px rgba(var(--player-art-r), var(--player-art-g), var(--player-art-b), 0.14)",
                }}
              />
            )}
            {playing && (
              <div
                className="player-cover-ring player-cover-ring--outer absolute -inset-[6px] rounded-[0.85rem] border"
                style={{
                  borderColor: "rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.42)",
                  boxShadow:
                    "0 0 0 1px rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.16) inset, 0 0 12px rgba(var(--player-art-r), var(--player-art-g), var(--player-art-b), 0.12)",
                }}
              />
            )}
          </div>

          <div className="min-w-0 flex-1">
            {hasTrack ? (
              <>
                {displayTitle && <p className="truncate text-sm font-semibold text-white">{displayTitle}</p>}
                {displayArtist && <p className="truncate text-xs text-violet-400">{displayArtist}</p>}
                {isRadioMode && (radioRequestedBy || syncedRadioTrack) && (
                  <p className="truncate text-[10px] text-gray-500">
                    {selectionLabel ? (
                      <>
                        Keuze: <span className="text-gray-300">{selectionLabel}</span>
                        {selectionPlaylistLabel ? (
                          <>
                            {" "}
                            · playlist <span className="text-violet-300">{selectionPlaylistLabel.replace(/^Playlist ·\s*/i, "")}</span>
                          </>
                        ) : null}
                      </>
                    ) : radioIsRandom ? (
                      <>Keuze: <span className="text-gray-300">Random selectie</span></>
                    ) : (
                      <>Keuze: <span className="text-gray-300">Wachtrij</span></>
                    )}
                    {radioRequestedBy ? (
                      <>
                        {" "}· door <span className="text-violet-300">{radioRequestedBy}</span>
                      </>
                    ) : null}
                  </p>
                )}
                {canLikeTrack && (
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={likeTrack}
                      disabled={feedbackSaving}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${
                        likedTrackKey === currentLikeKey
                          ? "bg-pink-500/20 text-pink-200"
                          : "bg-gray-800 text-pink-300 hover:bg-gray-700"
                      } disabled:opacity-70`}
                    >
                      {likedTrackKey === currentLikeKey ? "♥ Geliked" : feedbackSaving ? "Opslaan..." : "♡ Like"}
                    </button>
                    {canDislikeAutoTrack && (
                      <button
                        type="button"
                        onClick={dislikeTrack}
                        disabled={feedbackSaving}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${
                          dislikedTrackKey === currentLikeKey
                            ? "bg-red-500/20 text-red-200"
                            : "bg-gray-800 text-red-300 hover:bg-gray-700"
                        } disabled:opacity-70`}
                      >
                        {dislikedTrackKey === currentLikeKey ? "✕ Disliked" : feedbackSaving ? "Opslaan..." : "🚫 Dislike"}
                      </button>
                    )}
                    {feedbackMessage && (
                      <span className="truncate text-[10px] text-pink-200/90">{feedbackMessage}</span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm font-medium text-gray-400">
                {isRadioMode ? "Wacht op nummer..." : "Audio Stream"}
              </p>
            )}
            {isLoading ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="h-2 w-2 animate-spin rounded-full border border-violet-400 border-t-transparent" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400">Laden...</span>
              </div>
            ) : isRadioMode ? (
              <p className="mt-0.5 text-[10px] tabular-nums text-gray-500">
                {formatTime(elapsed)} / {durationLabel}
              </p>
            ) : (
              <div className="mt-1 flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-400">Live</span>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {showCastButton && (
              <button
                type="button"
                onClick={toggleCast}
                disabled={castBusy}
                className={`flex h-7 min-w-[44px] items-center justify-center rounded-full border px-2 text-[10px] font-semibold transition ${
                  (castConnected || remoteCastConnected)
                    ? "border-emerald-400/80 bg-emerald-500/20 text-emerald-100"
                    : "border-gray-600/70 bg-black/40 text-white hover:border-emerald-400/80 hover:bg-black/60"
                } disabled:opacity-60`}
                aria-label="Cast naar tv"
              >
                {castBusy ? "..." : (castConnected || remoteCastConnected) ? "TV" : "Cast"}
              </button>
            )}
            <button
              type="button"
              onClick={toggleFullscreen}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-600/70 bg-black/40 text-[10px] text-white transition hover:border-violet-400/80 hover:bg-black/60"
              aria-label="Fullscreen player"
            >
              ⛶
            </button>
            <button
              onClick={toggle}
              className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
                playing
                  ? "bg-violet-600 shadow-md shadow-violet-500/30 hover:bg-violet-500"
                  : "bg-gray-700 hover:bg-gray-600"
              }`}
            >
              {playing ? (
                <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg className="ml-0.5 h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {isRadioMode && duration && duration > 0 && (
          <div className="px-2 pb-1.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700">
              <div
                className="h-full rounded-full bg-violet-500 transition-all duration-1000 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>
        )}

        {playing && (
          <div className="px-2 pb-1.5">
            <AudioVisualizer audioRef={audioRef} hostRef={playerRef} playing={playing} barCount={24} className="h-8" />
          </div>
        )}
      </div>}

      {/* Desktop: compact horizontal layout */}
      {!isFullscreen && <div className="relative z-[1] hidden items-center gap-4 px-4 py-4 landscape:flex sm:flex">
        <div className="relative -ml-2 shrink-0 overflow-visible" style={{ perspective: "1100px" }}>
          {playing && <div className="player-cover-glow absolute -inset-2 rounded-2xl bg-violet-500/30 blur-xl" />}
          {(currentArtwork || incomingArtwork) ? (
            <div className={`player-cover-3d-shell player-cover-3d-shell--lg relative h-24 w-24 ${playing ? "player-cover-art" : "player-cover-idle-drift"} ${
              playing ? "shadow-lg shadow-violet-500/20" : "shadow-lg shadow-black/30"
            }`}>
              <div className={`player-cover-3d-card absolute inset-0 rounded-xl ${playing ? "player-cover-spin-cycle" : ""}`}>
                {currentArtwork && (
                  <img
                    src={currentArtwork}
                    alt=""
                    className="player-cover-face absolute inset-0 z-10 h-24 w-24 rounded-xl object-cover transition-opacity duration-700"
                    style={{ opacity: incomingArtwork ? (incomingArtworkVisible ? 0 : 1) : 1 }}
                  />
                )}
                {currentArtwork && (
                  <img
                    src={currentArtwork}
                    alt=""
                    className="player-cover-face player-cover-face--back absolute inset-0 z-[5] h-24 w-24 rounded-xl object-cover transition-opacity duration-700"
                    style={{ opacity: incomingArtwork ? (incomingArtworkVisible ? 0 : 1) : 1 }}
                  />
                )}
                {incomingArtwork && (
                  <img
                    src={incomingArtwork}
                    alt=""
                    className="player-cover-face absolute inset-0 z-10 h-24 w-24 rounded-xl object-cover transition-opacity duration-700"
                    style={{ opacity: incomingArtworkVisible ? 1 : 0 }}
                  />
                )}
                {incomingArtwork && (
                  <img
                    src={incomingArtwork}
                    alt=""
                    className="player-cover-face player-cover-face--back absolute inset-0 z-[5] h-24 w-24 rounded-xl object-cover transition-opacity duration-700"
                    style={{ opacity: incomingArtworkVisible ? 1 : 0 }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className={`player-fallback-note player-fallback-cover relative z-10 flex h-24 w-24 items-center justify-center rounded-xl border border-violet-300/30 ${
              playing ? "shadow-lg shadow-violet-500/20" : ""
            }`}>
              <span className="player-fallback-shine absolute inset-0 rounded-xl" />
              <span className="player-fallback-grid absolute inset-0 rounded-xl" />
              <span className="player-fallback-orb player-fallback-orb--a absolute rounded-full" />
              <span className="player-fallback-orb player-fallback-orb--b absolute rounded-full" />
              <span className="relative z-10">{artworkFallback}</span>
            </div>
          )}
          {playing && (
            <div
              className="player-cover-ring player-cover-ring--inner absolute -inset-2 z-20 rounded-[1.05rem] border-2"
              style={{
                borderColor: "rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.54)",
                boxShadow:
                  "0 0 0 1px rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.24) inset, 0 0 14px rgba(var(--player-art-r), var(--player-art-g), var(--player-art-b), 0.16)",
              }}
            />
          )}
          {playing && (
            <div
              className="player-cover-ring player-cover-ring--outer absolute -inset-4 z-20 rounded-[1.3rem] border"
              style={{
                borderColor: "rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.44)",
                boxShadow:
                  "0 0 0 1px rgba(var(--player-art-vibrant-r), var(--player-art-vibrant-g), var(--player-art-vibrant-b), 0.18) inset, 0 0 16px rgba(var(--player-art-r), var(--player-art-g), var(--player-art-b), 0.14)",
              }}
            />
          )}
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-t from-black/30 to-transparent" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {hasTrack && (
            <div className="min-w-0">
              {displayTitle && <p className="truncate text-sm font-semibold text-white">{displayTitle}</p>}
              {displayArtist && <p className="truncate text-xs text-violet-400">{displayArtist}</p>}
              {isRadioMode && (radioRequestedBy || syncedRadioTrack) && (
                <p className="truncate text-[11px] text-gray-500">
                  {selectionLabel ? (
                    <>
                      Keuze: <span className="text-gray-300">{selectionLabel}</span>
                      {selectionPlaylistLabel ? (
                        <>
                          {" "}
                          · playlist <span className="text-violet-300">{selectionPlaylistLabel.replace(/^Playlist ·\s*/i, "")}</span>
                        </>
                      ) : null}
                    </>
                  ) : radioIsRandom ? (
                    <>Keuze: <span className="text-gray-300">Random selectie</span></>
                  ) : (
                    <>Keuze: <span className="text-gray-300">Wachtrij</span></>
                  )}
                  {radioRequestedBy ? (
                    <>
                      {" "}· door <span className="text-violet-300">{radioRequestedBy}</span>
                    </>
                  ) : null}
                </p>
              )}
              {canLikeTrack && (
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={likeTrack}
                    disabled={feedbackSaving}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition ${
                      likedTrackKey === currentLikeKey
                        ? "bg-pink-500/20 text-pink-200"
                        : "bg-gray-800 text-pink-300 hover:bg-gray-700"
                    } disabled:opacity-70`}
                  >
                    {likedTrackKey === currentLikeKey ? "♥ Geliked" : feedbackSaving ? "Opslaan..." : "♡ Like dit nummer"}
                  </button>
                  {canDislikeAutoTrack && (
                    <button
                      type="button"
                      onClick={dislikeTrack}
                      disabled={feedbackSaving}
                      className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition ${
                        dislikedTrackKey === currentLikeKey
                          ? "bg-red-500/20 text-red-200"
                          : "bg-gray-800 text-red-300 hover:bg-gray-700"
                      } disabled:opacity-70`}
                    >
                      {dislikedTrackKey === currentLikeKey ? "✕ Disliked" : feedbackSaving ? "Opslaan..." : "🚫 Dislike"}
                    </button>
                  )}
                  {feedbackMessage && <span className="text-[11px] text-pink-200/90">{feedbackMessage}</span>}
                </div>
              )}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
              <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">Downloaden...</span>
            </div>
          ) : isRadioMode ? (
            <div className="flex w-full flex-col gap-1">
              {duration && duration > 0 && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700">
                  <div
                    className="h-full rounded-full bg-violet-500 transition-all duration-1000 ease-linear"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-[10px] tabular-nums text-gray-500">{formatTime(elapsed)}</span>
                <span className="text-[10px] tabular-nums text-gray-500">{durationLabel}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
              </span>
              <span className="text-xs font-semibold uppercase tracking-wider text-violet-400">Live</span>
            </div>
          )}

          <div className="flex items-center gap-3">
            {showCastButton && (
              <button
                type="button"
                onClick={toggleCast}
                disabled={castBusy}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                  (castConnected || remoteCastConnected)
                    ? "border-emerald-400/70 bg-emerald-500/20 text-emerald-100"
                    : "border-gray-600/70 bg-black/40 text-white hover:border-emerald-400/70 hover:bg-black/60"
                } disabled:opacity-60`}
              >
                {castBusy ? "Cast..." : (castConnected || remoteCastConnected) ? "TV verbonden" : "Cast"}
              </button>
            )}
            <button
              onClick={toggle}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all ${
                playing
                  ? "bg-violet-600 shadow-md shadow-violet-500/30 hover:bg-violet-500"
                  : "bg-gray-700 hover:bg-gray-600"
              }`}
            >
              {playing ? (
                <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg className="ml-0.5 h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <div className="flex flex-1 items-center gap-2">
              <svg className="h-3 w-3 shrink-0 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 9v6h4l5 5V4L7 9H3z" />
              </svg>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="violet-slider h-0.5 w-full max-w-20 cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
              />
              <svg className="h-3 w-3 shrink-0 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            </div>
          </div>

          {playing && (
            <AudioVisualizer audioRef={audioRef} hostRef={playerRef} playing={playing} barCount={48} className="h-10" />
          )}
        </div>
      </div>}
    </div>
  );
}
