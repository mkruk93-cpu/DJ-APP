"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  addTrackToUserPlaylist,
  getLikedTracksPlaylist,
  listUserPlaylists,
  createEmptyUserPlaylist,
  type UserPlaylist,
} from "@/lib/userPlaylistsApi";

interface TrackAction {
  key: string;
  label: string;
  onSelect: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

interface TrackActionsProps {
  title: string;
  artist: string | null;
  spotify_url?: string | null;
  artwork_url?: string | null;
  album?: string | null;
  className?: string;
  iconSize?: number;
  showLike?: boolean;
  showPlaylist?: boolean;
  playlistIcon?: "plus" | "dots";
  additionalActions?: TrackAction[];
}

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

export default function TrackActions({
  title,
  artist,
  spotify_url,
  artwork_url,
  album,
  className = "",
  iconSize = 18,
  showLike = true,
  showPlaylist = true,
  playlistIcon = "plus",
  additionalActions = [],
}: TrackActionsProps) {
  const [isLiked, setIsLiked] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [view, setView] = useState<"list" | "create" | "actions">("list");
  const [playlists, setPlaylists] = useState<UserPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [likedPlaylistId, setLikedPlaylistId] = useState<string | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [newPlaylistGenre, setNewPlaylistGenre] = useState("");
  const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const showActionMenu = additionalActions.length > 0;
  const queuePushActions = additionalActions.filter((action) => action.key === "queue-push");
  const queueRemoveActions = additionalActions.filter((action) => action.key === "queue-remove");
  const otherExtraActions = additionalActions.filter(
    (action) => action.key !== "queue-push" && action.key !== "queue-remove",
  );
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const updateDropdownPosition = useCallback(() => {
    if (typeof window === "undefined" || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = 224;
    const gap = 8;
    const viewportPadding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceAbove = rect.top - viewportPadding;
    const spaceBelow = viewportHeight - rect.bottom - viewportPadding;
    const openUpward = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, Math.min(320, openUpward ? spaceAbove - gap : spaceBelow - gap));
    const left = Math.min(
      Math.max(viewportPadding, rect.right - width),
      Math.max(viewportPadding, viewportWidth - width - viewportPadding),
    );
    const top = openUpward
      ? Math.max(viewportPadding, rect.top - gap - maxHeight)
      : Math.min(viewportHeight - viewportPadding - maxHeight, rect.bottom + gap);

    setDropdownStyle({ top, left, width, maxHeight });
  }, []);

  useEffect(() => {
    async function init() {
      try {
        const liked = await getLikedTracksPlaylist();
        setLikedPlaylistId(liked.id);
      } catch (err) {
        console.error("[TrackActions] Failed to get liked tracks playlist:", err);
      }
    }
    init();
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setShowDropdown(false);
        setView("list");
      }
    }
    if (showDropdown) {
      updateDropdownPosition();
      document.addEventListener("mousedown", handleClickOutside);
      window.addEventListener("resize", updateDropdownPosition);
      window.addEventListener("scroll", updateDropdownPosition, true);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("resize", updateDropdownPosition);
      window.removeEventListener("scroll", updateDropdownPosition, true);
    };
  }, [showDropdown, updateDropdownPosition]);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!likedPlaylistId || loading) return;

    setLoading(true);
    try {
      await addTrackToUserPlaylist(likedPlaylistId, {
        title,
        artist,
        album: album ?? null,
        spotify_url: spotify_url ?? null,
        artwork_url: artwork_url ?? null,
      });
      setIsLiked(true);
    } catch (err) {
      console.error("[TrackActions] Failed to like track:", err);
    } finally {
      setLoading(false);
    }
  };

  const toggleDropdown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!showDropdown) {
      setLoading(true);
      try {
        const list = await listUserPlaylists();
        setPlaylists(list);
      } catch (err) {
        console.error("[TrackActions] Failed to list playlists:", err);
      } finally {
        setLoading(false);
      }
    }
    setShowDropdown(!showDropdown);
    setView(!showDropdown ? (showActionMenu ? "actions" : "list") : "list");
  };

  const addToPlaylist = async (e: React.MouseEvent, playlistId: string) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await addTrackToUserPlaylist(playlistId, {
        title,
        artist,
        album: album ?? null,
        spotify_url: spotify_url ?? null,
        artwork_url: artwork_url ?? null,
      });
      setShowDropdown(false);
    } catch (err) {
      console.error("[TrackActions] Failed to add track to playlist:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAndAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!newPlaylistName.trim() || loading) return;

    setLoading(true);
    try {
      const newPlaylist = await createEmptyUserPlaylist(newPlaylistName.trim(), newPlaylistGenre || null);
      await addTrackToUserPlaylist(newPlaylist.id, {
        title,
        artist,
        album: album ?? null,
        spotify_url: spotify_url ?? null,
        artwork_url: artwork_url ?? null,
      });
      setShowDropdown(false);
      setNewPlaylistName("");
      setNewPlaylistGenre("");
    } catch (err) {
      console.error("[TrackActions] Failed to create playlist and add track:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-1.5 ${className}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Like Button */}
      {showLike && (
        <button
          type="button"
          onClick={handleLike}
          disabled={loading || isLiked}
          className={`p-1.5 transition-all duration-200 hover:scale-110 active:scale-95 ${
            isLiked ? "text-red-500" : "text-gray-400 hover:text-red-400"
          }`}
          title={isLiked ? "Toegevoegd aan Liked Tracks" : "Toevoegen aan Liked Tracks"}
        >
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill={isLiked ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l8.84-8.84 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </button>
      )}

      {/* Add to Playlist Button */}
      {showPlaylist && (
        <div className="relative" ref={triggerRef}>
          <button
            type="button"
            onClick={toggleDropdown}
            disabled={loading}
            className="p-1.5 text-gray-400 transition-all duration-200 hover:scale-110 hover:text-violet-400 active:scale-95"
            title="Opties"
          >
            {playlistIcon === "dots" ? (
              <svg
                width={iconSize}
                height={iconSize}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="1" />
                <circle cx="12" cy="5" r="1" />
                <circle cx="12" cy="19" r="1" />
              </svg>
            ) : (
              <svg
                width={iconSize}
                height={iconSize}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            )}
          </button>

          {showDropdown && dropdownStyle && typeof document !== "undefined" && createPortal(
            <div
              ref={dropdownRef}
              className="overflow-hidden rounded-lg border border-gray-700 bg-gray-950 shadow-2xl z-[1000]"
              style={{
                position: "fixed",
                top: dropdownStyle.top,
                left: dropdownStyle.left,
                width: dropdownStyle.width,
                maxHeight: dropdownStyle.maxHeight,
              }}
            >
              {view === "create" ? (
                <form onSubmit={handleCreateAndAdd} className="p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Nieuwe playlist</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setView("list"); }}
                      className="text-[10px] text-gray-400 hover:text-white"
                    >
                      Terug
                    </button>
                  </div>
                  <input
                    autoFocus
                    type="text"
                    value={newPlaylistName}
                    onChange={(e) => setNewPlaylistName(e.target.value)}
                    placeholder="Naam..."
                    className="mb-2 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-white outline-none focus:border-violet-500"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <select
                    value={newPlaylistGenre}
                    onChange={(e) => setNewPlaylistGenre(e.target.value)}
                    className="mb-3 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-white outline-none focus:border-violet-500"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <option value="">Kies genre (optioneel)</option>
                    {PLAYLIST_GENRE_GROUPS.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={!newPlaylistName.trim() || loading}
                    className="w-full rounded bg-violet-600 py-1.5 text-xs font-bold text-white transition hover:bg-violet-500 disabled:opacity-50"
                  >
                    {loading ? "Bezig..." : "Maak en voeg toe"}
                  </button>
                </form>
              ) : (
                <div className="flex flex-col">
                  {view === "actions" ? (
                    <div className="flex flex-col">
                      <div className="overflow-y-auto py-1" style={{ maxHeight: Math.max(120, dropdownStyle.maxHeight - 52) }}>
                        {queuePushActions.map((action) => (
                          <button
                            type="button"
                            key={action.key}
                            onClick={(e) => {
                              e.stopPropagation();
                              action.onSelect(e);
                              setShowDropdown(false);
                            }}
                            className="w-full px-3 py-2 text-left text-xs text-gray-200 transition hover:bg-violet-600/20 hover:text-violet-400"
                          >
                            {action.label}
                          </button>
                        ))}
                        {otherExtraActions.map((action) => (
                          <button
                            type="button"
                            key={action.key}
                            onClick={(e) => {
                              e.stopPropagation();
                              action.onSelect(e);
                              setShowDropdown(false);
                            }}
                            className="w-full px-3 py-2 text-left text-xs text-gray-200 transition hover:bg-violet-600/20 hover:text-violet-400"
                          >
                            {action.label}
                          </button>
                        ))}
                        {queueRemoveActions.map((action) => (
                          <button
                            type="button"
                            key={action.key}
                            onClick={(e) => {
                              e.stopPropagation();
                              action.onSelect(e);
                              setShowDropdown(false);
                            }}
                            className="w-full px-3 py-2 text-left text-xs text-red-200 transition hover:bg-red-500/15"
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                      {showPlaylist && (
                        <div className="border-t border-gray-800 p-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setView("list");
                            }}
                            className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-semibold text-violet-400 transition hover:bg-violet-400/10"
                          >
                            Toevoegen aan afspeellijst
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {showActionMenu && (
                        <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2 text-[10px] uppercase tracking-wider text-gray-500">
                          <span>Afspeellijst kiezen</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setView("actions");
                            }}
                            className="text-xs text-gray-400 hover:text-white"
                          >
                            Terug
                          </button>
                        </div>
                      )}
                      <div className="overflow-y-auto py-1" style={{ maxHeight: Math.max(120, dropdownStyle.maxHeight - 52) }}>
                        {playlists.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-gray-500 italic">
                            Geen playlists gevonden
                          </div>
                        ) : (
                          playlists.map((playlist) => (
                            <button
                              type="button"
                              key={playlist.id}
                              onClick={(e) => addToPlaylist(e, playlist.id)}
                              className="w-full px-3 py-2 text-left text-xs text-gray-200 transition hover:bg-violet-600/20 hover:text-violet-400"
                            >
                              {playlist.name}
                            </button>
                          ))
                        )}
                      </div>
                    </>
                  )}
                  <div className="border-t border-gray-800 p-1">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setView("create"); }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-semibold text-violet-400 transition hover:bg-violet-400/10"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Nieuwe playlist
                    </button>
                  </div>
                </div>
              )}
            </div>,
            document.body,
          )}
        </div>
      )}
    </div>
  );
}
