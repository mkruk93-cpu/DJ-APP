// Dummy change: commit & push fix - 2026-03-24 11:22
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
  createEmptyUserPlaylist,
  deleteUserPlaylist,
  getUserPlaylistTracksPage,
  getSharedPlaylistTracksPage,
  getSpotifyOembed,
  importUserPlaylistFiles,
  listAllSharedPlaylists,
  listKnownUsers,
  listUserPlaylists,
  removeTrackFromUserPlaylist,
  backfillUserPlaylistTrackArtwork,
  updateUserPlaylistSharing,
  type SharedPlaylist,
  type PlaylistGenreMetaInput,
  type UserPlaylist,
  type UserPlaylistTrack,
} from "@/lib/userPlaylistsApi";
import {
  listFavoriteArtists,
  removeFavoriteArtist,
  type FavoriteArtist,
} from "@/lib/userPlaylistsApi";
import { NoAutofillInput } from "@/components/NoAutofillInput";
import { useAuth } from "@/lib/authContext";
import TrackActions from "@/components/TrackActions";
import { getSocket } from "@/lib/socket";
import { getRadioToken } from "@/lib/auth";
import { useRadioStore } from "@/lib/radioStore";
import PlaylistOptionsButton, { type MenuAction } from "@/components/PlaylistOptionsButton";

interface SpotifyBrowserProps {
  onAddTrack: (track: {
    id?: string;
    query: string;
    artist?: string | null;
    title?: string | null;
    sourceType?: string | null;
    sourceGenre?: string | null;
    sourcePlaylist?: string | null;
    artwork_url?: string | null;
  }) => Promise<"added" | "manual_select" | "error">;
  submitting: boolean;
  mode?: "all" | "playlistsOnly" | "spotifyOnly";
  onSelectFavoriteArtist?: (artist: { mbid: string; name: string; image_url?: string | null }) => void;
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
type PersonalLibraryTab = "playlists" | "artists" | "create" | "import";
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

function isLikedTracksPlaylistName(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "liked tracks";
}

export default function SpotifyBrowser({ onAddTrack, submitting, mode = "all", onSelectFavoriteArtist }: SpotifyBrowserProps) {
  const { userAccount } = useAuth();
  const username = userAccount?.username || "";
  const lockAutoplayFallback = useRadioStore((s) => s.lockAutoplayFallback);

  // Locally extend UserPlaylist to include track_count for UI
  type UserPlaylistWithCount = UserPlaylist & { track_count?: number };

  // Playlist view state direct onder elkaar voor patch-compatibiliteit
  const [savedSortMode, setSavedSortMode] = useState<PlaylistSortMode>("name_asc");
  const [savedPlaylistViewMode, setSavedPlaylistViewMode] = useState<PlaylistViewMode>("grouped");
  const [collapsedSavedGenres, setCollapsedSavedGenres] = useState<string[]>([]);
  const [collapsedSavedSubgenres, setCollapsedSavedSubgenres] = useState<string[]>([]);
  const [hasStoredCollapseState, setHasStoredCollapseState] = useState(false);
  // ...rest van de bestaande state
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
  const [favoriteArtists, setFavoriteArtists] = useState<FavoriteArtist[]>([]);
  const [favoriteArtistsLoading, setFavoriteArtistsLoading] = useState(false);
  const [personalLibraryTab, setPersonalLibraryTab] = useState<PersonalLibraryTab>("playlists");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importPlaylistName, setImportPlaylistName] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [importGenreGroup, setImportGenreGroup] = useState("");
  const [importSubgenre, setImportSubgenre] = useState("");
  const [importCoverUrl, setImportCoverUrl] = useState("");
  const [importAutoCover, setImportAutoCover] = useState(true);
  const [createPlaylistBusy, setCreatePlaylistBusy] = useState(false);
  const [createPlaylistError, setCreatePlaylistError] = useState<string | null>(null);
  const [createPlaylistName, setCreatePlaylistName] = useState("");
  const [createPlaylistGenreGroup, setCreatePlaylistGenreGroup] = useState("");
  const [savedPlaylists, setSavedPlaylists] = useState<UserPlaylist[]>([]);
  const [savedPlaylistsLoading, setSavedPlaylistsLoading] = useState(false);
  const [savedTracks, setSavedTracks] = useState<UserPlaylistTrack[]>([]);
  const [savedTracksLoading, setSavedTracksLoading] = useState(false);
  const [savedTracksLoadingMore, setSavedTracksLoadingMore] = useState(false);
  const [savedTracksError, setSavedTracksError] = useState<string | null>(null);
  const [savedTracksOffset, setSavedTracksOffset] = useState(0);
  const [savedTracksHasMore, setSavedTracksHasMore] = useState(false);
  const [selectedSavedPlaylist, setSelectedSavedPlaylist] = useState<UserPlaylist | null>(null);
  const [savedTrackThumbs, setSavedTrackThumbs] = useState<Record<string, string>>({});
  // Shared playlists and tracks state
  const [sharedSortMode, setSharedSortMode] = useState<PlaylistSortMode>("name_asc");
  const [sharedPlaylistViewMode, setSharedPlaylistViewMode] = useState<PlaylistViewMode>("grouped");
  const [collapsedSharedGenres, setCollapsedSharedGenres] = useState<string[]>([]);
  const [collapsedSharedSubgenres, setCollapsedSharedSubgenres] = useState<string[]>([]);
  const [sharedPlaylists, setSharedPlaylists] = useState<SharedPlaylist[]>([]);
  const [sharedPlaylistsLoading, setSharedPlaylistsLoading] = useState(false);
  const [sharedUsage, setSharedUsage] = useState<any>(null); // Adjust type as needed
  const [sharedTracks, setSharedTracks] = useState<UserPlaylistTrack[]>([]);
  const [sharedTracksOffset, setSharedTracksOffset] = useState(0);
  const [sharedTracksHasMore, setSharedTracksHasMore] = useState(false);
  const [selectedSharedPlaylist, setSelectedSharedPlaylist] = useState<SharedPlaylist | null>(null);
  const [sharedTracksError, setSharedTracksError] = useState<string | null>(null);
  const [sharedTracksLoading, setSharedTracksLoading] = useState(false);
  const [sharedTracksLoadingMore, setSharedTracksLoadingMore] = useState(false);
  const [trackContextMenu, setTrackContextMenu] = useState<{ x: number; y: number; track: UserPlaylistTrack } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const trackHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const favoriteArtistHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Username from auth context

