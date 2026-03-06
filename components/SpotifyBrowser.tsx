"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  getUserPlaylistTracks,
  getSpotifyOembed,
  importUserPlaylistFile,
  listUserPlaylists,
  type UserPlaylist,
  type UserPlaylistTrack,
} from "@/lib/userPlaylistsApi";

interface SpotifyBrowserProps {
  onAddTrack: (track: { id?: string; query: string; artist?: string | null; title?: string | null }) => void;
  submitting: boolean;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type View = "playlists" | "tracks" | "importedTracks";
type TrackSource = "liked" | "playlist" | null;

export default function SpotifyBrowser({ onAddTrack, submitting }: SpotifyBrowserProps) {
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
  const [trackError, setTrackError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [playlistsNext, setPlaylistsNext] = useState<string | null>(null);
  const [tracksNext, setTracksNext] = useState<string | null>(null);
  const [trackSource, setTrackSource] = useState<TrackSource>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [savedPlaylists, setSavedPlaylists] = useState<UserPlaylist[]>([]);
  const [savedPlaylistsLoading, setSavedPlaylistsLoading] = useState(false);
  const [savedTracks, setSavedTracks] = useState<UserPlaylistTrack[]>([]);
  const [savedTracksLoading, setSavedTracksLoading] = useState(false);
  const [savedTracksError, setSavedTracksError] = useState<string | null>(null);
  const [selectedSavedPlaylist, setSelectedSavedPlaylist] = useState<UserPlaylist | null>(null);
  const [savedTrackThumbs, setSavedTrackThumbs] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const thumbnailLoadingRef = useRef<Set<string>>(new Set());

  const configured = isSpotifyConfigured();

  const checkConnection = useCallback(() => {
    const c = isSpotifyConnected();
    setConnected(c);
    return c;
  }, []);

  useEffect(() => {
    void loadSavedPlaylists();
    if (!checkConnection()) return;
    loadUser();
    void loadPlaylists(false);
  }, [checkConnection]);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if ((e.key === "spotify_token" || e.key === "spotify_refresh_token") && e.newValue) {
        setConnected(true);
        setAuthStatus(null);
        loadUser();
        void loadPlaylists(false);
        void loadSavedPlaylists();
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  async function loadUser() {
    try {
      const data = await spotifyFetch<SpotifyUser>("/me");
      if (data) setUser(data);
      else setConnected(false);
    } catch {
      setConnected(false);
    }
  }

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

  async function openSavedPlaylist(playlist: UserPlaylist) {
    setSelectedSavedPlaylist(playlist);
    setView("importedTracks");
    setFilter("");
    setSavedTracks([]);
    setSavedTracksError(null);
    setSavedTracksLoading(true);
    try {
      const tracks = await getUserPlaylistTracks(playlist.id);
      setSavedTracks(tracks);
    } catch (err) {
      setSavedTracksError(err instanceof Error ? err.message : "Kon tracks niet laden.");
    } finally {
      setSavedTracksLoading(false);
    }
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

  async function resolveSavedTrackThumbnail(spotifyUrl: string): Promise<void> {
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
  }

  async function handleImportExportify() {
    if (!importFile) {
      setImportError("Kies eerst een .csv of .zip bestand.");
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportStatus(null);
    try {
      const result = await importUserPlaylistFile(importFile);
      setImportStatus(`Import klaar: ${result.totalPlaylists} playlist(s), ${result.totalTracks} tracks.`);
      setImportFile(null);
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
    setSelectedPlaylist({ id: "liked", name: "Liked Songs", images: [], tracks: { total: 0 }, owner: { display_name: "" } });
    setTrackSource("liked");
    setView("tracks");
    setFilter("");
    setTracks([]);
    setTracksNext(null);
    await loadLikedSongs(false);
  }

  function handleAddTrack(track: SpotifyTrackItem) {
    try {
      const artists = track.artists?.map((a) => a?.name).filter(Boolean).join(", ") || "Unknown";
      const query = `${artists} - ${track.name ?? "Unknown"}`;
      setAddedTrackId(track.id);
      onAddTrack({ id: track.id ?? undefined, query, artist: artists, title: track.name ?? null });
      setTimeout(() => setAddedTrackId(null), 3000);
    } catch {}
  }

  function handleAddSavedTrack(track: UserPlaylistTrack) {
    const artist = (track.artist ?? "").trim();
    const title = (track.title ?? "").trim();
    const query = artist ? `${artist} - ${title}` : title;
    setAddedTrackId(track.id);
    onAddTrack({
      query,
      artist: artist || null,
      title: title || null,
    });
    setTimeout(() => setAddedTrackId(null), 3000);
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
  }, [view, playlistsNext, tracksNext, trackSource, selectedPlaylist, loading, loadingMore]);

  useEffect(() => {
    const onTokenRefresh = () => {
      setConnected(checkConnection());
      setAuthStatus("Spotify sessie vernieuwd.");
      if (view === "playlists") {
        void loadPlaylists(false);
        void loadSavedPlaylists();
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
  }, [checkConnection, view, trackSource, selectedPlaylist]);

  const spotifyEnabled = configured && connected;

  const filteredPlaylists = playlists.filter((p) =>
    p?.name?.toLowerCase().includes(filter.toLowerCase()),
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

  useEffect(() => {
    if (view !== "importedTracks") return;
    const uniqueUrls = Array.from(
      new Set(
        filteredSavedTracks
          .map((track) => (track.spotify_url ?? "").trim())
          .filter((url) => url.startsWith("https://open.spotify.com/track/")),
      ),
    );
    const missing = uniqueUrls.filter((url) => !savedTrackThumbs[url]).slice(0, 8);
    if (missing.length === 0) return;
    for (const url of missing) {
      void resolveSavedTrackThumbnail(url);
    }
  }, [view, filteredSavedTracks, savedTrackThumbs]);

  return (
    <div className="flex max-h-[40vh] flex-col gap-1.5 overflow-hidden">
      {/* Header + navigation */}
      <div className="flex shrink-0 items-center justify-between">
        {view !== "playlists" ? (
          <button
            type="button"
            onClick={() => {
              setView("playlists");
              setTracks([]);
              setTracksNext(null);
              setTrackSource(null);
              setSavedTracks([]);
              setSelectedSavedPlaylist(null);
              setFilter("");
              setTrackError(null);
              setSavedTracksError(null);
            }}
            className="flex items-center gap-1 text-xs text-violet-400 transition hover:text-violet-300"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            {view === "importedTracks" ? (selectedSavedPlaylist?.name ?? "Terug") : (selectedPlaylist?.name ?? "Terug")}
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <span className={`h-1.5 w-1.5 rounded-full ${spotifyEnabled ? "bg-[#1DB954]" : "bg-violet-400"}`} />
            {spotifyEnabled ? (user?.display_name ?? "Spotify") : "Exportify"}
          </div>
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
      {(loading || savedTracksLoading) && (
        <div className="flex shrink-0 items-center justify-center py-3">
          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-[#1DB954] border-t-transparent" />
        </div>
      )}

      {/* Playlist list */}
      {view === "playlists" && !loading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto">
          <div className="mb-2 rounded-md border border-gray-700/70 bg-gray-900/60 p-2">
            <p className="text-[11px] font-semibold text-gray-200">Import Exportify</p>
            <p className="mt-0.5 text-[10px] text-gray-500">Upload .csv of .zip met playlists uit Exportify.</p>
            <input
              type="file"
              accept=".csv,.zip"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setImportFile(file);
                setImportError(null);
              }}
              className="mt-2 w-full text-[10px] text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-700 file:px-2 file:py-1 file:text-[10px] file:font-medium file:text-white"
            />
            <button
              type="button"
              onClick={() => { void handleImportExportify(); }}
              disabled={!importFile || importing}
              className="mt-2 rounded bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? "Importeren..." : "Importeer bestand"}
            </button>
            {importStatus && <p className="mt-1 text-[10px] text-green-300">{importStatus}</p>}
            {importError && <p className="mt-1 text-[10px] text-red-300">{importError}</p>}
          </div>

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
            {savedPlaylists.length === 0 && !savedPlaylistsLoading && (
              <p className="text-[10px] text-gray-500">Nog geen geïmporteerde playlists.</p>
            )}
            {savedPlaylists.map((playlist) => (
              <div key={playlist.id} className="mt-1 flex items-center justify-between rounded bg-gray-800/70 px-2 py-1">
                <button
                  type="button"
                  onClick={() => { void openSavedPlaylist(playlist); }}
                  className="truncate text-left text-[11px] text-white transition hover:text-violet-300"
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

          {!configured && (
            <p className="mb-2 text-[10px] text-gray-500">
              Spotify is niet geconfigureerd. Exportify import werkt wel.
            </p>
          )}
          {configured && !connected && (
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

          {spotifyEnabled && (
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
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition hover:bg-gray-800/80"
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
          <div ref={loadMoreRef} className="h-1 w-full" />
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

      {/* Track list */}
      {view === "tracks" && !spotifyEnabled && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2">
          <p className="text-[11px] text-yellow-300">Spotify is niet verbonden. Ga terug naar playlists of koppel opnieuw.</p>
        </div>
      )}

      {view === "tracks" && spotifyEnabled && !loading && (
        <div ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto">
          {filteredTracks.map((track) => {
            const artists = track.artists?.map((a) => a?.name).filter(Boolean).join(", ") || "";
            const imgs = track.album?.images;
            const albumImg = imgs?.[0]?.url ?? imgs?.[imgs.length - 1]?.url;
            const isAdded = addedTrackId === track.id;

            return (
              <button
                type="button"
                key={track.id}
                onClick={() => handleAddTrack(track)}
                disabled={submitting || isAdded}
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
          <div ref={loadMoreRef} className="h-1 w-full" />
        </div>
      )}

      {view === "importedTracks" && !savedTracksLoading && (
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto">
          {filteredSavedTracks.map((track) => {
            const isAdded = addedTrackId === track.id;
            const spotifyUrl = (track.spotify_url ?? "").trim();
            const thumb = spotifyUrl ? savedTrackThumbs[spotifyUrl] : "";
            return (
              <button
                type="button"
                key={track.id}
                onClick={() => handleAddSavedTrack(track)}
                disabled={submitting || isAdded}
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
        </div>
      )}
    </div>
  );
}
