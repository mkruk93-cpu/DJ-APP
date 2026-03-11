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

type PlaylistSortMode = "name_asc" | "name_desc" | "tracks_desc";
type PlaylistViewMode = "grouped" | "all";
type FallbackSection = "local" | "auto" | "playlists";

interface SharedFallbackPreset {
  id: string;
  name: string;
  genreIds: string[];
  sharedPlaybackMode: "random" | "ordered";
  createdBy: string | null;
  createdAt: string;
}

function normalizeBucketLabel(value: string | null | undefined, fallback: string): string {
  const safe = (value ?? "").trim();
  return safe || fallback;
}

function groupSharedPlaylistsByGenre(
  playlists: Array<{
    id: string;
    label: string;
    trackCount: number;
    genre_group?: string | null;
    subgenre?: string | null;
  }>,
): Array<{
  genreLabel: string;
  subgroups: Array<{
    subgenreLabel: string;
    items: Array<{
      id: string;
      label: string;
      trackCount: number;
      genre_group?: string | null;
      subgenre?: string | null;
    }>;
  }>;
}> {
  const byGenre = new Map<string, Map<string, typeof playlists>>();
  for (const playlist of playlists) {
    const genreLabel = normalizeBucketLabel(playlist.genre_group, "Overig");
    const subgenreLabel = normalizeBucketLabel(playlist.subgenre, "Algemeen");
    if (!byGenre.has(genreLabel)) byGenre.set(genreLabel, new Map<string, typeof playlists>());
    const bySubgenre = byGenre.get(genreLabel)!;
    const bucket = bySubgenre.get(subgenreLabel) ?? [];
    bucket.push(playlist);
    bySubgenre.set(subgenreLabel, bucket);
  }
  return Array.from(byGenre.entries())
    .map(([genreLabel, bySubgenre]) => ({
      genreLabel,
      subgroups: Array.from(bySubgenre.entries()).map(([subgenreLabel, items]) => ({
        subgenreLabel,
        items,
      })),
    }));
}

function sortSharedPlaylists(
  playlists: Array<{
    id: string;
    label: string;
    trackCount: number;
    genre_group?: string | null;
    subgenre?: string | null;
  }>,
  mode: PlaylistSortMode,
): Array<{
  id: string;
  label: string;
  trackCount: number;
  genre_group?: string | null;
  subgenre?: string | null;
}> {
  const copy = playlists.slice();
  if (mode === "name_desc") {
    copy.sort((a, b) => b.label.localeCompare(a.label, "nl"));
    return copy;
  }
  if (mode === "tracks_desc") {
    copy.sort((a, b) => (b.trackCount - a.trackCount) || a.label.localeCompare(b.label, "nl"));
    return copy;
  }
  copy.sort((a, b) => a.label.localeCompare(b.label, "nl"));
  return copy;
}

function getStorageKey(): string {
  if (typeof window === "undefined") return "fallback-selector:guest";
  const nickname = (localStorage.getItem("nickname") ?? "guest").trim().toLowerCase() || "guest";
  return `fallback-selector:${nickname}`;
}

