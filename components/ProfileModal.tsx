"use client";

import { useState, useEffect, useMemo } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/authContext";

interface ProfileModalProps {
  username: string;
  isOwnProfile?: boolean;
  onClose: () => void;
}

const PRESET_COLORS = [
  "#ffffff", // White (default)
  "#ef4444", // Red
  "#f97316", // Orange
  "#eab308", // Yellow
  "#22c55e", // Green
  "#06b6d4", // Cyan
  "#3b82f6", // Blue
  "#8b5cf6", // Violet
  "#ec4899", // Pink
  "#f472b6", // Pink light
];

const PRESET_AVATARS = [
  "🎵", "🎸", "🎹", "🎤", "🎧", "🎷", "🎺", "🎻", "🥁", "🎺",
  "🔥", "⚡", "🌟", "💫", "⭐", "✨", "💥", "🎵", "🎶", "🎼",
  "😎", "🤘", "😺", "🐱", "🐶", "🦊", "🐼", "🦁", "🐯", "🦄",
];

export default function ProfileModal({ username, isOwnProfile = false, onClose }: ProfileModalProps) {
  const { userAccount } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<any>(null);
  const [account, setAccount] = useState<any>(null);
  const [error, setError] = useState("");
  
  // Editable fields for own profile
  const [nameColor, setNameColor] = useState("#ffffff");
  const [avatar, setAvatar] = useState("🎵");

  useEffect(() => {
    async function loadProfile() {
      setLoading(true);
      try {
        const res = await fetch(`/api/profile?username=${encodeURIComponent(username)}`);
        const data = await res.json();
        
        if (data.error) {
          setError(data.error);
          return;
        }
        
        setAccount(data.account);
        setProfile(data.profile);
        
        if (data.profile) {
          setNameColor(data.profile.name_color || "#ffffff");
          setAvatar(data.profile.avatar_url || "🎵");
        }
      } catch (err) {
        setError("Failed to load profile");
      } finally {
        setLoading(false);
      }
    }
    
    loadProfile();
  }, [username]);

  async function saveProfile() {
    if (!account?.id) return;
    
    setSaving(true);
    setError("");
    
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: account.id,
          name_color: nameColor,
          avatar_url: avatar,
        }),
      });
      
      const data = await res.json();
      
      if (data.error) {
        setError(data.error);
        return;
      }
      
      setProfile(data.profile);
      onClose();
    } catch (err) {
      setError("Failed to save profile");
    } finally {
      setSaving(false);
    }
  }

  function formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}u ${minutes}m`;
    }
    return `${minutes}m`;
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500"></div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-white">
            {isOwnProfile ? "Mijn Profiel" : `${username}'s Profiel`}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500/50 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Avatar */}
        <div className="flex flex-col items-center mb-6">
          <div className="w-24 h-24 rounded-full bg-gray-800 flex items-center justify-center text-5xl mb-3 border-4 border-gray-700">
            {profile?.avatar_url || avatar || "🎵"}
          </div>
          
          {isOwnProfile && (
            <div className="flex flex-wrap gap-2 justify-center">
              {PRESET_AVATARS.slice(0, 10).map((a) => (
                <button
                  key={a}
                  onClick={() => setAvatar(a)}
                  className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl transition ${
                    avatar === a ? "bg-violet-600 ring-2 ring-violet-400" : "bg-gray-800 hover:bg-gray-700"
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Username */}
        <div className="text-center mb-6">
          <h3 
            className="text-2xl font-bold"
            style={{ color: profile?.name_color || nameColor }}
          >
            {username}
          </h3>
          <p className="text-sm text-gray-500">
            Lid sinds {account?.created_at ? new Date(account.created_at).toLocaleDateString("nl-NL") : "onbekend"}
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-yellow-400">⭐</div>
            <div className="text-lg font-bold text-white">{profile?.points || 0}</div>
            <div className="text-xs text-gray-500">Punten</div>
          </div>
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-green-400">👂</div>
            <div className="text-lg font-bold text-white">{formatTime(profile?.total_listen_seconds || 0)}</div>
            <div className="text-xs text-gray-500">Geluisterd</div>
          </div>
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-blue-400">🎵</div>
            <div className="text-lg font-bold text-white">{profile?.total_requests || 0}</div>
            <div className="text-xs text-gray-500">Verzoeken</div>
          </div>
        </div>

        {/* Name color picker (only for own profile) */}
        {isOwnProfile && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-400 mb-2">
              Chat Naam Kleur
            </label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setNameColor(color)}
                  className={`w-8 h-8 rounded-full transition ${
                    nameColor === color ? "ring-2 ring-white ring-offset-2 ring-offset-gray-900" : ""
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Save button */}
        {isOwnProfile && (
          <button
            onClick={saveProfile}
            disabled={saving}
            className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-semibold transition"
          >
            {saving ? "Opslaan..." : "Profiel Opslaan"}
          </button>
        )}
      </div>
    </div>
  );
}
