"use client";

import { useEffect, useState, useRef } from "react";
import { getSupabase } from "@/lib/supabaseClient";

interface NowPlayingData {
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
}

export default function NowPlaying() {
  const [track, setTrack] = useState<NowPlayingData>({ title: null, artist: null, artwork_url: null });
  const [animate, setAnimate] = useState(false);
  const prevTrack = useRef<string>("");

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

  if (!track.title && !track.artist) return null;

  return (
    <div
      className={`mt-2 flex items-center gap-2 overflow-hidden rounded-lg border border-gray-700/60 bg-gray-800/60 px-3 py-1.5 transition-all duration-500 sm:mt-2 sm:gap-2.5 ${
        animate ? "border-violet-500/50 bg-violet-500/10" : ""
      }`}
    >
      {track.artwork_url ? (
        <img
          src={track.artwork_url}
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
          Live
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-white sm:text-sm">
          {track.artist && (
            <span className="text-violet-400">{track.artist}</span>
          )}
          {track.artist && track.title && (
            <span className="text-gray-500"> — </span>
          )}
          {track.title && <span>{track.title}</span>}
        </p>
      </div>
    </div>
  );
}
