"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { useRadioStore } from "@/lib/radioStore";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { getRadioToken } from "@/lib/auth";
import { useAuth } from "@/lib/authContext";
import {
  buildGroupedGenreSections,
  GENRE_FALLBACK_OPTIONS,
  isGroupedParentGenre,
  type GenreDropdownSection,
} from "@/lib/genreDropdown";
import type { GenreOption } from "@/lib/radioApi";

type PlaylistSortMode = "name_asc" | "name_desc" | "tracks_desc" | "owner_asc";
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

function cleanFallbackLabel(label: string): string {
  return label
    .replace(/^Playlist ·\s*/i, "")
    .trim();
}

function groupSharedPlaylistsByGenre(
  playlists: Array<{
    id: string;
    label: string;
    trackCount: number;
    genre_group?: string | null;
    subgenre?: string | null;
    owner_username?: string | null;
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
      owner_username?: string | null;
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
    owner_username?: string | null;
  }>,
  mode: PlaylistSortMode,
): Array<{
  id: string;
  label: string;
  trackCount: number;
  genre_group?: string | null;
  subgenre?: string | null;
  owner_username?: string | null;
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
  if (mode === "owner_asc") {
    copy.sort((a, b) => {
      const ownerA = (a.owner_username ?? "").trim().toLowerCase();
      const ownerB = (b.owner_username ?? "").trim().toLowerCase();
      if (ownerA !== ownerB) return ownerA.localeCompare(ownerB, "nl");
      return a.label.localeCompare(b.label, "nl");
    });
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
  const { userAccount } = useAuth();
  const connected = useRadioStore((s) => s.connected);
  const genres = useRadioStore((s) => s.fallbackGenres);
  const activeGenre = useRadioStore((s) => s.activeFallbackGenre);
  const activeGenres = useRadioStore((s) => s.activeFallbackGenres);
  const activeGenreBy = useRadioStore((s) => s.activeFallbackGenreBy);
  const sharedPlaybackMode = useRadioStore((s) => s.activeFallbackSharedMode);
  const activePresetName = useRadioStore((s) => s.activeFallbackPresetName);
  const lockAutoplayFallback = useRadioStore((s) => s.lockAutoplayFallback);
  const hideLocalDiscovery = useRadioStore((s) => s.hideLocalDiscovery);
  const isAdmin = useIsAdmin();
  const fallbackChangeBlocked = lockAutoplayFallback && !isAdmin;
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [menuLayout, setMenuLayout] = useState<{ top: number; left: number; width: number } | null>(null);
  const [activeSection, setActiveSection] = useState<FallbackSection>("local");
  const [playlistSortMode, setPlaylistSortMode] = useState<PlaylistSortMode>("name_asc");
  const [playlistViewMode, setPlaylistViewMode] = useState<PlaylistViewMode>("grouped");
  const [presets, setPresets] = useState<SharedFallbackPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [showPresetsPanel, setShowPresetsPanel] = useState(false);
  const [optimisticSelectedGenreIds, setOptimisticSelectedGenreIds] = useState<string[] | null>(null);

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

  const selectedGenreIds = useMemo(() => {
    const explicit = Array.from(new Set(activeGenres ?? []));
    if (explicit.length > 0) return explicit;
    return activeGenre ? [activeGenre] : [];
  }, [activeGenres, activeGenre]);

  const effectiveSelectedGenreIds = optimisticSelectedGenreIds ?? selectedGenreIds;
  const selectedSharedGenres = useMemo(
    () => effectiveSelectedGenreIds.filter((id) => id.startsWith("shared:") || id.startsWith("user:")),
    [effectiveSelectedGenreIds],
  );

  useEffect(() => {
    if (!optimisticSelectedGenreIds) return;
    const expected = new Set(optimisticSelectedGenreIds);
    const actual = new Set(selectedGenreIds);
    if (expected.size !== actual.size) return;
    for (const id of expected) {
      if (!actual.has(id)) return;
    }
    setOptimisticSelectedGenreIds(null);
  }, [optimisticSelectedGenreIds, selectedGenreIds]);

  function getSectionForGenreId(id: string): FallbackSection {
    if (id.startsWith("shared:") || id.startsWith("user:")) return "playlists";
    if (id.startsWith("auto:")) return "auto";
    return "local";
  }

  function getSectionIds(section: FallbackSection): string[] {
    if (section === "local") return localGenres.map((g) => g.id);
    if (section === "auto") return autoGenres.map((g) => g.id);
    return sharedPlaylists.map((g) => g.id);
  }

  function pickRandomSectionId(section: FallbackSection): string | null {
    const options = getSectionIds(section);
    if (options.length === 0) return null;
    const index = Math.floor(Math.random() * options.length);
    return options[index] ?? null;
  }
  const shouldRender = connected && sortedGenres.length > 0;
  const activeLabel = useMemo(() => {
    if (activePresetName) {
      return activePresetName;
    }
    // Als er meerdere playlists geselecteerd zijn, toon het aantal
    if (selectedSharedGenres.length > 1) {
      return `${selectedSharedGenres.length} playlists`;
    }
    // Als er 1 playlist geselecteerd is, toon de naam
    if (selectedSharedGenres.length === 1) {
      const first = sortedGenres.find((g) => g.id === selectedSharedGenres[0]);
      return first ? cleanFallbackLabel(first.label) : "Playlist";
    }
    // Als actieve genre een playlist is, toon alleen de naam
    if (activeGenre?.startsWith("shared:")) {
      const playlist = sortedGenres.find((g) => g.id === activeGenre);
      return playlist ? cleanFallbackLabel(playlist.label) : "Playlist";
    }
    const activeGenreLabel = sortedGenres.find((g) => g.id === activeGenre)?.label;
    return activeGenreLabel ? cleanFallbackLabel(activeGenreLabel) : activeGenre ?? "Kies genre";
  }, [sortedGenres, activeGenre, selectedSharedGenres, activePresetName]);

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
      if (!menuRef.current?.open || !summaryRef.current) return;
      const rect = summaryRef.current.getBoundingClientRect();
      const top = Math.max(8, Math.round(rect.bottom + 8));
      if (isMobile) {
        setMenuLayout({ top, left: 0, width: window.innerWidth });
        return;
      }
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8));
      const width = Math.min(Math.max(rect.width, 320), window.innerWidth - left - 8);
      setMenuLayout({ top, left, width });
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
    if (fallbackChangeBlocked) return;
    const selectedBy = userAccount?.username?.trim() || localStorage.getItem("nickname")?.trim() || undefined;
    const normalized = Array.from(new Set(nextSelected.filter((id) => id.startsWith("shared:") || id.startsWith("user:"))));
    const primary = normalized[0] ?? activeGenre ?? null;
    if (!primary) return;
    const selectedLabel = sortedSharedPlaylists.find((playlist) => playlist.id === primary)?.label ?? primary;
    getSocket().emit("fallback:genre:set", {
      genreId: primary,
      genreIds: normalized,
      selectedBy,
      selectedLabel,
      sharedPlaybackMode,
      token: getRadioToken() ?? undefined,
    });
  }

  function emitSelection(nextSelected: string[]): void {
    if (fallbackChangeBlocked) return;
    const selectedBy = userAccount?.username?.trim() || localStorage.getItem("nickname")?.trim() || undefined;
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
      token: getRadioToken() ?? undefined,
    });
  }

  function applySectionSelection(section: FallbackSection, ids: string[]): void {
    const sectionOnly = Array.from(new Set(ids.filter((id) => getSectionForGenreId(id) === section)));
    if (sectionOnly.length === 0) return;
    setActiveSection(section);
    setOptimisticSelectedGenreIds(sectionOnly);
    if (section === "playlists") {
      emitSharedSelection(sectionOnly);
      return;
    }
    emitSelection(sectionOnly);
  }

  function toggleSelection(id: string): void {
    const section = getSectionForGenreId(id);
    const sectionSelected = effectiveSelectedGenreIds.filter((entry) => getSectionForGenreId(entry) === section);
    const isActive = sectionSelected.includes(id);
    let next = isActive
      ? sectionSelected.filter((entry) => entry !== id)
      : [...sectionSelected, id];
    
    // Safety check: if unselecting the last item, pick a random one in the same section
    if (next.length === 0) {
      const randomFallback = pickRandomSectionId(section);
      if (randomFallback) next = [randomFallback];
    }
    
    // Apply to server
    applySectionSelection(section, next);
  }

  function setAllForSection(section: FallbackSection, enabled: boolean): void {
    const sectionIds = getSectionIds(section);
    if (sectionIds.length === 0) return;
    
    if (enabled) {
      applySectionSelection(section, sectionIds);
      return;
    }
    
    const fallbackId = pickRandomSectionId(section);
    if (fallbackId) {
      applySectionSelection(section, [fallbackId]);
    }
  }

  function applyPreset(preset: SharedFallbackPreset): void {
    if (fallbackChangeBlocked) return;
    const selectedBy = userAccount?.username?.trim() || localStorage.getItem("nickname")?.trim() || undefined;
    const baseSection = preset.genreIds[0] ? getSectionForGenreId(preset.genreIds[0]) : null;
    if (!baseSection) return;
    const sameSectionIds = preset.genreIds.filter((id) => getSectionForGenreId(id) === baseSection);
    if (sameSectionIds.length === 0) return;
    if (baseSection === "playlists") {
      getSocket().emit("fallback:shared:mode:set", {
        mode: preset.sharedPlaybackMode,
        selectedBy,
        token: getRadioToken() ?? undefined,
      });
    }
    applySectionSelection(baseSection, sameSectionIds);
  }

  function savePreset(): void {
    const name = presetName.trim();
    const currentSectionSelected = selectedGenreIds.filter((id) => getSectionForGenreId(id) === activeSection);
    if (!name || currentSectionSelected.length === 0) return;
    const selectedBy = userAccount?.username?.trim() || localStorage.getItem("nickname")?.trim() || undefined;
    getSocket().emit("fallback:preset:save", {
      name,
      genreIds: currentSectionSelected,
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
        activeSection: FallbackSection;
        openSections: Record<FallbackSection, boolean>;
      }>;
      if (parsed.playlistSortMode) setPlaylistSortMode(parsed.playlistSortMode);
      if (parsed.playlistViewMode) setPlaylistViewMode(parsed.playlistViewMode);
      if (parsed.activeSection) {
        setActiveSection(parsed.activeSection);
      } else if (parsed.openSections) {
        if (parsed.openSections.playlists) setActiveSection("playlists");
        else if (parsed.openSections.auto) setActiveSection("auto");
        else setActiveSection("local");
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
      activeSection,
    });
    localStorage.setItem(getStorageKey(), payload);
    localStorage.setItem(getLegacyStorageKey(), payload);
  }, [playlistSortMode, playlistViewMode, activeSection]);

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

  const [shouldScroll, setShouldScroll] = useState(false);
  const marqueeContainerRef = useRef<HTMLSpanElement>(null);
  const marqueeTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const checkScroll = () => {
      if (marqueeContainerRef.current && marqueeTextRef.current) {
        const containerWidth = marqueeContainerRef.current.offsetWidth;
        const textWidth = marqueeTextRef.current.scrollWidth;
        setShouldScroll(textWidth > containerWidth);
      }
    };
    checkScroll();
    window.addEventListener("resize", checkScroll);
    return () => window.removeEventListener("resize", checkScroll);
  }, [activeLabel]);

  if (!shouldRender) return null;

  return (
    <details
      ref={menuRef}
      className="group relative z-[260]"
      onToggle={(e) => {
        if (fallbackChangeBlocked) {
          e.preventDefault();
          return;
        }
        if (!menuRef.current?.open || !summaryRef.current) {
          setMenuLayout(null);
          return;
        }
        const rect = summaryRef.current.getBoundingClientRect();
        const top = Math.max(8, Math.round(rect.bottom + 8));
        if (isMobile) {
          setMenuLayout({ top, left: 0, width: window.innerWidth });
          return;
        }
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8));
        const width = Math.min(Math.max(rect.width, 320), window.innerWidth - left - 8);
        setMenuLayout({ top, left, width });
      }}
    >
      <summary 
        ref={summaryRef} 
        onClick={(e) => { if (fallbackChangeBlocked) { e.preventDefault(); } }}
        className={`grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-gray-700 bg-gray-900/75 px-2.5 py-1.5 text-xs text-gray-200 transition ${fallbackChangeBlocked ? 'cursor-not-allowed opacity-70' : 'hover:border-violet-500/60'}`}
      >
        <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold text-gray-300">
          Genre
        </span>
        <span className="flex min-w-0 items-center justify-center gap-1.5 truncate text-center text-[12px] font-semibold text-violet-300">
          {lockAutoplayFallback && (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 1a3 3 0 00-3 3v2H5a2 2 0 00-2 2v8a2 2 0 002 2h10a2 2 0 002-2V8a2 2 0 00-2-2h-2V4a3 3 0 00-3-3zM8 9a1 1 0 10-2 0v1a1 1 0 102 0V9zm4 0a1 1 0 10-2 0v1a1 1 0 102 0V9z" clipRule="evenodd" />
            </svg>
          )}
          <span ref={marqueeContainerRef} className="marquee-container relative block flex-1 overflow-hidden">
            <span
              ref={marqueeTextRef}
              className={`block whitespace-nowrap ${shouldScroll ? "marquee-text" : ""}`}
              style={{
                animation: shouldScroll ? 'marquee-scroll-slow 14s linear infinite' : 'none',
                display: 'inline-block',
              }}
            >
              {activeLabel}
              {shouldScroll && (
                <span aria-hidden="true" className="mx-8">{activeLabel}</span>
              )}
            </span>
          </span>
        </span>
        <span className="justify-self-end text-gray-400 transition group-open:rotate-180">▾</span>
      </summary>
      <div
        className="fixed z-[270] overflow-y-auto rounded-md border border-gray-700 bg-gray-900/95 p-1 shadow-lg shadow-black/40 sm:max-h-60"
        style={
          menuLayout !== null
            ? { top: menuLayout.top, left: menuLayout.left, width: menuLayout.width, maxHeight: `calc(100dvh - ${menuLayout.top + 8}px)` }
            : undefined
        }
      >
        <div className="sticky top-0 z-10 mb-1 flex items-center justify-between rounded-md border border-gray-800 bg-gray-900 px-2 py-1.5 shadow-sm">
          <div className="text-[10px] font-semibold text-gray-200">Fallback instellen</div>
          {isMobile && (
            <button
              type="button"
              onClick={() => { if (menuRef.current) menuRef.current.open = false; }}
              className="rounded bg-gray-800 px-2 py-0.5 text-[10px] font-bold text-violet-300"
            >
              Sluiten
            </button>
          )}
        </div>
        <div className="mb-1 rounded-md border border-gray-800 bg-gray-900/70 px-2 py-1">
          <div className="mb-1 text-[10px] font-semibold text-gray-200">Actief:</div>
          {selectedGenreIds.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {effectiveSelectedGenreIds
                .slice(0, 4)
                .map((id) => {
                  const label = sortedGenres.find((genre) => genre.id === id)?.label ?? id;
                  return (
                    <div key={id} className="text-[10px] text-gray-300 truncate">
                      {label}
                    </div>
                  );
                })}
              {effectiveSelectedGenreIds.length > 4 && (
                <div className="text-[9px] text-gray-400">
                  +{effectiveSelectedGenreIds.length - 4} meer
                </div>
              )}
            </div>
          ) : (
            <div className="text-[10px] text-gray-300">geen selectie</div>
          )}
        </div>
        {activeGenreBy && (
          <p className="mb-1 px-2 py-0.5 text-[10px] text-gray-400">
            Gekozen door: <span className="text-violet-300">{activeGenreBy}</span>
          </p>
        )}
        {lockAutoplayFallback && !getRadioToken() && (
          <p className="mb-1 rounded-md border border-amber-800/60 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-100">
            Autoplay is <span className="font-semibold">vergrendeld</span>. Alleen met het radio admin-token (zoals in het admin-dashboard) kun je dit wijzigen.
          </p>
        )}
        <div
          className={`mb-1 grid gap-1 rounded-md bg-gray-800/60 p-1 ${
            hideLocalDiscovery ? "grid-cols-2" : "grid-cols-3"
          }`}
        >
          {!hideLocalDiscovery && (
          <button
            type="button"
            onClick={() => setActiveSection("local")}
            className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
              activeSection === "local" ? "bg-violet-600 text-white shadow-sm" : "text-gray-400 hover:text-white"
            }`}
          >
            Lokaal ({localGenres.length})
          </button>
          )}
          <button
            type="button"
            onClick={() => setActiveSection("auto")}
            className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
              activeSection === "auto" ? "bg-violet-600 text-white shadow-sm" : "text-gray-400 hover:text-white"
            }`}
          >
            Online ({autoGenreCanonicalCount + (likedAutoGenre ? 1 : 0)})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection("playlists")}
            className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition ${
              activeSection === "playlists" ? "bg-violet-600 text-white shadow-sm" : "text-gray-400 hover:text-white"
            }`}
          >
            Playlists ({sharedPlaylists.length})
          </button>
        </div>
        <div className="mb-1">
          <button
            type="button"
            onClick={() => setShowPresetsPanel((prev) => !prev)}
            className="flex w-full items-center justify-between rounded-md border border-gray-800 bg-gray-900/70 px-2 py-1 text-[10px] font-semibold text-gray-200 transition hover:bg-gray-800"
          >
            <span>Presetbeheer</span>
            <span className={`text-gray-400 transition ${showPresetsPanel ? "rotate-180" : ""}`}>▾</span>
          </button>
          {showPresetsPanel && (
            <div className="mt-1 rounded-md border border-gray-800 bg-gray-900/70 p-1.5">
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
              <div className="max-h-20 space-y-1 overflow-y-auto pr-1">
                {presets.length === 0 ? (
                  <p className="text-[10px] text-gray-500">Nog geen presets.</p>
                ) : (
                  presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className="flex w-full items-center justify-between rounded border border-gray-700 bg-gray-800/70 px-2 py-1 text-left text-[10px] text-gray-200 transition hover:border-violet-500/70 hover:bg-gray-800"
                    >
                      <span className="truncate">{preset.name}{preset.createdBy ? ` (${preset.createdBy})` : ''}</span>
                      <span className="ml-2 text-gray-500">{preset.genreIds.length}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <div className="rounded-md border border-gray-800 bg-gray-900/70 p-1">
          <div className="mb-1 grid grid-cols-2 gap-1">
            <button type="button" disabled={fallbackChangeBlocked} onClick={() => setAllForSection(activeSection, true)} className="rounded border border-gray-700 px-2 py-1 text-[10px] font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50">Alles aan</button>
            <button type="button" disabled={fallbackChangeBlocked} onClick={() => setAllForSection(activeSection, false)} className="rounded border border-gray-700 px-2 py-1 text-[10px] font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50">Alles uit</button>
          </div>
          {activeSection === "local" && (
            <>
              {localGenres.map((genre) => {
                const isActive = effectiveSelectedGenreIds.includes(genre.id);
                return (
                  <label
                    key={genre.id}
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
                        disabled={fallbackChangeBlocked}
                        onChange={() => toggleSelection(genre.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                      <span className="truncate">{genre.label}</span>
                    </span>
                    <span className="ml-2 text-[10px] text-gray-500">{genre.trackCount}</span>
                  </label>
                );
              })}
              {localGenres.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-gray-400">Geen genres beschikbaar in Lokaal.</p>
              )}
            </>
          )}
          {activeSection === "auto" && (
            <>
              {likedAutoGenre && (
                <label
                  className={`mb-0.5 flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                    effectiveSelectedGenreIds.includes(likedAutoGenre.id)
                      ? "bg-fuchsia-600/25 text-fuchsia-100"
                      : "text-fuchsia-200 hover:bg-gray-800 hover:text-white"
                  }`}
                >
                  <span className="mr-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={effectiveSelectedGenreIds.includes(likedAutoGenre.id)}
                      disabled={fallbackChangeBlocked}
                      onChange={() => toggleSelection(likedAutoGenre.id)}
                      className="h-3.5 w-3.5 cursor-pointer accent-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <span className="truncate">{likedAutoGenre.label}</span>
                  </span>
                  <span className="ml-2 text-[10px] text-gray-500">AUTO</span>
                </label>
              )}
              {groupedAutoSections.map((section) => {
                const parentAutoId = `auto:${section.parent.id}`;
                const parentActive = effectiveSelectedGenreIds.includes(parentAutoId);
                return (
                  <div key={section.id} className="mb-1 last:mb-0">
                    <label
                      className={`flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                        parentActive
                          ? "bg-fuchsia-600/25 text-fuchsia-100"
                          : "text-fuchsia-200 hover:bg-gray-800 hover:text-white"
                      }`}
                    >
                      <span className="mr-2 flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={parentActive}
                          disabled={fallbackChangeBlocked}
                          onChange={() => toggleSelection(parentAutoId)}
                          className="h-3.5 w-3.5 cursor-pointer accent-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                        <span className="truncate">{section.parent.name}</span>
                      </span>
                      {isGroupedParentGenre(section.parent.id) && (
                        <span className="ml-2 text-[10px] text-gray-500">alles</span>
                      )}
                    </label>
                    {section.children.map((genre) => {
                      const childAutoId = `auto:${genre.id}`;
                      const isActive = effectiveSelectedGenreIds.includes(childAutoId);
                      return (
                        <label
                          key={`${section.id}:${genre.id}`}
                          className={`ml-2 mt-0.5 flex w-[calc(100%-0.5rem)] cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition ${
                            isActive
                              ? "bg-violet-600/25 text-violet-100"
                              : "text-gray-300 hover:bg-gray-800 hover:text-white"
                          }`}
                        >
                          <span className="mr-2 flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isActive}
                              disabled={fallbackChangeBlocked}
                              onChange={() => toggleSelection(childAutoId)}
                              className="h-3.5 w-3.5 cursor-pointer accent-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
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
                <p className="px-2 py-2 text-[11px] text-gray-400">Geen genres beschikbaar in Online.</p>
              )}
            </>
          )}
          {activeSection === "playlists" && (
            <>
              <p className="mb-1 px-0.5 text-[10px] text-gray-400">Weergave playlists</p>
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
                  Losse lijst
                </button>
              </div>
              <details className="mb-1 rounded border border-gray-800 bg-gray-900/55 p-1">
                <summary className="cursor-pointer list-none px-1 py-0.5 text-[10px] font-semibold text-gray-300">
                  Afspeel- en sorteeropties
                </summary>
                <div className="mt-1 space-y-1">
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (fallbackChangeBlocked) return;
                        const selectedBy = userAccount?.username?.trim() || localStorage.getItem("nickname")?.trim() || "onbekend";
                        getSocket().emit("fallback:shared:mode:set", {
                          mode: "random",
                          selectedBy,
                          token: getRadioToken() ?? undefined,
                        });
                      }}
                      disabled={fallbackChangeBlocked}
                      className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                        sharedPlaybackMode === "random"
                          ? "bg-violet-600/30 text-violet-100"
                          : "text-gray-300 hover:bg-gray-800"
                      } ${fallbackChangeBlocked ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      Mix willekeurig
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (fallbackChangeBlocked) return;
                        const selectedBy = userAccount?.username?.trim() || localStorage.getItem("nickname")?.trim() || "onbekend";
                        getSocket().emit("fallback:shared:mode:set", {
                          mode: "ordered",
                          selectedBy,
                          token: getRadioToken() ?? undefined,
                        });
                      }}
                      disabled={fallbackChangeBlocked}
                      className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                        sharedPlaybackMode === "ordered"
                          ? "bg-violet-600/30 text-violet-100"
                          : "text-gray-300 hover:bg-gray-800"
                      } ${fallbackChangeBlocked ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      Per playlist op volgorde
                    </button>
                  </div>
                  <select
                    value={playlistSortMode}
                    onChange={(e) => setPlaylistSortMode(e.target.value as PlaylistSortMode)}
                    className="w-full sm:w-auto rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white max-w-full"
                  >
                    <option value="name_asc">Sortering: Naam A-Z</option>
                    <option value="name_desc">Sortering: Naam Z-A</option>
                    <option value="tracks_desc">Sortering: Meeste tracks</option>
                    <option value="owner_asc">Sortering: Eigenaar A-Z</option>
                  </select>
                </div>
              </details>
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
                            const isActive = effectiveSelectedGenreIds.includes(playlist.id);
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
                                    disabled={fallbackChangeBlocked}
                                    onChange={() => toggleSelection(playlist.id)}
                                    className="h-3.5 w-3.5 cursor-pointer accent-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                                  />
                                  <span className="truncate">{cleanFallbackLabel(playlist.label)}</span>
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
                const isActive = effectiveSelectedGenreIds.includes(playlist.id);
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
                        disabled={fallbackChangeBlocked}
                        onChange={() => toggleSelection(playlist.id)}
                        className="h-3.5 w-3.5 cursor-pointer accent-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                      <span className="truncate">{cleanFallbackLabel(playlist.label)}</span>
                    </span>
                    <span className="ml-2 text-[10px] text-gray-500">{playlist.trackCount}</span>
                  </label>
                );
              })}
              {selectedSharedGenres.length > 1 && (
                <div className="mt-1 rounded-md border border-violet-700/40 bg-violet-900/20 px-2 py-1 text-[10px] text-violet-100">
                  Mix actief: {selectedSharedGenres.length} playlists
                </div>
              )}
              {sharedPlaylists.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-gray-400">
                  Geen publieke playlists beschikbaar.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </details>
  );
}
