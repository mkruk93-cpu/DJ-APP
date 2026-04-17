"use client";

import { useEffect, useState } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";
import { getRadioToken } from "@/lib/auth";
import { useAuth } from "@/lib/authContext";
import { decodeHtmlEntities } from "@/lib/trackDisplay";
import TrackActions from "@/components/TrackActions";
import { addTrackToUserPlaylist, getLikedTracksPlaylist } from "@/lib/userPlaylistsApi";

function deriveTitleFromId(sourceId: string): string {
  if (!sourceId) return "Nummer wordt geladen...";
  if (sourceId.startsWith("sc-")) {
    const slug = sourceId.slice(3);
    const parts = slug.split("-");
    if (parts.length >= 2) {
      const artist = parts[0].replace(/[-_]+/g, " ").trim();
      const title = parts.slice(1).join(" ").replace(/[-_]+/g, " ").trim();
      if (artist && title) return `${artist} - ${title}`;
    }
  }
  if (sourceId.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(sourceId)) {
    return "Onbekende video";
  }
  return "Nummer wordt geladen...";
}

interface DeferredQueueItem {
  id: string;
  youtube_url: string;
  title?: string | null;
  artist?: string | null;
  thumbnail?: string | null;
  created_at: number;
}

export default function Queue() {
  const queue = useRadioStore((s) => s.queue);
  const mode = useRadioStore((s) => s.mode);
  const queuePushVote = useRadioStore((s) => s.queuePushVote);
  const { userAccount } = useAuth();
  // Use userAccount username, but also check localStorage for nickname fallback
  const storedNickname = typeof window !== "undefined" ? (localStorage.getItem("nickname") ?? "").trim() : "";
  const nickname = userAccount?.username || storedNickname || "";
  const [deferredQueue, setDeferredQueue] = useState<DeferredQueueItem[]>([]);
  const canRequestPush = mode !== "dj";

  function isOwnItem(item: { added_by?: string | null }): boolean {
    const itemOwner = (item.added_by ?? "").toLowerCase().trim();
    const currentUser = nickname.toLowerCase().trim();
    // Also check stored nickname for legacy items
    const storedUser = storedNickname.toLowerCase().trim();
    return (itemOwner === currentUser || itemOwner === storedUser) && currentUser !== "";
  }

  function isAdminUser(): boolean {
    // Check both username and radio token for admin status
    const user = nickname.toLowerCase().trim();
    const hasRadioToken = getRadioToken() !== null;
    return user === "krukkex" || hasRadioToken;
  }

  useEffect(() => {
    if (!nickname) return;
    const socket = getSocket();
    function onDeferredQueueUpdate(data: { added_by?: string; items?: DeferredQueueItem[] }) {
      const owner = (data?.added_by ?? "").trim().toLowerCase();
      if (owner !== nickname.toLowerCase().trim()) return;
      setDeferredQueue(Array.isArray(data?.items) ? data.items : []);
    }
    socket.on("deferredQueue:update", onDeferredQueueUpdate);
    socket.emit("deferredQueue:sync", { added_by: nickname });
    return () => {
      socket.off("deferredQueue:update", onDeferredQueueUpdate);
    };
  }, [nickname]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5">
      <div className="border-b border-gray-800 px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-400 sm:text-sm">
            Wachtrij
          </h2>
          <span className="text-xs text-gray-500">
            {queue.length} {queue.length === 1 ? "nummer" : "nummers"}
          </span>
        </div>
      </div>

      <div className="chat-scroll min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 sm:px-4 sm:py-3">
        {deferredQueue.length > 0 && (
          <div className="mb-3 rounded-lg border border-violet-800/40 bg-violet-950/25 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-violet-300">
                Eigen wachtrij
              </p>
              <span className="text-[11px] text-violet-200/80">
                {deferredQueue.length} {deferredQueue.length === 1 ? "wachtend nummer" : "wachtende nummers"}
              </span>
            </div>
            <div className="space-y-1">
              {deferredQueue.map((item, idx) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded-md border border-violet-900/50 bg-violet-900/20 px-2 py-2"
                >
                  <span className="w-4 shrink-0 text-center text-xs text-violet-200/80">{idx + 1}</span>
                  {item.thumbnail ? (
                    <img
                      src={item.thumbnail}
                      alt=""
                      className="h-8 w-10 shrink-0 rounded object-cover"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-violet-100">
                      {item.artist && item.title && item.title.toLowerCase().startsWith(item.artist.toLowerCase())
                        ? decodeHtmlEntities(item.title)?.trim() || deriveTitleFromId(item.youtube_url)
                        : item.artist
                          ? `${item.artist} - ${decodeHtmlEntities(item.title)?.trim() || deriveTitleFromId(item.youtube_url)}`
                          : decodeHtmlEntities(item.title)?.trim() || deriveTitleFromId(item.youtube_url)}
                    </p>
                    <p className="truncate text-[10px] text-violet-200/70">
                      Wordt automatisch toegevoegd zodra een nummer afgelopen is
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        const liked = await getLikedTracksPlaylist();
                        await addTrackToUserPlaylist(liked.id, {
                          title: item.title ?? deriveTitleFromId(item.youtube_url),
                          artist: item.artist ?? null,
                          album: null,
                          spotify_url: null,
                          artwork_url: item.thumbnail ?? null,
                        });
                      } catch (err) {
                        console.error("[Queue] Failed to like deferred track:", err);
                      }
                    }}
                    className="p-1 text-violet-200/80 transition hover:text-red-400"
                    title="Toevoegen aan Liked Tracks"
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l8.84-8.84 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                  </button>
                  <TrackActions
                    title={item.title ?? deriveTitleFromId(item.youtube_url)}
                    artist={item.artist ?? null}
                    artwork_url={item.thumbnail ?? null}
                    className="mr-1"
                    iconSize={15}
                    showLike={false}
                    showPlaylist={true}
                    playlistIcon="dots"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      getSocket().emit("deferredQueue:remove", {
                        id: item.id,
                        token: getRadioToken(),
                        added_by: nickname || "anonymous",
                      })
                    }
                    className="rounded p-1 text-violet-200/80 transition hover:bg-red-500/15 hover:text-red-300"
                    title="Verwijderen uit eigen wachtrij"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {queue.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-500">
            Wachtrij is leeg
          </p>
        )}
        {queue.map((item, index) => (
          <div
            key={item.id}
            className="group flex items-center gap-2 rounded-md border border-gray-800 bg-gray-800/40 px-2 py-2 transition hover:border-gray-700 sm:gap-2 sm:px-2 sm:py-1.5"
          >
            <span className="w-4 shrink-0 text-center text-xs text-gray-500 sm:text-xs">
              {index + 1}
            </span>

            {item.thumbnail && (
              <img
                src={item.thumbnail}
                alt=""
                className="h-8 w-10 shrink-0 rounded object-cover sm:h-7 sm:w-10"
              />
            )}

            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-xs font-medium leading-tight text-white sm:text-xs">
                {item.artist && item.title && item.title.toLowerCase().startsWith(item.artist.toLowerCase())
                  ? decodeHtmlEntities(item.title)
                  : item.artist
                    ? `${item.artist} - ${decodeHtmlEntities(item.title) ?? deriveTitleFromId(item.youtube_id)}`
                    : decodeHtmlEntities(item.title) ?? deriveTitleFromId(item.youtube_id)}
              </p>
              <p className="hidden truncate text-[10px] text-gray-500 sm:block">
                {item.added_by}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const liked = await getLikedTracksPlaylist();
                    await addTrackToUserPlaylist(liked.id, {
                      title: item.title ?? deriveTitleFromId(item.youtube_id),
                      artist: item.artist ?? null,
                      album: null,
                      spotify_url: null,
                      artwork_url: item.thumbnail ?? null,
                    });
                  } catch (err) {
                    console.error("[Queue] Failed to like track:", err);
                  }
                }}
                className="p-1 text-gray-400 transition hover:text-red-400"
                title="Toevoegen aan Liked Tracks"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l8.84-8.84 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </button>
              <TrackActions
                title={item.title ?? deriveTitleFromId(item.youtube_id)}
                artist={item.artist ?? null}
                artwork_url={item.thumbnail ?? null}
                className="mr-0.5"
                iconSize={13}
                showLike={false}
                showPlaylist={true}
                playlistIcon="dots"
                additionalActions={[
                  ...(canRequestPush && index !== 0 ? [{
                    key: "queue-push",
                    label: "Stem als volgende",
                    onSelect: () => {
                      getSocket().emit("queuePushVote:start", { id: item.id, added_by: nickname || "onbekend" });
                    },
                  }] : []),
                  ...(mode !== "dj" && (isOwnItem(item) || isAdminUser()) ? [{
                    key: "queue-remove",
                    label: "Verwijder uit wachtrij",
                    onSelect: () => {
                      const token = isAdminUser() ? getRadioToken() : undefined;
                      getSocket().emit("queue:remove", {
                        id: item.id,
                        token: token ?? undefined,
                      });
                    },
                  }] : []),
                ]}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
