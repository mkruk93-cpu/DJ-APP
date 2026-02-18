"use client";

import { useEffect, useRef } from "react";

const CHANNEL = process.env.NEXT_PUBLIC_TWITCH_CHANNEL ?? "channel";

export default function TwitchPlayer() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = window.location.hostname;
    const container = containerRef.current;
    if (!container) return;

    const iframe = document.createElement("iframe");
    iframe.src = `https://player.twitch.tv/?channel=${CHANNEL}&parent=${parent}&muted=false`;
    iframe.setAttribute("allowfullscreen", "true");
    iframe.className = "absolute inset-0 h-full w-full rounded-xl";
    container.appendChild(iframe);

    return () => {
      container.innerHTML = "";
    };
  }, []);

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-lg shadow-violet-500/5"
         style={{ paddingTop: "56.25%" }}>
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
