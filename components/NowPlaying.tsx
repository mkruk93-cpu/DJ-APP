"use client";

import { useEffect, useState, useRef } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";
import { parseTrackDisplay } from "@/lib/trackDisplay";
import { useSyncedTrack } from "@/lib/useSyncedTrack";
import type { Track } from "@/lib/types";

interface NowPlayingData {
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
}

interface NowPlayingProps {
  radioTrack?: Track | null;
  showFallback?: boolean;
  preferSupabase?: boolean;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function NowPlaying({ radioTrack, showFallback = false, preferSupabase = false }: NowPlayingProps = {}) {
  const [track, setTrack] = useState<NowPlayingData>({ title: null, artist: null, artwork_url: null });
  const [animate, setAnimate] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const prevTrack = useRef<string>("");
  const connected = useRadioStore((s) => s.connected);
  const queue = useRadioStore((s) => s.queue);
  const upcomingTrack = useRadioStore((s) => s.upcomingTrack);
  const syncedRadioTrack = useSyncedTrack(radioTrack);

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
    if (!syncedRadioTrack?.started_at) { setElapsed(0); return; }

    function tick() {
      if (!syncedRadioTrack?.started_at) return;
      setElapsed(Math.max(0, Math.floor((Date.now() - syncedRadioTrack.started_at) / 1000)));
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [syncedRadioTrack]);

  const hasUpcomingTrack = !!upcomingTrack || queue.length > 0;
  const isRadioMode = !!syncedRadioTrack || connected || hasUpcomingTrack;
  const isLoading = !!syncedRadioTrack && syncedRadioTrack.started_at === 0;
  const radioHasMetadata = !!(syncedRadioTrack?.title || syncedRadioTrack?.thumbnail);
  const showSupabaseData = (showFallback && (!connected || preferSupabase)) || !radioHasMetadata;
  const parsedRadio = parseTrackDisplay(syncedRadioTrack?.title);
  const radioTitle = parsedRadio.title ?? syncedRadioTrack?.title ?? null;
  const radioArtist = parsedRadio.artist;
  const displayTitle = syncedRadioTrack ? radioTitle : (showSupabaseData ? track.title : null);
  const displayArtist = syncedRadioTrack ? radioArtist : (showSupabaseData ? track.artist : null);
  const displayArtwork = syncedRadioTrack?.thumbnail ?? (showSupabaseData ? track.artwork_url : null);
  const hasData = displayTitle || displayArtist;
  const nextQueueItem = queue[0] ?? null;
  const nextSourceTitle = nextQueueItem?.title ?? upcomingTrack?.title ?? null;
  const parsedNext = parseTrackDisplay(nextSourceTitle);
  const nextTitle = parsedNext.title ?? nextSourceTitle;
  const nextArtist = parsedNext.artist;
  const showNextTrack = isRadioMode && (!!nextSourceTitle || !!nextArtist);

  if (!hasData && !isRadioMode) return null;

  const duration = syncedRadioTrack?.duration ?? null;
  const progress = !isLoading && duration && duration > 0 ? Math.min(elapsed / duration, 1) : 0;

  return (
    <div
      className={`mt-2 flex flex-col gap-1 overflow-hidden rounded-lg border border-gray-700/60 bg-gray-800/60 px-2.5 py-1 transition-all duration-500 sm:px-3 sm:py-1.5 sm:mt-2 ${
        animate ? "border-violet-500/50 bg-violet-500/10" : ""
      }`}
    >
      <div className="flex items-center gap-2 sm:gap-2.5">
        {displayArtwork ? (
          <img
            src={displayArtwork}
            alt=""
            className="h-8 w-8 shrink-0 rounded-md object-cover sm:h-10 sm:w-10"
          />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-700/60 sm:h-10 sm:w-10">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 text-gray-400 sm:h-5 sm:w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10-4.5M9 9v10.5a3 3 0 1 1-3-3h3Zm10-4.5v10a3 3 0 1 1-3-3h3V4.5Z" />
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
          <p className="truncate text-[11px] font-medium text-white sm:text-sm">
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
          <span className="shrink-0 flex items-center gap-1.5 text-[11px] text-yellow-400 sm:text-xs">
            <span className="h-2 w-2 animate-spin rounded-full border border-yellow-400 border-t-transparent" />
            Laden
          </span>
        ) : isRadioMode && duration && duration > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-gray-500 sm:text-xs">
            {formatTime(elapsed)} / {formatTime(duration)}
          </span>
        ) : null}
      </div>

      {showNextTrack && (
        <div className="truncate border-t border-gray-700/50 pt-1 text-[10px] text-gray-400 sm:text-xs">
          <span className="mr-1 uppercase tracking-wider text-gray-500">Volgende:</span>
          {nextArtist && <span className="text-violet-400">{nextArtist}</span>}
          {nextArtist && nextTitle && <span className="text-gray-500"> — </span>}
          {nextTitle && <span className="text-gray-300">{nextTitle}</span>}
          {!nextQueueItem && upcomingTrack?.isFallback && (
            <span className="ml-1 text-gray-500">(random)</span>
          )}
        </div>
      )}

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
