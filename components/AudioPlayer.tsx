"use client";

import { useState, useRef, useEffect } from "react";
import { getSupabase } from "@/lib/supabaseClient";

interface NowPlayingData {
  title: string | null;
  artist: string | null;
  artwork_url: string | null;
}

export default function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [track, setTrack] = useState<NowPlayingData>({ title: null, artist: null, artwork_url: null });

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

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

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause();
      audio.src = "";
      setPlaying(false);
    } else {
      audio.src = src;
      audio.play().catch(() => {});
      setPlaying(true);
    }
  }

  const hasTrack = track.title || track.artist;

  const artworkFallback = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6 text-gray-600 sm:h-16 sm:w-16">
      <path d="M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2ZM19 15c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2ZM21 3v12.54a2.98 2.98 0 0 0-2-1.04c-1.1 0-2.13.6-2.67 1.5H16V6.3L10 7.83V17a2.98 2.98 0 0 0-2-1c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V9.12l6-1.5V13a2.98 2.98 0 0 0-2-1c-1.66 0-3 1.34-3 3s1.34 3 3 3c1.47 0 2.7-1.07 2.95-2.47L21 3Z" />
    </svg>
  );

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <audio ref={audioRef} onError={() => setPlaying(false)} />

      {/* Mobile: compact horizontal layout */}
      <div className="flex items-center gap-3 p-3 sm:hidden">
        {track.artwork_url ? (
          <img src={track.artwork_url} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-gray-800">
            {artworkFallback}
          </div>
        )}

        <div className="min-w-0 flex-1">
          {hasTrack ? (
            <>
              {track.title && <p className="truncate text-sm font-semibold text-white">{track.title}</p>}
              {track.artist && <p className="truncate text-xs text-violet-400">{track.artist}</p>}
            </>
          ) : (
            <p className="text-sm font-medium text-gray-400">Audio Stream</p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${playing ? "animate-ping bg-violet-400" : "bg-gray-600"}`} />
              <span className={`relative inline-flex h-2 w-2 rounded-full ${playing ? "bg-violet-500" : "bg-gray-600"}`} />
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              {playing ? "Live" : "Offline"}
            </span>
          </div>
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

      {/* Desktop: centered vertical layout */}
      <div className="hidden flex-col items-center justify-center gap-5 px-6 py-10 sm:flex sm:py-14">
        {track.artwork_url ? (
          <img
            src={track.artwork_url}
            alt=""
            className={`h-44 w-44 rounded-2xl object-cover shadow-xl ${
              playing ? "shadow-violet-500/20" : "shadow-black/30"
            }`}
          />
        ) : (
          <div className={`flex h-44 w-44 items-center justify-center rounded-2xl bg-gray-800 ${
            playing ? "shadow-xl shadow-violet-500/20" : ""
          }`}>
            {artworkFallback}
          </div>
        )}

        {hasTrack && (
          <div className="max-w-64 text-center">
            {track.title && <p className="truncate text-base font-semibold text-white">{track.title}</p>}
            {track.artist && <p className="truncate text-sm text-violet-400">{track.artist}</p>}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${playing ? "animate-ping bg-violet-400" : "bg-gray-600"}`} />
            <span className={`relative inline-flex h-3 w-3 rounded-full ${playing ? "bg-violet-500" : "bg-gray-600"}`} />
          </span>
          <span className="text-sm font-semibold uppercase tracking-wider text-gray-400">
            {playing ? "Audio Live" : "Audio Stream"}
          </span>
        </div>

        <button
          onClick={toggle}
          className={`flex h-16 w-16 items-center justify-center rounded-full transition-all ${
            playing
              ? "bg-violet-600 shadow-lg shadow-violet-500/30 hover:bg-violet-500"
              : "bg-gray-700 hover:bg-gray-600"
          }`}
        >
          {playing ? (
            <svg className="h-6 w-6 text-white" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg className="ml-1 h-6 w-6 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex w-full max-w-48 items-center gap-2">
          <svg className="h-4 w-4 shrink-0 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3 9v6h4l5 5V4L7 9H3z" />
          </svg>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="h-1 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-violet-500"
          />
          <svg className="h-4 w-4 shrink-0 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
        </div>
      </div>
    </div>
  );
}
