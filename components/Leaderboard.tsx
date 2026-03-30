"use client";

import { useState, useEffect } from "react";

type LeaderboardType = "points" | "listen_time" | "requests";

interface LeaderboardEntry {
  rank: number;
  user_id: string;
  username: string;
  points: number;
  listen_seconds: number;
  total_requests: number;
  name_color: string;
}

interface LeaderboardProps {
  onUserClick?: (username: string) => void;
}

export default function Leaderboard({ onUserClick }: LeaderboardProps) {
  const [type, setType] = useState<LeaderboardType>("points");
  const [loading, setLoading] = useState(true);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadLeaderboard() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/leaderboard?type=${type}&limit=20`);
        const data = await res.json();
        
        if (data.error) {
          setError(data.error);
        }
        
        if (data.leaderboard) {
          setLeaderboard(data.leaderboard);
        }
      } catch (err) {
        console.error("Failed to load leaderboard:", err);
        setError("Kon ranking niet laden");
      } finally {
        setLoading(false);
      }
    }
    
    loadLeaderboard();
    const interval = setInterval(loadLeaderboard, 30000);
    return () => clearInterval(interval);
  }, [type]);

  function formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}u ${minutes}m`;
    }
    return `${minutes}m`;
  }

  const typeLabels = {
    points: "⭐ Punten",
    listen_time: "👂 Luistertijd",
    requests: "🎵 Verzoeken",
  };

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-2">
        {(Object.keys(typeLabels) as LeaderboardType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition ${
              type === t
                ? "bg-violet-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white"
            }`}
          >
            {typeLabels[t]}
          </button>
        ))}
      </div>

      {/* Leaderboard */}
      {loading ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500"></div>
        </div>
      ) : error ? (
        <div className="text-center py-8 text-red-400">
          {error}
        </div>
      ) : leaderboard.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          Nog geen punten verdient. Voeg verzoeken toe of luister mee om punten te krijgen!
        </div>
      ) : (
        <div className="space-y-2">
          {leaderboard.map((entry) => (
            <button
              key={entry.user_id}
              onClick={() => onUserClick?.(entry.username)}
              className="w-full flex items-center gap-3 p-3 rounded-xl bg-gray-800/50 hover:bg-gray-800 transition text-left"
            >
              {/* Rank */}
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                entry.rank === 1 ? "bg-yellow-500/20 text-yellow-400" :
                entry.rank === 2 ? "bg-gray-400/20 text-gray-300" :
                entry.rank === 3 ? "bg-amber-700/20 text-amber-600" :
                "bg-gray-700 text-gray-400"
              }`}>
                {entry.rank}
              </div>

              {/* Avatar placeholder */}
              <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-xl">
                🎵
              </div>

              {/* Name and stats */}
              <div className="flex-1 min-w-0">
                <div 
                  className="font-semibold truncate"
                  style={{ color: entry.name_color || "#fff" }}
                >
                  {entry.username}
                </div>
                <div className="text-xs text-gray-500">
                  {type === "points" && `${entry.points} punten`}
                  {type === "listen_time" && formatTime(entry.listen_seconds)}
                  {type === "requests" && `${entry.total_requests} verzoeken`}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
