"use client";

import { useState, useRef, useEffect } from "react";
import { useRadioStore } from "@/lib/radioStore";
import { MODE_LABELS } from "@/lib/types";

const MODE_COLORS: Record<string, string> = {
  dj: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  radio: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  democracy: "bg-green-500/20 text-green-400 border-green-500/30",
  jukebox: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  party: "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

const MODE_DESCRIPTIONS: Record<string, { icon: string; lines: string[] }> = {
  dj: {
    icon: "🎧",
    lines: [
      "De DJ heeft volledige controle",
      "Alleen de admin kan nummers toevoegen en skippen",
    ],
  },
  radio: {
    icon: "📻",
    lines: [
      "Automatische playlist",
      "De admin beheert de wachtrij",
    ],
  },
  democracy: {
    icon: "🗳️",
    lines: [
      "Iedereen kan nummers toevoegen",
      "Stemmen bepaalt welk nummer geskipt wordt",
    ],
  },
  jukebox: {
    icon: "🎵",
    lines: [
      "Iedereen kan nummers toevoegen",
      "Alleen de admin kan skippen",
    ],
  },
  party: {
    icon: "🎉",
    lines: [
      "Iedereen mag nummers toevoegen",
      "Iedereen mag skippen",
    ],
  },
};

const MODE_SHORT_LABELS: Record<string, string> = {
  dj: "DJ",
  radio: "RAD",
  democracy: "DEM",
  jukebox: "JBOX",
  party: "PTY",
};

export default function ModeIndicator() {
  const mode = useRadioStore((s) => s.mode);
  const connected = useRadioStore((s) => s.connected);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Show loading state instead of hiding completely when not connected
  if (!connected) {
    return (
      <div className="inline-flex items-center gap-1 rounded-full border border-gray-600/50 bg-gray-500/10 px-2.5 py-1 text-xs font-semibold text-gray-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-500" />
        Verbinden...
      </div>
    );
  }

  const color = MODE_COLORS[mode] ?? MODE_COLORS.radio;
  const label = MODE_LABELS[mode] ?? mode;
  const shortLabel = MODE_SHORT_LABELS[mode] ?? label.slice(0, 3).toUpperCase();
  const info = MODE_DESCRIPTIONS[mode];

  return (
    <div ref={popoverRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-125 ${color}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        <span className="sm:hidden">{shortLabel}</span>
        <span className="hidden sm:inline">{label}</span>
      </button>

      {open && info && (
        <div className="absolute left-0 top-full z-50 mt-2 w-64 rounded-xl border border-gray-700 bg-gray-900 p-4 shadow-2xl shadow-black/50">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xl">{info.icon}</span>
            <span className={`text-sm font-bold ${color.split(" ")[1]}`}>{label}</span>
          </div>
          <ul className="space-y-1.5">
            {info.lines.map((line, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-gray-500" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
