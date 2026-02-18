"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabaseClient";

interface PresenceState {
  nickname: string;
}

export default function OnlineUsers() {
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const nickname =
    typeof window !== "undefined"
      ? localStorage.getItem("nickname") ?? "anon"
      : "anon";

  useEffect(() => {
    const sb = getSupabase();
    const channel = sb.channel("online-users", {
      config: { presence: { key: nickname } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<PresenceState>();
        const users = Object.keys(state);
        setOnlineUsers(users.sort((a, b) => a.localeCompare(b)));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ nickname });
        }
      });

    return () => {
      sb.removeChannel(channel);
    };
  }, [nickname]);

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:border-gray-600 hover:text-white"
      >
        <span className="h-2 w-2 rounded-full bg-green-500" />
        <span>{onlineUsers.length} online</span>
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
                key={user}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-gray-300"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                <span className="truncate">
                  {user}
                  {user === nickname && (
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
