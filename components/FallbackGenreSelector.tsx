"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";

export default function FallbackGenreSelector() {
  const connected = useRadioStore((s) => s.connected);
  const genres = useRadioStore((s) => s.fallbackGenres);
  const activeGenre = useRadioStore((s) => s.activeFallbackGenre);
  const activeGenreBy = useRadioStore((s) => s.activeFallbackGenreBy);
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuTop, setMobileMenuTop] = useState<number | null>(null);

  const sortedGenres = useMemo(
    () => [...genres].sort((a, b) => a.label.localeCompare(b.label, "nl")),
    [genres],
  );

  const shouldRender = connected && sortedGenres.length > 0;
  const activeLabel = sortedGenres.find((g) => g.id === activeGenre)?.label ?? activeGenre ?? "Kies genre";

  useEffect(() => {
    function updateMobileState() {
      setIsMobile(window.innerWidth < 640);
    }
    updateMobileState();
    window.addEventListener("resize", updateMobileState);
    return () => window.removeEventListener("resize", updateMobileState);
  }, []);

  useEffect(() => {
    function updateMenuPosition() {
      if (!isMobile || !menuRef.current?.open || !summaryRef.current) return;
      const rect = summaryRef.current.getBoundingClientRect();
      setMobileMenuTop(Math.max(8, Math.round(rect.bottom + 8)));
    }
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, { passive: true });
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition);
    };
  }, [isMobile]);

  if (!shouldRender) return null;

  return (
    <details
      ref={menuRef}
      className="group relative z-40"
      onToggle={() => {
        if (!menuRef.current?.open || !isMobile || !summaryRef.current) {
          setMobileMenuTop(null);
          return;
        }
        const rect = summaryRef.current.getBoundingClientRect();
        setMobileMenuTop(Math.max(8, Math.round(rect.bottom + 8)));
      }}
    >
      <summary ref={summaryRef} className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-gray-700 bg-gray-900/75 px-2.5 py-1.5 text-xs text-gray-200 transition hover:border-violet-500/60">
        <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold text-gray-300">
          Genre
        </span>
        <span className="min-w-0 truncate text-center text-[12px] font-semibold text-violet-300">{activeLabel}</span>
        <span className="justify-self-end text-gray-400 transition group-open:rotate-180">▾</span>
      </summary>
      <div
        className={`${isMobile ? "fixed left-2 right-2 mt-0" : "relative mt-1"} z-40 overflow-y-auto rounded-md border border-gray-700 bg-gray-900/95 p-1 shadow-lg shadow-black/40 sm:relative sm:mt-1 sm:left-auto sm:right-auto sm:max-h-60`}
        style={
          isMobile && mobileMenuTop !== null
            ? { top: mobileMenuTop, maxHeight: `calc(100dvh - ${mobileMenuTop + 8}px)` }
            : undefined
        }
      >
        <p className="mb-1 rounded-md bg-gray-800/70 px-2 py-1.5 text-[11px] leading-snug text-gray-300">
          Dit genre bepaalt welke random nummers worden gekozen als de wachtrij leeg is.
        </p>
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
