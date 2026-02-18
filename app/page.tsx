"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const NICKNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const CHANNEL = process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "channel";

export default function NicknameGate() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("nickname");
    if (stored && NICKNAME_REGEX.test(stored)) {
      router.replace("/stream");
    }
  }, [router]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!NICKNAME_REGEX.test(nickname)) {
      setError("Nickname moet 3-20 tekens zijn (letters, cijfers, underscores).");
      return;
    }
    localStorage.setItem("nickname", nickname);
    router.push("/stream");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 shadow-lg shadow-violet-500/5">
        {/* Channel branding */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-violet-600/20 text-3xl">
            🎵
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            {CHANNEL}
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Kies een nickname om de stream te bekijken
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value);
                setError("");
              }}
              placeholder="Jouw nickname"
              maxLength={20}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
            />
            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500 active:scale-[0.98]"
          >
            Ga naar de stream
          </button>
        </form>
      </div>
    </div>
  );
}
