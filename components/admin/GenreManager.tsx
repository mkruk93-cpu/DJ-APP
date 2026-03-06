"use client";

import { useState, useEffect, useCallback } from "react";
import { useRadioStore } from "@/lib/radioStore";

interface Genre {
  id: string;
  label: string;
  priorityArtists: string[];
  minScore: number;
  priorityLabels: string[];
  requiredTokens: string[];
  blockedTokens: string[];
  priorityTracks: string[];
  blockedTracks: string[];
  blockedArtists: string[];
}

type UnknownGenre = Partial<Genre> & Record<string, unknown>;

function normalizeGenre(raw: UnknownGenre): Genre {
  return {
    id: String(raw.id ?? ""),
    label: String(raw.label ?? raw.id ?? "Unknown"),
    priorityArtists: Array.isArray(raw.priorityArtists) ? raw.priorityArtists.map((v) => String(v)) : [],
    minScore: typeof raw.minScore === "number" ? raw.minScore : 0,
    priorityLabels: Array.isArray(raw.priorityLabels) ? raw.priorityLabels.map((v) => String(v)) : [],
    requiredTokens: Array.isArray(raw.requiredTokens) ? raw.requiredTokens.map((v) => String(v)) : [],
    blockedTokens: Array.isArray(raw.blockedTokens) ? raw.blockedTokens.map((v) => String(v)) : [],
    priorityTracks: Array.isArray(raw.priorityTracks) ? raw.priorityTracks.map((v) => String(v)) : [],
    blockedTracks: Array.isArray(raw.blockedTracks) ? raw.blockedTracks.map((v) => String(v)) : [],
    blockedArtists: Array.isArray(raw.blockedArtists) ? raw.blockedArtists.map((v) => String(v)) : [],
  };
}

