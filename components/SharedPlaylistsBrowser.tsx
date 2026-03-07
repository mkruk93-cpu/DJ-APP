"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSharedPlaylistTracksPage,
  getSpotifyOembed,
  importUserPlaylistFile,
  listSharedPlaylists,
  type SharedPlaylist,
  type UserPlaylistTrack,
} from "@/lib/userPlaylistsApi";

interface SharedPlaylistsBrowserProps {
  onAddTrack: (track: { id?: string; query: string; artist?: string | null; title?: string | null }) => void;
  submitting: boolean;
}

type View = "playlists" | "tracks";
const TRACK_PAGE_SIZE = 120;

export default function SharedPlaylistsBrowser({ onAddTrack, submitting }: SharedPlaylistsBrowserProps) {
  const [view, setView] = useState<View>("playlists");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
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

  async function resolveThumb(url: string): Promise<void> {
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
  }

  useEffect(() => {
    if (view !== "tracks") return;
    const urls = Array.from(
      new Set(
        tracks
          .map((track) => (track.spotify_url ?? "").trim())
          .filter((url) => url.startsWith("https://open.spotify.com/track/")),
      ),
    );
    for (const url of urls.slice(0, 10)) {
      void resolveThumb(url);
    }
  }, [view, tracks]);

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
    if (!importFile) {
      setError("Kies eerst een .csv of .zip bestand.");
      return;
    }
    setImporting(true);
    setError(null);
    setStatus(null);
    try {
      const result = await importUserPlaylistFile(importFile);
      setStatus(
        `Import klaar: ${result.totalPlaylists} playlist(s), ${result.totalTracks} tracks`
        + `${result.shared ? ` · gedeeld: ${result.shared.importedPlaylists}` : ""}.`,
      );
      setImportFile(null);
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
    setAddedTrackId(track.id);
    onAddTrack({ id: track.id, query, artist: artist || null, title: title || null });
    setTimeout(() => setAddedTrackId(null), 3000);
  }

  const filteredPlaylists = sharedPlaylists.filter((playlist) =>
    playlist.name.toLowerCase().includes(filter.toLowerCase()),
  );
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
    <div className="flex max-h-[40vh] flex-col gap-1.5 overflow-hidden">
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
      </div>

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
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto">
          <div className="mb-2 rounded-md border border-gray-700/70 bg-gray-900/60 p-2">
            <p className="text-[11px] font-semibold text-gray-200">Nieuwe playlist toevoegen</p>
            <p className="mt-0.5 text-[10px] text-gray-500">Upload Exportify .csv/.zip. Wordt automatisch gedeeld.</p>
            <input
              type="file"
              accept=".csv,.zip"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setImportFile(file);
                setError(null);
              }}
              className="mt-2 w-full text-[10px] text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-700 file:px-2 file:py-1 file:text-[10px] file:font-medium file:text-white"
            />
            <button
              type="button"
              onClick={() => { void handleImport(); }}
              disabled={!importFile || importing}
              className="mt-2 rounded bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? "Importeren..." : "Importeer bestand"}
            </button>
            {status && <p className="mt-1 text-[10px] text-green-300">{status}</p>}
            {error && <p className="mt-1 text-[10px] text-red-300">{error}</p>}
          </div>

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
            {filteredPlaylists.length === 0 && (
              <p className="text-[10px] text-gray-400">Nog geen publieke playlists beschikbaar.</p>
            )}
            {filteredPlaylists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                onClick={() => { void openPlaylist(playlist); }}
                className="mt-1 flex w-full items-center justify-between rounded bg-gray-800/70 px-2 py-1 text-left transition hover:bg-gray-800"
              >
                <span className="truncate text-[11px] text-white">{playlist.name}</span>
                <span className="ml-2 shrink-0 text-[10px] text-gray-400">{playlist.track_count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {view === "tracks" && !loading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto">
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
          <div ref={loadMoreRef} className="h-1 w-full" />
        </div>
      )}
    </div>
  );
}