function getLegacyStorageKey(): string {
  return "fallback-selector:guest";
}

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
  const activeGenres = useRadioStore((s) => s.activeFallbackGenres);
  const activeGenreBy = useRadioStore((s) => s.activeFallbackGenreBy);
  const sharedPlaybackMode = useRadioStore((s) => s.activeFallbackSharedMode);
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuTop, setMobileMenuTop] = useState<number | null>(null);
  const [openSections, setOpenSections] = useState<Record<FallbackSection, boolean>>({
    local: true,
    auto: false,
    playlists: false,
  });
  const [playlistSortMode, setPlaylistSortMode] = useState<PlaylistSortMode>("name_asc");
  const [playlistViewMode, setPlaylistViewMode] = useState<PlaylistViewMode>("grouped");
  const [showFallbackHelp, setShowFallbackHelp] = useState(false);
  const [presets, setPresets] = useState<SharedFallbackPreset[]>([]);
  const [presetName, setPresetName] = useState("");

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
  const sortedSharedPlaylists = useMemo(
    () => sortSharedPlaylists(sharedPlaylists, playlistSortMode),
    [sharedPlaylists, playlistSortMode],
  );
  const groupedSharedPlaylists = useMemo(
    () => groupSharedPlaylistsByGenre(sortedSharedPlaylists),
    [sortedSharedPlaylists],
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

  const selectedSharedGenres = useMemo(() => {
    const explicit = Array.from(new Set((activeGenres ?? []).filter((id) => id.startsWith("shared:"))));
    if (explicit.length > 0) return explicit;
    if (activeGenre?.startsWith("shared:")) return [activeGenre];
    return [];
  }, [activeGenres, activeGenre]);
  const selectedGenreIds = useMemo(() => {
    const explicit = Array.from(new Set(activeGenres ?? []));
    if (explicit.length > 0) return explicit;
    return activeGenre ? [activeGenre] : [];
  }, [activeGenres, activeGenre]);
  const shouldRender = connected && sortedGenres.length > 0;
  const activeLabel = useMemo(() => {
    if (selectedSharedGenres.length > 1) {
      return `${selectedSharedGenres.length} playlists actief`;
    }
    return sortedGenres.find((g) => g.id === activeGenre)?.label ?? activeGenre ?? "Kies genre";
  }, [sortedGenres, activeGenre, selectedSharedGenres]);

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

  function emitSharedSelection(nextSelected: string[]): void {
    const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
    const normalized = Array.from(new Set(nextSelected.filter((id) => id.startsWith("shared:"))));
    const primary = normalized[0] ?? activeGenre ?? null;
    if (!primary) return;
    const selectedLabel = sortedSharedPlaylists.find((playlist) => playlist.id === primary)?.label ?? primary;
    getSocket().emit("fallback:genre:set", {
      genreId: primary,
      genreIds: normalized,
      selectedBy,
      selectedLabel,
      sharedPlaybackMode,
    });
  }

  function emitSelection(nextSelected: string[]): void {
    const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
    const normalized = Array.from(new Set(nextSelected.map((id) => id.trim()).filter(Boolean)));
    const primary = normalized[0] ?? activeGenre ?? null;
    if (!primary) return;
    const selectedLabel = sortedGenres.find((genre) => genre.id === primary)?.label ?? primary;
    getSocket().emit("fallback:genre:set", {
      genreId: primary,
      genreIds: normalized,
      selectedBy,
      selectedLabel,
      sharedPlaybackMode,
    });
  }

  function toggleSelection(id: string): void {
    const isActive = selectedGenreIds.includes(id);
    const next = isActive
      ? selectedGenreIds.filter((entry) => entry !== id)
      : [...selectedGenreIds, id];
    emitSelection(next.length > 0 ? next : [id]);
  }

  function setSectionOpen(section: FallbackSection): void {
    setOpenSections((prev) => {
      const shouldOpen = !prev[section];
      return {
        local: false,
        auto: false,
        playlists: false,
        [section]: shouldOpen,
      };
    });
  }

  function setAllForSection(section: FallbackSection, enabled: boolean): void {
    const sectionIds = (
      section === "local"
        ? localGenres.map((g) => g.id)
        : section === "auto"
          ? autoGenres.map((g) => g.id)
          : sharedPlaylists.map((g) => g.id)
    );
    const nextSet = new Set(selectedGenreIds);
    if (enabled) {
      sectionIds.forEach((id) => nextSet.add(id));
    } else {
      sectionIds.forEach((id) => nextSet.delete(id));
    }
    let next = Array.from(nextSet);
    if (next.length === 0 && !enabled) {
      const fallbackId = (
        section === "local"
          ? [...autoGenres, ...sharedPlaylists][0]?.id
          : section === "auto"
            ? [...localGenres, ...sharedPlaylists][0]?.id
            : [...localGenres, ...autoGenres][0]?.id
      );
      if (fallbackId) next = [fallbackId];
    }
    if (next.length > 0) emitSelection(next);
  }

  function applyPreset(preset: SharedFallbackPreset): void {
    const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
    getSocket().emit("fallback:preset:apply", { id: preset.id, selectedBy });
  }

  function savePreset(): void {
    const name = presetName.trim();
    if (!name || selectedGenreIds.length === 0) return;
    const selectedBy = localStorage.getItem("nickname")?.trim() || "onbekend";
    getSocket().emit("fallback:preset:save", {
      name,
      genreIds: selectedGenreIds,
      sharedPlaybackMode: sharedPlaybackMode,
      selectedBy,
    });
    setPresetName("");
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(getStorageKey()) ?? localStorage.getItem(getLegacyStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<{
        playlistSortMode: PlaylistSortMode;
        playlistViewMode: PlaylistViewMode;
        openSections: Record<FallbackSection, boolean>;
      }>;
      if (parsed.playlistSortMode) setPlaylistSortMode(parsed.playlistSortMode);
      if (parsed.playlistViewMode) setPlaylistViewMode(parsed.playlistViewMode);
      if (parsed.openSections) {
        setOpenSections((prev) => ({ ...prev, ...parsed.openSections }));
      }
    } catch {
      // Ignore invalid preferences.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify({
      playlistSortMode,
      playlistViewMode,
      openSections,
    });
    localStorage.setItem(getStorageKey(), payload);
    localStorage.setItem(getLegacyStorageKey(), payload);
  }, [playlistSortMode, playlistViewMode, openSections]);

  useEffect(() => {
    const socket = getSocket();
    function onPresetUpdate(data: { presets?: SharedFallbackPreset[] }) {
      setPresets(Array.isArray(data?.presets) ? data.presets : []);
    }
    socket.on("fallback:presets:update", onPresetUpdate);
    socket.emit("fallback:presets:get");
    return () => {
      socket.off("fallback:presets:update", onPresetUpdate);
    };
  }, []);

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
          Kies bronnen voor autoplay als de wachtrij leeg is. Gebruik presets om complete sets op te slaan voor iedereen.
        </p>
        {activeGenreBy && (
          <p className="mb-1 px-2 py-1 text-[10px] text-gray-400">
            Gekozen door: <span className="text-violet-300">{activeGenreBy}</span>
          </p>
        )}
        <div className="mb-1 rounded-md border border-gray-800 bg-gray-900/70 px-2 py-1 text-[10px] text-gray-300">
          <span className="font-semibold text-gray-200">Actief nu:</span>{" "}
          {selectedGenreIds.length > 0
            ? selectedGenreIds
              .map((id) => sortedGenres.find((genre) => genre.id === id)?.label ?? id)
              .slice(0, 4)
              .join(" · ")
            : "geen selectie"}
          {selectedGenreIds.length > 4 ? ` (+${selectedGenreIds.length - 4})` : ""}
        </div>
        <div className="mb-1 rounded-md border border-gray-800 bg-gray-900/70 p-1.5">
          <p className="mb-1 text-[10px] font-semibold text-gray-300">Presets (gedeeld)</p>
          <div className="mb-1 flex gap-1">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="Naam preset..."
              className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[11px] text-white placeholder-gray-500"
            />
            <button
              type="button"
              onClick={savePreset}
              className="rounded border border-violet-600/70 bg-violet-700/20 px-2 py-1 text-[11px] font-semibold text-violet-100 transition hover:bg-violet-700/30"
            >
              Opslaan
            </button>
          </div>
          <div className="max-h-24 space-y-1 overflow-y-auto pr-1">
            {presets.length === 0 ? (
              <p className="text-[10px] text-gray-500">Nog geen presets opgeslagen.</p>
            ) : (
              presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="flex w-full items-center justify-between rounded border border-gray-700 bg-gray-800/70 px-2 py-1 text-left text-[10px] text-gray-200 transition hover:border-violet-500/70 hover:bg-gray-800"
                >
                  <span className="truncate">{preset.name}</span>
                  <span className="ml-2 text-gray-500">{preset.genreIds.length}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="border-b border-gray-800/80 mb-1" />
        <div className="space-y-1">
          <div className="rounded-md border border-gray-800 bg-gray-900/70">
            <button
              type="button"
              onClick={() => setSectionOpen("local")}
              className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] font-semibold text-gray-200"
            >
              <span>Lokaal ({localGenres.length})</span>
              <span>{openSections.local ? "▾" : "▸"}</span>
            </button>
            {openSections.local && (
              <div className="border-t border-gray-800 px-1 pb-1">
                <div className="mb-1 mt-1 grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => setAllForSection("local", true)} className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-200 hover:bg-gray-800">Alles aan</button>
                  <button type="button" onClick={() => setAllForSection("local", false)} className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-200 hover:bg-gray-800">Alles uit</button>
                </div>
                <>
            {localGenres.map((genre) => {
              const isActive = selectedGenreIds.includes(genre.id);
              return (
                <label
                  key={genre.id}
                  className={`flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                    isActive
                      ? "bg-violet-600/25 text-violet-100"
                      : "text-gray-300 hover:bg-gray-800 hover:text-white"
                  }`}
                >
                  <span className="mr-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => toggleSelection(genre.id)}
                      className="h-3.5 w-3.5 cursor-pointer accent-violet-500"
                    />
                    <span className="truncate">{genre.label}</span>
                  </span>
                  <span className="ml-2 text-[10px] text-gray-500">{genre.trackCount}</span>
                </label>
              );
            })}
            {localGenres.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-gray-400">
                Geen genres beschikbaar in de Lokale lijst.
              </p>
            )}
                </>
              </div>
            )}
          </div>
          <div className="rounded-md border border-gray-800 bg-gray-900/70">
            <button
              type="button"
              onClick={() => setSectionOpen("auto")}
              className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] font-semibold text-gray-200"
            >
              <span>Online ({autoGenreCanonicalCount + (likedAutoGenre ? 1 : 0)})</span>
              <span>{openSections.auto ? "▾" : "▸"}</span>
            </button>
            {openSections.auto && (
              <div className="border-t border-gray-800 px-1 pb-1">
                <div className="mb-1 mt-1 grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => setAllForSection("auto", true)} className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-200 hover:bg-gray-800">Alles aan</button>
                  <button type="button" onClick={() => setAllForSection("auto", false)} className="rounded border border-gray-700 px-2 py-1 text-[10px] text-gray-200 hover:bg-gray-800">Alles uit</button>
                </div>
                <>
            {likedAutoGenre && (
              <label
                className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                  selectedGenreIds.includes(likedAutoGenre.id)
                    ? "bg-fuchsia-600/25 text-fuchsia-100"
                    : "text-fuchsia-200 hover:bg-gray-800 hover:text-white"
                }`}
              >
                <span className="mr-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedGenreIds.includes(likedAutoGenre.id)}
                    onChange={() => toggleSelection(likedAutoGenre.id)}
                    className="h-3.5 w-3.5 cursor-pointer accent-fuchsia-500"
                  />
                  <span className="truncate">{likedAutoGenre.label}</span>
                </span>
                <span className="ml-2 text-[10px] text-gray-500">AUTO</span>
              </label>
            )}
            {groupedAutoSections.map((section) => {
              const parentAutoId = `auto:${section.parent.id}`;
              const parentActive = selectedGenreIds.includes(parentAutoId);
              return (
                <div key={section.id} className="mb-1 last:mb-0">
                  <label
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                      parentActive
                        ? "bg-fuchsia-600/25 text-fuchsia-100"
                        : "text-fuchsia-200 hover:bg-gray-800 hover:text-white"
                    }`}
                  >
                    <span className="mr-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={parentActive}
                        onChange={() => toggleSelection(parentAutoId)}
                        className="h-3.5 w-3.5 cursor-pointer accent-fuchsia-500"
                      />
                      <span className="truncate">{section.parent.name}</span>
                    </span>
                    {isGroupedParentGenre(section.parent.id) && (
                      <span className="ml-2 text-[10px] text-gray-500">alles</span>
                    )}
                  </label>
                  {section.children.map((genre) => {
                    const childAutoId = `auto:${genre.id}`;
                    const isActive = selectedGenreIds.includes(childAutoId);
                    return (
                      <label
                        key={`${section.id}:${genre.id}`}
                        className={`ml-2 mt-0.5 flex w-[calc(100%-0.5rem)] items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                          isActive
                            ? "bg-violet-600/25 text-violet-100"
                            : "text-gray-300 hover:bg-gray-800 hover:text-white"
                        }`}
                      >
                        <span className="mr-2 flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={isActive}
                            onChange={() => toggleSelection(childAutoId)}
                            className="h-3.5 w-3.5 cursor-pointer accent-violet-500"
                          />
                          <span className="truncate">- {genre.name}</span>
                        </span>
                        <span className="ml-2 text-[10px] text-gray-500">AUTO</span>
                      </label>
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
              </div>
            )}
          </div>
          <div className="rounded-md border border-gray-800 bg-gray-900/70">
            <button
              type="button"
              onClick={() => setSectionOpen("playlists")}
              className="flex w-full items-center justify-between px-2 py-1.5 text-left text-[11px] font-semibold text-gray-200"
            >
              <span>Playlists ({sharedPlaylists.length})</span>
              <span>{openSections.playlists ? "▾" : "▸"}</span>
            </button>
            {openSections.playlists && (
              <div className="border-t border-gray-800 px-1 pb-1">
            <div className="mb-1 rounded-md border border-gray-800 bg-gray-900/70 p-1.5">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold text-gray-300">Playlist selectie</p>
                <button
                  type="button"
                  onClick={() => setShowFallbackHelp((prev) => !prev)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-gray-700 text-[10px] text-gray-300 transition hover:border-violet-500 hover:text-white"
                  aria-label="Hoe werkt autoplay fallback?"
                  title="Hoe werkt autoplay fallback?"
                >
                  ?
                </button>
              </div>
              {showFallbackHelp && (
                <div className="mb-1 rounded border border-violet-700/40 bg-violet-900/20 px-2 py-1 text-[10px] leading-relaxed text-violet-100">
                  Vink meerdere playlists aan voor een mix. De speler verdeelt tracks netjes over de geselecteerde playlists.
                  Als een track niet gevonden wordt, probeert hij de volgende kandidaat automatisch.
                </div>
              )}
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setAllForSection("playlists", true)}
                  className="rounded border border-gray-700 px-2 py-1 text-[11px] font-semibold text-gray-200 transition hover:bg-gray-800"
                >
                  Alles aan
                </button>
                <button
                  type="button"
                  onClick={() => setAllForSection("playlists", false)}
                  className="rounded border border-gray-700 px-2 py-1 text-[11px] font-semibold text-gray-200 transition hover:bg-gray-800"
                >
                  Alles uit
                </button>
              </div>
            </div>
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
            <select
              value={playlistSortMode}
              onChange={(e) => setPlaylistSortMode(e.target.value as PlaylistSortMode)}
              className="mb-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white"
            >
              <option value="name_asc">Sortering: Naam A-Z</option>
              <option value="name_desc">Sortering: Naam Z-A</option>
              <option value="tracks_desc">Sortering: Meeste tracks</option>
            </select>
            <div className="mb-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setPlaylistViewMode("grouped")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  playlistViewMode === "grouped" ? "bg-violet-600/30 text-violet-100" : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Op genre
              </button>
              <button
                type="button"
                onClick={() => setPlaylistViewMode("all")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  playlistViewMode === "all" ? "bg-violet-600/30 text-violet-100" : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Alle playlists
              </button>
            </div>
            {playlistViewMode === "grouped" ? groupedSharedPlaylists.map((genreGroup) => (
              <div key={`genre:${genreGroup.genreLabel}`} className="mb-1 rounded border border-gray-800 bg-gray-900/50 p-1">
                <p className="px-1 py-0.5 text-[11px] font-semibold text-violet-100">
                  {genreGroup.genreLabel} ({genreGroup.subgroups.reduce((acc, subgroup) => acc + subgroup.items.length, 0)})
                </p>
                <div className="mt-1 space-y-1">
                  {genreGroup.subgroups.map((subgroup) => (
                    <div key={`sub:${genreGroup.genreLabel}:${subgroup.subgenreLabel}`} className="rounded border border-gray-800/80 bg-gray-900/40 p-1">
                      <p className="text-[10px] font-semibold text-gray-300">
                        {subgroup.subgenreLabel} ({subgroup.items.length})
                      </p>
                      <div className="mt-1 space-y-0.5">
                        {subgroup.items.map((playlist) => {
                          const isActive = selectedSharedGenres.includes(playlist.id);
                          return (
                            <label
                              key={playlist.id}
                              className={`flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                                isActive
                                  ? "bg-violet-600/25 text-violet-100"
                                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
                              }`}
                            >
                              <span className="mr-2 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={isActive}
                                  onChange={() => {
                                    const next = isActive
                                      ? selectedSharedGenres.filter((id) => id !== playlist.id)
                                      : [...selectedSharedGenres, playlist.id];
                                    const safeNext = next.length > 0 ? next : [playlist.id];
                                    emitSharedSelection(safeNext);
                                  }}
                                  className="h-3.5 w-3.5 cursor-pointer accent-violet-500"
                                />
                                <span className="truncate">{playlist.label.replace(/^Playlist ·\s*/i, "")}</span>
                              </span>
                              <span className="ml-2 text-[10px] text-gray-500">{playlist.trackCount}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )) : sortedSharedPlaylists.map((playlist) => {
              const isActive = selectedSharedGenres.includes(playlist.id);
              return (
                <label
                  key={playlist.id}
                  className={`mb-0.5 flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                    isActive
                      ? "bg-violet-600/25 text-violet-100"
                      : "text-gray-300 hover:bg-gray-800 hover:text-white"
                  }`}
                >
                  <span className="mr-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => {
                        const next = isActive
                          ? selectedSharedGenres.filter((id) => id !== playlist.id)
                          : [...selectedSharedGenres, playlist.id];
                        const safeNext = next.length > 0 ? next : [playlist.id];
                        emitSharedSelection(safeNext);
                      }}
                      className="h-3.5 w-3.5 cursor-pointer accent-violet-500"
                    />
                    <span className="truncate">{playlist.label.replace(/^Playlist ·\s*/i, "")}</span>
                  </span>
                  <span className="ml-2 text-[10px] text-gray-500">{playlist.trackCount}</span>
                </label>
              );
            })}
            {selectedSharedGenres.length > 1 && (
              <div className="mb-1 rounded-md border border-violet-700/40 bg-violet-900/20 px-2 py-1 text-[10px] text-violet-100">
                Mix actief: {selectedSharedGenres.length} playlists
              </div>
            )}
            {sharedPlaylists.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-gray-400">
                Geen publieke playlists beschikbaar.
              </p>
            )}
              </div>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}
