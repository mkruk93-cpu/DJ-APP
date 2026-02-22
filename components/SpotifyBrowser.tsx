"use client";

import { useState, useEffect, useCallback } from "react";
import {
  isSpotifyConnected,
  isSpotifyConfigured,
  loginWithSpotify,
  disconnectSpotify,
  spotifyFetch,
  type SpotifyPlaylist,
  type SpotifyPlaylistTrack,
  type SpotifyTrackItem,
  type SpotifyPaginatedResponse,
  type SpotifyUser,
} from "@/lib/spotify";

interface SpotifyBrowserProps {
  onAddTrack: (searchQuery: string) => void;
  submitting: boolean;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type View = "playlists" | "tracks";

export default function SpotifyBrowser({ onAddTrack, submitting }: SpotifyBrowserProps) {
  const [connected, setConnected] = useState(false);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [tracks, setTracks] = useState<SpotifyTrackItem[]>([]);
  const [view, setView] = useState<View>("playlists");
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [addedTrackId, setAddedTrackId] = useState<string | null>(null);

  const configured = isSpotifyConfigured();

  const checkConnection = useCallback(() => {
    const c = isSpotifyConnected();
    setConnected(c);
    return c;
  }, []);

  useEffect(() => {
    if (!checkConnection()) return;
    loadUser();
    loadPlaylists();
  }, [checkConnection]);

  async function loadUser() {
    const data = await spotifyFetch<SpotifyUser>("/me");
    if (data) setUser(data);
    else setConnected(false);
  }

  async function loadPlaylists() {
    setLoading(true);
    const all: SpotifyPlaylist[] = [];
    let url = "/me/playlists?limit=50";

    while (url) {
      const data = await spotifyFetch<SpotifyPaginatedResponse<SpotifyPlaylist>>(url);
      if (!data) break;
      all.push(...data.items);
      if (data.next) {
        url = data.next.replace("https://api.spotify.com/v1", "");
      } else {
        break;
      }
    }

    setPlaylists(all);
    setLoading(false);
  }

  async function openPlaylist(playlist: SpotifyPlaylist) {
    setSelectedPlaylist(playlist);
    setView("tracks");
    setFilter("");
    setLoading(true);

    const all: SpotifyTrackItem[] = [];
    let url = `/playlists/${playlist.id}/tracks?limit=50&fields=items(track(id,name,artists,album,duration_ms)),next,total`;

    while (url) {
      const data = await spotifyFetch<SpotifyPaginatedResponse<SpotifyPlaylistTrack>>(url);
      if (!data) break;
      for (const item of data.items) {
        if (item.track) all.push(item.track);
      }
      if (data.next) {
        url = data.next.replace("https://api.spotify.com/v1", "");
      } else {
        break;
      }
    }

    setTracks(all);
    setLoading(false);
  }

  async function openLikedSongs() {
    setSelectedPlaylist({ id: "liked", name: "Liked Songs", images: [], tracks: { total: 0 }, owner: { display_name: "" } });
    setView("tracks");
    setFilter("");
    setLoading(true);

    const all: SpotifyTrackItem[] = [];
    let url = "/me/tracks?limit=50";

    while (url) {
      const data = await spotifyFetch<SpotifyPaginatedResponse<{ track: SpotifyTrackItem }>>(url);
      if (!data) break;
      for (const item of data.items) {
        if (item.track) all.push(item.track);
      }
      if (data.next) {
        url = data.next.replace("https://api.spotify.com/v1", "");
      } else {
        break;
      }
    }

    setTracks(all);
    setLoading(false);
  }

  function handleAddTrack(track: SpotifyTrackItem) {
    const artists = track.artists.map((a) => a.name).join(", ");
    const query = `${artists} - ${track.name}`;
    setAddedTrackId(track.id);
    onAddTrack(query);
    setTimeout(() => setAddedTrackId(null), 3000);
  }

  function handleDisconnect() {
    disconnectSpotify();
    setConnected(false);
    setUser(null);
    setPlaylists([]);
    setTracks([]);
    setView("playlists");
  }

  if (!configured) {
    return (
      <div className="py-6 text-center text-sm text-gray-500">
        Spotify is niet geconfigureerd.
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <p className="text-sm text-gray-400">
          Koppel je Spotify om nummers uit je playlists toe te voegen
        </p>
        <button
          onClick={loginWithSpotify}
          className="flex items-center gap-2 rounded-full bg-[#1DB954] px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-[#1ed760] active:scale-[0.97]"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
          </svg>
          Koppel Spotify
        </button>
      </div>
    );
  }

  // ── Connected state ──

  const filteredPlaylists = playlists.filter((p) =>
    p.name.toLowerCase().includes(filter.toLowerCase()),
  );

  const filteredTracks = tracks.filter((t) => {
    const q = filter.toLowerCase();
    return (
      t.name.toLowerCase().includes(q) ||
      t.artists.some((a) => a.name.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="h-2 w-2 rounded-full bg-[#1DB954]" />
          {user?.display_name ?? "Spotify"}
        </div>
        <button
          onClick={handleDisconnect}
          className="text-xs text-gray-500 transition hover:text-red-400"
        >
          Ontkoppel
        </button>
      </div>

      {/* Navigation */}
      {view === "tracks" && (
        <button
          onClick={() => { setView("playlists"); setTracks([]); setFilter(""); }}
          className="flex items-center gap-1 text-xs text-violet-400 transition hover:text-violet-300"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {selectedPlaylist?.name ?? "Terug"}
        </button>
      )}

      {/* Filter */}
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={view === "playlists" ? "Filter playlists..." : "Filter nummers..."}
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 outline-none transition focus:border-[#1DB954]"
      />

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-6">
          <span className="block h-5 w-5 animate-spin rounded-full border-2 border-[#1DB954] border-t-transparent" />
        </div>
      )}

      {/* Playlist list */}
      {view === "playlists" && !loading && (
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {/* Liked Songs */}
          <button
            onClick={openLikedSongs}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-gray-800/80"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gradient-to-br from-[#450AF5] to-[#C4EFD9]">
              <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">Liked Songs</p>
              <p className="text-xs text-gray-500">Je opgeslagen nummers</p>
            </div>
          </button>

          {filteredPlaylists.map((pl) => (
            <button
              key={pl.id}
              onClick={() => openPlaylist(pl)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-gray-800/80"
            >
              {pl.images[0] ? (
                <img
                  src={pl.images[0].url}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gray-800">
                  <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V4.5A2.25 2.25 0 0016.5 2.25h-1.875a2.25 2.25 0 00-2.25 2.25v13.5m0 0a2.25 2.25 0 01-2.25 2.25H8.25a2.25 2.25 0 01-2.25-2.25V6.75" />
                  </svg>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{pl.name}</p>
                <p className="text-xs text-gray-500">
                  {pl.tracks.total} nummers &middot; {pl.owner.display_name}
                </p>
              </div>
            </button>
          ))}

          {filteredPlaylists.length === 0 && !loading && (
            <p className="py-4 text-center text-xs text-gray-500">
              Geen playlists gevonden
            </p>
          )}
        </div>
      )}

      {/* Track list */}
      {view === "tracks" && !loading && (
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {filteredTracks.map((track) => {
            const artists = track.artists.map((a) => a.name).join(", ");
            const albumImg = track.album.images[track.album.images.length - 1]?.url;
            const isAdded = addedTrackId === track.id;

            return (
              <button
                key={track.id}
                onClick={() => handleAddTrack(track)}
                disabled={submitting || isAdded}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition ${
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
                  <p className="truncate text-sm font-medium text-white">{track.name}</p>
                  <p className="truncate text-xs text-gray-400">{artists}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs tabular-nums text-gray-500">
                    {formatDuration(track.duration_ms)}
                  </span>
                  {isAdded ? (
                    <svg className="h-4 w-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })}

          {filteredTracks.length === 0 && !loading && (
            <p className="py-4 text-center text-xs text-gray-500">
              Geen nummers gevonden
            </p>
          )}
        </div>
      )}
    </div>
  );
}
