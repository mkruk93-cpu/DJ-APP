"use client";

import { useEffect, useState, useRef } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";
import type { Track } from "@/lib/types";

interface NowPlayingData {
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
}

interface NowPlayingProps {
  radioTrack?: Track | null;
  showFallback?: boolean;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function NowPlaying({ radioTrack, showFallback = false }: NowPlayingProps = {}) {
  const [track, setTrack] = useState<NowPlayingData>({ title: null, artist: null, artwork_url: null });
  const [animate, setAnimate] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const prevTrack = useRef<string>("");
  const connected = useRadioStore((s) => s.connected);

  useEffect(() => {
    const sb = getSupabase();

    sb.from("now_playing")
      .select("title, artist, artwork_url")
      .eq("id", 1)
      .single()
      .then(({ data }) => {
        if (data) {
          setTrack(data);
          prevTrack.current = `${data.artist}|${data.title}`;
        }
      });

    const channel = sb
      .channel("now-playing")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "now_playing", filter: "id=eq.1" },
        (payload) => {
          const { title, artist, artwork_url } = payload.new as NowPlayingData;
          const key = `${artist}|${title}`;
          if (key !== prevTrack.current) {
            prevTrack.current = key;
            setAnimate(true);
            setTimeout(() => setAnimate(false), 700);
          }
          setTrack({ title, artist, artwork_url });
        }
      )
      .subscribe();

    return () => {
      sb.removeChannel(channel);
    };
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

  const isRadioMode = !!radioTrack;
  const isLoading = isRadioMode && radioTrack.started_at === 0;
  const showSupabaseData = showFallback && !connected;
  const displayTitle = radioTrack?.title ?? (showSupabaseData ? track.title : null);
  const displayArtist = radioTrack ? null : (showSupabaseData ? track.artist : null);
  const displayArtwork = radioTrack?.thumbnail ?? (showSupabaseData ? track.artwork_url : null);
  const hasData = displayTitle || displayArtist;

  if (!hasData && !isRadioMode) return null;

  const duration = radioTrack?.duration ?? null;
  const progress = !isLoading && duration && duration > 0 ? Math.min(elapsed / duration, 1) : 0;

  return (
    <div
      className={`mt-2 flex flex-col gap-1 overflow-hidden rounded-lg border border-gray-700/60 bg-gray-800/60 px-3 py-1.5 transition-all duration-500 sm:mt-2 ${
        animate ? "border-violet-500/50 bg-violet-500/10" : ""
      }`}
    >
      <div className="flex items-center gap-2 sm:gap-2.5">
        {displayArtwork ? (
          <img
            src={displayArtwork}
            alt=""
            className="h-10 w-10 shrink-0 rounded-md object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gray-700/60">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-gray-500">
              <path d="M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2ZM19 15c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2ZM21 3v12.54a2.98 2.98 0 0 0-2-1.04c-1.1 0-2.13.6-2.67 1.5H16V6.3L10 7.83V17a2.98 2.98 0 0 0-2-1c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V9.12l6-1.5V13a2.98 2.98 0 0 0-2-1c-1.66 0-3 1.34-3 3s1.34 3 3 3c1.47 0 2.7-1.07 2.95-2.47L21 3Z" />
            </svg>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
          </span>
          <span className="hidden text-xs font-medium uppercase tracking-wider text-gray-500 sm:inline">
            {isRadioMode ? "Radio" : "Live"}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-white sm:text-sm">
            {displayArtist && (
              <span className="text-violet-400">{displayArtist}</span>
            )}
            {displayArtist && displayTitle && (
              <span className="text-gray-500"> — </span>
            )}
            {displayTitle && <span>{displayTitle}</span>}
            {isRadioMode && !displayTitle && (
              <span className="text-gray-400">Wacht op nummer...</span>
            )}
          </p>
        </div>
        {isLoading ? (
          <span className="shrink-0 flex items-center gap-1.5 text-xs text-yellow-400">
            <span className="h-2 w-2 animate-spin rounded-full border border-yellow-400 border-t-transparent" />
            Laden
          </span>
        ) : isRadioMode && duration && duration > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-gray-500">
            {formatTime(elapsed)} / {formatTime(duration)}
          </span>
        ) : null}
      </div>

      {isRadioMode && !isLoading && duration && duration > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700">
          <div
            className="h-full rounded-full bg-violet-500 transition-all duration-1000 ease-linear"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
