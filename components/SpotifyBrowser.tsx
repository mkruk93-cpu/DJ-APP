"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  isSpotifyConnected,
  isSpotifyConfigured,
  loginWithSpotify,
  disconnectSpotify,
  spotifyFetch,
  type SpotifyPlaylist,
  type SpotifyTrackItem,
  type SpotifyPaginatedResponse,
  type SpotifyUser,
} from "@/lib/spotify";
import {
  deleteUserPlaylist,
  getUserPlaylistTracksPage,
  getSharedPlaylistTracksPage,
  getSpotifyOembed,
  importUserPlaylistFiles,
  listAllSharedPlaylists,
  listUserPlaylists,
  type SharedPlaylist,
  type PlaylistGenreMetaInput,
  type UserPlaylist,
  type UserPlaylistTrack,
} from "@/lib/userPlaylistsApi";

interface SpotifyBrowserProps {
  onAddTrack: (track: {
    id?: string;
    query: string;
    artist?: string | null;
    title?: string | null;
    sourceType?: string | null;
    sourceGenre?: string | null;
    sourcePlaylist?: string | null;
  }) => Promise<"added" | "manual_select" | "error">;
  submitting: boolean;
  mode?: "all" | "playlistsOnly" | "spotifyOnly";
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type View = "playlists" | "tracks" | "importedTracks" | "sharedTracks";
type TrackSource = "liked" | "playlist" | null;
type PlaylistSortMode = "name_asc" | "name_desc" | "tracks_desc" | "newest";
type PlaylistViewMode = "grouped" | "all";
const IMPORTED_TRACK_PAGE_SIZE = 120;
const PLAYLIST_GENRE_GROUPS = [
  "Hard Dance",
  "Hardcore",
  "Hardstyle",
  "Nederlandstalig",
  "Electronic",
  "House",
  "Techno",
  "Trance",
  "Bass",
  "Rock/Metal",
  "Pop",
  "Hip-Hop",
  "Other",
];

function keepFieldVisibleOnMobile(target: HTMLElement): void {
  if (typeof window === "undefined") return;
  if (window.innerWidth >= 640) return;
  requestAnimationFrame(() => {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function normalizeBucketLabel(value: string | null | undefined, fallback: string): string {
  const safe = (value ?? "").trim();
  return safe || fallback;
}

function groupPlaylistsByGenre<T extends { name: string; genre_group: string | null; subgenre: string | null }>(
  playlists: T[],
): Array<{ genreLabel: string; subgroups: Array<{ subgenreLabel: string; items: T[] }> }> {
  const byGenre = new Map<string, Map<string, T[]>>();
  for (const playlist of playlists) {
    const genreLabel = normalizeBucketLabel(playlist.genre_group, "Overig");
    const subgenreLabel = normalizeBucketLabel(playlist.subgenre, "Algemeen");
    if (!byGenre.has(genreLabel)) byGenre.set(genreLabel, new Map<string, T[]>());
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

function sortPlaylists<T extends { name: string; track_count?: number; imported_at?: string; created_at?: string }>(
  items: T[],
  mode: PlaylistSortMode,
): T[] {
  const copy = items.slice();
  if (mode === "name_desc") {
    copy.sort((a, b) => b.name.localeCompare(a.name, "nl"));
    return copy;
  }
  if (mode === "tracks_desc") {
    copy.sort((a, b) => ((b.track_count ?? 0) - (a.track_count ?? 0)) || a.name.localeCompare(b.name, "nl"));
    return copy;
  }
  if (mode === "newest") {
    copy.sort((a, b) => {
      const aDate = a.imported_at ?? a.created_at ?? "";
      const bDate = b.imported_at ?? b.created_at ?? "";
      return bDate.localeCompare(aDate) || a.name.localeCompare(b.name, "nl");
    });
    return copy;
  }
  copy.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  return copy;
}

function getStorageKey(): string {
  if (typeof window === "undefined") return "spotify-browser:guest";
  const nickname = (localStorage.getItem("nickname") ?? "guest").trim().toLowerCase() || "guest";
  return `spotify-browser:${nickname}`;
}

function getLegacyStorageKey(): string {
  return "spotify-browser:guest";
}

export default function SpotifyBrowser({ onAddTrack, submitting, mode = "all" }: SpotifyBrowserProps) {
  const [connected, setConnected] = useState(false);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [tracks, setTracks] = useState<SpotifyTrackItem[]>([]);
  const [view, setView] = useState<View>("playlists");
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState("");
  const [addedTrackId, setAddedTrackId] = useState<string | null>(null);
  const [pendingTrackId, setPendingTrackId] = useState<string | null>(null);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [playlistsNext, setPlaylistsNext] = useState<string | null>(null);
  const [tracksNext, setTracksNext] = useState<string | null>(null);
  const [trackSource, setTrackSource] = useState<TrackSource>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importPlaylistName, setImportPlaylistName] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [savedSortMode, setSavedSortMode] = useState<PlaylistSortMode>("name_asc");
  const [sharedSortMode, setSharedSortMode] = useState<PlaylistSortMode>("name_asc");
  const [savedPlaylistViewMode, setSavedPlaylistViewMode] = useState<PlaylistViewMode>("grouped");
  const [sharedPlaylistViewMode, setSharedPlaylistViewMode] = useState<PlaylistViewMode>("grouped");
  const [collapsedSavedGenres, setCollapsedSavedGenres] = useState<string[]>([]);
  const [collapsedSavedSubgenres, setCollapsedSavedSubgenres] = useState<string[]>([]);
  const [collapsedSharedGenres, setCollapsedSharedGenres] = useState<string[]>([]);
  const [collapsedSharedSubgenres, setCollapsedSharedSubgenres] = useState<string[]>([]);
  const [hasStoredCollapseState, setHasStoredCollapseState] = useState(false);
  const [savedPlaylists, setSavedPlaylists] = useState<UserPlaylist[]>([]);
  const [savedPlaylistsLoading, setSavedPlaylistsLoading] = useState(false);
  const [savedTracks, setSavedTracks] = useState<UserPlaylistTrack[]>([]);
  const [savedTracksLoading, setSavedTracksLoading] = useState(false);
  const [savedTracksLoadingMore, setSavedTracksLoadingMore] = useState(false);
  const [savedTracksError, setSavedTracksError] = useState<string | null>(null);
  const [savedTracksOffset, setSavedTracksOffset] = useState(0);
  const [savedTracksHasMore, setSavedTracksHasMore] = useState(false);
  const [selectedSavedPlaylist, setSelectedSavedPlaylist] = useState<UserPlaylist | null>(null);
  const [sharedPlaylists, setSharedPlaylists] = useState<SharedPlaylist[]>([]);
  const [sharedPlaylistsLoading, setSharedPlaylistsLoading] = useState(false);
  const [sharedTracks, setSharedTracks] = useState<UserPlaylistTrack[]>([]);
  const [sharedTracksLoading, setSharedTracksLoading] = useState(false);
  const [sharedTracksLoadingMore, setSharedTracksLoadingMore] = useState(false);
  const [sharedTracksError, setSharedTracksError] = useState<string | null>(null);
  const [sharedTracksOffset, setSharedTracksOffset] = useState(0);
  const [sharedTracksHasMore, setSharedTracksHasMore] = useState(false);
  const [selectedSharedPlaylist, setSelectedSharedPlaylist] = useState<SharedPlaylist | null>(null);
  const [sharedUsage, setSharedUsage] = useState<{ playlists: number; tracks: number } | null>(null);
  const [importGenreGroup, setImportGenreGroup] = useState("");
  const [importSubgenre, setImportSubgenre] = useState("");
  const [importCoverUrl, setImportCoverUrl] = useState("");
  const [importAutoCover, setImportAutoCover] = useState(true);
  const [savedTrackThumbs, setSavedTrackThumbs] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const thumbnailLoadingRef = useRef<Set<string>>(new Set());
  const thumbnailQueueRef = useRef<string[]>([]);
  const thumbnailWorkersRef = useRef(0);
  const viewRef = useRef<View>("playlists");

  // Spotify functionaliteit
  // const configured = isSpotifyConfigured();
  // const showPlaylistSections = mode !== "spotifyOnly";
  // const showSpotifySection = mode !== "playlistsOnly";
  // const showSharedPlaylistsInSpotifyTab = false;
  // Nieuwe logica: alleen persoonlijke en nieuwe playlists tonen, geen Spotify connect/koppel
  const configured = false;
  const showPlaylistSections = true;
  const showSpotifySection = false;
  const showSharedPlaylistsInSpotifyTab = false;

  // Verwijder Spotify connect functionaliteit
  const checkConnection = useCallback(() => false, []);

  const backToPlaylists = useCallback(() => {
    setView("playlists");
    setTracks([]);
    setTracksNext(null);
    setTrackSource(null);
    setSavedTracks([]);
    setSavedTracksOffset(0);
    setSavedTracksHasMore(false);
    setSelectedSavedPlaylist(null);
    setSharedTracks([]);
    setSharedTracksOffset(0);
    setSharedTracksHasMore(false);
    setSelectedSharedPlaylist(null);
    setFilter("");
    setTrackError(null);
    setSavedTracksError(null);
    setSharedTracksError(null);
  }, []);

  useEffect(() => {
    if (showPlaylistSections) {
      void loadSavedPlaylists();
      if (showSharedPlaylistsInSpotifyTab) void loadSharedPlaylists();
    }
    // Spotify connectie niet meer nodig
  }, [showPlaylistSections, showSharedPlaylistsInSpotifyTab]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = () => {
      if (viewRef.current !== "playlists") {
        backToPlaylists();
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [backToPlaylists]);

  // Spotify connectie niet meer nodig

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(getStorageKey()) ?? localStorage.getItem(getLegacyStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<{
        showHelp: boolean;
        savedSortMode: PlaylistSortMode;
        sharedSortMode: PlaylistSortMode;
        savedPlaylistViewMode: PlaylistViewMode;
        sharedPlaylistViewMode: PlaylistViewMode;
        collapsedSavedGenres: string[];
        collapsedSavedSubgenres: string[];
        collapsedSharedGenres: string[];
        collapsedSharedSubgenres: string[];
        hasStoredCollapseState: boolean;
      }>;
      if (typeof parsed.showHelp === "boolean") setShowHelp(parsed.showHelp);
      if (parsed.savedSortMode) setSavedSortMode(parsed.savedSortMode);
      if (parsed.sharedSortMode) setSharedSortMode(parsed.sharedSortMode);
      if (parsed.savedPlaylistViewMode) setSavedPlaylistViewMode(parsed.savedPlaylistViewMode);
      if (parsed.sharedPlaylistViewMode) setSharedPlaylistViewMode(parsed.sharedPlaylistViewMode);
      if (Array.isArray(parsed.collapsedSavedGenres)) setCollapsedSavedGenres(parsed.collapsedSavedGenres);
      if (Array.isArray(parsed.collapsedSavedSubgenres)) setCollapsedSavedSubgenres(parsed.collapsedSavedSubgenres);
      if (Array.isArray(parsed.collapsedSharedGenres)) setCollapsedSharedGenres(parsed.collapsedSharedGenres);
      if (Array.isArray(parsed.collapsedSharedSubgenres)) setCollapsedSharedSubgenres(parsed.collapsedSharedSubgenres);
      if (typeof parsed.hasStoredCollapseState === "boolean") setHasStoredCollapseState(parsed.hasStoredCollapseState);
      else setHasStoredCollapseState(true);
    } catch {
      // Ignore invalid preferences.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify({
      showHelp,
      savedSortMode,
      sharedSortMode,
      savedPlaylistViewMode,
      sharedPlaylistViewMode,
      collapsedSavedGenres,
      collapsedSavedSubgenres,
      collapsedSharedGenres,
      collapsedSharedSubgenres,
      hasStoredCollapseState,
    });
    localStorage.setItem(getStorageKey(), payload);
    localStorage.setItem(getLegacyStorageKey(), payload);
  }, [
    showHelp,
    savedSortMode,
    sharedSortMode,
    savedPlaylistViewMode,
    sharedPlaylistViewMode,
    collapsedSavedGenres,
    collapsedSavedSubgenres,
    collapsedSharedGenres,
    collapsedSharedSubgenres,
    hasStoredCollapseState,
  ]);

  // Spotify connectie niet meer nodig

  async function loadSavedPlaylists() {
    setSavedPlaylistsLoading(true);
    try {
      const items = await listUserPlaylists();
      setSavedPlaylists(items);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Kon opgeslagen playlists niet laden.");
    } finally {
      setSavedPlaylistsLoading(false);
    }
  }

  async function loadSharedPlaylists() {
    setSharedPlaylistsLoading(true);
    try {
      const result = await listAllSharedPlaylists(250, 30);
      setSharedPlaylists(result.items);
      setSharedUsage(result.usage);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Kon gedeelde playlists niet laden.");
    } finally {
      setSharedPlaylistsLoading(false);
    }
  }

  async function loadSavedTracksPage(playlistId: string, append: boolean) {
    if (append) setSavedTracksLoadingMore(true);
    else setSavedTracksLoading(true);
    setSavedTracksError(null);
    try {
      const page = await getUserPlaylistTracksPage(
        playlistId,
        IMPORTED_TRACK_PAGE_SIZE,
        append ? savedTracksOffset : 0,
      );
      setSavedTracks((prev) => {
        if (!append) return page.items;
        const map = new Map<string, UserPlaylistTrack>();
        for (const item of prev) map.set(item.id, item);
        for (const item of page.items) map.set(item.id, item);
        return [...map.values()];
      });
      const nextOffset = page.paging.offset + page.items.length;
      setSavedTracksOffset(nextOffset);
      setSavedTracksHasMore(page.paging.hasMore);
    } catch (err) {
      setSavedTracksError(err instanceof Error ? err.message : "Kon tracks niet laden.");
      if (!append) {
        setSavedTracks([]);
        setSavedTracksOffset(0);
        setSavedTracksHasMore(false);
      }
    } finally {
      setSavedTracksLoading(false);
      setSavedTracksLoadingMore(false);
    }
  }

  async function openSavedPlaylist(playlist: UserPlaylist) {
    if (typeof window !== "undefined" && viewRef.current === "playlists") {
      window.history.pushState({ ...(window.history.state ?? {}), __inAppBack: "spotify-saved" }, "");
    }
    setSelectedSavedPlaylist(playlist);
    setSelectedSharedPlaylist(null);
    setView("importedTracks");
    setFilter("");
    setSavedTracks([]);
    setSavedTracksOffset(0);
    setSavedTracksHasMore(false);
    setSavedTracksError(null);
    await loadSavedTracksPage(playlist.id, false);
  }

  async function loadSharedTracksPage(playlistId: string, append: boolean) {
    if (append) setSharedTracksLoadingMore(true);
    else setSharedTracksLoading(true);
    setSharedTracksError(null);
    try {
      const page = await getSharedPlaylistTracksPage(
        playlistId,
        IMPORTED_TRACK_PAGE_SIZE,
        append ? sharedTracksOffset : 0,
      );
      setSharedTracks((prev) => {
        if (!append) return page.items;
        const map = new Map<string, UserPlaylistTrack>();
        for (const item of prev) map.set(item.id, item);
        for (const item of page.items) map.set(item.id, item);
        return [...map.values()];
      });
      const nextOffset = page.paging.offset + page.items.length;
      setSharedTracksOffset(nextOffset);
      setSharedTracksHasMore(page.paging.hasMore);
    } catch (err) {
      setSharedTracksError(err instanceof Error ? err.message : "Kon gedeelde tracks niet laden.");
      if (!append) {
        setSharedTracks([]);
        setSharedTracksOffset(0);
        setSharedTracksHasMore(false);
      }
    } finally {
      setSharedTracksLoading(false);
      setSharedTracksLoadingMore(false);
    }
  }

  async function openSharedPlaylist(playlist: SharedPlaylist) {
    if (typeof window !== "undefined" && viewRef.current === "playlists") {
      window.history.pushState({ ...(window.history.state ?? {}), __inAppBack: "spotify-shared" }, "");
    }
    setSelectedSharedPlaylist(playlist);
    setSelectedSavedPlaylist(null);
    setView("sharedTracks");
    setFilter("");
    setSharedTracks([]);
    setSharedTracksOffset(0);
    setSharedTracksHasMore(false);
    setSharedTracksError(null);
    await loadSharedTracksPage(playlist.id, false);
  }

  async function removeSavedPlaylist(playlist: UserPlaylist) {
    setImportError(null);
    try {
      await deleteUserPlaylist(playlist.id);
      setSavedPlaylists((prev) => prev.filter((p) => p.id !== playlist.id));
      if (selectedSavedPlaylist?.id === playlist.id) {
        setSelectedSavedPlaylist(null);
        setSavedTracks([]);
        setView("playlists");
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Verwijderen mislukt.");
    }
  }

  const resolveSavedTrackThumbnail = useCallback(async (spotifyUrl: string): Promise<void> => {
    if (savedTrackThumbs[spotifyUrl]) return;
    if (thumbnailLoadingRef.current.has(spotifyUrl)) return;
    thumbnailLoadingRef.current.add(spotifyUrl);
    try {
      const meta = await getSpotifyOembed(spotifyUrl);
      const thumb = (meta.thumbnail_url ?? "").trim();
      if (thumb) {
        setSavedTrackThumbs((prev) => ({ ...prev, [spotifyUrl]: thumb }));
      }
    } catch {
      // Thumbnails are optional; ignore metadata fetch failures.
    } finally {
      thumbnailLoadingRef.current.delete(spotifyUrl);
    }
  }, [savedTrackThumbs]);

  const pumpThumbnailQueue = useCallback(() => {
    const MAX_WORKERS = 6;
    while (thumbnailWorkersRef.current < MAX_WORKERS && thumbnailQueueRef.current.length > 0) {
      const nextUrl = thumbnailQueueRef.current.shift();
      if (!nextUrl) continue;
      thumbnailWorkersRef.current += 1;
      void resolveSavedTrackThumbnail(nextUrl).finally(() => {
        thumbnailWorkersRef.current = Math.max(0, thumbnailWorkersRef.current - 1);
        pumpThumbnailQueue();
      });
    }
  }, [resolveSavedTrackThumbnail]);

  async function handleImportExportify() {
    if (importFiles.length === 0) {
      setImportError("Kies eerst een .csv of .zip bestand.");
      return;
    }
    if (importFiles.length >= 2 && !importPlaylistName.trim()) {
      setImportError("Geef een playlistnaam op als je meerdere CSV's tegelijk importeert.");
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportStatus(null);
    try {
      const meta: PlaylistGenreMetaInput = {
        genre_group: importGenreGroup.trim() || null,
        subgenre: importSubgenre.trim() || null,
        cover_url: importCoverUrl.trim() || null,
        auto_cover: importAutoCover,
      };
      const result = await importUserPlaylistFiles(
        importFiles,
        meta,
        importPlaylistName.trim() || null,
      );
      const sharedInfo = result.shared
        ? ` · gedeeld: ${result.shared.importedPlaylists}`
        : "";
      setImportStatus(`Import klaar: ${result.totalPlaylists} playlist(s), ${result.totalTracks} tracks${sharedInfo}.`);
      setImportFiles([]);
      setImportPlaylistName("");
      setImportSubgenre("");
      setImportCoverUrl("");
      setImportAutoCover(true);
      await loadSavedPlaylists();
      if (showSharedPlaylistsInSpotifyTab) await loadSharedPlaylists();
      if (result.shared?.warnings?.length) {
        setImportError(`Shared waarschuwingen: ${result.shared.warnings.slice(0, 2).map((w) => `${w.name} (${w.reason})`).join(", ")}`);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import mislukt.");
    } finally {
      setImporting(false);
    }
  }

  const appendUniquePlaylists = useCallback((incoming: SpotifyPlaylist[], append: boolean) => {
    setPlaylists((prev) => {
      if (!append) return incoming;
      const map = new Map<string, SpotifyPlaylist>();
      for (const p of prev) map.set(p.id, p);
      for (const p of incoming) map.set(p.id, p);
      return [...map.values()];
    });
  }, []);

  const appendUniqueTracks = useCallback((incoming: SpotifyTrackItem[], append: boolean) => {
    setTracks((prev) => {
      if (!append) return incoming;
      const map = new Map<string, SpotifyTrackItem>();
      for (const t of prev) {
        const key = (t.id || `${t.name}-${t.artists?.map((a) => a?.name).join(",") || "unknown"}`).toLowerCase();
        map.set(key, t);
      }
      for (const t of incoming) {
        const key = (t.id || `${t.name}-${t.artists?.map((a) => a?.name).join(",") || "unknown"}`).toLowerCase();
        map.set(key, t);
      }
      return [...map.values()];
    });
  }, []);

  async function loadPlaylists(append: boolean) {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const url = append ? playlistsNext : "/me/playlists?limit=30";
      if (!url) return;
      const data = await spotifyFetch<SpotifyPaginatedResponse<SpotifyPlaylist>>(url);
      if (!data) {
        setAuthStatus("Spotify sessie verversen... probeer opnieuw.");
        checkConnection();
        return;
      }
      setAuthStatus(null);
      const items = data.items.filter((item) => !!item?.id && !!item?.name);
      appendUniquePlaylists(items, append);
      setPlaylistsNext(data.next ? data.next.replace("https://api.spotify.com/v1", "") : null);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  function isValidTrack(t: SpotifyTrackItem | null | undefined): t is SpotifyTrackItem {
    if (!t) return false;
    return !!(t.id || t.name);
  }

  async function loadPlaylistTracks(playlist: SpotifyPlaylist, append: boolean) {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setTrackError(null);
    try {
      const initialUrl = `/playlists/${playlist.id}/tracks?limit=50&additional_types=track&market=from_token`;
      const url = append ? tracksNext : initialUrl;
      if (!url) return;
      const data = await spotifyFetch<SpotifyPaginatedResponse<{ track: SpotifyTrackItem | null }>>(url);
      if (!data) {
        setAuthStatus("Spotify sessie verversen... probeer opnieuw.");
        setTrackError(`Kan playlist "${playlist.name}" nu niet laden.`);
        checkConnection();
        return;
      }
      setAuthStatus(null);
      const items = data.items
        .map((item) => item?.track)
        .filter((t): t is SpotifyTrackItem => isValidTrack(t));
      appendUniqueTracks(items, append);
      setTracksNext(data.next ? data.next.replace("https://api.spotify.com/v1", "") : null);
      if (!append && items.length === 0) {
        setTrackError(`Geen nummers gevonden in "${playlist.name}".`);
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  async function openPlaylist(playlist: SpotifyPlaylist) {
    if (typeof window !== "undefined" && viewRef.current === "playlists") {
      window.history.pushState({ ...(window.history.state ?? {}), __inAppBack: "spotify-playlist" }, "");
    }
    setSelectedPlaylist(playlist);
    setTrackSource("playlist");
    setView("tracks");
    setFilter("");
    setTracks([]);
    setTracksNext(null);
    await loadPlaylistTracks(playlist, false);
  }

  async function loadLikedSongs(append: boolean) {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setTrackError(null);
    try {
      const url = append ? tracksNext : "/me/tracks?limit=50";
      if (!url) return;
      const data = await spotifyFetch<SpotifyPaginatedResponse<{ track: SpotifyTrackItem | null }>>(url);
      if (!data) {
        setAuthStatus("Spotify sessie verversen... probeer opnieuw.");
        checkConnection();
        return;
      }
      setAuthStatus(null);
      const items = data.items
        .map((item) => item?.track)
        .filter((t): t is SpotifyTrackItem => isValidTrack(t));
      appendUniqueTracks(items, append);
      setTracksNext(data.next ? data.next.replace("https://api.spotify.com/v1", "") : null);
      if (!append && items.length === 0) {
        setTrackError("Geen nummers gevonden in Liked Songs.");
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  async function openLikedSongs() {
    if (typeof window !== "undefined" && viewRef.current === "playlists") {
      window.history.pushState({ ...(window.history.state ?? {}), __inAppBack: "spotify-liked" }, "");
    }
    setSelectedPlaylist({ id: "liked", name: "Liked Songs", images: [], tracks: { total: 0 }, owner: { display_name: "" } });
    setTrackSource("liked");
    setView("tracks");
    setFilter("");
    setTracks([]);
    setTracksNext(null);
    await loadLikedSongs(false);
  }

  async function handleAddTrack(track: SpotifyTrackItem) {
    const trackKey = track.id ?? `${track.name ?? "unknown"}:${track.artists?.map((a) => a?.name).join(",") ?? "unknown"}`;
    if (pendingTrackId === trackKey || addedTrackId === trackKey) return;
    setPendingTrackId(trackKey);
    setAddedTrackId(trackKey);
    try {
      const artists = track.artists?.map((a) => a?.name).filter(Boolean).join(", ") || "Unknown";
      const query = `${artists} - ${track.name ?? "Unknown"}`;
      const result = await onAddTrack({
        id: track.id ?? undefined,
        query,
        artist: artists,
        title: track.name ?? null,
        sourceType: "spotify",
      });
      if (result === "added") {
        setTimeout(() => setAddedTrackId(null), 3000);
      } else {
        setAddedTrackId(null);
      }
    } catch {
      setAddedTrackId(null);
    } finally {
      setPendingTrackId(null);
    }
  }

  async function handleAddSavedTrack(track: UserPlaylistTrack) {
    if (pendingTrackId === track.id || addedTrackId === track.id) return;
    setPendingTrackId(track.id);
    setAddedTrackId(track.id);
    try {
      const artist = (track.artist ?? "").trim();
      const title = (track.title ?? "").trim();
      const query = artist ? `${artist} - ${title}` : title;
      const playlistMeta = view === "sharedTracks" ? selectedSharedPlaylist : selectedSavedPlaylist;
      const sourceType = view === "sharedTracks" ? "shared_playlist" : "user_playlist";
      const sourceGenre = [playlistMeta?.genre_group, playlistMeta?.subgenre].filter(Boolean).join(" / ") || null;
      const result = await onAddTrack({
        query,
        artist: artist || null,
        title: title || null,
        sourceType,
        sourceGenre,
        sourcePlaylist: playlistMeta?.name ?? null,
      });
      if (result === "added") {
        setTimeout(() => setAddedTrackId(null), 3000);
      } else {
        setAddedTrackId(null);
      }
    } catch {
      setAddedTrackId(null);
    } finally {
      setPendingTrackId(null);
    }
  }

  function handleDisconnect() {
    disconnectSpotify();
    setConnected(false);
    setUser(null);
    setPlaylists([]);
    setTracks([]);
    setPlaylistsNext(null);
    setTracksNext(null);
    setTrackSource(null);
    setView("playlists");
  }

  async function loadMore() {
    if (loading || loadingMore) return;
    if (view === "playlists") {
      if (!spotifyEnabled) return;
      if (!playlistsNext) return;
      await loadPlaylists(true);
      return;
    }
    if (view === "importedTracks" && selectedSavedPlaylist) {
      if (savedTracksLoading || savedTracksLoadingMore || !savedTracksHasMore) return;
      await loadSavedTracksPage(selectedSavedPlaylist.id, true);
      return;
    }
    if (view === "sharedTracks" && selectedSharedPlaylist) {
      if (sharedTracksLoading || sharedTracksLoadingMore || !sharedTracksHasMore) return;
      await loadSharedTracksPage(selectedSharedPlaylist.id, true);
      return;
    }
    if (!tracksNext) return;
    if (trackSource === "liked") {
      await loadLikedSongs(true);
      return;
    }
    if (trackSource === "playlist" && selectedPlaylist) {
      await loadPlaylistTracks(selectedPlaylist, true);
    }
  }

  useEffect(() => {
    const root = listRef.current;
    const sentinel = loadMoreRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (!visible) return;
        void loadMore();
      },
      { root, rootMargin: "140px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    view,
    playlistsNext,
    tracksNext,
    trackSource,
    selectedPlaylist,
    selectedSavedPlaylist,
    selectedSharedPlaylist,
    savedTracksHasMore,
    sharedTracksHasMore,
    savedTracksLoading,
    savedTracksLoadingMore,
    sharedTracksLoading,
    sharedTracksLoadingMore,
    savedTracksOffset,
    sharedTracksOffset,
    loading,
    loadingMore,
  ]);

  useEffect(() => {
    if (!showSpotifySection) return;
    const onTokenRefresh = () => {
      setConnected(checkConnection());
      setAuthStatus("Spotify sessie vernieuwd.");
      if (view === "playlists") {
        void loadPlaylists(false);
        if (showPlaylistSections) {
          void loadSavedPlaylists();
          if (showSharedPlaylistsInSpotifyTab) void loadSharedPlaylists();
        }
        return;
      }
      if (trackSource === "liked") {
        void loadLikedSongs(false);
        return;
      }
      if (trackSource === "playlist" && selectedPlaylist) {
        void loadPlaylistTracks(selectedPlaylist, false);
      }
    };

    window.addEventListener("spotify:token_refreshed", onTokenRefresh);
    window.addEventListener("spotify:connected", onTokenRefresh);
    return () => {
      window.removeEventListener("spotify:token_refreshed", onTokenRefresh);
      window.removeEventListener("spotify:connected", onTokenRefresh);
    };
  }, [checkConnection, showPlaylistSections, showSpotifySection, view, trackSource, selectedPlaylist, showSharedPlaylistsInSpotifyTab]);

  const spotifyEnabled = false;
  const headerLabel = "Playlists";

  const filteredPlaylists = playlists.filter((p) =>
    p?.name?.toLowerCase().includes(filter.toLowerCase()),
  );
  const filteredSavedPlaylists = savedPlaylists.filter((playlist) =>
    playlist.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const filteredSharedPlaylists = sharedPlaylists.filter((playlist) =>
    playlist.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const sortedSavedPlaylists = useMemo(
    () => sortPlaylists(filteredSavedPlaylists, savedSortMode),
    [filteredSavedPlaylists, savedSortMode],
  );
  const sortedSharedPlaylists = useMemo(
    () => sortPlaylists(filteredSharedPlaylists, sharedSortMode),
    [filteredSharedPlaylists, sharedSortMode],
  );
  const groupedSavedPlaylists = useMemo(() => groupPlaylistsByGenre(sortedSavedPlaylists), [sortedSavedPlaylists]);
  const groupedSharedPlaylists = useMemo(() => groupPlaylistsByGenre(sortedSharedPlaylists), [sortedSharedPlaylists]);

  const filteredTracks = tracks.filter((t) => {
    if (!t?.name) return false;
    const q = filter.toLowerCase();
    return (
      t.name.toLowerCase().includes(q) ||
      t.artists?.some((a) => a?.name?.toLowerCase().includes(q)) === true
    );
  });

  const filteredSavedTracks = savedTracks.filter((track) => {
    const q = filter.toLowerCase();
    if (!q) return true;
    return (
      track.title.toLowerCase().includes(q) ||
      (track.artist ?? "").toLowerCase().includes(q) ||
      (track.album ?? "").toLowerCase().includes(q)
    );
  });

  const filteredSharedTracks = sharedTracks.filter((track) => {
    const q = filter.toLowerCase();
    if (!q) return true;
    return (
      track.title.toLowerCase().includes(q) ||
      (track.artist ?? "").toLowerCase().includes(q) ||
      (track.album ?? "").toLowerCase().includes(q)
    );
  });

  useEffect(() => {
    if (view !== "importedTracks" && view !== "sharedTracks") return;
    const visibleTracks = view === "sharedTracks" ? filteredSharedTracks : filteredSavedTracks;
    const uniqueUrls = Array.from(
      new Set(
        visibleTracks
          .map((track) => (track.spotify_url ?? "").trim())
          .filter((url) => url.startsWith("https://open.spotify.com/track/")),
      ),
    );
    for (const url of uniqueUrls) {
      if (savedTrackThumbs[url]) continue;
      if (thumbnailLoadingRef.current.has(url)) continue;
      if (thumbnailQueueRef.current.includes(url)) continue;
      thumbnailQueueRef.current.push(url);
    }
    pumpThumbnailQueue();
  }, [view, filteredSavedTracks, filteredSharedTracks, savedTrackThumbs, pumpThumbnailQueue]);

  return (
    <div className="flex h-[62dvh] max-h-[62dvh] min-h-0 flex-col gap-1.5 overflow-hidden pb-[max(env(safe-area-inset-bottom),4px)] sm:h-auto sm:max-h-[40vh] sm:pb-0">
      {/* Header + navigation */}
      <div className="flex shrink-0 items-center justify-between">
        {view !== "playlists" ? (
          <button
            type="button"
            onClick={backToPlaylists}
            className="flex items-center gap-1 text-xs text-violet-400 transition hover:text-violet-300"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            {view === "importedTracks"
              ? (selectedSavedPlaylist?.name ?? "Terug")
              : view === "sharedTracks"
                ? (selectedSharedPlaylist?.name ?? "Terug")
                : (selectedPlaylist?.name ?? "Terug")}
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <span className={`h-1.5 w-1.5 rounded-full ${spotifyEnabled ? "bg-[#1DB954]" : "bg-violet-400"}`} />
            {headerLabel}
          </div>
        )}
        <div className="flex items-center gap-1">
          {view === "playlists" && (
            <button
              type="button"
              onClick={() => setShowHelp((prev) => !prev)}
              className="rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-[11px] font-semibold text-gray-300 transition hover:border-violet-500 hover:text-white"
              title="Uitleg playlists"
            >
              ?
            </button>
          )}
          {spotifyEnabled && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="text-[11px] text-gray-500 transition hover:text-red-400"
            >
              Ontkoppel
            </button>
          )}
        </div>
      </div>
      {showHelp && view === "playlists" && (
        <div className="shrink-0 rounded-md border border-violet-800/60 bg-violet-950/20 p-2 text-[11px] text-violet-100">
          <p className="font-semibold">Wat doet dit?</p>
          <p className="mt-0.5 text-violet-100/90">
            Kies hier een Spotify playlist of een geïmporteerde playlist en voeg direct tracks toe aan de queue.
            Met Exportify importeer je CSV/ZIP bestanden; persoonlijke playlists blijven van jou.
          </p>
        </div>
      )}

      {/* Filter */}
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={view === "playlists" ? "Filter playlists..." : "Filter tracks..."}
        className="w-full shrink-0 rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 text-xs text-white placeholder-gray-500 outline-none transition focus:border-[#1DB954]"
      />
      {authStatus && (
        <p className="shrink-0 text-[11px] text-amber-300">{authStatus}</p>
      )}

      {/* Loading */}
      {(loading || savedTracksLoading || sharedTracksLoading) && (
        <div className="flex shrink-0 items-center justify-center py-3">
          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-[#1DB954] border-t-transparent" />
        </div>
      )}

      {/* Playlist list */}
      {view === "playlists" && !loading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto pb-14 sm:pb-2">
          {showPlaylistSections && (
          <div className="mb-2 rounded-md border border-gray-700/70 bg-gray-900/50 p-2">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-[11px] font-semibold text-gray-200">Persoonlijke playlists</p>
              <button
                type="button"
                onClick={() => { void loadSavedPlaylists(); }}
                disabled={savedPlaylistsLoading}
                className="text-[10px] text-violet-300 transition hover:text-violet-200 disabled:opacity-40"
              >
                {savedPlaylistsLoading ? "Laden..." : "Ververs"}
              </button>
            </div>
            <select
              value={savedSortMode}
              onChange={(e) => setSavedSortMode(e.target.value as PlaylistSortMode)}
              className="mb-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white"
            >
              <option value="name_asc">Sortering: Naam A-Z</option>
              <option value="name_desc">Sortering: Naam Z-A</option>
              <option value="tracks_desc">Sortering: Meeste tracks</option>
              <option value="newest">Sortering: Nieuwste import</option>
            </select>
            <div className="mb-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setSavedPlaylistViewMode("grouped")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  savedPlaylistViewMode === "grouped"
                    ? "bg-violet-600/30 text-violet-100"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Op genre
              </button>
              <button
                type="button"
                onClick={() => setSavedPlaylistViewMode("all")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  savedPlaylistViewMode === "all"
                    ? "bg-violet-600/30 text-violet-100"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Alles onder elkaar
              </button>
            </div>
            {groupedSavedPlaylists.length === 0 && !savedPlaylistsLoading && (
              <p className="text-[10px] text-gray-500">Nog geen geïmporteerde playlists.</p>
            )}
            {savedPlaylistViewMode === "grouped" ? groupedSavedPlaylists.map((genreGroup) => (
              <details
                key={`saved-genre:${genreGroup.genreLabel}`}
                open={hasStoredCollapseState ? !collapsedSavedGenres.includes(genreGroup.genreLabel) : false}
                onToggle={(event) => {
                  const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                  setHasStoredCollapseState(true);
                  setCollapsedSavedGenres((prev) => (
                    isOpen
                      ? prev.filter((entry) => entry !== genreGroup.genreLabel)
                      : Array.from(new Set([...prev, genreGroup.genreLabel]))
                  ));
                }}
                className="mt-1 rounded border border-gray-800 bg-gray-900/40 p-1"
              >
                <summary className="cursor-pointer list-none text-[11px] font-semibold text-gray-200">
                  {genreGroup.genreLabel} ({genreGroup.subgroups.reduce((acc, subgroup) => acc + subgroup.items.length, 0)})
                </summary>
                <div className="mt-1 space-y-1">
                  {genreGroup.subgroups.map((subgroup) => (
                    <details
                      key={`saved-sub:${genreGroup.genreLabel}:${subgroup.subgenreLabel}`}
                      open={hasStoredCollapseState ? !collapsedSavedSubgenres.includes(`${genreGroup.genreLabel}::${subgroup.subgenreLabel}`) : false}
                      onToggle={(event) => {
                        const key = `${genreGroup.genreLabel}::${subgroup.subgenreLabel}`;
                        const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                        setHasStoredCollapseState(true);
                        setCollapsedSavedSubgenres((prev) => (
                          isOpen
                            ? prev.filter((entry) => entry !== key)
                            : Array.from(new Set([...prev, key]))
                        ));
                      }}
                      className="rounded border border-gray-800/80 bg-gray-900/50 p-1"
                    >
                      <summary className="cursor-pointer list-none text-[10px] font-semibold text-gray-300">
                        {subgroup.subgenreLabel} ({subgroup.items.length})
                      </summary>
                      <div className="mt-1 space-y-1">
                        {subgroup.items.map((playlist) => (
                          <div key={playlist.id} className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/70 px-2.5 py-1.5">
                            {playlist.cover_url ? (
                              <img
                                src={playlist.cover_url}
                                alt=""
                                className="mr-2 h-8 w-8 shrink-0 rounded object-cover"
                              />
                            ) : (
                              <div className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gray-800">
                                <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V4.5A2.25 2.25 0 0016.5 2.25h-1.875a2.25 2.25 0 00-2.25 2.25v13.5m0 0a2.25 2.25 0 01-2.25 2.25H8.25a2.25 2.25 0 01-2.25-2.25V6.75" />
                                </svg>
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => { void openSavedPlaylist(playlist); }}
                              className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white transition hover:text-violet-300"
                            >
                              {playlist.name}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void removeSavedPlaylist(playlist); }}
                              className="ml-2 text-[10px] text-red-300 transition hover:text-red-200"
                            >
                              Verwijder
                            </button>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )) : sortedSavedPlaylists.map((playlist) => (
              <div key={playlist.id} className="mt-1 flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/70 px-2.5 py-1.5">
                {playlist.cover_url ? (
                  <img
                    src={playlist.cover_url}
                    alt=""
                    className="mr-2 h-8 w-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gray-800">
                    <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V4.5A2.25 2.25 0 0016.5 2.25h-1.875a2.25 2.25 0 00-2.25 2.25v13.5m0 0a2.25 2.25 0 01-2.25 2.25H8.25a2.25 2.25 0 01-2.25-2.25V6.75" />
                    </svg>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { void openSavedPlaylist(playlist); }}
                  className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white transition hover:text-violet-300"
                >
                  {playlist.name}
                </button>
                <button
                  type="button"
                  onClick={() => { void removeSavedPlaylist(playlist); }}
                  className="ml-2 text-[10px] text-red-300 transition hover:text-red-200"
                >
                  Verwijder
                </button>
              </div>
            ))}
          </div>
          )}

          {/* showPlaylistSections && showSharedPlaylistsInSpotifyTab && (
          <div className="mb-2 rounded-md border border-blue-700/70 bg-blue-950/20 p-2">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-[11px] font-semibold text-blue-100">Gedeelde playlists</p>
              <button
                type="button"
                onClick={() => { void loadSharedPlaylists(); }}
                disabled={sharedPlaylistsLoading}
                className="text-[10px] text-blue-300 transition hover:text-blue-200 disabled:opacity-40"
              >
                {sharedPlaylistsLoading ? "Laden..." : "Ververs"}
              </button>
            </div>
            <select
              value={sharedSortMode}
              onChange={(e) => setSharedSortMode(e.target.value as PlaylistSortMode)}
              className="mb-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white"
            >
              <option value="name_asc">Sortering: Naam A-Z</option>
              <option value="name_desc">Sortering: Naam Z-A</option>
              <option value="tracks_desc">Sortering: Meeste tracks</option>
              <option value="newest">Sortering: Nieuwste import</option>
            </select>
            <div className="mb-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setSharedPlaylistViewMode("grouped")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  sharedPlaylistViewMode === "grouped"
                    ? "bg-blue-700/35 text-blue-100"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Op genre
              </button>
              <button
                type="button"
                onClick={() => setSharedPlaylistViewMode("all")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  sharedPlaylistViewMode === "all"
                    ? "bg-blue-700/35 text-blue-100"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Alles onder elkaar
              </button>
            </div>
            {sharedUsage && (
              <p className="mb-1 text-[10px] text-blue-300/80">
                Pool: {sharedUsage.playlists} playlists · {sharedUsage.tracks} tracks
              </p>
            )}
            {groupedSharedPlaylists.length === 0 && !sharedPlaylistsLoading && (
              <p className="text-[10px] text-gray-400">Nog geen gedeelde playlists beschikbaar.</p>
            )}
            {sharedPlaylistViewMode === "grouped" ? groupedSharedPlaylists.map((genreGroup) => (
              <details
                key={`shared-genre:${genreGroup.genreLabel}`}
                open={hasStoredCollapseState ? !collapsedSharedGenres.includes(genreGroup.genreLabel) : false}
                onToggle={(event) => {
                  const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                  setHasStoredCollapseState(true);
                  setCollapsedSharedGenres((prev) => (
                    isOpen
                      ? prev.filter((entry) => entry !== genreGroup.genreLabel)
                      : Array.from(new Set([...prev, genreGroup.genreLabel]))
                  ));
                }}
                className="mt-1 rounded border border-blue-900/40 bg-blue-950/10 p-1"
              >
                <summary className="cursor-pointer list-none text-[11px] font-semibold text-blue-100">
                  {genreGroup.genreLabel} ({genreGroup.subgroups.reduce((acc, subgroup) => acc + subgroup.items.length, 0)})
                </summary>
                <div className="mt-1 space-y-1">
                  {genreGroup.subgroups.map((subgroup) => (
                    <details
                      key={`shared-sub:${genreGroup.genreLabel}:${subgroup.subgenreLabel}`}
                      open={hasStoredCollapseState ? !collapsedSharedSubgenres.includes(`${genreGroup.genreLabel}::${subgroup.subgenreLabel}`) : false}
                      onToggle={(event) => {
                        const key = `${genreGroup.genreLabel}::${subgroup.subgenreLabel}`;
                        const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                        setHasStoredCollapseState(true);
                        setCollapsedSharedSubgenres((prev) => (
                          isOpen
                            ? prev.filter((entry) => entry !== key)
                            : Array.from(new Set([...prev, key]))
                        ));
                      }}
                      className="rounded border border-gray-800/80 bg-gray-900/40 p-1"
                    >
                      <summary className="cursor-pointer list-none text-[10px] font-semibold text-gray-300">
                        {subgroup.subgenreLabel} ({subgroup.items.length})
                      </summary>
                      <div className="mt-1 space-y-1">
                        {subgroup.items.map((playlist) => (
                          <div key={playlist.id} className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/70 px-2.5 py-1.5">
                            {playlist.cover_url ? (
                              <img
                                src={playlist.cover_url}
                                alt=""
                                className="mr-2 h-8 w-8 shrink-0 rounded object-cover"
                              />
                            ) : (
                              <div className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gray-800">
                                <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V4.5A2.25 2.25 0 0016.5 2.25h-1.875a2.25 2.25 0 00-2.25 2.25v13.5m0 0a2.25 2.25 0 01-2.25 2.25H8.25a2.25 2.25 0 01-2.25-2.25V6.75" />
                                </svg>
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => { void openSharedPlaylist(playlist); }}
                              className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white transition hover:text-blue-300"
                            >
                              {playlist.name}
                            </button>
                            <span className="ml-2 shrink-0 text-[10px] text-gray-400">
                              {playlist.track_count} tracks
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )) : sortedSharedPlaylists.map((playlist) => (
              <div key={playlist.id} className="mt-1 flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900/70 px-2.5 py-1.5">
                {playlist.cover_url ? (
                  <img
                    src={playlist.cover_url}
                    alt=""
                    className="mr-2 h-8 w-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gray-800">
                    <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V4.5A2.25 2.25 0 0016.5 2.25h-1.875a2.25 2.25 0 00-2.25 2.25v13.5m0 0a2.25 2.25 0 01-2.25 2.25H8.25a2.25 2.25 0 01-2.25-2.25V6.75" />
                    </svg>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { void openSharedPlaylist(playlist); }}
                  className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white transition hover:text-blue-300"
                >
                  {playlist.name}
                </button>
                <span className="ml-2 shrink-0 text-[10px] text-gray-400">
                  {playlist.track_count} tracks
                </span>
              </div>
            ))}
          </div>
          )}

          {showSpotifySection && !configured && (
            <p className="mb-2 text-[10px] text-gray-500">
              Spotify is niet geconfigureerd. Exportify import werkt wel.
            </p>
          )}
          {showSpotifySection && configured && !connected && (
            <div className="mb-2 rounded-md border border-green-700/40 bg-green-950/20 p-2">
              <p className="text-[10px] text-gray-300">Spotify koppelen is optioneel voor browse/liked songs.</p>
              <button
                type="button"
                onClick={() => { void loginWithSpotify(); }}
                className="mt-2 rounded bg-[#1DB954] px-2 py-1 text-[10px] font-semibold text-black transition hover:bg-[#1ed760]"
              >
                Koppel Spotify
              </button>
            </div>
          )}

          {showSpotifySection && spotifyEnabled && (
            <>
              <button
                type="button"
                onClick={() => { void openLikedSongs(); }}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition hover:bg-gray-800/80"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gradient-to-br from-[#450AF5] to-[#C4EFD9]">
                  <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">Liked Songs</p>
                </div>
              </button>

              {filteredPlaylists.map((pl) => {
                const plImg = pl.images?.[0]?.url;
                return (
                  <button
                    type="button"
                    key={pl.id}
                    onClick={() => { void openPlaylist(pl); }}
                    className="flex w-full items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/70 px-2 py-1.5 text-left transition hover:border-[#1DB954]/60 hover:bg-gray-800/80"
                  >
                    {plImg ? (
                      <img
                        src={plImg}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gray-800">
                        <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V4.5A2.25 2.25 0 0016.5 2.25h-1.875a2.25 2.25 0 00-2.25 2.25v13.5m0 0a2.25 2.25 0 01-2.25 2.25H8.25a2.25 2.25 0 01-2.25-2.25V6.75" />
                        </svg>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-white">{pl.name}</p>
                      <p className="text-[10px] text-gray-500">
                        {pl.tracks?.total ?? 0} nummers
                      </p>
                    </div>
                  </button>
                );
              })}

              {filteredPlaylists.length === 0 && !loading && (
                <p className="py-2 text-center text-[11px] text-gray-500">
                  Geen Spotify playlists gevonden
                </p>
              )}
              {loadingMore && (
                <p className="py-2 text-center text-[11px] text-gray-500">
                  Meer playlists laden...
                </p>
              )}
            </>
          )}
          <button
            className="mt-2 rounded bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleImport}
            disabled={importing}
          >
            {importing ? "Importeren..." : "Importeer bestand"}
          </button>
          {importStatus && <p className="mt-1 text-[10px] text-green-300">{importStatus}</p>}
          {importError && <p className="mt-1 text-[10px] text-red-300">{importError}</p>}
        </details>
          )}
          <div ref={loadMoreRef} className="h-10 w-full sm:h-2" />
        </div>
      )}

      {/* Track error */}
      {trackError && view === "tracks" && !loading && (
        <div className="shrink-0 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
          <p className="text-[11px] text-yellow-400">{trackError}</p>
          <button
            type="button"
            onClick={() => {
              if (trackSource === "liked") void loadLikedSongs(false);
              if (trackSource === "playlist" && selectedPlaylist) void openPlaylist(selectedPlaylist);
            }}
            className="mt-1 text-[11px] text-violet-400 transition hover:text-violet-300"
          >
            Opnieuw proberen
          </button>
        </div>
      )}

      {savedTracksError && view === "importedTracks" && !savedTracksLoading && (
        <div className="shrink-0 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
          <p className="text-[11px] text-yellow-400">{savedTracksError}</p>
          <button
            type="button"
            onClick={() => {
              if (selectedSavedPlaylist) void openSavedPlaylist(selectedSavedPlaylist);
            }}
            className="mt-1 text-[11px] text-violet-400 transition hover:text-violet-300"
          >
            Opnieuw proberen
          </button>
        </div>
      )}

      {sharedTracksError && view === "sharedTracks" && !sharedTracksLoading && (
        <div className="shrink-0 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
          <p className="text-[11px] text-yellow-400">{sharedTracksError}</p>
          <button
            type="button"
            onClick={() => {
              if (selectedSharedPlaylist) void openSharedPlaylist(selectedSharedPlaylist);
            }}
            className="mt-1 text-[11px] text-violet-400 transition hover:text-violet-300"
          >
            Opnieuw proberen
          </button>
        </div>
      )}

      {/* Track list */}
      {view === "tracks" && !spotifyEnabled && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
          <p className="text-[11px] text-yellow-300">Spotify is niet verbonden. Ga terug naar playlists of koppel opnieuw.</p>
        </div>
      )}

      {view === "tracks" && spotifyEnabled && !loading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto pb-14 sm:pb-2">
          {filteredTracks.map((track) => {
            const trackKey = track.id ?? `${track.name ?? "unknown"}:${track.artists?.map((a) => a?.name).join(",") ?? "unknown"}`;
            const artists = track.artists?.map((a) => a?.name).filter(Boolean).join(", ") || "";
            const imgs = track.album?.images;
            const albumImg = imgs?.[0]?.url ?? imgs?.[imgs.length - 1]?.url;
            const isAdded = addedTrackId === trackKey;
            const isPending = pendingTrackId === trackKey;

            return (
              <button
                type="button"
                key={track.id}
                onClick={() => handleAddTrack(track)}
                disabled={submitting || isAdded || isPending}
                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded
                    ? "bg-green-500/10"
                    : "hover:bg-gray-800/80"
                } disabled:opacity-60`}
              >
                {albumImg ? (
                  <img
                    src={albumImg}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded bg-gray-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{track.name}</p>
                  <p className="truncate text-[10px] text-gray-400">{artists}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[10px] tabular-nums text-gray-500">
                    {track.duration_ms ? formatDuration(track.duration_ms) : ""}
                  </span>
                  {isAdded ? (
                    <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                      Toegevoegd
                    </span>
                  ) : isPending ? (
                    <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                      Bezig...
                    </span>
                  ) : (
                    <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })}

          {filteredTracks.length === 0 && !loading && !trackError && (
            <p className="py-2 text-center text-[11px] text-gray-500">
              Geen nummers gevonden
            </p>
          )}
          {loadingMore && (
            <p className="py-2 text-center text-[11px] text-gray-500">
              Meer nummers laden...
            </p>
          )}
          <div ref={loadMoreRef} className="h-10 w-full sm:h-2" />
        </div>
      )}

      {view === "importedTracks" && !savedTracksLoading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto pb-14 sm:pb-2">
          {filteredSavedTracks.map((track) => {
            const isAdded = addedTrackId === track.id;
            const isPending = pendingTrackId === track.id;
            const spotifyUrl = (track.spotify_url ?? "").trim();
            const thumb = spotifyUrl ? savedTrackThumbs[spotifyUrl] : "";
            return (
              <button
                type="button"
                key={track.id}
                onClick={() => handleAddSavedTrack(track)}
                disabled={submitting || isAdded || isPending}
                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                } disabled:opacity-60`}
              >
                {thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gray-800">
                    <svg className="h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.7 0 12 0zm5.5 17.3c-.2.4-.7.5-1 .2-2.8-1.7-6.3-2.1-10.5-1.1-.4.1-.8-.2-.9-.6-.1-.4.2-.8.5-.9 4.6-1 8.6-.6 11.7 1.3.3.2.4.7.2 1.1zm1.4-3.3c-.3.4-.8.5-1.3.3-3.2-2-8.1-2.6-11.9-1.4-.5.2-1-.1-1.2-.6-.1-.5.2-1 .7-1.1 4.3-1.3 9.8-.6 13.6 1.7.5.3.6.8.3 1.1z" />
                    </svg>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{track.title}</p>
                  <p className="truncate text-[10px] text-gray-400">{track.artist ?? "Unknown"}</p>
                </div>
                {isAdded ? (
                  <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                    Toegevoegd
                  </span>
                ) : isPending ? (
                  <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                    Bezig...
                  </span>
                ) : (
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                )}
              </button>
            );
          })}

          {filteredSavedTracks.length === 0 && !savedTracksError && (
            <p className="py-2 text-center text-[11px] text-gray-500">
              Geen tracks gevonden
            </p>
          )}
          {savedTracksLoadingMore && (
            <p className="py-2 text-center text-[11px] text-gray-500">
              Meer tracks laden...
            </p>
          )}
          <div ref={loadMoreRef} className="h-10 w-full sm:h-2" />
        </div>
      )}

      {view === "sharedTracks" && !sharedTracksLoading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto pb-14 sm:pb-2">
          {filteredSharedTracks.map((track) => {
            const isAdded = addedTrackId === track.id;
            const isPending = pendingTrackId === track.id;
            const spotifyUrl = (track.spotify_url ?? "").trim();
            const thumb = spotifyUrl ? savedTrackThumbs[spotifyUrl] : "";
            return (
              <button
                type="button"
                key={track.id}
                onClick={() => handleAddSavedTrack(track)}
                disabled={submitting || isAdded || isPending}
                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                } disabled:opacity-60`}
              >
                {thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gray-800">
                    <svg className="h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.7 0 12 0zm5.5 17.3c-.2.4-.7.5-1 .2-2.8-1.7-6.3-2.1-10.5-1.1-.4.1-.8-.2-.9-.6-.1-.4.2-.8.5-.9 4.6-1 8.6-.6 11.7 1.3.3.2.4.7.2 1.1zm1.4-3.3c-.3.4-.8.5-1.3.3-3.2-2-8.1-2.6-11.9-1.4-.5.2-1-.1-1.2-.6-.1-.5.2-1 .7-1.1 4.3-1.3 9.8-.6 13.6 1.7.5.3.6.8.3 1.1z" />
                    </svg>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{track.title}</p>
                  <p className="truncate text-[10px] text-gray-400">{track.artist ?? "Unknown"}</p>
                </div>
                {isAdded ? (
                  <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                    Toegevoegd
                  </span>
                ) : isPending ? (
                  <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                    Bezig...
                  </span>
                ) : (
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                )}
              </button>
            );
          })}

          {filteredSharedTracks.length === 0 && !sharedTracksError && (
            <p className="py-2 text-center text-[11px] text-gray-500">
              Geen tracks gevonden
            </p>
          )}
          {sharedTracksLoadingMore && (
            <p className="py-2 text-center text-[11px] text-gray-500">
              Meer tracks laden...
            </p>
          )}
          <div ref={loadMoreRef} className="h-10 w-full sm:h-2" />
        </div>
      )}
    </div>
  );
}
