"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSharedPlaylistTracksPage,
  getSpotifyOembed,
  importSharedPlaylistFiles,
  listSharedPlaylists,
  type PlaylistGenreMetaInput,
  type SharedPlaylist,
  type UserPlaylistTrack,
} from "@/lib/userPlaylistsApi";

interface SharedPlaylistsBrowserProps {
  onAddTrack: (track: {
    id?: string;
    query: string;
    artist?: string | null;
    title?: string | null;
    sourceType?: string | null;
    sourceGenre?: string | null;
    sourcePlaylist?: string | null;
  }) => void;
  submitting: boolean;
}

type View = "playlists" | "tracks";
const TRACK_PAGE_SIZE = 120;
const PLAYLIST_GENRE_GROUPS = [
  "Hard Dance",
  "Hardcore",
  "Hardstyle",
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

function buildPlaylistTreeRows<T extends { id: string; related_parent_playlist_id: string | null }>(
  items: T[],
): Array<{ item: T; depth: number }> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string | null, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parentId = item.related_parent_playlist_id?.trim() || null;
    if (parentId && byId.has(parentId) && parentId !== item.id) {
      const bucket = children.get(parentId) ?? [];
      bucket.push(item);
      children.set(parentId, bucket);
    } else {
      roots.push(item);
    }
  }
  const output: Array<{ item: T; depth: number }> = [];
  const walk = (node: T, depth: number, chain: Set<string>) => {
    output.push({ item: node, depth });
    if (chain.has(node.id)) return;
    const nextChain = new Set(chain);
    nextChain.add(node.id);
    for (const child of children.get(node.id) ?? []) walk(child, Math.min(depth + 1, 5), nextChain);
  };
  for (const root of roots) walk(root, 0, new Set());
  return output;
}

