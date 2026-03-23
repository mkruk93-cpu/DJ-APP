"use client";

import { useEffect, useState, useRef } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useRadioStore } from "@/lib/radioStore";

export default function OnlineUsers({ username }: { username?: string } = {}) {
  const [onlineUsers, setOnlineUsers] = useState<Array<{ nickname: string; listening: boolean }>>([]);
  const [expanded, setExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // We gebruiken 'any' voor state om type-errors te voorkomen als playerPlaying niet in de store-definitie staat
  const playerPlaying = useRadioStore((s: any) => s.playerPlaying);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = getSupabase();
    const myNickname = username || (typeof window !== "undefined" ? localStorage.getItem("nickname") : "anon");
    
    const channel = supabase.channel('online_users');

    channel
      .on('presence', { event: 'sync' }, () => {
        const newState = channel.presenceState();
        const users: any[] = [];
        
        for (const id in newState) {
          users.push(...newState[id]);
        }
        
        // Filter dubbele gebruikers op basis van nickname
        const distinctUsers = Array.from(new Map(users.map(u => [u.nickname, u])).values());
        
        setOnlineUsers(distinctUsers.map(u => ({
          nickname: u.nickname,
          listening: u.listening ?? true
        })));
        setIsLoading(false);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            nickname: myNickname,
            listening: true,
            online_at: new Date().toISOString(),
          });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [username]);

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
                  <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
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