  const thumbnailLoadingRef = useRef<Set<string>>(new Set());
  const thumbnailQueueRef = useRef<string[]>([]);
  const thumbnailWorkersRef = useRef(0);
  const artworkBackfillQueueRef = useRef<Map<string, string>>(new Map());
  const artworkBackfillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    void loadSavedPlaylists(); // Refresh playlists when going back
  }, []);

  async function handleDeletePlaylist(e: React.MouseEvent, playlistId: string, name: string) {
    e.stopPropagation();
    if (!confirm(`Weet je zeker dat je de playlist "${name}" wilt verwijderen?`)) return;
    try {
      await deleteUserPlaylist(playlistId);
      await loadSavedPlaylists();
    } catch (err) {
      alert("Verwijderen mislukt: " + (err instanceof Error ? err.message : "onbekende fout"));
    }
  }

  async function handleDeleteTrack(e: React.MouseEvent, playlistId: string, trackId: string, title: string) {
    e.stopPropagation();
    setTrackContextMenu(null);
    if (!confirm(`Weet je zeker dat je "${title}" wilt verwijderen uit deze playlist?`)) return;
    try {
      await removeTrackFromUserPlaylist(playlistId, trackId);
      if (view === "importedTracks") {
        await loadSavedTracksPage(playlistId, false);
      }
    } catch (err) {
      alert("Verwijderen mislukt: " + (err instanceof Error ? err.message : "onbekende fout"));
    }
  }

  function clearTrackHoldTimer() {
    if (trackHoldTimerRef.current) {
      clearTimeout(trackHoldTimerRef.current);
      trackHoldTimerRef.current = null;
    }
  }

  function clearFavoriteArtistHoldTimer() {
    if (favoriteArtistHoldTimerRef.current) {
      clearTimeout(favoriteArtistHoldTimerRef.current);
      favoriteArtistHoldTimerRef.current = null;
    }
  }

  async function handleRemoveFavoriteArtist(artist: FavoriteArtist): Promise<void> {
    const ok = confirm(`Favoriete artiest "${artist.name}" verwijderen?`);
    if (!ok) return;
    try {
      await removeFavoriteArtist(artist.mbid);
      setFavoriteArtists((prev) => prev.filter((entry) => entry.mbid !== artist.mbid));
    } catch (err) {
      alert("Verwijderen mislukt: " + (err instanceof Error ? err.message : "onbekende fout"));
    }
  }

  function openTrackContextMenu(track: UserPlaylistTrack, x: number, y: number) {
    if (!selectedSavedPlaylist?.viewer_can_edit) return;
    setTrackContextMenu({ x, y, track });
  }

  function setPlaylistAsAutoplayFallback(playlist: UserPlaylist) {
    if (lockAutoplayFallback && !getRadioToken()) {
      alert("Autoplay fallback is vergrendeld. Alleen admin kan dit aanpassen.");
      return;
    }
    const selectedBy = (typeof window !== "undefined" ? localStorage.getItem("nickname") : null)?.trim() || "onbekend";
    getSocket().emit("fallback:genre:set", {
      genreId: `user:${playlist.id}`,
      selectedBy,
      sharedPlaybackMode: "random",
      token: getRadioToken() ?? undefined,
    });
  }

  async function handleSharePlaylist(e: React.MouseEvent, playlist: UserPlaylist) {
    e.stopPropagation();
    const target = window.prompt(`Met welke gebruiker wil je "${playlist.name}" delen?`);
    if (!target?.trim()) return;
    try {
      await updateUserPlaylistSharing(playlist.id, { share_username: target.trim() });
      await loadSavedPlaylists();
    } catch (err) {
      alert("Delen mislukt: " + (err instanceof Error ? err.message : "onbekende fout"));
    }
  }

  async function handleSharePlaylistToUser(playlist: UserPlaylist, targetUsername: string) {
    try {
      await updateUserPlaylistSharing(playlist.id, { share_username: targetUsername.trim() });
      await loadSavedPlaylists();
    } catch (err) {
      alert("Delen mislukt: " + (err instanceof Error ? err.message : "onbekende fout"));
    }
  }

  async function loadShareableUsers(): Promise<string[]> {
    const users = await listKnownUsers("", 250);
    return users.filter((entry) => entry.toLowerCase() !== username.trim().toLowerCase());
  }

  async function handleTogglePublicPlaylist(e: React.MouseEvent, playlist: UserPlaylist) {
    e.stopPropagation();
    try {
      await updateUserPlaylistSharing(playlist.id, { is_public: !playlist.is_public });
      await loadSavedPlaylists();
      if (showSharedPlaylistsInSpotifyTab) await loadSharedPlaylists();
    } catch (err) {
      alert("Publiek zetten mislukt: " + (err instanceof Error ? err.message : "onbekende fout"));
    }
  }

  async function handleTogglePublicFallback(e: React.MouseEvent, playlist: UserPlaylist) {
    e.stopPropagation();
    try {
      const nextPublic = playlist.is_public ? undefined : true;
      await updateUserPlaylistSharing(playlist.id, {
        is_public: nextPublic,
        is_public_fallback: !playlist.is_public_fallback,
      });
      await loadSavedPlaylists();
    } catch (err) {
      alert("Fallback-zichtbaarheid aanpassen mislukt: " + (err instanceof Error ? err.message : "onbekende fout"));
    }
  }

  function renderSavedPlaylistOptions(playlist: UserPlaylist) {
    const canManagePlaylist = playlist.viewer_can_edit && !isLikedTracksPlaylistName(playlist.name);
    const actions: MenuAction[] = [
      {
        key: "auto",
        label: "Gebruik als autoplay fallback",
        tone: "accent" as const,
        onSelect: () => setPlaylistAsAutoplayFallback(playlist),
      },
      {
        key: "public",
        label: playlist.is_public ? "Maak niet publiek" : "Maak publiek zichtbaar",
        tone: playlist.is_public ? "success" as const : "default" as const,
        onSelect: () => handleTogglePublicPlaylist({ stopPropagation() {} } as React.MouseEvent, playlist),
      },
      {
        key: "fallback",
        label: playlist.is_public_fallback ? "Verberg uit publieke fallback" : "Toon in publieke fallback",
        tone: playlist.is_public_fallback ? "warning" as const : "default" as const,
        onSelect: () => handleTogglePublicFallback({ stopPropagation() {} } as React.MouseEvent, playlist),
      },
    ];
    if (canManagePlaylist) {
      actions.push({
        key: "delete",
        label: "Verwijder playlist",
        tone: "danger" as const,
        onSelect: () => handleDeletePlaylist({ stopPropagation() {} } as React.MouseEvent, playlist.id, playlist.name),
      });
    }

    return (
      <PlaylistOptionsButton
        actions={actions}
        shareConfig={playlist.viewer_can_edit ? {
          loadUsers: loadShareableUsers,
          onSelectUser: (targetUsername) => handleSharePlaylistToUser(playlist, targetUsername),
        } : undefined}
      />
    );
  }

  const reloadFavoriteArtists = useCallback(async () => {
    setFavoriteArtistsLoading(true);
    try {
      const favs = await listFavoriteArtists();
      setFavoriteArtists(favs);
    } catch (err) {
      console.error("[SpotifyBrowser] Failed to load favorite artists:", err);
      setFavoriteArtists([]);
    } finally {
      setFavoriteArtistsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showPlaylistSections) {
      void loadSavedPlaylists();
      if (showSharedPlaylistsInSpotifyTab) void loadSharedPlaylists();
    }
    // Spotify connectie niet meer nodig
  }, [showPlaylistSections, showSharedPlaylistsInSpotifyTab]);

  useEffect(() => {
    if (!showPlaylistSections) return;
    void reloadFavoriteArtists();
  }, [reloadFavoriteArtists, showPlaylistSections]);

  useEffect(() => {
    function closeTrackMenu() {
      setTrackContextMenu(null);
      clearTrackHoldTimer();
    }
    window.addEventListener("click", closeTrackMenu);
    window.addEventListener("scroll", closeTrackMenu, true);
    return () => {
      window.removeEventListener("click", closeTrackMenu);
      window.removeEventListener("scroll", closeTrackMenu, true);
    };
  }, []);

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
      // For each playlist, fetch the track count
      const playlistsWithCount = await Promise.all(
        items.map(async (playlist) => {
          try {
            const page = await getUserPlaylistTracksPage(playlist.id, 1, 0);
            return { ...playlist, track_count: page.paging.total };
          } catch {
            return { ...playlist, track_count: 0 };
          }
        })
      );
      setSavedPlaylists(playlistsWithCount);
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

  const flushArtworkBackfill = useCallback(async () => {
    const playlist = selectedSavedPlaylist;
    if (!playlist?.id || !playlist.viewer_can_edit) return;
    const queued = Array.from(artworkBackfillQueueRef.current.entries()).map(([trackId, artwork_url]) => ({ trackId, artwork_url }));
    artworkBackfillQueueRef.current.clear();
    if (queued.length === 0) return;
    try {
      await backfillUserPlaylistTrackArtwork(playlist.id, queued.slice(0, 250));
    } catch {
      // Best effort background write; local UI already has fallback artwork.
    }
  }, [selectedSavedPlaylist]);

  const scheduleArtworkBackfill = useCallback((updates: Array<{ trackId: string; artwork_url: string }>) => {
    if (!selectedSavedPlaylist?.id || !selectedSavedPlaylist.viewer_can_edit) return;
    for (const update of updates) {
      const trackId = (update.trackId ?? "").trim();
      const artwork = (update.artwork_url ?? "").trim();
      if (!trackId || !artwork) continue;
      artworkBackfillQueueRef.current.set(trackId, artwork);
    }
    if (artworkBackfillTimerRef.current) return;
    artworkBackfillTimerRef.current = setTimeout(() => {
      artworkBackfillTimerRef.current = null;
      void flushArtworkBackfill();
    }, 700);
  }, [flushArtworkBackfill, selectedSavedPlaylist]);

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
      setImportStatus(`Import klaar: ${result.totalPlaylists} playlist(s), ${result.totalTracks} tracks.`);
      setImportFiles([]);
      setImportPlaylistName("");
      setImportSubgenre("");
      setImportCoverUrl("");
      setImportAutoCover(true);
      await loadSavedPlaylists();
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
      const albumImg = track.album?.images?.[0]?.url ?? track.album?.images?.[1]?.url ?? track.album?.images?.[2]?.url ?? null;
      const result = await onAddTrack({
        id: track.id ?? undefined,
        query,
        artist: artists,
        title: track.name ?? null,
        sourceType: "spotify",
        artwork_url: albumImg,
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
      const spotifyUrl = (track.spotify_url ?? "").trim();
      const fallbackThumb = spotifyUrl ? savedTrackThumbs[spotifyUrl] : "";
      const result = await onAddTrack({
        query,
        artist: artist || null,
        title: title || null,
        sourceType,
        sourceGenre,
        sourcePlaylist: playlistMeta?.name ?? null,
        artwork_url: track.artwork_url || fallbackThumb || null,
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
  const headerLabel = "Persoonlijk";

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
  const personalPlaylistCount = savedPlaylists.length;
  const personalTrackCount = useMemo(
    () => savedPlaylists.reduce((sum, playlist) => sum + ((playlist as UserPlaylistWithCount).track_count ?? 0), 0),
    [savedPlaylists],
  );

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
      const updateTracksWithThumb = (
        tracks: UserPlaylistTrack[],
      ): UserPlaylistTrack[] => {
        let changed = false;
        const next = tracks.map((track) => {
          const spotifyUrl = (track.spotify_url ?? "").trim();
          if (!spotifyUrl) return track;
          const knownThumb = savedTrackThumbs[spotifyUrl];
          if (!knownThumb) return track;
          const currentArtwork = (track.artwork_url ?? "").trim();
          if (currentArtwork) return track;
          changed = true;
          return { ...track, artwork_url: knownThumb };
        });
        return changed ? next : tracks;
      };
      if (view === "sharedTracks") {
        setSharedTracks((prev) => updateTracksWithThumb(prev));
      } else {
        setSavedTracks((prev) => {
          const pendingBackfill = prev
            .filter((track) => !(track.artwork_url ?? "").trim())
            .map((track) => {
              const spotifyUrl = (track.spotify_url ?? "").trim();
              const artwork = spotifyUrl ? savedTrackThumbs[spotifyUrl] : "";
              return { trackId: track.id, artwork_url: artwork || "" };
            })
            .filter((entry) => !!entry.artwork_url);
          const next = updateTracksWithThumb(prev);
          if (next === prev) return prev;
          if (pendingBackfill.length > 0) {
            scheduleArtworkBackfill(pendingBackfill);
          }
          return next;
        });
      }
    for (const track of visibleTracks) {
      const spotifyUrl = (track.spotify_url ?? "").trim();
      const artworkUrl = (track.artwork_url ?? "").trim();
      if (spotifyUrl && artworkUrl && !savedTrackThumbs[spotifyUrl]) {
        setSavedTrackThumbs((prev) => (prev[spotifyUrl] ? prev : { ...prev, [spotifyUrl]: artworkUrl }));
      }
    }
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
  }, [view, filteredSavedTracks, filteredSharedTracks, savedTrackThumbs, pumpThumbnailQueue, scheduleArtworkBackfill]);

  useEffect(() => () => {
    if (artworkBackfillTimerRef.current) {
      clearTimeout(artworkBackfillTimerRef.current);
      artworkBackfillTimerRef.current = null;
    }
    clearFavoriteArtistHoldTimer();
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1.5 pb-[max(env(safe-area-inset-bottom),4px)] sm:pb-0">
      {/* Header + navigation */}
      <div className="flex shrink-0 items-center justify-between px-0.5">
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
            Hier beheer je je persoonlijke playlists. Je kunt playlists importeren of maken, tracks meteen aan de queue toevoegen,
            en via `Opties` per playlist delen met een gebruiker, publiek zichtbaar maken of als autoplay fallback instellen.
          </p>
        </div>
      )}

      {/* Filter */}
      <NoAutofillInput
        type="search"
        name={`spotify-filter-${Math.random().toString(36).substring(7)}`}
        autoComplete="off"
        spellCheck={false}
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
          <div className="mb-2 rounded-md border border-gray-700 bg-gray-900/80 p-2.5 shadow-[0_8px_20px_rgba(0,0,0,0.22)]">
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-400">
              <span className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1">
                {personalPlaylistCount} playlists
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1">
                {favoriteArtists.length} artiesten
              </span>
              <span className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1">
                {personalTrackCount} tracks
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {[
                { key: "playlists", label: "Playlists" },
                { key: "artists", label: "Artiesten" },
                { key: "create", label: "Maken" },
                { key: "import", label: "Import" },
              ].map((tab) => {
                const isActive = personalLibraryTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setPersonalLibraryTab(tab.key as PersonalLibraryTab)}
                    className={`rounded-md border px-2.5 py-1.5 text-left text-[11px] transition ${
                      isActive
                        ? "border-violet-500/50 bg-violet-500/15 text-violet-100"
                        : "border-gray-700 bg-gray-800/70 text-gray-300 hover:border-violet-500/40 hover:bg-gray-800"
                    }`}
                  >
                    <span className="block font-semibold">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {showPlaylistSections && personalLibraryTab === "artists" && (
          <div className="mb-2 rounded-md border border-gray-700 bg-gray-900/80 p-2.5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[11px] font-semibold text-white">Favoriete artiesten</p>
              <button
                type="button"
                onClick={() => { void reloadFavoriteArtists(); }}
                disabled={favoriteArtistsLoading}
                className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold text-gray-300 transition hover:border-white/15 hover:bg-white/[0.05] disabled:opacity-40"
              >
                {favoriteArtistsLoading ? "Laden..." : "Ververs"}
              </button>
            </div>
            {favoriteArtistsLoading ? (
              <div className="flex items-center justify-center py-3">
                <span className="block h-4 w-4 animate-spin rounded-full border-2 border-gray-500 border-t-transparent" />
              </div>
            ) : favoriteArtists.length === 0 ? (
              <p className="text-[10px] text-gray-400">Nog geen favorieten. Zoek naar een artiest en klik op het hartje om toe te voegen.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {favoriteArtists.map((artist) => (
                  <button
                    key={artist.mbid}
                    type="button"
                    onClick={() => {
                      if (onSelectFavoriteArtist) {
                        onSelectFavoriteArtist({ mbid: artist.mbid, name: artist.name, image_url: artist.image_url ?? null });
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void handleRemoveFavoriteArtist(artist);
                    }}
                    onTouchStart={() => {
                      clearFavoriteArtistHoldTimer();
                      favoriteArtistHoldTimerRef.current = setTimeout(() => {
                        void handleRemoveFavoriteArtist(artist);
                      }, 550);
                    }}
                    onTouchEnd={clearFavoriteArtistHoldTimer}
                    onTouchMove={clearFavoriteArtistHoldTimer}
                    onTouchCancel={clearFavoriteArtistHoldTimer}
                    className="group flex items-center gap-3 rounded-md border border-gray-700 bg-gray-800/70 px-3 py-2 text-left transition hover:border-violet-500/35 hover:bg-gray-800"
                  >
                    {artist.image_url ? (
                      <img src={artist.image_url} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04]">
                        <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                      </div>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white">{artist.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {showPlaylistSections && personalLibraryTab === "playlists" && (
          <div className="mb-2 rounded-md border border-gray-700 bg-gray-900/80 p-2.5">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <p className="mr-auto text-[11px] font-semibold text-white">Persoonlijke playlists</p>
              <button
                type="button"
                onClick={() => { void loadSavedPlaylists(); }}
                disabled={savedPlaylistsLoading}
                className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold text-gray-300 transition hover:border-white/15 hover:bg-white/[0.05] disabled:opacity-40"
              >
                {savedPlaylistsLoading ? "Laden..." : "Ververs"}
              </button>
              <select
                value={savedSortMode}
                onChange={(e) => setSavedSortMode(e.target.value as PlaylistSortMode)}
                className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] text-white outline-none focus:border-emerald-400"
                style={{ colorScheme: "dark" }}
              >
                <option value="name_asc" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Naam A-Z</option>
                <option value="name_desc" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Naam Z-A</option>
                <option value="tracks_desc" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Meeste tracks</option>
                <option value="newest" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Nieuwste import</option>
              </select>
            </div>
            <div className="mb-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setSavedPlaylistViewMode("grouped")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  savedPlaylistViewMode === "grouped"
                    ? "bg-emerald-500/20 text-emerald-100"
                    : "text-gray-300 hover:bg-white/[0.04]"
                }`}
              >
                Op genre
              </button>
              <button
                type="button"
                onClick={() => setSavedPlaylistViewMode("all")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  savedPlaylistViewMode === "all"
                    ? "bg-emerald-500/20 text-emerald-100"
                    : "text-gray-300 hover:bg-white/[0.04]"
                }`}
              >
                Alles onder elkaar
              </button>
            </div>
            {groupedSavedPlaylists.length === 0 && !savedPlaylistsLoading && (
              <p className="text-[10px] text-gray-400">Nog geen persoonlijke playlists.</p>
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
                className="mt-2 rounded-md border border-gray-700 bg-gray-900/70 p-1.5"
              >
                <summary className="cursor-pointer list-none text-[11px] font-semibold text-white">
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
                      className="rounded-xl border border-white/6 bg-white/[0.03] p-1.5"
                    >
                      <summary className="cursor-pointer list-none text-[10px] font-semibold text-gray-300">
                        {subgroup.subgenreLabel} ({subgroup.items.length})
                      </summary>
                      <div className="mt-1 space-y-1">
                        {subgroup.items.map((playlist: UserPlaylist) => {
                          const playlistWithCount = playlist as UserPlaylistWithCount;
                          return (
                            <div key={playlistWithCount.id} className="rounded-md border border-gray-700 bg-gray-950/75 px-3 py-2">
                              <div className="mb-1 flex flex-wrap items-center gap-1">
                                {playlistWithCount.is_owner ? (
                                  <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-gray-200">Van jou</span>
                                ) : (
                                  <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-200">Gedeeld door {playlistWithCount.owner_username}</span>
                                )}
                                {playlistWithCount.is_public && (
                                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">Publiek</span>
                                )}
                                {playlistWithCount.is_public_fallback && (
                                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Fallback zichtbaar</span>
                                )}
                                {playlistWithCount.shared_with_count > 0 && (
                                  <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-200">Gedeeld met {playlistWithCount.shared_with_count}</span>
                                )}
                              </div>
                              <div className="flex items-center justify-between">
                              {playlistWithCount.cover_url ? (
                                <img
                                  src={playlistWithCount.cover_url}
                                  alt=""
                                  className="mr-3 h-10 w-10 shrink-0 rounded-xl object-cover"
                                />
                              ) : (
                                <div className="mr-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04]">
                                  <svg className="h-4 w-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                    <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />
                                  </svg>
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={() => { void openSavedPlaylist(playlistWithCount); }}
                                className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white transition hover:text-gray-200"
                              >
                                {playlistWithCount.name}
                              </button>
                              <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-gray-300">
                                {playlistWithCount.track_count}
                              </span>
                              {renderSavedPlaylistOptions(playlistWithCount)}
                              {isLikedTracksPlaylistName(playlistWithCount.name) && (
                                <span className="ml-2 shrink-0 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-pink-200">
                                  Vast
                                </span>
                              )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )) : sortedSavedPlaylists.map((playlist) => {
              return (
              <div key={playlist.id} className="mt-2 rounded-md border border-gray-700 bg-gray-950/75 px-3 py-2">
                <div className="mb-1 flex flex-wrap items-center gap-1">
                  {playlist.is_owner ? (
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-gray-200">Van jou</span>
                  ) : (
                    <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-200">Gedeeld door {playlist.owner_username}</span>
                  )}
                  {playlist.is_public && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">Publiek</span>
                  )}
                  {playlist.is_public_fallback && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200">Fallback zichtbaar</span>
                  )}
                  {playlist.shared_with_count > 0 && (
                    <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-200">Gedeeld met {playlist.shared_with_count}</span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                {playlist.cover_url ? (
                  <img
                    src={playlist.cover_url}
                    alt=""
                    className="mr-3 h-10 w-10 shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <div className="mr-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04]">
                    <svg className="h-4 w-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />
                    </svg>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { void openSavedPlaylist(playlist); }}
                  className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white transition hover:text-gray-200"
                >
                  {playlist.name}
                </button>
                <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-gray-300">
                  {(playlist as UserPlaylistWithCount).track_count}
                </span>
                {renderSavedPlaylistOptions(playlist)}
                {isLikedTracksPlaylistName(playlist.name) && (
                  <span className="ml-2 shrink-0 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-pink-200">
                    Vast
                  </span>
                )}
                </div>
              </div>
            )})}
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
              className="mb-1 w-full sm:w-auto rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white max-w-full"
              style={{ colorScheme: "dark" }}
            >
              <option value="name_asc" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Sortering: Naam A-Z</option>
              <option value="name_desc" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Sortering: Naam Z-A</option>
              <option value="tracks_desc" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Sortering: Meeste tracks</option>
              <option value="newest" style={{ color: "#111827", backgroundColor: "#ffffff" }}>Sortering: Nieuwste import</option>
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
          )*/}

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
          {personalLibraryTab === "create" && (
          <div className="mb-2 rounded-md border border-gray-700 bg-gray-900/80 p-2.5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-[11px] font-semibold text-white">Lege playlist maken</p>
              <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03] text-gray-300">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
            </div>
            <div className="mt-2 space-y-2">
              <input
                type="text"
                value={createPlaylistName}
                onChange={(e) => setCreatePlaylistName(e.target.value)}
                placeholder="Naam van de playlist..."
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] text-white placeholder-gray-500 outline-none focus:border-emerald-400"
              />
              <select
                value={createPlaylistGenreGroup}
                onChange={(e) => setCreatePlaylistGenreGroup(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] text-white"
              >
                <option value="">Kies genre (optioneel)</option>
                {PLAYLIST_GENRE_GROUPS.map((group) => (
                  <option key={group} value={group}>{group}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={async () => {
                  if (!createPlaylistName.trim()) return;
                  setCreatePlaylistBusy(true);
                  setCreatePlaylistError(null);
                  try {
                    await createEmptyUserPlaylist(createPlaylistName.trim(), createPlaylistGenreGroup || null);
                    setCreatePlaylistName("");
                    setCreatePlaylistGenreGroup("");
                    await loadSavedPlaylists();
                  } catch (err) {
                    setCreatePlaylistError(err instanceof Error ? err.message : "Aanmaken mislukt");
                  } finally {
                    setCreatePlaylistBusy(false);
                  }
                }}
                disabled={!createPlaylistName.trim() || createPlaylistBusy}
                className="w-full rounded-xl bg-[#1DB954] py-2 text-[10px] font-bold text-black transition hover:bg-[#34d26a] disabled:opacity-50"
              >
                {createPlaylistBusy ? "Bezig..." : "Maak playlist"}
              </button>
              {createPlaylistError && (
                <p className="text-[10px] text-red-300">{createPlaylistError}</p>
              )}
            </div>
          </div>
          )}

          {personalLibraryTab === "import" && (
          <div className="mb-2 rounded-md border border-gray-700 bg-gray-900/80 p-2.5">
            <p className="text-[11px] font-semibold text-white">CSV/Exportify importeren</p>
            <p className="mt-1 text-[10px] text-gray-400">
              Upload meerdere Exportify CSV&apos;s of ZIP bestanden tegelijk (Ctrl/Shift in bestandsdialoog). We voegen samen en dedupliceren
              zoals bij admin-import. Naam is verplicht; daarna kun je je eigen playlist nog bewerken.
            </p>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              <select
                value={importGenreGroup}
                onChange={(e) => setImportGenreGroup(e.target.value)}
                onFocus={(e) => keepFieldVisibleOnMobile(e.currentTarget)}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] text-white"
              >
                <option value="">Overkoepelend genre</option>
                {PLAYLIST_GENRE_GROUPS.map((group) => (
                  <option key={group} value={group}>{group}</option>
                ))}
              </select>
              <input
                type="text"
                value={importSubgenre}
                onChange={(e) => setImportSubgenre(e.target.value)}
                placeholder="Subgenre (optioneel)"
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] text-white placeholder-gray-500"
              />
            </div>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-[1fr_auto]">
              <input
                type="text"
                value={importCoverUrl}
                onChange={(e) => setImportCoverUrl(e.target.value)}
                placeholder="Playlist cover URL (optioneel)"
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] text-white placeholder-gray-500"
              />
              <label className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] text-gray-200">
                <input
                  type="checkbox"
                  checked={importAutoCover}
                  onChange={(e) => setImportAutoCover(e.target.checked)}
                  className="h-3 w-3 accent-[#1DB954]"
                />
                Auto cover
              </label>
            </div>
            <input
              type="text"
              value={importPlaylistName}
              onChange={(e) => setImportPlaylistName(e.target.value)}
              placeholder="Playlist naam (verplicht; underscores → spaties in titel)"
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] text-white placeholder-gray-500 outline-none focus:border-emerald-400"
            />
            <input
              type="file"
              multiple
              accept=".csv,.zip,text/csv,application/csv,application/vnd.ms-excel,application/zip"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []).filter((file) => 
                  file.name.toLowerCase().endsWith(".csv") || file.name.toLowerCase().endsWith(".zip")
                );
                setImportFiles(files);
                setImportError(null);
              }}
              className="mt-2 w-full text-[10px] text-gray-400 file:mr-2 file:rounded-xl file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-[10px] file:font-medium file:text-white"
            />
            {importFiles.length > 0 && (
              <p className="mt-1 text-[10px] text-gray-400">{importFiles.length} bestand(en) geselecteerd</p>
            )}
            <button
              type="button"
              onClick={() => { void handleImportExportify(); }}
              disabled={importFiles.length === 0 || !importPlaylistName.trim() || importing}
              className="mt-2 rounded-xl bg-[#1DB954] px-3 py-2 text-[10px] font-semibold text-black transition hover:bg-[#34d26a] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? "Importeren..." : "Importeer bestand"}
            </button>
            {importStatus && <p className="mt-1 text-[10px] text-green-300">{importStatus}</p>}
            {importError && <p className="mt-1 text-[10px] text-red-300">{importError}</p>}
          </div>
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
              <div
                key={track.id}
                className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded
                    ? "bg-green-500/10"
                    : "hover:bg-gray-800/80"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleAddTrack(track)}
                  disabled={submitting || isPending}
                  className="flex min-w-0 flex-1 items-center gap-2 disabled:opacity-60"
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
                  <div className="min-w-0 flex-1 text-left">
                    <p className="truncate text-xs font-medium text-white">{track.name}</p>
                    <p className="truncate text-[10px] text-gray-400">{artists}</p>
                  </div>
                  {isAdded ? (
                    <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                      Toegevoegd
                    </span>
                  ) : isPending ? (
                    <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                      Bezig...
                    </span>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <TrackActions 
                    title={track.name ?? ""} 
                    artist={artists} 
                    spotify_url={track.external_urls?.spotify}
                    artwork_url={albumImg ?? null}
                    album={track.album?.name}
                    className="mr-1"
                    iconSize={16}
                  />
                  <span className="text-[10px] tabular-nums text-gray-500">
                    {track.duration_ms ? formatDuration(track.duration_ms) : ""}
                  </span>
                </div>
              </div>
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
            const explicitArtwork = (track.artwork_url ?? "").trim();
            const thumb = explicitArtwork || (spotifyUrl ? (savedTrackThumbs[spotifyUrl] ?? "").trim() : "");
            const canLikeTrack = !isLikedTracksPlaylistName(selectedSavedPlaylist?.name);
            const canEditPlaylist = Boolean(selectedSavedPlaylist?.viewer_can_edit);
            return (
              <div
                key={track.id}
                onContextMenu={(e) => {
                  if (!canEditPlaylist) return;
                  e.preventDefault();
                  openTrackContextMenu(track, e.clientX, e.clientY);
                }}
                onTouchStart={(e) => {
                  if (!canEditPlaylist) return;
                  clearTrackHoldTimer();
                  const touch = e.touches[0];
                  if (!touch) return;
                  trackHoldTimerRef.current = setTimeout(() => {
                    openTrackContextMenu(track, touch.clientX, touch.clientY);
                  }, 450);
                }}
                onTouchEnd={clearTrackHoldTimer}
                onTouchMove={clearTrackHoldTimer}
                onTouchCancel={clearTrackHoldTimer}
                className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleAddSavedTrack(track)}
                  disabled={submitting || isPending}
                  className="flex min-w-0 flex-1 items-center gap-2 disabled:opacity-60"
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
                  <div className="min-w-0 flex-1 text-left">
                    <p className="truncate text-xs font-medium text-white">{track.title}</p>
                    <p className="truncate text-[10px] text-gray-400">{track.artist ?? "Unknown"}</p>
                  </div>
                  {isAdded ? (
                    <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                      Toegevoegd
                    </span>
                  ) : isPending ? (
                    <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                      Bezig...
                    </span>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <TrackActions 
                    title={track.title} 
                    artist={track.artist} 
                    spotify_url={track.spotify_url}
                    artwork_url={thumb || null}
                    album={track.album}
                    showLike={canLikeTrack}
                    className="mr-1"
                    iconSize={16}
                  />
                </div>
              </div>
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

      {trackContextMenu && selectedSavedPlaylist?.viewer_can_edit && (
        <div
          className="fixed z-[90] overflow-hidden rounded-lg border border-red-800/60 bg-gray-950 shadow-2xl"
          style={{ left: trackContextMenu.x, top: trackContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={(e) => selectedSavedPlaylist && handleDeleteTrack(e, selectedSavedPlaylist.id, trackContextMenu.track.id, trackContextMenu.track.title)}
            className="block w-full px-3 py-2 text-left text-xs text-red-200 transition hover:bg-red-500/15"
          >
            Verwijder uit playlist
          </button>
        </div>
      )}

      {view === "sharedTracks" && !sharedTracksLoading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto pb-14 sm:pb-2">
          {filteredSharedTracks.map((track) => {
            const isAdded = addedTrackId === track.id;
            const isPending = pendingTrackId === track.id;
            const spotifyUrl = (track.spotify_url ?? "").trim();
            const explicitArtwork = (track.artwork_url ?? "").trim();
            const thumb = explicitArtwork || (spotifyUrl ? (savedTrackThumbs[spotifyUrl] ?? "").trim() : "");
            return (
              <div
                key={track.id}
                className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleAddSavedTrack(track)}
                  disabled={submitting || isPending}
                  className="flex min-w-0 flex-1 items-center gap-2 disabled:opacity-60"
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
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-xs font-medium text-white">{track.title}</p>
                  <p className="truncate text-[10px] text-gray-400">{track.artist ?? "Unknown"}</p>
                </div>
                {isAdded ? (
                  <span className="shrink-0 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                    Toegevoegd
                  </span>
                ) : isPending ? (
                  <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">
                    Bezig...
                  </span>
                ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <TrackActions 
                    title={track.title} 
                    artist={track.artist} 
                    spotify_url={track.spotify_url}
                    artwork_url={thumb || null}
                    album={track.album}
                    className="mr-1"
                    iconSize={16}
                  />
                  <button
                    type="button"
                    onClick={(e) => selectedSharedPlaylist && handleDeleteTrack(e, selectedSharedPlaylist.id, track.id, track.title)}
                    className="rounded-md p-1 text-gray-500 transition hover:bg-red-500/20 hover:text-red-400"
                    title="Verwijder uit playlist"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>
              </div>
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
  )
}