export default function GenreManager() {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedGenres, setExpandedGenres] = useState<Set<string>>(new Set());
  const [editingArtist, setEditingArtist] = useState<{ genreId: string; oldArtist: string; newArtist: string } | null>(null);
  const [addingArtist, setAddingArtist] = useState<{ genreId: string; artist: string } | null>(null);
  const [addingBlockedTrack, setAddingBlockedTrack] = useState<{ genreId: string; track: string } | null>(null);
  const [newGenreId, setNewGenreId] = useState("");
  const [newGenreLabel, setNewGenreLabel] = useState("");

  const serverUrl = useRadioStore((s) => s.serverUrl) ?? process.env.NEXT_PUBLIC_CONTROL_SERVER_URL;

  const fetchGenres = useCallback(async () => {
    if (!serverUrl) {
      setLoading(false);
      setError('Server URL not configured');
      return;
    }
    
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${serverUrl}/api/genre-management/genres`);
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Invalid API response shape");
      }
      const normalized = data
        .map((item) => normalizeGenre(item as UnknownGenre))
        .filter((g) => g.id.length > 0);
      setGenres(normalized);
    } catch (err) {
      console.error('[genre-manager] Failed to fetch genres:', err);
      setError(`Failed to load genres: ${(err as Error).message}`);
      setGenres([]);
    } finally {
      setLoading(false);
    }
  }, [serverUrl]);

  useEffect(() => {
    // Add a small delay to ensure the component is fully mounted
    const timer = setTimeout(() => {
      fetchGenres();
    }, 100);
    
    return () => clearTimeout(timer);
  }, [fetchGenres]);

  const toggleGenre = (genreId: string) => {
    setExpandedGenres(prev => {
      const next = new Set(prev);
      if (next.has(genreId)) {
        next.delete(genreId);
      } else {
        next.add(genreId);
      }
      return next;
    });
  };

  const addArtist = async (genreId: string, artist: string) => {
    if (!serverUrl || !artist.trim()) return;

    try {
      const response = await fetch(`${serverUrl}/api/genre-management/genres/${encodeURIComponent(genreId)}/artists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist: artist.trim() })
      });

      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // Ignore JSON parse errors
        }
        throw new Error(errorMessage);
      }

      await fetchGenres();
      setAddingArtist(null);
    } catch (err) {
      console.error('[genre-manager] Failed to add artist:', err);
      alert(`Failed to add artist: ${(err as Error).message}`);
    }
  };

  const removeArtist = async (genreId: string, artist: string) => {
    if (!serverUrl) return;
    if (!confirm(`Are you sure you want to remove "${artist}" from ${genreId}?`)) return;

    try {
      const response = await fetch(`${serverUrl}/api/genre-management/genres/${genreId}/artists/${encodeURIComponent(artist)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      await fetchGenres();
    } catch (err) {
      console.error('[genre-manager] Failed to remove artist:', err);
      alert(`Failed to remove artist: ${(err as Error).message}`);
    }
  };

  const editArtist = async (genreId: string, oldArtist: string, newArtist: string) => {
    if (!serverUrl || !newArtist.trim()) return;

    try {
      const response = await fetch(`${serverUrl}/api/genre-management/genres/${genreId}/artists/${encodeURIComponent(oldArtist)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtist: newArtist.trim() })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      await fetchGenres();
      setEditingArtist(null);
    } catch (err) {
      console.error('[genre-manager] Failed to edit artist:', err);
      alert(`Failed to edit artist: ${(err as Error).message}`);
    }
  };

  const addBlockedTrack = async (genreId: string, track: string) => {
    if (!serverUrl || !track.trim()) return;

    try {
      const response = await fetch(`${serverUrl}/api/genre-management/genres/${genreId}/blocked-tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: track.trim() })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      await fetchGenres();
      setAddingBlockedTrack(null);
    } catch (err) {
      console.error('[genre-manager] Failed to add blocked track:', err);
      alert(`Failed to add blocked track: ${(err as Error).message}`);
    }
  };

  const removeBlockedTrack = async (genreId: string, track: string) => {
    if (!serverUrl) return;
    if (!confirm(`Are you sure you want to remove blocked track "${track}" from ${genreId}?`)) return;

    try {
      const response = await fetch(`${serverUrl}/api/genre-management/genres/${genreId}/blocked-tracks/${encodeURIComponent(track)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      await fetchGenres();
    } catch (err) {
      console.error('[genre-manager] Failed to remove blocked track:', err);
      alert(`Failed to remove blocked track: ${(err as Error).message}`);
    }
  };

  const createGenre = async () => {
    if (!serverUrl) return;
    if (!newGenreId.trim() && !newGenreLabel.trim()) {
      alert("Vul een genre naam of id in.");
      return;
    }

    try {
      const response = await fetch(`${serverUrl}/api/genre-management/genres`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newGenreId.trim(),
          label: newGenreLabel.trim(),
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      setNewGenreId("");
      setNewGenreLabel("");
      await fetchGenres();
    } catch (err) {
      alert(`Genre aanmaken mislukt: ${(err as Error).message}`);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-4 text-lg font-bold text-white">Genre Management</h2>
        <div className="flex items-center justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-violet-400 border-t-transparent"></div>
          <span className="ml-3 text-gray-400">
            {!serverUrl ? 'Waiting for server connection...' : 'Loading genres...'}
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-4 text-lg font-bold text-white">Genre Management</h2>
        <div className="rounded-lg bg-red-900/20 border border-red-800 p-4">
          <p className="text-red-400">{error}</p>
          <button
            onClick={fetchGenres}
            className="mt-2 rounded-lg bg-red-600 px-3 py-1 text-sm font-semibold text-white transition hover:bg-red-500"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Genre Management</h2>
        <button
          onClick={fetchGenres}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:border-gray-600 hover:text-white"
        >
          Refresh
        </button>
      </div>

      <div className="mb-4 rounded-lg border border-gray-700 bg-gray-800 p-3">
        <p className="mb-2 text-sm font-semibold text-white">Nieuw genre</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            type="text"
            value={newGenreLabel}
            onChange={(e) => setNewGenreLabel(e.target.value)}
            placeholder="Label (bijv. Melodic House)"
            className="rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-white placeholder-gray-400 outline-none focus:border-violet-500"
          />
          <input
            type="text"
            value={newGenreId}
            onChange={(e) => setNewGenreId(e.target.value)}
            placeholder="Id (optioneel, bijv. melodic_house)"
            className="rounded border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-white placeholder-gray-400 outline-none focus:border-violet-500"
          />
          <button
            onClick={createGenre}
            className="rounded bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-violet-500"
          >
            Genre toevoegen
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {genres.map((genre) => (
          <div key={genre.id} className="rounded-lg border border-gray-700 bg-gray-800">
            <button
              onClick={() => toggleGenre(genre.id)}
              className="flex w-full items-center justify-between p-3 text-left transition hover:bg-gray-750"
            >
              <div>
                <h3 className="font-semibold text-white">{genre.label}</h3>
                <p className="text-sm text-gray-400">
                  {genre.priorityArtists.length} artists, {genre.blockedTracks.length} blocked tracks
                </p>
              </div>
              <span className={`text-gray-400 transition-transform ${expandedGenres.has(genre.id) ? 'rotate-180' : ''}`}>
                ▾
              </span>
            </button>

            {expandedGenres.has(genre.id) && (
              <div className="border-t border-gray-700 p-3">
                {/* Priority Artists Section */}
                <div className="mb-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-white">Priority Artists ({genre.priorityArtists.length})</h4>
                    <button
                      onClick={() => setAddingArtist({ genreId: genre.id, artist: '' })}
                      className="rounded bg-green-600 px-2 py-1 text-xs font-semibold text-white transition hover:bg-green-500"
                    >
                      Add Artist
                    </button>
                  </div>

                  {addingArtist?.genreId === genre.id && (
                    <div className="mb-2 flex gap-2">
                      <input
                        type="text"
                        value={addingArtist.artist}
                        onChange={(e) => setAddingArtist({ ...addingArtist, artist: e.target.value })}
                        placeholder="Artist name..."
                        className="flex-1 rounded border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-white placeholder-gray-400 outline-none focus:border-green-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            addArtist(genre.id, addingArtist.artist);
                          } else if (e.key === 'Escape') {
                            setAddingArtist(null);
                          }
                        }}
                        autoFocus
                      />
                      <button
                        onClick={() => addArtist(genre.id, addingArtist.artist)}
                        className="rounded bg-green-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-green-500"
                      >
                        Add
                      </button>
                      <button
                        onClick={() => setAddingArtist(null)}
                        className="rounded bg-gray-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-gray-500"
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {genre.priorityArtists.map((artist) => (
                      <div key={artist} className="flex items-center justify-between rounded bg-gray-700 px-2 py-1">
                        {editingArtist?.genreId === genre.id && editingArtist.oldArtist === artist ? (
                          <input
                            type="text"
                            value={editingArtist.newArtist}
                            onChange={(e) => setEditingArtist({ ...editingArtist, newArtist: e.target.value })}
                            className="flex-1 bg-transparent text-sm text-white outline-none"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                editArtist(genre.id, artist, editingArtist.newArtist);
                              } else if (e.key === 'Escape') {
                                setEditingArtist(null);
                              }
                            }}
                            onBlur={() => editArtist(genre.id, artist, editingArtist.newArtist)}
                            autoFocus
                          />
                        ) : (
                          <>
                            <span className="text-sm text-white">{artist}</span>
                            <div className="flex gap-1">
                              <button
                                onClick={() => setEditingArtist({ genreId: genre.id, oldArtist: artist, newArtist: artist })}
                                className="text-xs text-blue-400 hover:text-blue-300"
                                title="Edit artist"
                              >
                                ✏️
                              </button>
                              <button
                                onClick={() => removeArtist(genre.id, artist)}
                                className="text-xs text-red-400 hover:text-red-300"
                                title="Remove artist"
                              >
                                🗑️
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Blocked Tracks Section */}
                {genre.blockedTracks.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-white">Blocked Tracks ({genre.blockedTracks.length})</h4>
                      <button
                        onClick={() => setAddingBlockedTrack({ genreId: genre.id, track: '' })}
                        className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white transition hover:bg-red-500"
                      >
                        Add Blocked Track
                      </button>
                    </div>

                    {addingBlockedTrack?.genreId === genre.id && (
                      <div className="mb-2 flex gap-2">
                        <input
                          type="text"
                          value={addingBlockedTrack.track}
                          onChange={(e) => setAddingBlockedTrack({ ...addingBlockedTrack, track: e.target.value })}
                          placeholder="Track name (artist - title)..."
                          className="flex-1 rounded border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-white placeholder-gray-400 outline-none focus:border-red-500"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              addBlockedTrack(genre.id, addingBlockedTrack.track);
                            } else if (e.key === 'Escape') {
                              setAddingBlockedTrack(null);
                            }
                          }}
                          autoFocus
                        />
                        <button
                          onClick={() => addBlockedTrack(genre.id, addingBlockedTrack.track)}
                          className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-500"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => setAddingBlockedTrack(null)}
                          className="rounded bg-gray-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-gray-500"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    <div className="space-y-1">
                      {genre.blockedTracks.map((track) => (
                        <div key={track} className="flex items-center justify-between rounded bg-red-900/20 px-2 py-1">
                          <span className="text-sm text-red-200">{track}</span>
                          <button
                            onClick={() => removeBlockedTrack(genre.id, track)}
                            className="text-xs text-red-400 hover:text-red-300"
                            title="Remove blocked track"
                          >
                            🗑️
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Add blocked track button if no blocked tracks exist */}
                {genre.blockedTracks.length === 0 && (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-white">Blocked Tracks (0)</h4>
                      <button
                        onClick={() => setAddingBlockedTrack({ genreId: genre.id, track: '' })}
                        className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white transition hover:bg-red-500"
                      >
                        Add Blocked Track
                      </button>
                    </div>

                    {addingBlockedTrack?.genreId === genre.id && (
                      <div className="mb-2 flex gap-2">
                        <input
                          type="text"
                          value={addingBlockedTrack.track}
                          onChange={(e) => setAddingBlockedTrack({ ...addingBlockedTrack, track: e.target.value })}
                          placeholder="Track name (artist - title)..."
                          className="flex-1 rounded border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-white placeholder-gray-400 outline-none focus:border-red-500"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              addBlockedTrack(genre.id, addingBlockedTrack.track);
                            } else if (e.key === 'Escape') {
                              setAddingBlockedTrack(null);
                            }
                          }}
                          autoFocus
                        />
                        <button
                          onClick={() => addBlockedTrack(genre.id, addingBlockedTrack.track)}
                          className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-500"
                        >
                          Add
                        </button>
                        <button
                          onClick={() => setAddingBlockedTrack(null)}
                          className="rounded bg-gray-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-gray-500"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}