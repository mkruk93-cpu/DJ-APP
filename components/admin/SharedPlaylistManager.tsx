"use client";

import { useEffect, useState } from "react";
import { getRadioToken } from "@/lib/auth";
import {
  deleteSharedPlaylistAdmin,
  deleteSharedPlaylistTrackAdmin,
  getSharedPlaylistTracksPage,
  importIntoSharedPlaylistAdmin,
  listSharedPlaylists,
  updateSharedPlaylistAdmin,
  type SharedPlaylist,
  type UserPlaylistTrack,
} from "@/lib/userPlaylistsApi";

export default function SharedPlaylistManager() {
  const [items, setItems] = useState<SharedPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [genreGroupDraft, setGenreGroupDraft] = useState("");
  const [subgenreDraft, setSubgenreDraft] = useState("");
  const [relatedParentDraft, setRelatedParentDraft] = useState("");
  const [coverDraft, setCoverDraft] = useState("");
  const [autoCoverDraft, setAutoCoverDraft] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tracks, setTracks] = useState<UserPlaylistTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState<string | null>(null);
  const [trackFilter, setTrackFilter] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  async function loadPlaylists() {
    setLoading(true);
    setError(null);
    try {
      const result = await listSharedPlaylists(250, 0);
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kon gedeelde playlists niet laden.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPlaylists();
  }, []);

  async function handleSavePlaylistSettings(playlist: SharedPlaylist) {
    const token = getRadioToken();
    if (!token) {
      setError("Admin token ontbreekt.");
      return;
    }
    const safeName = nameDraft.trim();
    if (!safeName) {
      setError("Playlistnaam mag niet leeg zijn.");
      return;
    }
    setError(null);
    setStatus(null);
    try {
      const updated = await updateSharedPlaylistAdmin(
        playlist.id,
        safeName,
        token,
        {
          genre_group: genreGroupDraft.trim() || null,
          subgenre: subgenreDraft.trim() || null,
          related_parent_playlist_id: relatedParentDraft.trim() || null,
          cover_url: coverDraft.trim() || null,
          auto_cover: autoCoverDraft,
        },
      );
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId(null);
      setNameDraft("");
      setGenreGroupDraft("");
      setSubgenreDraft("");
      setRelatedParentDraft("");
      setCoverDraft("");
      setAutoCoverDraft(true);
      setStatus("Playlist-instellingen bijgewerkt.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playlist bijwerken mislukt.");
    }
  }

  async function handleDelete(playlist: SharedPlaylist) {
    const token = getRadioToken();
    if (!token) {
      setError("Admin token ontbreekt.");
      return;
    }
    if (!window.confirm(`Verwijder "${playlist.name}"?`)) return;
    setError(null);
    setStatus(null);
    try {
      await deleteSharedPlaylistAdmin(playlist.id, token);
      setItems((prev) => prev.filter((item) => item.id !== playlist.id));
      setStatus("Playlist verwijderd.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playlist verwijderen mislukt.");
    }
  }

  async function openPlaylistContent(playlist: SharedPlaylist) {
    if (expandedId === playlist.id) {
      setExpandedId(null);
      setTracks([]);
      setTracksError(null);
      setUploadFiles([]);
      return;
    }
    setExpandedId(playlist.id);
    setTracks([]);
    setTracksError(null);
    setTrackFilter("");
    setUploadFiles([]);
    setTracksLoading(true);
    try {
      const page = await getSharedPlaylistTracksPage(playlist.id, 300, 0);
      setTracks(page.items);
    } catch (err) {
      setTracksError(err instanceof Error ? err.message : "Kon playlist inhoud niet laden.");
    } finally {
      setTracksLoading(false);
    }
  }

  async function handleDeleteTrack(playlist: SharedPlaylist, track: UserPlaylistTrack) {
    const token = getRadioToken();
    if (!token) {
      setError("Admin token ontbreekt.");
      return;
    }
    setError(null);
    setStatus(null);
    try {
      const result = await deleteSharedPlaylistTrackAdmin(playlist.id, track.id, token);
      setTracks((prev) => prev.filter((row) => row.id !== track.id));
      setItems((prev) =>
        prev.map((row) => (row.id === result.playlist.id ? { ...row, track_count: result.playlist.track_count } : row)),
      );
      setStatus("Track verwijderd uit playlist.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Track verwijderen mislukt.");
    }
  }

  async function handleAppendCsv(playlist: SharedPlaylist) {
    const token = getRadioToken();
    if (!token) {
      setError("Admin token ontbreekt.");
      return;
    }
    if (uploadFiles.length === 0) {
      setError("Kies eerst 1 of meerdere CSV bestanden.");
      return;
    }
    setError(null);
    setStatus(null);
    setUploading(true);
    try {
      const result = await importIntoSharedPlaylistAdmin(playlist.id, uploadFiles, token);
      setItems((prev) =>
        prev.map((row) => (row.id === result.playlist.id ? { ...row, track_count: result.playlist.track_count } : row)),
      );
      setUploadFiles([]);
      const page = await getSharedPlaylistTracksPage(playlist.id, 300, 0);
      setTracks(page.items);
      setStatus("CSV toegevoegd. Nieuwe tracks zijn gededuped en ingeladen.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV toevoegen mislukt.");
    } finally {
      setUploading(false);
    }
  }

  const filteredTracks = tracks.filter((track) => {
    const q = trackFilter.toLowerCase().trim();
    if (!q) return true;
    return (
      track.title.toLowerCase().includes(q)
      || (track.artist ?? "").toLowerCase().includes(q)
      || (track.album ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Gedeelde playlists (admin)</h3>
        <button
          type="button"
          onClick={() => { void loadPlaylists(); }}
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 transition hover:border-gray-600 hover:text-white"
        >
          Ververs
        </button>
      </div>
      {error && <p className="mb-2 text-xs text-red-300">{error}</p>}
      {status && <p className="mb-2 text-xs text-green-300">{status}</p>}
      {loading ? (
        <p className="text-xs text-gray-400">Laden...</p>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {items.map((playlist) => (
            <div key={playlist.id} className="rounded border border-gray-800 bg-gray-900/60 p-2">
              {editingId === playlist.id ? (
                <div className="flex gap-2">
                  <div className="grid flex-1 gap-2 sm:grid-cols-2">
                    <input
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      placeholder="Playlist naam"
                      className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white"
                    />
                    <input
                      value={genreGroupDraft}
                      onChange={(e) => setGenreGroupDraft(e.target.value)}
                      placeholder="Overkoepelend genre"
                      className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white"
                    />
                    <input
                      value={subgenreDraft}
                      onChange={(e) => setSubgenreDraft(e.target.value)}
                      placeholder="Subgenre"
                      className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white"
                    />
                    <select
                      value={relatedParentDraft}
                      onChange={(e) => setRelatedParentDraft(e.target.value)}
                      className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white"
                    >
                      <option value="">Verwante parent-playlist</option>
                      {items
                        .filter((item) => item.id !== playlist.id)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                    <input
                      value={coverDraft}
                      onChange={(e) => setCoverDraft(e.target.value)}
                      placeholder="Cover URL (optioneel)"
                      className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white"
                    />
                    <label className="flex items-center gap-2 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200">
                      <input
                        type="checkbox"
                        checked={autoCoverDraft}
                        onChange={(e) => setAutoCoverDraft(e.target.checked)}
                        className="h-3.5 w-3.5 accent-violet-500"
                      />
                      Auto cover (uit tracks)
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { void handleSavePlaylistSettings(playlist); }}
                      className="rounded bg-violet-600 px-2 py-1 text-xs font-semibold text-white hover:bg-violet-500"
                    >
                      Opslaan
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setNameDraft("");
                        setGenreGroupDraft("");
                        setSubgenreDraft("");
                        setRelatedParentDraft("");
                        setCoverDraft("");
                        setAutoCoverDraft(true);
                      }}
                      className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-white"
                    >
                      Annuleer
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {playlist.cover_url ? (
                      <img
                        src={playlist.cover_url}
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
                    <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-white">{playlist.name}</p>
                    <p className="text-[10px] text-gray-500">
                      {playlist.track_count} tracks
                      {(playlist.genre_group || playlist.subgenre)
                        ? ` · ${[playlist.genre_group, playlist.subgenre].filter(Boolean).join(" / ")}`
                        : ""}
                    </p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => { void openPlaylistContent(playlist); }}
                      className="rounded border border-gray-700 px-2 py-1 text-[11px] text-violet-300 transition hover:text-violet-200"
                    >
                      {expandedId === playlist.id ? "Sluit" : "Inhoud"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(playlist.id);
                        setNameDraft(playlist.name);
                        setGenreGroupDraft(playlist.genre_group ?? "");
                        setSubgenreDraft(playlist.subgenre ?? "");
                        setRelatedParentDraft(playlist.related_parent_playlist_id ?? "");
                        setCoverDraft(playlist.cover_url ?? "");
                        setAutoCoverDraft(true);
                      }}
                      className="rounded border border-gray-700 px-2 py-1 text-[11px] text-blue-300 transition hover:text-blue-200"
                    >
                      Bewerken
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleDelete(playlist); }}
                      className="rounded border border-red-700/60 px-2 py-1 text-[11px] text-red-300 transition hover:text-red-200"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
              {expandedId === playlist.id && (
                <div className="mt-2 rounded border border-gray-800 bg-gray-950/60 p-2">
                  <p className="text-[11px] font-semibold text-gray-200">Inhoud bewerken</p>
                  <div className="mt-2 rounded border border-gray-800 bg-gray-900/70 p-2">
                    <p className="text-[10px] font-semibold text-gray-300">CSV toevoegen (dedupe)</p>
                    <input
                      type="file"
                      multiple
                      accept=".csv,text/csv,application/csv,application/vnd.ms-excel"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []).filter((file) =>
                          file.name.toLowerCase().endsWith(".csv"),
                        );
                        setUploadFiles(files);
                      }}
                      className="mt-1 w-full text-[10px] text-gray-400 file:mr-2 file:rounded file:border-0 file:bg-gray-700 file:px-2 file:py-1 file:text-[10px] file:font-medium file:text-white"
                    />
                    {uploadFiles.length > 0 && (
                      <p className="mt-1 text-[10px] text-gray-400">{uploadFiles.length} CSV geselecteerd</p>
                    )}
                    <button
                      type="button"
                      onClick={() => { void handleAppendCsv(playlist); }}
                      disabled={uploading || uploadFiles.length === 0}
                      className="mt-1 rounded bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
                    >
                      {uploading ? "Toevoegen..." : "Voeg CSV toe"}
                    </button>
                  </div>

                  <input
                    value={trackFilter}
                    onChange={(e) => setTrackFilter(e.target.value)}
                    placeholder="Filter tracks..."
                    className="mt-2 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-[11px] text-white placeholder-gray-500"
                  />
                  {tracksError && <p className="mt-1 text-[10px] text-red-300">{tracksError}</p>}
                  {tracksLoading ? (
                    <p className="mt-2 text-[10px] text-gray-400">Tracks laden...</p>
                  ) : (
                    <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
                      {filteredTracks.map((track) => (
                        <div key={track.id} className="flex items-center justify-between gap-2 rounded border border-gray-800 bg-gray-900/70 px-2 py-1">
                          <div className="min-w-0">
                            <p className="truncate text-[11px] font-medium text-white">{track.title}</p>
                            <p className="truncate text-[10px] text-gray-400">{track.artist ?? "Unknown"}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => { void handleDeleteTrack(playlist, track); }}
                            className="shrink-0 rounded border border-red-700/60 px-2 py-0.5 text-[10px] text-red-300 transition hover:text-red-200"
                          >
                            Verwijder
                          </button>
                        </div>
                      ))}
                      {filteredTracks.length === 0 && (
                        <p className="text-[10px] text-gray-500">Geen tracks gevonden.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {items.length === 0 && (
            <p className="text-xs text-gray-500">Geen gedeelde playlists.</p>
          )}
        </div>
      )}
    </div>
  );
}
