"use client";

import { useMemo, useRef } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";

export default function FallbackGenreSelector() {
  const connected = useRadioStore((s) => s.connected);
  const genres = useRadioStore((s) => s.fallbackGenres);
  const activeGenre = useRadioStore((s) => s.activeFallbackGenre);
  const activeGenreBy = useRadioStore((s) => s.activeFallbackGenreBy);
  const menuRef = useRef<HTMLDetailsElement | null>(null);

  const sortedGenres = useMemo(
    () => [...genres].sort((a, b) => a.label.localeCompare(b.label, "nl")),
    [genres],
  );

  if (!connected || sortedGenres.length === 0) return null;

  const activeLabel = sortedGenres.find((g) => g.id === activeGenre)?.label ?? activeGenre ?? "Kies genre";

  return (
    <details ref={menuRef} className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-gray-700 bg-gray-900/75 px-2.5 py-1.5 text-xs text-gray-200 transition hover:border-violet-500/60">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Random genre
        </span>
        <span className="min-w-0 flex-1 truncate text-violet-300">{activeLabel}</span>
        <span className="text-gray-400 transition group-open:rotate-180">▾</span>
      </summary>
      <div className="absolute left-0 right-0 z-30 mt-1 max-h-[55dvh] overflow-y-auto rounded-md border border-gray-700 bg-gray-900/95 p-1 shadow-lg shadow-black/40 sm:max-h-60">
        {activeGenreBy && (
          <p className="mb-1 px-2 py-1 text-[10px] text-gray-400">
            Gekozen door: <span className="text-violet-300">{activeGenreBy}</span>
          </p>
        )}
        <div className="border-b border-gray-800/80 mb-1" />
        {sortedGenres.map((genre) => {
          const isActive = genre.id === activeGenre;
          return (
            <button
              key={genre.id}
              type="button"
              onClick={() => {
                const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
                getSocket().emit("fallback:genre:set", { genreId: genre.id, selectedBy });
                if (menuRef.current) menuRef.current.open = false;
              }}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                isActive
                  ? "bg-violet-600/25 text-violet-100"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <span className="truncate">{genre.label}</span>
              <span className="ml-2 text-[10px] text-gray-500">{genre.trackCount}</span>
            </button>
          );
        })}
      </div>
    </details>
  );
}
