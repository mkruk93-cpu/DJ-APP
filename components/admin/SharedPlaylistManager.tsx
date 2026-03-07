"use client";

import { useEffect, useState } from "react";
import { getRadioToken } from "@/lib/auth";
import {
  deleteSharedPlaylistAdmin,
  listSharedPlaylists,
  updateSharedPlaylistAdmin,
  type SharedPlaylist,
} from "@/lib/userPlaylistsApi";

export default function SharedPlaylistManager() {
  const [items, setItems] = useState<SharedPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

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

  async function handleRename(playlist: SharedPlaylist) {
    const token = getRadioToken();
    if (!token) {
      setError("Admin token ontbreekt.");
      return;
    }
    const safeName = nameDraft.trim();
    if (!safeName) {
      setError("Nieuwe naam mag niet leeg zijn.");
      return;
    }
    setError(null);
    setStatus(null);
    try {
      const updated = await updateSharedPlaylistAdmin(playlist.id, safeName, token);
      setItems((prev) => prev.map((item) => (item.id === updated.id ? { ...item, name: updated.name } : item)));
      setEditingId(null);
      setNameDraft("");
      setStatus("Playlistnaam bijgewerkt.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Naam wijzigen mislukt.");
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
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    className="flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white"
                  />
                  <button
                    type="button"
                    onClick={() => { void handleRename(playlist); }}
                    className="rounded bg-violet-600 px-2 py-1 text-xs font-semibold text-white hover:bg-violet-500"
                  >
                    Opslaan
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setNameDraft("");
                    }}
                    className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-white"
                  >
                    Annuleer
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-white">{playlist.name}</p>
                    <p className="text-[10px] text-gray-500">{playlist.track_count} tracks</p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(playlist.id);
                        setNameDraft(playlist.name);
                      }}
                      className="rounded border border-gray-700 px-2 py-1 text-[11px] text-blue-300 transition hover:text-blue-200"
                    >
                      Rename
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
