"use client";

import { useState, useRef, useEffect } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";
import AudioVisualizer from "@/components/AudioVisualizer";
import { parseTrackDisplay } from "@/lib/trackDisplay";
import { useSyncedTrack } from "@/lib/useSyncedTrack";
import { dislikeCurrentAutoTrack, likeCurrentAutoTrack } from "@/lib/radioApi";
import { getSocket } from "@/lib/socket";
import type { Track } from "@/lib/types";

interface NowPlayingData {
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
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
  const userPaused = useRef(false);
  const playingRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const stallWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastProgressTimeRef = useRef(0);
  const lastProgressStampRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nicknameRef = useRef<string>("anonymous");
  const connected = useRadioStore((s) => s.connected);

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
    function clearReconnectTimer() {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    }

    function scheduleReconnect(delayMs: number) {
      if (!src || userPaused.current) return;
      clearReconnectTimer();
      reconnectTimer.current = setTimeout(() => {
        const audio = audioRef.current;
        if (!audio || userPaused.current || !src) return;

        const attempt = Math.min(reconnectAttemptRef.current + 1, 8);
        reconnectAttemptRef.current = attempt;
        const cacheBust = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now()}`;
        if (audio.src !== cacheBust) {
          audio.src = cacheBust;
        }
        audio.play()
          .then(() => {
            reconnectAttemptRef.current = 0;
            setAutoplayBlocked(false);
            setPlaying(true);
          })
          .catch(() => {
            setAutoplayBlocked(true);
          });
      }, delayMs);
    }

    const audio = audioRef.current;
    if (!audio) return;
    if (!playing || userPaused.current || !src) {
      if (stallWatchdogRef.current) {
        clearInterval(stallWatchdogRef.current);
        stallWatchdogRef.current = null;
      }
      return;
    }

    lastProgressTimeRef.current = audio.currentTime;
    lastProgressStampRef.current = Date.now();
    if (stallWatchdogRef.current) clearInterval(stallWatchdogRef.current);
    stallWatchdogRef.current = setInterval(() => {
      const currentAudio = audioRef.current;
      if (!currentAudio || userPaused.current || !src) return;

      const now = Date.now();
      const progress = currentAudio.currentTime;
      if (progress > lastProgressTimeRef.current + 0.2) {
        lastProgressTimeRef.current = progress;
        lastProgressStampRef.current = now;
        return;
      }

      const silentForMs = now - lastProgressStampRef.current;
      const noDataLikely = currentAudio.readyState < 2 || currentAudio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
      if (silentForMs >= 15000 || noDataLikely) {
        scheduleReconnect(1200);
      }
    }, 5000);

    return () => {
      if (stallWatchdogRef.current) {
        clearInterval(stallWatchdogRef.current);
        stallWatchdogRef.current = null;
      }
    };
  }, [playing, src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function clearReconnectTimer() {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    }

    function scheduleReconnect(delayMs: number) {
      if (!src || userPaused.current) return;
      clearReconnectTimer();
      reconnectTimer.current = setTimeout(() => {
        const current = audioRef.current;
        if (!current || userPaused.current || !src) return;
        const attempt = Math.min(reconnectAttemptRef.current + 1, 8);
        reconnectAttemptRef.current = attempt;
        const cacheBust = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now()}`;
        if (current.src !== cacheBust) current.src = cacheBust;
        current.play()
          .then(() => {
            reconnectAttemptRef.current = 0;
            setPlaying(true);
            setAutoplayBlocked(false);
          })
          .catch(() => setAutoplayBlocked(true));
      }, delayMs);
    }

    function recoverIfNeeded(baseDelayMs: number) {
      if (!playingRef.current || userPaused.current || !src) return;
      scheduleReconnect(baseDelayMs + reconnectAttemptRef.current * 350);
    }

    function onWaiting() {
      recoverIfNeeded(900);
    }

    function onSuspend() {
      recoverIfNeeded(1300);
    }

    function onEnded() {
      recoverIfNeeded(500);
    }

    function onVisibilityOrFocus() {
      if (document.visibilityState === "hidden") return;
      if (!src || userPaused.current) return;
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
    audio.addEventListener("suspend", onSuspend);
    audio.addEventListener("ended", onEnded);
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    window.addEventListener("focus", onVisibilityOrFocus);

    return () => {
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("suspend", onSuspend);
      audio.removeEventListener("ended", onEnded);
      document.removeEventListener("visibilitychange", onVisibilityOrFocus);
      window.removeEventListener("focus", onVisibilityOrFocus);
    };
  }, [src]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("pause", () => {
      const audio = audioRef.current;
      if (!audio) return;
      userPaused.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      audio.pause();
      setPlaying(false);
    });

    navigator.mediaSession.setActionHandler("play", () => {
      const audio = audioRef.current;
      if (!audio || !src) return;
      userPaused.current = false;
      if (audio.src !== src) {
        audio.src = src;
      }
      audio.play()
        .then(() => {
          reconnectAttemptRef.current = 0;
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
  }, [src]);

  useEffect(() => {
    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (stallWatchdogRef.current) {
        clearInterval(stallWatchdogRef.current);
        stallWatchdogRef.current = null;
      }
    };
  }, []);

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
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectAttemptRef.current = 0;
      userPaused.current = true;
      audio.pause();
      audio.src = "";
      setPlaying(false);
      setAutoplayBlocked(false);
    } else {
      userPaused.current = false;
      audio.src = src;
      audio.play()
        .then(() => {
          reconnectAttemptRef.current = 0;
          setPlaying(true);
          setAutoplayBlocked(false);
        })
        .catch(() => {
          setPlaying(false);
          setAutoplayBlocked(true);
        });
    }
  }

  const isRadioMode = !!syncedRadioTrack;
  const isLoading = isRadioMode && syncedRadioTrack.started_at === 0;
  const radioHasMetadata = !!(syncedRadioTrack?.title || syncedRadioTrack?.thumbnail);
  const showSupabaseData = (showFallback && (!connected || preferSupabase)) || !radioHasMetadata;
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
  const displayArtwork = isJingleTrack ? null : (syncedRadioTrack?.thumbnail ?? (showSupabaseData ? track.artwork_url : null));
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

  useEffect(() => {
    if (!feedbackMessage) return;
    const timer = setTimeout(() => setFeedbackMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [feedbackMessage]);

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

    if (!displayArtwork) {
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
    img.src = displayArtwork;

    return () => {
      cancelled = true;
      if (tintAnimRafRef.current) {
        cancelAnimationFrame(tintAnimRafRef.current);
        tintAnimRafRef.current = null;
      }
    };
  }, [displayArtwork]);

  useEffect(() => {
    if (artSwapTimerRef.current) {
      clearTimeout(artSwapTimerRef.current);
      artSwapTimerRef.current = null;
    }
    if (artSwapRafRef.current) {
      cancelAnimationFrame(artSwapRafRef.current);
      artSwapRafRef.current = null;
    }

    if (!displayArtwork) {
      setCurrentArtwork(null);
      setIncomingArtwork(null);
      setIncomingArtworkVisible(false);
      return;
    }

    if (!currentArtwork) {
      setCurrentArtwork(displayArtwork);
      setIncomingArtwork(null);
      setIncomingArtworkVisible(false);
      return;
    }

    if (displayArtwork === currentArtwork || displayArtwork === incomingArtwork) {
      return;
    }

    setIncomingArtwork(displayArtwork);
    setIncomingArtworkVisible(false);
    artSwapRafRef.current = requestAnimationFrame(() => setIncomingArtworkVisible(true));
    artSwapTimerRef.current = setTimeout(() => {
      setCurrentArtwork(displayArtwork);
      setIncomingArtwork(null);
      setIncomingArtworkVisible(false);
      artSwapTimerRef.current = null;
    }, 700);
  }, [displayArtwork, currentArtwork, incomingArtwork]);

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
      className="audio-player-shell relative w-full max-w-full overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5"
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
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          if (playingRef.current && !userPaused.current && src) {
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            reconnectTimer.current = setTimeout(() => {
              const audio = audioRef.current;
              if (!audio || userPaused.current) return;
              const cacheBust = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now()}`;
              audio.src = cacheBust;
              audio.play()
                .then(() => {
                  reconnectAttemptRef.current = 0;
                  setAutoplayBlocked(false);
                })
                .catch(() => setAutoplayBlocked(true));
            }, 2000);
          } else {
            setPlaying(false);
          }
        }}
        onStalled={() => {
          if (playingRef.current && !userPaused.current && src) {
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            reconnectTimer.current = setTimeout(() => {
              const audio = audioRef.current;
              if (!audio || userPaused.current || !audio.paused) return;
              const cacheBust = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now()}`;
              audio.src = cacheBust;
              audio.play()
                .then(() => {
                  reconnectAttemptRef.current = 0;
                  setAutoplayBlocked(false);
                })
                .catch(() => setAutoplayBlocked(true));
            }, 3000);
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

      {/* Mobile: compact horizontal layout */}
      <div className="relative z-[1] flex flex-col landscape:hidden sm:hidden">
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
      </div>

      {/* Desktop: compact horizontal layout */}
      <div className="relative z-[1] hidden items-center gap-4 px-4 py-4 landscape:flex sm:flex">
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
              <svg className="h-3.5 w-3.5 shrink-0 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 9v6h4l5 5V4L7 9H3z" />
              </svg>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="violet-slider h-1 w-full max-w-32 cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
              />
              <svg className="h-3.5 w-3.5 shrink-0 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            </div>
          </div>

          {playing && (
            <AudioVisualizer audioRef={audioRef} hostRef={playerRef} playing={playing} barCount={48} className="h-10" />
          )}
        </div>
      </div>
    </div>
  );
}
