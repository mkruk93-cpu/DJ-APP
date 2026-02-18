"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import TwitchPlayer from "@/components/TwitchPlayer";
import ChatBox from "@/components/ChatBox";
import RequestForm from "@/components/RequestForm";

export default function StreamPage() {
  const router = useRouter();

  useEffect(() => {
    const nickname = localStorage.getItem("nickname");
    if (!nickname) router.replace("/");
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900/80 px-6 py-3 backdrop-blur-sm">
        <h1 className="text-lg font-bold tracking-tight text-white">
          🎵 <span className="text-violet-400">{process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "Stream"}</span>
        </h1>
        <button
          onClick={() => {
            localStorage.removeItem("nickname");
            router.push("/");
          }}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:border-gray-600 hover:text-white"
        >
          Uitloggen
        </button>
      </header>

      {/* Three-column layout */}
      <main className="flex flex-1 flex-col gap-4 p-4 lg:flex-row">
        {/* Column 1: Player */}
        <div className="lg:flex-[2]">
          <TwitchPlayer />
        </div>

        {/* Column 2: Chat */}
        <div className="h-[500px] lg:h-auto lg:flex-1">
          <ChatBox />
        </div>

        {/* Column 3: Requests */}
        <div className="h-[500px] lg:h-auto lg:flex-1">
          <RequestForm />
        </div>
      </main>
    </div>
  );
}
