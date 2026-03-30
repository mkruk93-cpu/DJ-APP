"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";
import { useAuth } from "@/lib/authContext";

export default function OnlineUsers({ username }: { username?: string } = {}) {
  const [onlineUsers, setOnlineUsers] = useState<Array<{ nickname: string; listening: boolean }>>([]);
  const [expanded, setExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const playerPlaying = useRadioStore((s) => s.playerPlaying);
  const setOnlineUserCount = useRadioStore((s) => s.setOnlineUserCount);
  const { userAccount } = useAuth();
  const menuRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof getSupabase>["channel"]> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const myNickname = useMemo(() => {
    const candidate = (username ?? userAccount?.username ?? "").trim();
    if (candidate) return candidate;
    if (typeof window === "undefined") return "Gast";
    const saved = (localStorage.getItem("nickname") ?? "").trim();
    return saved || "Gast";
  }, [username, userAccount?.username]);

  const presenceKey = useMemo(() => {
    const key = (userAccount?.id ?? "").trim();
    if (key) return key;
    if (typeof window === "undefined") return "guest";
    const saved = localStorage.getItem("djapp:presence-key");
    if (saved) return saved;
    const next = `guest:${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("djapp:presence-key", next);
    return next;
  }, [userAccount?.id]);

  const trackPresence = useCallback(async () => {
    const channel = channelRef.current;
    if (!channel) return;
    try {
      await channel.track({
        nickname: myNickname,
        listening: !!playerPlaying,
        online_at: new Date().toISOString(),
      });
    } catch {
      // Ignore presence track errors; reconnect will retry.
    }
  }, [myNickname, playerPlaying]);

  useEffect(() => {
    const supabase = getSupabase();

    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channel = supabase.channel("online_users", {
      config: { presence: { key: presenceKey } },
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, Array<{ nickname?: string; listening?: boolean }>>;
      const distinctByKey = new Map<string, { nickname: string; listening: boolean }>();
      for (const key of Object.keys(state)) {
        const entries = Array.isArray(state[key]) ? state[key] : [];
        for (const entry of entries) {
          const nick = (entry.nickname ?? "").trim();
          if (!nick) continue;
          distinctByKey.set(key, { nickname: nick, listening: entry.listening !== false });
        }
      }
      const users = Array.from(distinctByKey.values());
      setOnlineUsers(users);
      setOnlineUserCount(users.length);
      setIsLoading(false);
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void trackPresence();
      }
    });

    heartbeatRef.current = setInterval(() => {
      void trackPresence();
    }, 25_000);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void trackPresence();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [presenceKey, setOnlineUserCount, trackPresence]);

  useEffect(() => {
    void trackPresence();
  }, [trackPresence]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (isLoading) {
    return (
      <div className="hidden animate-pulse rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-500 sm:block">
        ...
      </div>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-2 rounded-lg border px-2 py-1 text-xs transition sm:px-3 sm:text-sm ${
            expanded 
            ? "border-violet-500/80 bg-violet-500/15 text-violet-200" 
            : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-white"
        }`}
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500"></span>
        </span>
        <span className="hidden sm:inline">{onlineUsers.length} online</span>
        <span className="sm:hidden">{onlineUsers.length}</span>
      </button>

      {expanded && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-48 overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-xl shadow-black/40">
          <div className="border-b border-gray-800 bg-gray-800/50 px-3 py-2">
            <p className="text-xs font-semibold text-white">Online Luisteraars</p>
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {onlineUsers.length === 0 ? (
              <p className="px-2 py-1 text-xs text-gray-500">Niemand online.</p>
            ) : (
              onlineUsers.map((user, idx) => (
                <div key={`${user.nickname}-${idx}`} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-800">
                  <div className={`h-1.5 w-1.5 rounded-full ${user.listening ? "bg-green-500" : "bg-red-500"}`} />
                  <span className="truncate text-xs text-gray-200">{user.nickname}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
