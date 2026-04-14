"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getSharedPlaylistTracksPage,
  getSpotifyOembed,
  importSharedPlaylistFiles,
  updateSharedPlaylistAsOwner,
  listAllSharedPlaylists,
  type PlaylistGenreMetaInput,
  type SharedPlaylist,
  type UserPlaylistTrack,
} from "@/lib/userPlaylistsApi";
import { getSocket } from "@/lib/socket";
import { getRadioToken } from "@/lib/auth";
import { useRadioStore } from "@/lib/radioStore";
import { NoAutofillInput } from "@/components/NoAutofillInput";
import TrackActions from "@/components/TrackActions";
import PlaylistOptionsButton, { type MenuAction } from "@/components/PlaylistOptionsButton";

interface SharedPlaylistsBrowserProps {
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
}

type View = "playlists" | "tracks";
type PlaylistSortMode = "name_asc" | "name_desc" | "tracks_desc" | "newest";
type PlaylistViewMode = "grouped" | "all";
const TRACK_PAGE_SIZE = 120;
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

function groupPlaylistsByGenre(playlists: SharedPlaylist[]): Array<{
  genreLabel: string;
  subgroups: Array<{ subgenreLabel: string; items: SharedPlaylist[] }>;
}> {
  const byGenre = new Map<string, Map<string, SharedPlaylist[]>>();
  for (const playlist of playlists) {
    const genreLabel = normalizeBucketLabel(playlist.genre_group, "Overig");
    const subgenreLabel = normalizeBucketLabel(playlist.subgenre, "Algemeen");
    if (!byGenre.has(genreLabel)) byGenre.set(genreLabel, new Map<string, SharedPlaylist[]>());
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

function sortPlaylists(items: SharedPlaylist[], mode: PlaylistSortMode): SharedPlaylist[] {
  const copy = items.slice();
  if (mode === "name_desc") {
    copy.sort((a, b) => b.name.localeCompare(a.name, "nl"));
    return copy;
  }
  if (mode === "tracks_desc") {
    copy.sort((a, b) => (b.track_count - a.track_count) || a.name.localeCompare(b.name, "nl"));
    return copy;
  }
  if (mode === "newest") {
    copy.sort((a, b) => b.imported_at.localeCompare(a.imported_at) || a.name.localeCompare(b.name, "nl"));
    return copy;
  }
  copy.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  return copy;
}

function getStorageKey(): string {
  if (typeof window === "undefined") return "shared-playlists-browser:guest";
  const nickname = (localStorage.getItem("nickname") ?? "guest").trim().toLowerCase() || "guest";
  return `shared-playlists-browser:${nickname}`;
}

function getLegacyStorageKey(): string {
  return "shared-playlists-browser:guest";
}

export default function SharedPlaylistsBrowser({ onAddTrack, submitting }: SharedPlaylistsBrowserProps) {
  const lockAutoplayFallback = useRadioStore((s) => s.lockAutoplayFallback);
  const [view, setView] = useState<View>("playlists");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importName, setImportName] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [playlistSortMode, setPlaylistSortMode] = useState<PlaylistSortMode>("name_asc");
  const [playlistViewMode, setPlaylistViewMode] = useState<PlaylistViewMode>("grouped");
  const [collapsedGenres, setCollapsedGenres] = useState<string[]>([]);
  const [collapsedSubgenres, setCollapsedSubgenres] = useState<string[]>([]);
  const [hasStoredCollapseState, setHasStoredCollapseState] = useState(false);
  const [importGenreGroup, setImportGenreGroup] = useState("");
  const [importSubgenre, setImportSubgenre] = useState("");
  const [importCoverUrl, setImportCoverUrl] = useState("");
  const [importAutoCover, setImportAutoCover] = useState(true);
  const [editDraft, setEditDraft] = useState<{
    id: string;
    name: string;
    genre_group: string;
    subgenre: string;
    cover_url: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [addedTrackId, setAddedTrackId] = useState<string | null>(null);
  const [pendingTrackId, setPendingTrackId] = useState<string | null>(null);
  const [sharedPlaylists, setSharedPlaylists] = useState<SharedPlaylist[]>([]);
  const [sharedUsage, setSharedUsage] = useState<{ playlists: number; tracks: number } | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SharedPlaylist | null>(null);
  const [tracks, setTracks] = useState<UserPlaylistTrack[]>([]);
  const [tracksOffset, setTracksOffset] = useState(0);
  const [tracksHasMore, setTracksHasMore] = useState(false);
  const [loadingMoreTracks, setLoadingMoreTracks] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbLoadingRef = useRef<Set<string>>(new Set());
  const thumbQueueRef = useRef<string[]>([]);
  const thumbWorkersRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>("playlists");

  const viewerNickname = useMemo(() => {
    if (typeof window === "undefined") return "";
    return (localStorage.getItem("nickname") ?? "").trim();
  }, []);

  const isPlaylistOwner = useCallback(
    (playlist: SharedPlaylist) => {
      const by = (playlist.added_by ?? "").trim().toLowerCase();
      const me = viewerNickname.trim().toLowerCase();
      return !!by && !!me && by === me;
    },
    [viewerNickname],
  );

  const backToPlaylists = useCallback(() => {
    setView("playlists");
    setSelectedPlaylist(null);
    setTracks([]);
    setTracksOffset(0);
    setTracksHasMore(false);
    setFilter("");
    setError(null);
  }, []);

  async function loadSharedPlaylists() {
    setLoading(true);
    setError(null);
    try {
      const result = await listAllSharedPlaylists(250, 30);
      setSharedPlaylists(result.items);
      setSharedUsage(result.usage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kon gedeelde playlists niet laden.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSharedPlaylists();
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(getStorageKey()) ?? localStorage.getItem(getLegacyStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<{
        sortMode: PlaylistSortMode;
        playlistViewMode: PlaylistViewMode;
        showHelp: boolean;
        collapsedGenres: string[];
        collapsedSubgenres: string[];
        hasStoredCollapseState: boolean;
      }>;
      if (parsed.sortMode) setPlaylistSortMode(parsed.sortMode);
      if (parsed.playlistViewMode) setPlaylistViewMode(parsed.playlistViewMode);
      if (typeof parsed.showHelp === "boolean") setShowHelp(parsed.showHelp);
      if (Array.isArray(parsed.collapsedGenres)) setCollapsedGenres(parsed.collapsedGenres);
      if (Array.isArray(parsed.collapsedSubgenres)) setCollapsedSubgenres(parsed.collapsedSubgenres);
      if (typeof parsed.hasStoredCollapseState === "boolean") setHasStoredCollapseState(parsed.hasStoredCollapseState);
      else setHasStoredCollapseState(true);
    } catch {
      // Ignore invalid preferences.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify({
      sortMode: playlistSortMode,
      playlistViewMode,
      showHelp,
      collapsedGenres,
      collapsedSubgenres,
      hasStoredCollapseState,
    });
    localStorage.setItem(getStorageKey(), payload);
    localStorage.setItem(getLegacyStorageKey(), payload);
  }, [playlistSortMode, playlistViewMode, showHelp, collapsedGenres, collapsedSubgenres, hasStoredCollapseState]);

  const loadTracksPage = useCallback(async (playlistId: string, append: boolean) => {
    if (append) setLoadingMoreTracks(true);
    else setLoading(true);
    setError(null);
    try {
      const page = await getSharedPlaylistTracksPage(
        playlistId,
        TRACK_PAGE_SIZE,
        append ? tracksOffset : 0,
      );
      setTracks((prev) => {
        if (!append) return page.items;
        const map = new Map<string, UserPlaylistTrack>();
        for (const item of prev) map.set(item.id, item);
        for (const item of page.items) map.set(item.id, item);
        return [...map.values()];
      });
      const nextOffset = page.paging.offset + page.items.length;
      setTracksOffset(nextOffset);
      setTracksHasMore(page.paging.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kon playlist-tracks niet laden.");
      if (!append) {
        setTracks([]);
        setTracksOffset(0);
        setTracksHasMore(false);
      }
    } finally {
      setLoading(false);
      setLoadingMoreTracks(false);
    }
  }, [tracksOffset]);

  async function openPlaylist(playlist: SharedPlaylist) {
    if (typeof window !== "undefined" && viewRef.current === "playlists") {
      window.history.pushState({ ...(window.history.state ?? {}), __inAppBack: "shared-playlists" }, "");
    }
    setSelectedPlaylist(playlist);
    setView("tracks");
    setFilter("");
    setError(null);
    setTracks([]);
    setTracksOffset(0);
    setTracksHasMore(false);
    await loadTracksPage(playlist.id, false);
  }

  const resolveThumb = useCallback(async (url: string): Promise<void> => {
    if (thumbs[url]) return;
    if (thumbLoadingRef.current.has(url)) return;
    thumbLoadingRef.current.add(url);
    try {
      const meta = await getSpotifyOembed(url);
      const thumb = (meta.thumbnail_url ?? "").trim();
      if (thumb) {
        setThumbs((prev) => ({ ...prev, [url]: thumb }));
      }
    } catch {
      // Thumbnail is optional.
    } finally {
      thumbLoadingRef.current.delete(url);
    }
  }, [thumbs]);

  const pumpThumbQueue = useCallback(() => {
    const MAX_WORKERS = 6;
    while (thumbWorkersRef.current < MAX_WORKERS && thumbQueueRef.current.length > 0) {
      const nextUrl = thumbQueueRef.current.shift();
      if (!nextUrl) continue;
      thumbWorkersRef.current += 1;
      void resolveThumb(nextUrl).finally(() => {
        thumbWorkersRef.current = Math.max(0, thumbWorkersRef.current - 1);
        pumpThumbQueue();
      });
    }
  }, [resolveThumb]);

  useEffect(() => {
    if (view !== "tracks") return;
    const urls = Array.from(
      new Set(
        tracks
          .map((track) => (track.spotify_url ?? "").trim())
          .filter((url) => url.startsWith("https://open.spotify.com/track/")),
      ),
    );
    for (const url of urls) {
      if (thumbs[url]) continue;
      if (thumbLoadingRef.current.has(url)) continue;
      if (thumbQueueRef.current.includes(url)) continue;
      thumbQueueRef.current.push(url);
    }
    pumpThumbQueue();
  }, [view, tracks, thumbs, pumpThumbQueue]);

  useEffect(() => {
    if (view !== "tracks" || !selectedPlaylist) return;
    const root = listRef.current;
    const sentinel = loadMoreRef.current;
    if (!root || !sentinel) return;
    if (!tracksHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (!visible) return;
        if (loading || loadingMoreTracks) return;
        void loadTracksPage(selectedPlaylist.id, true);
      },
      { root, rootMargin: "180px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [view, selectedPlaylist, tracksHasMore, loading, loadingMoreTracks, loadTracksPage]);

  async function handleImport() {
    if (importFiles.length === 0) {
      setError("Kies eerst minimaal 1 .csv bestand.");
      return;
    }
    const safeName = importName.trim();
    if (!safeName) {
      setError("Geef eerst een playlistnaam op.");
      return;
    }
    setImporting(true);
    setError(null);
    setStatus(null);
    try {
      const meta: PlaylistGenreMetaInput = {
        genre_group: importGenreGroup.trim() || null,
        subgenre: importSubgenre.trim() || null,
        cover_url: importCoverUrl.trim() || null,
        auto_cover: importAutoCover,
      };
      const result = await importSharedPlaylistFiles(importFiles, safeName, meta);
      setStatus(`Import klaar: ${result.playlist.name} (${result.playlist.trackCount} unieke tracks).`);
      setImportFiles([]);
      setImportName("");
      setImportSubgenre("");
      setImportCoverUrl("");
      setImportAutoCover(true);
      await loadSharedPlaylists();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import mislukt.");
    } finally {
      setImporting(false);
    }
  }

  function openPlaylistEdit(playlist: SharedPlaylist) {
    setEditDraft({
      id: playlist.id,
      name: playlist.name,
      genre_group: playlist.genre_group ?? "",
      subgenre: playlist.subgenre ?? "",
      cover_url: playlist.cover_url ?? "",
    });
  }

  async function savePlaylistEdit() {
    if (!editDraft) return;
    setEditSaving(true);
    setError(null);
    try {
      await updateSharedPlaylistAsOwner(editDraft.id, {
        playlistName: editDraft.name.trim(),
        genre_group: editDraft.genre_group.trim() || null,
        subgenre: editDraft.subgenre.trim() || null,
        cover_url: editDraft.cover_url.trim() || null,
      });
      setStatus("Playlist bijgewerkt.");
      setEditDraft(null);
      await loadSharedPlaylists();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Opslaan mislukt.");
    } finally {
      setEditSaving(false);
    }
  }

  async function handleAddTrack(track: UserPlaylistTrack) {
    if (pendingTrackId === track.id || addedTrackId === track.id) return;
    setPendingTrackId(track.id);
    setAddedTrackId(track.id);
    const artist = (track.artist ?? "").trim();
    const title = (track.title ?? "").trim();
    const query = artist ? `${artist} - ${title}` : title;
    const sourceGenre = selectedPlaylist
      ? [selectedPlaylist.genre_group, selectedPlaylist.subgenre].filter(Boolean).join(" / ") || null
      : null;
    try {
      const result = await onAddTrack({
        id: track.id,
        query,
        artist: artist || null,
        title: title || null,
        sourceType: "shared_playlist",
        sourceGenre,
        sourcePlaylist: selectedPlaylist?.name ?? null,
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

  function setAsAutoplayFallback(playlist: SharedPlaylist) {
    if (lockAutoplayFallback && !getRadioToken()) {
      setStatus("Autoplay fallback is vergrendeld (alleen admin kan dit wijzigen).");
      return;
    }
    const selectedBy = (typeof window !== "undefined" ? localStorage.getItem("nickname") : null)?.trim() || "onbekend";
    getSocket().emit("fallback:genre:set", {
      genreId: playlist.kind === "user_public" ? playlist.id : `shared:${playlist.id}`,
      selectedBy,
      sharedPlaybackMode: "random",
      token: getRadioToken() ?? undefined,
    });
    setStatus(`Autoplay fallback ingesteld op: ${playlist.name}`);
  }

  function renderPlaylistOptions(playlist: SharedPlaylist) {
    const actions: MenuAction[] = [
      {
        key: "auto",
        label: "Gebruik als autoplay fallback",
        tone: "accent" as const,
        onSelect: () => setAsAutoplayFallback(playlist),
      },
    ];
    if (isPlaylistOwner(playlist) && playlist.kind !== "user_public") {
      actions.push({
        key: "edit",
        label: "Bewerk playlist",
        tone: "default" as const,
        onSelect: () => openPlaylistEdit(playlist),
      });
    }
    return <PlaylistOptionsButton actions={actions} />;
  }

  const filteredPlaylists = sharedPlaylists.filter((playlist) =>
    playlist.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const sortedPlaylists = useMemo(
    () => sortPlaylists(filteredPlaylists, playlistSortMode),
    [filteredPlaylists, playlistSortMode],
  );
  const groupedPlaylists = useMemo(() => groupPlaylistsByGenre(sortedPlaylists), [sortedPlaylists]);
  const filteredTracks = tracks.filter((track) => {
    const q = filter.toLowerCase();
    if (!q) return true;
    return (
      track.title.toLowerCase().includes(q)
      || (track.artist ?? "").toLowerCase().includes(q)
      || (track.album ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1.5 pb-[max(env(safe-area-inset-bottom),4px)] sm:pb-0">
      <div className="flex shrink-0 items-center justify-between px-0.5">
        {view === "tracks" ? (
          <button
            type="button"
            onClick={backToPlaylists}
            className="flex items-center gap-1 text-xs text-violet-400 transition hover:text-violet-300"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            {selectedPlaylist?.name ?? "Terug"}
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            Playlists (publiek)
          </div>
        )}
        {view === "playlists" && (
          <button
            type="button"
            onClick={() => setShowHelp((prev) => !prev)}
            className="rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-[11px] font-semibold text-gray-300 transition hover:border-blue-500 hover:text-white"
            title="Uitleg playlists"
          >
            ?
          </button>
        )}
      </div>
      {showHelp && view === "playlists" && (
        <div className="shrink-0 rounded-md border border-blue-800/60 bg-blue-950/25 p-2 text-[11px] text-blue-100">
          <p className="font-semibold">Wat doet dit?</p>
          <p className="mt-0.5 text-blue-100/90">
            Hier kies je publieke playlists om snel tracks toe te voegen. Via `Opties` kun je een playlist als autoplay fallback gebruiken,
            en als eigenaar ook de naam, cover en genre-informatie aanpassen.
          </p>
        </div>
      )}

      <NoAutofillInput
        type="search"
        name={`shared-filter-${Math.random().toString(36).substring(7)}`}
        autoComplete="off"
        spellCheck={false}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={view === "playlists" ? "Filter playlists..." : "Filter tracks..."}
        className="w-full shrink-0 rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 text-xs text-white placeholder-gray-500 outline-none transition focus:border-violet-500"
      />

      {loading && (
        <div className="flex shrink-0 items-center justify-center py-3">
          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
        </div>
      )}

      {view === "playlists" && !loading && (
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto pb-14 sm:pb-2">
          <div className="mb-2 rounded-md border border-blue-700/70 bg-blue-950/20 p-2">
            {sharedUsage && (
              <p className="mb-1 text-[10px] text-blue-300/80">
                Pool: {sharedUsage.playlists} playlists · {sharedUsage.tracks} tracks
              </p>
            )}
            <div className="mb-1 flex flex-wrap items-center justify-between gap-1.5">
              <button
                type="button"
                onClick={() => { void loadSharedPlaylists(); }}
                disabled={loading}
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] font-semibold text-violet-300 transition hover:border-violet-500 hover:text-violet-200 disabled:opacity-40"
              >
                {loading ? "Laden..." : "Ververs"}
              </button>
              <select
                value={playlistSortMode}
                onChange={(e) => setPlaylistSortMode(e.target.value as PlaylistSortMode)}
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white outline-none focus:border-violet-500"
              >
                <option value="name_asc">Naam A-Z</option>
                <option value="name_desc">Naam Z-A</option>
                <option value="tracks_desc">Meeste tracks</option>
                <option value="newest">Nieuwste import</option>
              </select>
            </div>
            <div className="mb-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setPlaylistViewMode("grouped")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  playlistViewMode === "grouped"
                    ? "bg-blue-700/35 text-blue-100"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Op genre
              </button>
              <button
                type="button"
                onClick={() => setPlaylistViewMode("all")}
                className={`rounded px-2 py-1 text-[10px] font-semibold transition ${
                  playlistViewMode === "all"
                    ? "bg-blue-700/35 text-blue-100"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Alles onder elkaar
              </button>
            </div>
            {groupedPlaylists.length === 0 && (
              <p className="text-[10px] text-gray-400">Nog geen publieke playlists beschikbaar.</p>
            )}
            {playlistViewMode === "grouped" ? groupedPlaylists.map((genreGroup) => (
              <details
                key={`genre:${genreGroup.genreLabel}`}
                open={hasStoredCollapseState ? !collapsedGenres.includes(genreGroup.genreLabel) : false}
                onToggle={(event) => {
                  const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                  setHasStoredCollapseState(true);
                  setCollapsedGenres((prev) => (
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
                      key={`sub:${genreGroup.genreLabel}:${subgroup.subgenreLabel}`}
                      open={hasStoredCollapseState ? !collapsedSubgenres.includes(`${genreGroup.genreLabel}::${subgroup.subgenreLabel}`) : false}
                      onToggle={(event) => {
                        const key = `${genreGroup.genreLabel}::${subgroup.subgenreLabel}`;
                        const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                        setHasStoredCollapseState(true);
                        setCollapsedSubgenres((prev) => (
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
                          <div key={playlist.id} className="space-y-1">
                            <div className="flex w-full items-center gap-1 rounded-lg border border-gray-800 bg-gray-900/70 px-2 py-1.5 text-left transition hover:border-blue-700/60 hover:bg-gray-800/80 sm:gap-2 sm:px-2.5">
                              {playlist.cover_url ? (
                                <img src={playlist.cover_url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                              ) : (
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-blue-500/15">
                                  <svg className="h-4 w-4 text-blue-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                    <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />
                                  </svg>
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={() => { void openPlaylist(playlist); }}
                                className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white"
                              >
                                {playlist.name}
                              </button>
                              <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                                {playlist.track_count}
                              </span>
                              {renderPlaylistOptions(playlist)}
                            </div>
                            {editDraft?.id === playlist.id && (
                              <div className="rounded border border-violet-800/60 bg-violet-950/25 p-2 text-[10px] text-gray-200">
                                <p className="mb-1 font-semibold text-violet-200">Playlist bewerken</p>
                                <input
                                  type="text"
                                  value={editDraft.name}
                                  onChange={(e) => setEditDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                                  className="mb-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white"
                                  placeholder="Naam"
                                />
                                <div className="mb-1 grid gap-1 sm:grid-cols-2">
                                  <select
                                    value={editDraft.genre_group}
                                    onChange={(e) => setEditDraft((d) => (d ? { ...d, genre_group: e.target.value } : d))}
                                    className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white"
                                  >
                                    <option value="">Overkoepelend genre</option>
                                    {PLAYLIST_GENRE_GROUPS.map((group) => (
                                      <option key={group} value={group}>{group}</option>
                                    ))}
                                  </select>
                                  <input
                                    type="text"
                                    value={editDraft.subgenre}
                                    onChange={(e) => setEditDraft((d) => (d ? { ...d, subgenre: e.target.value } : d))}
                                    placeholder="Subgenre"
                                    className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white placeholder-gray-500"
                                  />
                                </div>
                                <input
                                  type="text"
                                  value={editDraft.cover_url}
                                  onChange={(e) => setEditDraft((d) => (d ? { ...d, cover_url: e.target.value } : d))}
                                  placeholder="Cover URL (https...)"
                                  className="mb-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white placeholder-gray-500"
                                />
                                <div className="flex flex-wrap gap-1">
                                  <button
                                    type="button"
                                    onClick={() => { void savePlaylistEdit(); }}
                                    disabled={editSaving || !editDraft.name.trim()}
                                    className="rounded bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                                  >
                                    {editSaving ? "Opslaan..." : "Opslaan"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditDraft(null)}
                                    className="rounded border border-gray-600 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-800"
                                  >
                                    Annuleren
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )) : sortedPlaylists.map((playlist) => (
              <div key={playlist.id} className="mt-1 space-y-1">
                <div className="flex w-full items-center gap-1 rounded-lg border border-gray-800 bg-gray-900/70 px-2 py-1.5 text-left transition hover:border-blue-700/60 hover:bg-gray-800/80 sm:gap-2 sm:px-2.5">
                  {playlist.cover_url ? (
                    <img src={playlist.cover_url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-blue-500/15">
                      <svg className="h-4 w-4 text-blue-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />
                      </svg>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => { void openPlaylist(playlist); }}
                    className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white"
                  >
                    {playlist.name}
                  </button>
                  <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                    {playlist.track_count}
                  </span>
                  {renderPlaylistOptions(playlist)}
                </div>
                {editDraft?.id === playlist.id && (
                  <div className="rounded border border-violet-800/60 bg-violet-950/25 p-2 text-[10px] text-gray-200">
                    <p className="mb-1 font-semibold text-violet-200">Playlist bewerken</p>
                    <input
                      type="text"
                      value={editDraft.name}
                      onChange={(e) => setEditDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                      className="mb-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white"
                      placeholder="Naam"
                    />
                    <div className="mb-1 grid gap-1 sm:grid-cols-2">
                      <select
                        value={editDraft.genre_group}
                        onChange={(e) => setEditDraft((d) => (d ? { ...d, genre_group: e.target.value } : d))}
                        className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white"
                      >
                        <option value="">Overkoepelend genre</option>
                        {PLAYLIST_GENRE_GROUPS.map((group) => (
                          <option key={group} value={group}>{group}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={editDraft.subgenre}
                        onChange={(e) => setEditDraft((d) => (d ? { ...d, subgenre: e.target.value } : d))}
                        placeholder="Subgenre"
                        className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white placeholder-gray-500"
                      />
                    </div>
                    <input
                      type="text"
                      value={editDraft.cover_url}
                      onChange={(e) => setEditDraft((d) => (d ? { ...d, cover_url: e.target.value } : d))}
                      placeholder="Cover URL (https...)"
                      className="mb-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[10px] text-white placeholder-gray-500"
                    />
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        onClick={() => { void savePlaylistEdit(); }}
                        disabled={editSaving || !editDraft.name.trim()}
                        className="rounded bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                      >
                        {editSaving ? "Opslaan..." : "Opslaan"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditDraft(null)}
                        className="rounded border border-gray-600 px-2 py-1 text-[10px] text-gray-300 hover:bg-gray-800"
                      >
                        Annuleren
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <details className="mb-2 rounded-lg border border-gray-700/70 bg-gradient-to-br from-gray-900 to-gray-900/70 p-2.5">
            <summary className="cursor-pointer list-none text-[11px] font-semibold text-gray-200">
              Nieuwe playlist toevoegen
            </summary>
            <p className="mt-1 text-[10px] text-gray-500">
              Upload meerdere Exportify CSV&apos;s tegelijk (Ctrl/Shift in bestandsdialoog). We voegen samen en dedupliceren
              zoals bij admin-import. Naam is verplicht; daarna kun je je eigen playlist nog bewerken via Bewerk.
            </p>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              <select
                value={importGenreGroup}
                onChange={(e) => setImportGenreGroup(e.target.value)}
                onFocus={(e) => keepFieldVisibleOnMobile(e.currentTarget)}
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white"
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
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white placeholder-gray-500"
              />
            </div>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-[1fr_auto]">
              <input
                type="text"
                value={importCoverUrl}
                onChange={(e) => setImportCoverUrl(e.target.value)}
                placeholder="Playlist cover URL (optioneel)"
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white placeholder-gray-500"
              />
              <label className="flex items-center gap-1.5 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-gray-200">
                <input
                  type="checkbox"
                  checked={importAutoCover}
                  onChange={(e) => setImportAutoCover(e.target.checked)}
                  className="h-3 w-3 accent-violet-500"
                />
                Auto cover
              </label>
            </div>
            <input
              type="text"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="Playlist naam (verplicht; underscores → spaties in titel)"
              className="mt-2 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[11px] text-white placeholder-gray-500 outline-none focus:border-violet-500"
            />
            <input
              type="file"
              multiple
              accept=".csv,text/csv,application/csv,application/vnd.ms-excel"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []).filter((file) => file.name.toLowerCase().endsWith(".csv"));
                setImportFiles(files);
                setError(null);
              }}
              className="mt-2 w-full text-[10px] text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-700 file:px-2 file:py-1 file:text-[10px] file:font-medium file:text-white"
            />
            {importFiles.length > 0 && (
              <p className="mt-1 text-[10px] text-gray-400">{importFiles.length} CSV bestand(en) geselecteerd</p>
            )}
            <button
              type="button"
              onClick={() => { void handleImport(); }}
              disabled={importFiles.length === 0 || !importName.trim() || importing}
              className="mt-2 rounded bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? "Importeren..." : "Importeer bestand"}
            </button>
            {status && <p className="mt-1 text-[10px] text-green-300">{status}</p>}
            {error && <p className="mt-1 text-[10px] text-red-300">{error}</p>}
          </details>
          <div className="h-10 w-full sm:h-2" />
        </div>
      )}

      {view === "tracks" && !loading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto pb-14 sm:pb-2">
          {filteredTracks.map((track) => {
            const isAdded = addedTrackId === track.id;
            const isPending = pendingTrackId === track.id;
            const spotifyUrl = (track.spotify_url ?? "").trim();
            const thumb = spotifyUrl ? thumbs[spotifyUrl] : "";
            return (
              <div
                key={track.id}
                className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleAddTrack(track)}
                  disabled={submitting || isPending}
                  className="flex min-w-0 flex-1 items-center gap-2 disabled:opacity-60"
                >
                {thumb ? (
                  <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded bg-gray-800" />
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
                    album={track.album}
                    className="mr-1"
                    iconSize={16}
                  />
                </div>
              </div>
            );
          })}
          {filteredTracks.length === 0 && (
            <p className="py-2 text-center text-[11px] text-gray-500">Geen tracks gevonden</p>
          )}
          {loadingMoreTracks && (
            <p className="py-2 text-center text-[11px] text-gray-500">Meer tracks laden...</p>
          )}
          <div ref={loadMoreRef} className="h-10 w-full sm:h-2" />
        </div>
      )}
    </div>
  );
}
