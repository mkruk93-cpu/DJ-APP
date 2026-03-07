"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import {
  buildGroupedGenreSections,
  GENRE_FALLBACK_OPTIONS,
  isGroupedParentGenre,
  type GenreDropdownSection,
} from "@/lib/genreDropdown";
import type { GenreOption } from "@/lib/radioApi";

type FallbackListTab = "local" | "auto" | "playlists";

function normalizeAutoGenreId(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === "terrorcore") return "terror";
  if (value === "psytrance") return "psy trance";
  if (value === "brostep") return "dubstep";
  if (value === "neurofunk") return "liquid drum and bass";
  return value;
}

export default function FallbackGenreSelector() {
  const connected = useRadioStore((s) => s.connected);
  const genres = useRadioStore((s) => s.fallbackGenres);
  const activeGenre = useRadioStore((s) => s.activeFallbackGenre);
  const activeGenreBy = useRadioStore((s) => s.activeFallbackGenreBy);
  const sharedPlaybackMode = useRadioStore((s) => s.activeFallbackSharedMode);
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuTop, setMobileMenuTop] = useState<number | null>(null);
  const [activeListTab, setActiveListTab] = useState<FallbackListTab>("local");

  const sortedGenres = useMemo(
    () => [...genres].sort((a, b) => a.label.localeCompare(b.label, "nl")),
    [genres],
  );
  const localGenres = useMemo(
    () => sortedGenres.filter((genre) => !genre.id.startsWith("auto:") && !genre.id.startsWith("shared:")),
    [sortedGenres],
  );
  const autoGenres = useMemo(
    () => sortedGenres.filter((genre) => genre.id.startsWith("auto:")),
    [sortedGenres],
  );
  const sharedPlaylists = useMemo(
    () => sortedGenres.filter((genre) => genre.id.startsWith("shared:")),
    [sortedGenres],
  );
  const autoGenreCanonicalCount = useMemo(() => {
    const unique = new Set<string>();
    for (const genre of autoGenres) {
      if (genre.id === "auto:liked") continue;
      const rawId = genre.id.slice("auto:".length).trim();
      if (!rawId) continue;
      unique.add(normalizeAutoGenreId(rawId));
    }
    return unique.size;
  }, [autoGenres]);
  const likedAutoGenre = useMemo(
    () => autoGenres.find((genre) => genre.id === "auto:liked") ?? null,
    [autoGenres],
  );
  const groupedAutoSections = useMemo<GenreDropdownSection[]>(() => {
    const optionMap = new Map<string, GenreOption>();
    for (const fallback of GENRE_FALLBACK_OPTIONS) {
      optionMap.set(fallback.id.toLowerCase(), {
        id: fallback.id,
        name: fallback.name,
      });
    }
    for (const genre of autoGenres) {
      if (genre.id === "auto:liked") continue;
      const rawId = normalizeAutoGenreId(genre.id.slice("auto:".length).trim());
      if (!rawId) continue;
      const displayName = genre.label
        .replace(/^auto\s*playlist\s*[·:-]\s*/i, "")
        .trim();
      optionMap.set(rawId.toLowerCase(), {
        id: rawId,
        name: displayName || rawId,
      });
    }
    return buildGroupedGenreSections(Array.from(optionMap.values()), "");
  }, [autoGenres]);

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

  useEffect(() => {
    if (activeGenre?.startsWith("auto:")) {
      setActiveListTab("auto");
      return;
    }
    if (activeGenre?.startsWith("shared:")) {
      setActiveListTab("playlists");
      return;
    }
    setActiveListTab("local");
  }, [activeGenre]);

  if (!shouldRender) return null;

  return (
    <details
      ref={menuRef}
      className="group relative z-[130]"
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
        className={`${isMobile ? "fixed left-2 right-2 mt-0" : "absolute left-0 right-0 top-full mt-1"} z-[140] overflow-y-auto rounded-md border border-gray-700 bg-gray-900/95 p-1 shadow-lg shadow-black/40 sm:max-h-60`}
        style={
          isMobile && mobileMenuTop !== null
            ? { top: mobileMenuTop, maxHeight: `calc(100dvh - ${mobileMenuTop + 8}px)` }
            : undefined
        }
      >
        <p className="mb-1 rounded-md bg-gray-800/70 px-2 py-1.5 text-[11px] leading-snug text-gray-300">
          Kies lokaal genre, online genre, of gedeelde playlist voor random nummers als de wachtrij leeg is.
        </p>
        <div className="mb-1 grid grid-cols-3 gap-1 rounded-md border border-gray-800 bg-gray-900/70 p-1">
          <button
            type="button"
            onClick={() => setActiveListTab("local")}
            className={`rounded px-2 py-1 text-[11px] font-semibold transition ${
              activeListTab === "local"
                ? "bg-violet-600/30 text-violet-100"
                : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            Lokaal ({localGenres.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveListTab("auto")}
            className={`rounded px-2 py-1 text-[11px] font-semibold transition ${
              activeListTab === "auto"
                ? "bg-violet-600/30 text-violet-100"
                : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            Online ({autoGenreCanonicalCount + (likedAutoGenre ? 1 : 0)})
          </button>
          <button
            type="button"
            onClick={() => setActiveListTab("playlists")}
            className={`rounded px-2 py-1 text-[11px] font-semibold transition ${
              activeListTab === "playlists"
                ? "bg-violet-600/30 text-violet-100"
                : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            Playlists ({sharedPlaylists.length})
          </button>
        </div>
        {activeGenreBy && (
          <p className="mb-1 px-2 py-1 text-[10px] text-gray-400">
            Gekozen door: <span className="text-violet-300">{activeGenreBy}</span>
          </p>
        )}
        <div className="border-b border-gray-800/80 mb-1" />
        {activeListTab === "local" ? (
          <>
            {localGenres.map((genre) => {
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
            {localGenres.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-gray-400">
                Geen genres beschikbaar in de Lokale lijst.
              </p>
            )}
          </>
        ) : activeListTab === "auto" ? (
          <>
            {likedAutoGenre && (
              <button
                type="button"
                onClick={() => {
                  const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
                  getSocket().emit("fallback:genre:set", { genreId: likedAutoGenre.id, selectedBy });
                  if (menuRef.current) menuRef.current.open = false;
                }}
                className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                  likedAutoGenre.id === activeGenre
                    ? "bg-fuchsia-600/25 text-fuchsia-100"
                    : "text-fuchsia-200 hover:bg-gray-800 hover:text-white"
                }`}
              >
                <span className="truncate">{likedAutoGenre.label}</span>
                <span className="ml-2 text-[10px] text-gray-500">AUTO</span>
              </button>
            )}
            {groupedAutoSections.map((section) => {
              const parentAutoId = `auto:${section.parent.id}`;
              const parentActive = activeGenre === parentAutoId;
              return (
                <div key={section.id} className="mb-1 last:mb-0">
                  <button
                    type="button"
                    onClick={() => {
                      const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
                      getSocket().emit("fallback:genre:set", { genreId: parentAutoId, selectedBy });
                      if (menuRef.current) menuRef.current.open = false;
                    }}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                      parentActive
                        ? "bg-fuchsia-600/25 text-fuchsia-100"
                        : "text-fuchsia-200 hover:bg-gray-800 hover:text-white"
                    }`}
                  >
                    <span className="truncate">{section.parent.name}</span>
                    {isGroupedParentGenre(section.parent.id) && (
                      <span className="ml-2 text-[10px] text-gray-500">alles</span>
                    )}
                  </button>
                  {section.children.map((genre) => {
                    const childAutoId = `auto:${genre.id}`;
                    const isActive = activeGenre === childAutoId;
                    return (
                      <button
                        key={`${section.id}:${genre.id}`}
                        type="button"
                        onClick={() => {
                          const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
                          getSocket().emit("fallback:genre:set", { genreId: childAutoId, selectedBy });
                          if (menuRef.current) menuRef.current.open = false;
                        }}
                        className={`ml-2 mt-0.5 flex w-[calc(100%-0.5rem)] items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                          isActive
                            ? "bg-violet-600/25 text-violet-100"
                            : "text-gray-300 hover:bg-gray-800 hover:text-white"
                        }`}
                      >
                        <span className="truncate">- {genre.name}</span>
                        <span className="ml-2 text-[10px] text-gray-500">AUTO</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {groupedAutoSections.length === 0 && !likedAutoGenre && (
              <p className="px-2 py-2 text-[11px] text-gray-400">
                Geen genres beschikbaar in de Online lijst.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="mb-1 rounded-md border border-gray-800 bg-gray-900/70 p-1">
              <p className="mb-1 px-1 text-[10px] text-gray-400">Afspeelvolgorde</p>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
                    getSocket().emit("fallback:shared:mode:set", { mode: "random", selectedBy });
                  }}
                  className={`rounded px-2 py-1 text-[11px] font-semibold transition ${
                    sharedPlaybackMode === "random"
                      ? "bg-violet-600/30 text-violet-100"
                      : "text-gray-300 hover:bg-gray-800"
                  }`}
                >
                  Random
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
                    getSocket().emit("fallback:shared:mode:set", { mode: "ordered", selectedBy });
                  }}
                  className={`rounded px-2 py-1 text-[11px] font-semibold transition ${
                    sharedPlaybackMode === "ordered"
                      ? "bg-violet-600/30 text-violet-100"
                      : "text-gray-300 hover:bg-gray-800"
                  }`}
                >
                  Op volgorde
                </button>
              </div>
            </div>
            {sharedPlaylists.map((playlist) => {
              const isActive = playlist.id === activeGenre;
              return (
                <button
                  key={playlist.id}
                  type="button"
                  onClick={() => {
                    const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
                    getSocket().emit("fallback:genre:set", {
                      genreId: playlist.id,
                      selectedBy,
                      sharedPlaybackMode,
                    });
                    if (menuRef.current) menuRef.current.open = false;
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                    isActive
                      ? "bg-violet-600/25 text-violet-100"
                      : "text-gray-300 hover:bg-gray-800 hover:text-white"
                  }`}
                >
                  <span className="truncate">{playlist.label.replace(/^Playlist ·\s*/i, "")}</span>
                  <span className="ml-2 text-[10px] text-gray-500">{playlist.trackCount}</span>
                </button>
              );
            })}
            {sharedPlaylists.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-gray-400">
                Geen publieke playlists beschikbaar.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
