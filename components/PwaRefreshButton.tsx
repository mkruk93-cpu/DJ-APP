"use client";

import { useEffect, useState } from "react";

function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  const byMedia = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const byIos = typeof (window.navigator as Navigator & { standalone?: boolean }).standalone === "boolean"
    ? !!(window.navigator as Navigator & { standalone?: boolean }).standalone
    : false;
  return byMedia || byIos;
}

export default function PwaRefreshButton() {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia?.("(display-mode: standalone)");
    const update = () => setStandalone(isStandaloneMode());
    update();
    media?.addEventListener?.("change", update);
    window.addEventListener("pageshow", update);
    return () => {
      media?.removeEventListener?.("change", update);
      window.removeEventListener("pageshow", update);
    };
  }, []);

  if (!standalone) return null;

  return (
    <button
      type="button"
      aria-label="Ververs app"
      onClick={() => window.location.reload()}
      className="fixed right-3 top-3 z-[80] inline-flex items-center gap-1.5 rounded-full border border-violet-400/60 bg-gray-900/90 px-3 py-1.5 text-xs font-semibold text-violet-100 shadow-lg shadow-black/40 backdrop-blur transition hover:bg-gray-800"
    >
      <span aria-hidden>↻</span>
      <span>Ververs</span>
    </button>
  );
}