export default function SharedPlaylistsBrowser({ onAddTrack, submitting }: SharedPlaylistsBrowserProps) {
  const [view, setView] = useState<View>("playlists");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importName, setImportName] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [importGenreGroup, setImportGenreGroup] = useState("");
  const [importSubgenre, setImportSubgenre] = useState("");
  const [importRelatedPlaylistId, setImportRelatedPlaylistId] = useState("");
  const [addedTrackId, setAddedTrackId] = useState<string | null>(null);
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

  async function loadSharedPlaylists() {
    setLoading(true);
    setError(null);
    try {
      const result = await listSharedPlaylists(180, 0);
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
    setSelectedPlaylist(playlist);
    setView("tracks");
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
        related_parent_playlist_id: importRelatedPlaylistId.trim() || null,
      };
      const result = await importSharedPlaylistFiles(importFiles, safeName, meta);
      setStatus(`Import klaar: ${result.playlist.name} (${result.playlist.trackCount} unieke tracks).`);
      setImportFiles([]);
      setImportName("");
      setImportSubgenre("");
      setImportRelatedPlaylistId("");
      await loadSharedPlaylists();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import mislukt.");
    } finally {
      setImporting(false);
    }
  }

  function handleAddTrack(track: UserPlaylistTrack) {
    const artist = (track.artist ?? "").trim();
    const title = (track.title ?? "").trim();
    const query = artist ? `${artist} - ${title}` : title;
    const sourceGenre = selectedPlaylist
      ? [selectedPlaylist.genre_group, selectedPlaylist.subgenre].filter(Boolean).join(" / ") || null
      : null;
    setAddedTrackId(track.id);
    onAddTrack({
      id: track.id,
      query,
      artist: artist || null,
      title: title || null,
      sourceType: "shared_playlist",
      sourceGenre,
      sourcePlaylist: selectedPlaylist?.name ?? null,
    });
    setTimeout(() => setAddedTrackId(null), 3000);
  }

  const filteredPlaylists = sharedPlaylists.filter((playlist) =>
    playlist.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const playlistTreeRows = buildPlaylistTreeRows(filteredPlaylists);
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
    <div className="flex h-[62dvh] max-h-[62dvh] min-h-0 flex-col gap-1.5 overflow-hidden pb-[max(env(safe-area-inset-bottom),4px)] sm:h-auto sm:max-h-[40vh] sm:pb-0">
      <div className="flex shrink-0 items-center justify-between">
        {view === "tracks" ? (
          <button
            type="button"
            onClick={() => {
              setView("playlists");
              setSelectedPlaylist(null);
              setTracks([]);
              setTracksOffset(0);
              setTracksHasMore(false);
              setFilter("");
              setError(null);
            }}
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
            Hier kies je publieke playlists om snel tracks toe te voegen. Upload 1 of meerdere Exportify CSV's,
            geef 1 playlistnaam op, en dubbele tracks worden automatisch verwijderd.
          </p>
        </div>
      )}

      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={view === "playlists" ? "Filter playlists..." : "Filter tracks..."}
        className="w-full shrink-0 rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 text-xs text-white placeholder-gray-500 outline-none transition focus:border-blue-500"
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
            <button
              type="button"
              onClick={() => { void loadSharedPlaylists(); }}
              className="mb-1 text-[10px] text-blue-300 transition hover:text-blue-200"
            >
              Ververs
            </button>
            {playlistTreeRows.length === 0 && (
              <p className="text-[10px] text-gray-400">Nog geen publieke playlists beschikbaar.</p>
            )}
            {playlistTreeRows.map(({ item: playlist, depth }) => (
              <button
                key={playlist.id}
                type="button"
                onClick={() => { void openPlaylist(playlist); }}
                className="mt-1 flex w-full items-center gap-2 rounded-lg border border-gray-800 bg-gray-900/70 px-2.5 py-1.5 text-left transition hover:border-blue-700/60 hover:bg-gray-800/80"
                style={{ marginLeft: `${depth * 12}px` }}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-blue-500/15">
                  <svg className="h-4 w-4 text-blue-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />
                  </svg>
                </div>
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white">
                  {depth > 0 ? "↳ " : ""}{playlist.name}
                  {(playlist.genre_group || playlist.subgenre) ? (
                    <span className="ml-1 text-[10px] font-normal text-gray-400">
                      ({[playlist.genre_group, playlist.subgenre].filter(Boolean).join(" / ")})
                    </span>
                  ) : null}
                </span>
                <span className="ml-2 shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-300">
                  {playlist.track_count}
                </span>
              </button>
            ))}
          </div>
          <details className="mb-2 rounded-lg border border-gray-700/70 bg-gradient-to-br from-gray-900 to-gray-900/70 p-2.5">
            <summary className="cursor-pointer list-none text-[11px] font-semibold text-gray-200">
              Nieuwe playlist toevoegen
            </summary>
            <p className="mt-1 text-[10px] text-gray-500">Upload meerdere Exportify CSV's. We voegen samen en dedupliceren.</p>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
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
              <select
                value={importRelatedPlaylistId}
                onChange={(e) => setImportRelatedPlaylistId(e.target.value)}
                onFocus={(e) => keepFieldVisibleOnMobile(e.currentTarget)}
                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[10px] text-white"
              >
                <option value="">Verwante parent-playlist</option>
                {sharedPlaylists.map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="Playlist naam (verplicht)"
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
            const spotifyUrl = (track.spotify_url ?? "").trim();
            const thumb = spotifyUrl ? thumbs[spotifyUrl] : "";
            return (
              <button
                key={track.id}
                type="button"
                onClick={() => handleAddTrack(track)}
                disabled={submitting || isAdded}
                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition ${
                  isAdded ? "bg-green-500/10" : "hover:bg-gray-800/80"
                } disabled:opacity-60`}
              >
                {thumb ? (
                  <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded bg-gray-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{track.title}</p>
                  <p className="truncate text-[10px] text-gray-400">{track.artist ?? "Unknown"}</p>
                </div>
                {isAdded ? (
                  <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
                    Toegevoegd
                  </span>
                ) : (
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                )}
              </button>
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
