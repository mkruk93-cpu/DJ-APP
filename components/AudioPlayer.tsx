"use client";

import { useState, useRef, useEffect } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";
import AudioVisualizer from "@/components/AudioVisualizer";
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
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function AudioPlayer({ src, radioTrack, showFallback = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [track, setTrack] = useState<NowPlayingData>({ title: null, artist: null, artwork_url: null });
  const [elapsed, setElapsed] = useState(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const userPaused = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = useRadioStore((s) => s.connected);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Autoplay when stream source becomes available
  useEffect(() => {
    if (!src || userPaused.current || playing) return;
    const audio = audioRef.current;
    if (!audio) return;

    audio.src = src;
    audio.play()
      .then(() => {
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
      audio.src = src;
      audio.play()
        .then(() => {
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
    if (!radioTrack?.started_at) { setElapsed(0); return; }

    function tick() {
      if (!radioTrack?.started_at) return;
      setElapsed(Math.max(0, Math.floor((Date.now() - radioTrack.started_at) / 1000)));
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [radioTrack]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      audio.pause();
      audio.src = "";
      setPlaying(false);
      userPaused.current = true;
      setAutoplayBlocked(false);
    } else {
      userPaused.current = false;
      audio.src = src;
      audio.play().catch(() => {});
      setPlaying(true);
      setAutoplayBlocked(false);
    }
  }

  const isRadioMode = !!radioTrack;
  const isLoading = isRadioMode && radioTrack.started_at === 0;
  const showSupabaseData = showFallback && !connected;
  const displayTitle = radioTrack?.title ?? (showSupabaseData ? track.title : null);
  const displayArtist = radioTrack ? null : (showSupabaseData ? track.artist : null);
  const displayArtwork = radioTrack?.thumbnail ?? (showSupabaseData ? track.artwork_url : null);
  const hasTrack = displayTitle || displayArtist;

  const duration = radioTrack?.duration ?? null;
  const progress = duration && duration > 0 ? Math.min(elapsed / duration, 1) : 0;

  const artworkFallback = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6 text-gray-500 sm:h-16 sm:w-16">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10-4.5M9 9v10.5a3 3 0 1 1-3-3h3Zm10-4.5v10a3 3 0 1 1-3-3h3V4.5Z" />
    </svg>
  );

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onError={() => {
          if (playing && !userPaused.current && src) {
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            reconnectTimer.current = setTimeout(() => {
              const audio = audioRef.current;
              if (!audio || userPaused.current) return;
              audio.src = src;
              audio.play().catch(() => {});
            }, 2000);
          } else {
            setPlaying(false);
          }
        }}
        onStalled={() => {
          if (playing && !userPaused.current && src) {
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            reconnectTimer.current = setTimeout(() => {
              const audio = audioRef.current;
              if (!audio || userPaused.current || !audio.paused) return;
              audio.src = src;
              audio.play().catch(() => {});
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
      <div className="flex flex-col sm:hidden">
        <div className="flex items-center gap-3 p-3">
          {displayArtwork ? (
            <img src={displayArtwork} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-gray-800">
              {artworkFallback}
            </div>
          )}

          <div className="min-w-0 flex-1">
            {hasTrack ? (
              <>
                {displayTitle && <p className="truncate text-sm font-semibold text-white">{displayTitle}</p>}
                {displayArtist && <p className="truncate text-xs text-violet-400">{displayArtist}</p>}
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
            ) : isRadioMode && duration && duration > 0 ? (
              <p className="mt-0.5 text-[10px] tabular-nums text-gray-500">
                {formatTime(elapsed)} / {formatTime(duration)}
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
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all ${
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
          <div className="px-3 pb-2">
            <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700">
              <div
                className="h-full rounded-full bg-violet-500 transition-all duration-1000 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>
        )}

        {playing && (
          <div className="px-3 pb-2">
            <AudioVisualizer audioRef={audioRef} playing={playing} barCount={24} className="h-8" />
          </div>
        )}
      </div>

      {/* Desktop: compact horizontal layout */}
      <div className="hidden items-center gap-4 px-4 py-4 sm:flex">
        {displayArtwork ? (
          <img
            src={displayArtwork}
            alt=""
            className={`h-24 w-24 shrink-0 rounded-xl object-cover shadow-lg ${
              playing ? "shadow-violet-500/20" : "shadow-black/30"
            }`}
          />
        ) : (
          <div className={`flex h-24 w-24 shrink-0 items-center justify-center rounded-xl bg-gray-800 ${
            playing ? "shadow-lg shadow-violet-500/20" : ""
          }`}>
            {artworkFallback}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {hasTrack && (
            <div className="min-w-0">
              {displayTitle && <p className="truncate text-sm font-semibold text-white">{displayTitle}</p>}
              {displayArtist && <p className="truncate text-xs text-violet-400">{displayArtist}</p>}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
              <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">Downloaden...</span>
            </div>
          ) : isRadioMode && duration && duration > 0 ? (
            <div className="flex w-full flex-col gap-1">
              <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700">
                <div
                  className="h-full rounded-full bg-violet-500 transition-all duration-1000 ease-linear"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <div className="flex justify-between">
                <span className="text-[10px] tabular-nums text-gray-500">{formatTime(elapsed)}</span>
                <span className="text-[10px] tabular-nums text-gray-500">{formatTime(duration)}</span>
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
                className="h-1 w-full max-w-32 cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
              />
              <svg className="h-3.5 w-3.5 shrink-0 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            </div>
          </div>

          {playing && (
            <AudioVisualizer audioRef={audioRef} playing={playing} barCount={48} className="h-10" />
          )}
        </div>
      </div>
    </div>
  );
}
