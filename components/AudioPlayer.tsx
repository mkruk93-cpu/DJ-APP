"use client";

import { useState, useRef, useEffect } from "react";

export default function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

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

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 sm:py-16">
        <audio ref={audioRef} onError={() => setPlaying(false)} />

        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                playing ? "animate-ping bg-violet-400" : "bg-gray-600"
              }`}
            />
            <span
              className={`relative inline-flex h-3 w-3 rounded-full ${
                playing ? "bg-violet-500" : "bg-gray-600"
              }`}
            />
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
