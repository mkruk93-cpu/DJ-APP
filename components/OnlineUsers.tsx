"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabaseClient";

interface PresenceState {
  nickname: string;
  listening?: boolean;
}

export default function OnlineUsers() {
  const [onlineUsers, setOnlineUsers] = useState<Array<{ nickname: string; listening: boolean }>>([]);
  const [expanded, setExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const nickname =
    typeof window !== "undefined"
      ? localStorage.getItem("nickname") ?? "anon"
      : "anon";

  useEffect(() => {
    const sb = getSupabase();
    const channel = sb.channel("online-users", {
      config: { presence: { key: nickname } },
    });
    let subscribed = false;
    const trackPresence = async (listening: boolean) => {
      if (!subscribed) return;
      await channel.track({ nickname, listening });
    };

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<PresenceState>();
        const users = Object.entries(state)
          .map(([key, metas]) => {
            const list = Array.isArray(metas) ? metas : [];
            const listening = list.some((meta) => !!meta?.listening);
            return { nickname: key, listening };
          })
          .sort((a, b) => {
            if (a.listening !== b.listening) return a.listening ? -1 : 1;
            return a.nickname.localeCompare(b.nickname);
          });
        setOnlineUsers(users);
        setIsLoading(false);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          subscribed = true;
          const initialListening =
            (window as Window & { __radioListeningState?: boolean }).__radioListeningState ?? isListening;
          setIsListening(!!initialListening);
          await trackPresence(!!initialListening);
        }
      });

    function onListeningState(event: Event) {
      const custom = event as CustomEvent<{ listening?: boolean }>;
      const nextListening = !!custom.detail?.listening;
      setIsListening(nextListening);
      void trackPresence(nextListening);
    }
    window.addEventListener("radio-listening-state", onListeningState as EventListener);

    return () => {
      window.removeEventListener("radio-listening-state", onListeningState as EventListener);
      sb.removeChannel(channel);
    };
  }, [nickname]);

  const activeListeningCount = onlineUsers.filter((user) => user.listening).length;

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 transition hover:border-gray-600 hover:text-white sm:gap-2 sm:px-3 sm:py-1.5 sm:text-sm"
      >
        <span className={`h-2 w-2 rounded-full ${isLoading ? 'bg-gray-500 animate-pulse' : (activeListeningCount > 0 ? 'bg-green-500' : 'bg-red-500')}`} />
        <span className="whitespace-nowrap sm:hidden">
          {isLoading ? "..." : `${onlineUsers.length}/${activeListeningCount}`}
        </span>
        <span className="hidden whitespace-nowrap sm:inline">
          {isLoading ? 'Laden...' : `${onlineUsers.length} online · ${activeListeningCount} luisteren`}
        </span>
        <svg
          className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && onlineUsers.length > 0 && (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-gray-700 bg-gray-900 p-3 shadow-xl shadow-black/40 sm:w-56">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Online gebruikers
          </p>
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {onlineUsers.map((user) => (
              <li
                key={user.nickname}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-gray-300"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${user.listening ? "bg-green-500" : "bg-red-500"}`} />
                <span className="truncate">
                  {user.nickname}
                  {user.nickname === nickname && (
                    <span className="ml-1 text-xs text-gray-500">(jij)</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
